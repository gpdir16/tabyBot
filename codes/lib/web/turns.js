// 턴 오케스트레이션: 사용자 메시지 1건을 에이전트 턴으로 실행하고 SSE 이벤트로 방송한다.
import { runAgent } from "../agent/loop.js";
import {
    RECOVERY_PROMPT,
    appendChatTurn,
    appendPendingUserTurn,
    checkpointChatTurn,
    hasRecoverableChatTurn,
    lastChatTurnMessages,
    markChatTurnInterrupted,
    prepareChatTurnRecovery,
} from "../agent/chat-history.js";
import { beginAgentSession, endAgentSession, enqueueAgentMessage, isAgentSessionRunning, requestAgentStop } from "../agent/session.js";
import { cancelQueuedAgentWork, scheduleWork } from "../agent-queue.js";
import { loadUserConfig } from "../config-loader.js";
import { setScheduleJobHandler as registerScheduleJobHandler } from "../scheduling/scheduler.js";
import { SCHEDULED_TURN_MARKER } from "../tools/schedule-tool.js";
import { formatAgentError, t } from "../i18n.js";
import { emit } from "./bus.js";
import { ensureConversation, ensureTitleFromMessage, getConversationMeta, isValidId, listConversations } from "./conversations.js";
import { firstAgentId } from "../agents-store.js";

function isStoppedByUser(result) {
    return result?.error === "stopped_by_user";
}

function isReplyFailure(result) {
    return (result?.error === "tool_rounds_exceeded" || result?.error === "empty_reply_exhausted") && !result.text?.trim();
}

function shouldRecover(result) {
    return isReplyFailure(result) || result?.error === "agent_error" || result?.error === "agent_turn_failed";
}

function isSilentReply(result) {
    return Boolean(result?.silent) && !result?.text?.trim();
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

export async function runTurn({ sessionKey, agentId, userText, displayText = null, attachments = [], recovery = false, quietEmpty = false }) {
    const lang = loadUserConfig().language || "en";
    const session = beginAgentSession(sessionKey);
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
                onCheckpoint: (turnMessages) => {
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
            saveChatTurn(sessionKey, result, resumed ? [] : attachments, resumed ? null : displayText, resumed ? recoveryBaseMessages : null);
            if (!result?.error && !quietEmpty) ensureTitleFromMessage(sessionKey, displayText || attachments[0]?.name || userText);
            if (result?.error && !isStoppedByUser(result)) markChatTurnInterrupted(sessionKey);
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
    try {
        appendPendingUserTurn(sessionKey, displayText ?? userText, attachments);
        ensureTitleFromMessage(sessionKey, displayText || attachments[0]?.name || userText);
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
    const stoppedActive = stoppedQueued ? false : requestAgentStop(sessionKey);
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

function scheduleConversationId(job) {
    const id = String(job.conversationId || "").trim();
    if (isValidId(id)) return id;
    return `web-sched-${job.id}`;
}

function buildScheduleFirePrompt(job) {
    return `${SCHEDULED_TURN_MARKER}
Scheduled task "${job.name}"${job.schedule ? ` (${job.schedule})` : ""}. This is an automatic run, not a user message.

Task:
${job.prompt}

Follow the task for when to speak. If it does not say to report empty results, stay silent unless there is a real finding or a failure the user must know. Do not narrate negative checks (no "I looked", "nothing new", "the list is empty"). If there is nothing to tell the user, reply with ONLY __SILENT__ — the entire message.`;
}

// 스케줄 결과는 지정한 대화에 올라간다. 빈 확인은 알림하지 않는다.
export function setScheduleJobHandler() {
    registerScheduleJobHandler(async (job) => {
        const lang = loadUserConfig().language || "en";
        const conversationId = scheduleConversationId(job);
        const agentId = job.agentId || firstAgentId();
        ensureConversation(conversationId, agentId);
        try {
            const result = await runTurn({
                sessionKey: conversationId,
                agentId,
                userText: buildScheduleFirePrompt(job),
                quietEmpty: true,
            });
            if (!result || isSilentReply(result)) return result;
            if (result.error) {
                emit({
                    type: "notice",
                    level: "error",
                    text: `⏰ ${job.name}: ${result.errorDetail || result.error}`,
                    conversationId,
                });
                return result;
            }
            const body = result.text?.trim() || t("schedule_no_output", lang);
            emit({ type: "notice", level: "info", text: `⏰ ${job.name}: ${body.slice(0, 400)}`, conversationId });
            emit({ type: "conversations_changed" });
            return result;
        } catch (err) {
            console.error("Schedule job error:", err?.stack || err);
            emit({
                type: "notice",
                level: "error",
                text: `⏰ ${job.name}: ${err?.message || String(err)}`,
                conversationId,
            });
            return { error: err?.message || String(err), silent: true };
        }
    });
}
