// 턴 오케스트레이션: 사용자 메시지 1건을 에이전트 턴으로 실행하고 SSE 이벤트로 방송한다.
import { runAgent } from "../agent/loop.js";
import {
    RECOVERY_PROMPT,
    appendChatTurn,
    appendPendingUserTurn,
    checkpointChatTurn,
    hasRecoverableChatTurn,
    isInternalStoredMessage,
    isSilentMarkedText,
    lastChatTurnMessages,
    markChatTurnInterrupted,
    prepareChatTurnRecovery,
} from "../agent/chat-history.js";
import { beginAgentSession, endAgentSession, enqueueAgentMessage, isAgentSessionRunning, requestAgentStop } from "../agent/session.js";
import { cancelQueuedAgentWork, scheduleWork } from "../agent-queue.js";
import { loadUserConfig } from "../config-loader.js";
import { setTodoHandlers } from "../todos/scheduler.js";
import { SCHEDULED_TURN_MARKER } from "../tools/todo-tool.js";
import { formatAgentError, t } from "../i18n.js";
import { emit } from "./bus.js";
import { ensureConversation, getConversationMeta, listConversations } from "./conversations.js";
import { maybeScheduleSessionReview } from "../dreaming/review.js";
import { markUserActivity } from "../user-activity.js";
import { setProactiveRunner, CHECKIN_PROMPT } from "../proactive.js";

function isStoppedByUser(result) {
    return result?.error === "stopped_by_user";
}

function isReplyFailure(result) {
    return (result?.error === "tool_rounds_exceeded" || result?.error === "empty_reply_exhausted") && !result.text?.trim();
}

function shouldRecover(result) {
    return isReplyFailure(result) || result?.error === "agent_error" || result?.error === "agent_turn_failed";
}

export function isSilentReply(result) {
    return Boolean(result?.silent) && !result?.text?.trim();
}

// 읽기 전용 도구 — 이것들만 쓰고 침묵한 자동 턴은 히스토리에 남기지 않는다.
const OBSERVATION_TOOLS = new Set(["file_read", "session_search", "todo_list", "skills_read", "bg_status", "bg_list"]);

// 자동 턴 중 "아무 일도 안 한" 턴만 저장을 건너뛴다. 무응답이어도 상태를 바꾼
// 도구를 썼거나 유저에게 말을 걸었거나 도중에 유저 메시지가 끼어든 턴은
// 에이전트 연속성을 위해 남긴다 — 도중에 한 말도 유저가 이미 본 발화다.
// 무의미한 체크인까지 쌓이면 히스토리가 불어나 다음 자동 턴의 입력 비용까지 키운다.
function isUnremarkableAutoTurn(result) {
    for (const m of result?.turnMessages || []) {
        if (m?.role === "user") {
            if (Array.isArray(m.content)) return false; // 이미지 관측 등 — 도구가 무언가 수행했다
            const text = typeof m.content === "string" ? m.content : "";
            if (text && !text.includes(SCHEDULED_TURN_MARKER) && !isInternalStoredMessage(m)) return false;
        }
        if (m?.role === "assistant") {
            for (const tc of m.tool_calls || []) {
                const name = tc?.function?.name || "";
                if (name && !OBSERVATION_TOOLS.has(name)) return false;
            }
            const text = typeof m.content === "string" ? m.content.trim() : "";
            if (text && !isSilentMarkedText(text)) return false;
        }
    }
    return true;
}

function saveChatTurn(sessionKey, result, attachments = [], displayText = null, baseMessages = null) {
    if (!result?.turnMessages?.length) return;
    try {
        const messages = result.turnMessages.map((message) => ({ ...message }));
        const userMessage = messages.find((message) => message?.role === "user");
        if (userMessage) {
            if (Array.isArray(userMessage.content)) {
                const textPart = userMessage.content.find((part) => part?.type === "text");
                userMessage.content = displayText != null ? displayText : textPart?.text || "";
            } else if (displayText != null) {
                userMessage.content = displayText;
            }
        }
        appendChatTurn(sessionKey, messages, {
            stats: result.stats,
            attachments,
            deliveredAttachments: result.deliveredAttachments,
            baseMessages,
        });
    } catch (err) {
        console.error("Chat history save failed:", err?.stack || err);
    }
}

export async function runTurn({
    sessionKey,
    agentId,
    userText,
    displayText = null,
    attachments = [],
    recovery = false,
    quietEmpty = false,
    automated = false,
    todoId = null,
}) {
    const lang = loadUserConfig().language || "en";
    const session = beginAgentSession(sessionKey, { automated });
    let recoveryBaseMessages = recovery ? lastChatTurnMessages(sessionKey) : null;
    let resumed = recovery;
    const startedAt = Date.now();
    let lastPhase = null;

    const status = (phase, detail = null) => {
        // 같은 phase 연속 방출은 클라이언트 상태 깜빡임만 유발하므로 스킵
        if (phase === lastPhase && !detail) return;
        lastPhase = phase;
        emit({ type: "status", conversationId: sessionKey, phase, detail });
    };

    try {
        status("generating", recovery ? "resuming interrupted run" : null);
        const run = (message, appendToRecovery = false) =>
            runAgent(message, {
                chatId: sessionKey,
                sessionKey,
                agentId,
                session,
                quietEmpty,
                todoId,
                attachments: appendToRecovery ? [] : attachments,
                onStatusPhase: (phase, detail) => status(phase, detail),
                onTextDelta: (text, full) => {
                    if (
                        quietEmpty &&
                        String(full || "")
                            .trim()
                            .startsWith("__SILENT__")
                    )
                        return;
                    emit({ type: "delta", conversationId: sessionKey, text, full });
                },
                onCheckpoint: automated
                    ? undefined // 자동 턴은 중간 체크포인트를 쓰지 않는다 — 무의미 턴이면 통째로 저장을 건너뛴다.
                    : (turnMessages) => {
                          if (!getConversationMeta(sessionKey)) return;
                          checkpointChatTurn(sessionKey, turnMessages, {
                              baseMessages: appendToRecovery ? recoveryBaseMessages : null,
                          });
                      },
            });

        let result = await run(userText, recovery);
        if (!recovery && !quietEmpty && shouldRecover(result)) {
            markChatTurnInterrupted(sessionKey);
            prepareChatTurnRecovery(sessionKey);
            recoveryBaseMessages = lastChatTurnMessages(sessionKey);
            resumed = true;
            status("generating", "resuming interrupted run");
            result = await run(RECOVERY_PROMPT, true);
        }

        // 실행 중 대화가 삭제되었으면 디스크에 되살리지 않는다.
        if (getConversationMeta(sessionKey)) {
            const skipPersist = automated && isUnremarkableAutoTurn(result);
            if (!skipPersist) {
                saveChatTurn(sessionKey, result, resumed ? [] : attachments, resumed ? null : displayText, resumed ? recoveryBaseMessages : null);
                if (result?.error && !isStoppedByUser(result)) markChatTurnInterrupted(sessionKey);
            }
            maybeScheduleSessionReview({ sessionKey, agentId, result, automated });
        }

        if (isStoppedByUser(result)) {
            emit({
                type: "turn_done",
                conversationId: sessionKey,
                text: result.text?.trim() || t("stopped_by_user", lang),
                stats: result.stats || null,
                attachments: result.deliveredAttachments || [],
                error: null,
                stopped: true,
            });
            return result;
        }

        if (result?.error && result.error !== "silent") {
            const detail = result.errorDetail ? formatAgentError(new Error(result.errorDetail), lang) : t(result.error, lang) || result.error;
            emit({
                type: "turn_done",
                conversationId: sessionKey,
                text: null,
                stats: result.stats || null,
                attachments: result.deliveredAttachments || [],
                error: { code: result.error, detail },
                automated: automated || undefined,
            });
            return result;
        }

        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: isSilentReply(result) ? null : result.text || "",
            stats: result.stats || null,
            attachments: result.deliveredAttachments || [],
            error: null,
            silent: isSilentReply(result),
            elapsedMs: Date.now() - startedAt,
        });
        return result;
    } catch (err) {
        console.error("Agent turn error:", err?.stack || err);
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: { code: "agent_turn_failed", detail: formatAgentError(err, lang) },
        });
        return { error: "agent_turn_failed", text: null };
    } finally {
        endAgentSession(sessionKey);
    }
}

// 실행 중이면 현재 턴에 끼워 넣고(pending), 아니면 새 턴을 예약한다.
export function dispatchMessage({ sessionKey, agentId, userText, displayText = null, attachments = [] }) {
    markUserActivity();
    try {
        appendPendingUserTurn(sessionKey, displayText ?? userText, attachments);
    } catch (err) {
        console.error("Pending user turn save failed:", err?.stack || err);
    }
    if (isAgentSessionRunning(sessionKey)) {
        const queued = enqueueAgentMessage(sessionKey, userText);
        if (queued) return { queued: true };
    }
    void scheduleWork("user", () => runTurn({ sessionKey, agentId, userText, displayText, attachments }), {
        sessionKey,
        cancellable: true,
    }).catch((err) => {
        console.error("Agent error:", err?.stack || err);
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: { code: "agent_turn_failed", detail: formatAgentError(err, loadUserConfig().language || "en") },
        });
    });
    return { queued: false };
}

export function recoverInterruptedTurns() {
    for (const conversation of listConversations()) {
        const sessionKey = conversation.id;
        if (!hasRecoverableChatTurn(sessionKey) || !prepareChatTurnRecovery(sessionKey)) continue;

        void scheduleWork(
            "user",
            () =>
                runTurn({
                    sessionKey,
                    agentId: conversation.agentId,
                    userText: RECOVERY_PROMPT,
                    recovery: true,
                }),
            { sessionKey, cancellable: true },
        ).catch((err) => console.error("Interrupted turn recovery failed:", err?.stack || err));
    }
}

export function stopConversation(sessionKey) {
    const stoppedQueued = cancelQueuedAgentWork(sessionKey);
    const stoppedActive = requestAgentStop(sessionKey);
    if (stoppedQueued || stoppedActive) {
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: null,
            stopped: true,
        });
    }
    return stoppedActive || stoppedQueued;
}

function buildFirePrompt(item) {
    const when = item.when ? ` (${item.when})` : "";
    const body = String(item.prompt || "").trim() || `Do the task: ${item.title}`;
    const isJob = (item.list || "user") !== "user";
    const editNote =
        item.lastEdit?.by === "user"
            ? `\nNote: the user last edited this task at ${item.lastEdit.at}${item.lastEdit.fields?.length ? ` (changed: ${item.lastEdit.fields.join(", ")})` : ""}. The text below is the current version.`
            : "";
    return `${SCHEDULED_TURN_MARKER}
${isJob ? `Scheduled job` : `Agent todo`} "${item.title}"${when}. This is an automatic run${isJob ? "" : " of a subcontracted task"}, not a user message.${editNote}

Task:
${body}

Follow the task for when to speak. If it does not say to report empty results, stay silent unless there is a real finding or a failure the user must know. Do not narrate negative checks (no "I looked", "nothing new", "the list is empty"). If there is nothing to tell the user, reply with ONLY __SILENT__ — the entire message.`;
}

// 능동 체크인: 봇의 메인 스레드에서 조용히 깨어 할 말이 있을 때만 게시한다.
export function setProactiveHandler() {
    setProactiveRunner(async (agent) => {
        const sessionKey = agent.uuid;
        ensureConversation(sessionKey);
        const result = await runTurn({
            sessionKey,
            agentId: agent.id,
            userText: `${SCHEDULED_TURN_MARKER}\nAutomatic proactive check-in — not a user message.\n\n${CHECKIN_PROMPT}`,
            quietEmpty: true,
            automated: true,
        });
        if (!result || isSilentReply(result) || result.error) return result;
        const body = result.text?.trim();
        if (body) {
            emit({ type: "notice", level: "info", text: body.slice(0, 400), conversationId: sessionKey });
            emit({ type: "conversations_changed" });
        }
        return result;
    });
}

export function setTodoJobHandler() {
    setTodoHandlers({
        emit,
        async runAgent({ agent, item, sessionKey }) {
            const lang = loadUserConfig().language || "en";
            const isJob = (item.list || "user") !== "user";
            ensureConversation(sessionKey);
            try {
                const result = await runTurn({
                    sessionKey,
                    agentId: agent.id,
                    userText: buildFirePrompt(item),
                    quietEmpty: true,
                    automated: true,
                    todoId: item.id,
                });
                emit({ type: "todos_changed" });
                if (!result || isSilentReply(result)) return result;
                if (result.error) {
                    if (!isStoppedByUser(result)) {
                        emit({
                            type: "notice",
                            level: "error",
                            text: `${isJob ? "⏰" : "❌"} ${item.title}: ${result.errorDetail || result.error}`,
                            conversationId: sessionKey,
                        });
                    }
                    return result;
                }
                const body = result.text?.trim() || t("schedule_no_output", lang);
                emit({
                    type: "notice",
                    level: "info",
                    text: `${isJob ? "⏰" : "✅"} ${item.title}: ${body.slice(0, 400)}`,
                    conversationId: sessionKey,
                });
                emit({ type: "conversations_changed" });
                return result;
            } catch (err) {
                console.error("Todo job error:", err?.stack || err);
                emit({
                    type: "notice",
                    level: "error",
                    text: `${isJob ? "⏰" : "❌"} ${item.title}: ${err?.message || String(err)}`,
                    conversationId: sessionKey,
                });
                return { error: err?.message || String(err), silent: true };
            }
        },
        async remindUser({ item }) {
            emit({
                type: "todo_due",
                title: item.title,
                kind: item.kind || "none",
                cron: item.cron || "",
                every: item.every || "",
                at: item.at || "",
                timezone: item.timezone || "",
                text: item.title,
                url: `/t/${item.id}`,
            });
            emit({ type: "todos_changed" });
        },
    });
}
