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
    newMessageId,
    prepareChatTurnRecovery,
    settlePendingUserTurns,
    userMessageIdsOf,
} from "../agent/chat-history.js";
import { beginAgentSession, endAgentSession, enqueueAgentMessage, requestAgentStop, restartOnQuickFollowup } from "../agent/session.js";
import { ASK_CANCEL_USER_MESSAGE, cancelPendingAsk } from "../agent/user-ask.js";
import { cancelQueuedAgentWork, scheduleWork } from "../agent-queue.js";
import { loadUserConfig } from "../config-loader.js";
import { setTodoHandlers } from "../todos/scheduler.js";
import { SCHEDULED_TURN_MARKER, isScheduledTurnText } from "../agent/history/messages.js";
import { formatAgentError, t } from "../i18n.js";
import { emit } from "./bus.js";
import { ensureConversation, hasConversation, listConversations, toDisplayTurns } from "./conversations.js";
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

// 읽기 전용 도구: 이것들만 쓰고 침묵한 자동 턴은 히스토리에 남기지 않는다.
const OBSERVATION_TOOLS = new Set(["file_read", "session_search", "todo_list", "skills_read", "bg_status", "bg_list"]);

// 자동 턴 중 "아무 일도 안 한" 턴만 저장을 건너뛴다. 무응답이어도 상태를 바꾼
// 도구를 썼거나 유저에게 말을 걸었거나 도중에 유저 메시지가 끼어든 턴은
// 에이전트 연속성을 위해 남긴다. 도중에 한 말도 유저가 이미 본 발화다.
// 무의미한 체크인까지 쌓이면 히스토리가 불어나 다음 자동 턴의 입력 비용까지 키운다.
function isUnremarkableAutoTurn(result) {
    for (const m of result?.turnMessages || []) {
        if (m?.role === "user") {
            if (Array.isArray(m.content)) return false; // 이미지 관측 등: 도구가 무언가 수행했다
            const text = typeof m.content === "string" ? m.content : "";
            if (text && !isScheduledTurnText(text) && !isInternalStoredMessage(m)) return false;
        }
        if (m?.role === "assistant") {
            for (const tc of m.tool_calls || []) {
                const name = tc?.function?.name || "";
                if (name && !OBSERVATION_TOOLS.has(name)) return false;
            }
            const text = typeof m.content === "string" ? m.content.trim() : "";
            // 툴 호출에 붙은 본문은 사용자에게 가지 않는 내부 메모: 턴의 가치를 올리지 않는다.
            // (user_say 호출은 위 도구 판정에서 이미 유의미로 걸러진다)
            if (text && !isSilentMarkedText(text) && !m.tool_calls?.length) return false;
        }
    }
    return true;
}

// 이번 턴을 시작시킨 사용자 메시지를 저장용 모양으로 되돌린다.
// 모델에 보낸 본문은 가공돼 있다(이미지 파트 배열, 시크릿 자리표시자). 그대로 저장하면
// 실행 중인 화면에서 그 메시지가 숨겨지고 세션 파일에 이미지 원문이 들어간다.
function storableTurnMessages(turnMessages, { messageId = null, displayText = null, attachments = [] } = {}) {
    const messages = turnMessages.map((message) => ({ ...message }));
    const userMessage = messageId ? messages.find((message) => message?.role === "user" && message.id === messageId) : null;
    if (!userMessage) return messages;
    if (displayText != null) {
        userMessage.content = displayText;
    } else if (Array.isArray(userMessage.content)) {
        userMessage.content = userMessage.content.find((part) => part?.type === "text")?.text || "";
    }
    if (attachments.length) userMessage.attachments = attachments;
    return messages;
}

function saveChatTurn(sessionKey, result, { turnId, messageId, displayText, attachments, baseMessages }) {
    if (!result?.turnMessages?.length) return;
    try {
        appendChatTurn(sessionKey, storableTurnMessages(result.turnMessages, { messageId, displayText, attachments }), {
            turnId,
            stats: result.stats,
            deliveredAttachments: result.deliveredAttachments,
            baseMessages,
        });
    } catch (err) {
        console.error("Chat history save failed:", err?.stack || err);
    }
}

// 실행 중 대화가 삭제되었으면 디스크에 되살리지 않는다.
function persistCompletedTurn({
    sessionKey,
    agentId,
    result,
    turnId,
    messageId,
    attachments,
    displayText,
    resumed,
    recoveryBaseMessages,
    automated,
}) {
    if (!hasConversation(sessionKey)) return;
    const skipPersist = automated && isUnremarkableAutoTurn(result);
    if (!skipPersist) {
        saveChatTurn(sessionKey, result, { turnId, messageId, displayText, attachments, baseMessages: resumed ? recoveryBaseMessages : null });
        // 자동 턴이 답을 못 받고 끝난 것(빈 답, 라운드 소진)은 끊긴 턴이 아니다. 재시작 때 다시 돌리지 않는다.
        if (result?.error && !isStoppedByUser(result) && !(automated && isReplyFailure(result))) markChatTurnInterrupted(sessionKey);
    }
    maybeScheduleSessionReview({ sessionKey, agentId, result, automated });
}

// 스트리밍 본문을 짧게 묶어 늘어난 부분만 보낸다. 토큰마다 지금까지의 전문을 실어 보내면
// 긴 답변에서 전송량이 길이의 제곱으로 불어나고, 재접속용 이벤트 기록도 델타로 가득 찬다.
const DELTA_FLUSH_MS = 60;

// 침묵 마커. 답의 앞이나 끝에 붙으면 그 답은 사용자에게 가지 않는다(loop.js와 같은 규칙).
const SILENT_MARKER = "__SILENT__";

// 본문 끝이 마커의 앞부분과 겹치는 길이. 그만큼은 아직 내보내지 않는다(마커가 완성될 수 있다).
function markerPrefixTail(text) {
    for (let n = Math.min(SILENT_MARKER.length, text.length); n > 0; n -= 1) {
        if (SILENT_MARKER.startsWith(text.slice(-n))) return n;
    }
    return 0;
}

function createDeltaStream({ sessionKey, automated }) {
    let full = "";
    let sent = 0;
    let timer = null;

    function send(offset, text) {
        emit({ type: "delta", conversationId: sessionKey, offset, text, automated: automated || undefined });
    }

    function flush() {
        clearTimeout(timer);
        timer = null;
        const trimmed = full.trimEnd();
        // 침묵 답변은 화면에 내보내지 않는다. 사람이 보낸 턴이면 루프가 되돌려 다시 답을 받는다.
        if (full.trim().startsWith(SILENT_MARKER)) return;
        // 끝에 마커가 붙었으면 이미 보낸 부분까지 거둔다(빈 본문을 처음부터 보내면 화면이 비운다).
        if (trimmed.endsWith(SILENT_MARKER)) {
            if (sent > 0) send(0, "");
            sent = 0;
            return;
        }
        // 끝이 마커로 이어질 수 있는 부분은 다음 조각을 볼 때까지 붙잡아 둔다.
        const ready = trimmed.length - markerPrefixTail(trimmed);
        if (ready <= sent) return;
        send(sent, full.slice(sent, ready));
        sent = ready;
    }

    return {
        push(delta, nextFull) {
            const next = String(nextFull || "");
            // 새 모델 호출은 본문이 처음부터 다시 쌓인다. 이어지는 본문이 아니면 offset 0부터 다시 보낸다.
            if (next.length !== full.length + String(delta || "").length) sent = 0;
            full = next;
            if (!timer) timer = setTimeout(flush, DELTA_FLUSH_MS);
        },
        flush,
        stop() {
            clearTimeout(timer);
            timer = null;
        },
    };
}

// 화면에 보이는 내용이 달라졌을 때만 알리기 위한 서명.
function displaySignature(messages) {
    return JSON.stringify(toDisplayTurns([{ messages }]));
}

// mirror(messages, { final, result }): 그룹 방에서 쓴다. 이 실행의 기록이 바뀔 때마다(체크포인트, 완료) 불려
// 방의 화면 기록에 같은 내용을 옮겨 적게 한다. onLeftover(messages): 끝나기 직전에 와서 합쳐지지 못한
// 메시지를 넘긴다. 없으면 같은 세션의 다음 턴으로 이어 돌린다.
export async function runTurn({
    sessionKey,
    agentId,
    userText,
    displayText = null,
    attachments = [],
    messageId = null,
    messageAt = null,
    recovery = false,
    quietEmpty = false,
    silenceHint = null,
    automated = false,
    todoId = null,
    mirror = null,
    onLeftover = null,
}) {
    const lang = loadUserConfig().language || "en";
    const session = beginAgentSession(sessionKey, { automated });
    if (messageAt) session.lastUserMessageAt = Date.parse(messageAt);
    // 이 실행의 기록은 turnId로 찾는다. 위치(마지막 턴)로 찾으면 실행 중에 온 메시지와 뒤섞인다.
    const turnId = newMessageId();
    let recoveryBaseMessages = recovery ? lastChatTurnMessages(sessionKey) : null;
    let resumed = recovery;
    const startedAt = Date.now();
    let lastPhase = null;
    let lastDisplay = null;
    // 턴이 어떻게 끝났는지: 남은 대기 메시지를 어떻게 할지 정한다.
    let outcome = "failed";
    let finalResult = null;
    const deltas = createDeltaStream({ sessionKey, automated });

    const status = (phase, detail = null) => {
        // 같은 phase 연속 방출은 클라이언트 상태 깜빡임만 유발하므로 스킵
        if (phase === lastPhase && !detail) return;
        lastPhase = phase;
        // 묶어 둔 본문을 먼저 내보내 이벤트 순서를 지킨다(도구 단계 뒤에 앞선 본문이 도착하지 않게).
        deltas.flush();
        emit({ type: "status", conversationId: sessionKey, phase, detail, automated: automated || undefined });
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
                silenceHint,
                todoId,
                attachments: appendToRecovery ? [] : attachments,
                userMessageMeta: appendToRecovery || !messageId ? null : { id: messageId, at: messageAt },
                onStatusPhase: (phase, detail) => status(phase, detail),
                onTextDelta: (text, full) => deltas.push(text, full),
                onCheckpoint: automated
                    ? undefined // 자동 턴은 중간 체크포인트를 쓰지 않는다. 무의미 턴이면 통째로 저장을 건너뛴다.
                    : (turnMessages) => {
                          if (!hasConversation(sessionKey)) return;
                          const messages = storableTurnMessages(turnMessages, { messageId, displayText, attachments });
                          checkpointChatTurn(sessionKey, messages, {
                              turnId,
                              baseMessages: appendToRecovery ? recoveryBaseMessages : null,
                          });
                          mirror?.(messages, { final: false });
                          // 보이는 내용(중간 발화, 답변, 합쳐진 사용자 메시지)이 바뀐 체크포인트만 화면에 알린다.
                          const display = displaySignature(messages);
                          if (display === lastDisplay) return;
                          lastDisplay = display;
                          emit({ type: "turns_changed", conversationId: sessionKey });
                      },
            });

        let result = await run(userText, recovery);
        // 이어 돌릴 끊긴 턴이 있을 때만 복구한다. 체크포인트 하나 없이 실패한 턴(예: 그룹 멤버 세션의 빈 답)에서
        // 복구하면 앞의 끝난 턴을 이어 써서 이번 메시지가 사라지고 지난 답이 되풀이된다.
        if (!recovery && !quietEmpty && shouldRecover(result) && markChatTurnInterrupted(sessionKey) && prepareChatTurnRecovery(sessionKey)) {
            recoveryBaseMessages = lastChatTurnMessages(sessionKey);
            // 끊긴 턴에 함께 묶인 대기 메시지는 이미 기록으로 모델에 들어간다. 대기열에서 또 넣지 않는다.
            session.dropPendingMessages(new Set(userMessageIdsOf(recoveryBaseMessages)));
            resumed = true;
            status("generating", "resuming interrupted run");
            result = await run(RECOVERY_PROMPT, true);
        }
        deltas.stop();
        finalResult = result;
        const stoppedByUser = isStoppedByUser(result);
        if (stoppedByUser) outcome = "stopped";
        else if (!result?.error || result.error === "silent") outcome = "done";

        persistCompletedTurn({
            sessionKey,
            agentId,
            result,
            turnId,
            messageId: resumed ? null : messageId,
            attachments: resumed ? [] : attachments,
            displayText: resumed ? null : displayText,
            resumed,
            recoveryBaseMessages,
            automated,
        });
        if (mirror && result?.turnMessages?.length) {
            mirror(storableTurnMessages(result.turnMessages, { messageId, displayText, attachments }), { final: true, result });
        }

        if (stoppedByUser) {
            emit({
                type: "turn_done",
                conversationId: sessionKey,
                // 바로 이어 보낸 메시지로 다시 시작할 때는 중지 안내를 남기지 않는다.
                text: session.restartRequested ? null : result.text?.trim() || t("stopped_by_user", lang),
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
        deltas.stop();
        const leftover = session.drainPendingMessages();
        endAgentSession(sessionKey);
        // 이어 돌린 실행이면 시작 메시지는 이미 기록에 있다.
        const origin = { id: resumed ? null : messageId, text: userText, attachments, at: messageAt };
        continueAfterTurn({ sessionKey, agentId, outcome, restart: session.restartRequested, origin, finalResult, leftover, onLeftover });
    }
}

// 끝난 실행 뒤에 남은 대기 메시지를 처리한다.
function continueAfterTurn({ sessionKey, agentId, outcome, restart, origin, finalResult, leftover, onLeftover }) {
    if (outcome === "stopped" && restart) {
        restartAfterQuickFollowup({ sessionKey, agentId, origin, savedMessages: finalResult?.turnMessages, leftover });
    } else if (outcome === "stopped") settleStoppedConversation(sessionKey);
    // 끝나기 직전에 도착해 이번 실행에 합쳐지지 못한 메시지: 버리지 않고 다음 턴으로 넘긴다.
    // 실패한 턴 뒤에는 잇지 않는다(같은 오류를 되풀이한다). 기록에는 끊긴 턴으로 남아 있다.
    else if (outcome === "done" && leftover.length) {
        if (onLeftover) onLeftover(leftover);
        else startUserTurn({ sessionKey, agentId, messages: leftover });
    }
}

// 바로 이어 보낸 메시지로 멈춘 실행을 다시 시작한다. 멈춘 실행이 시작 메시지를 기록하지 못했으면 함께 다시 보낸다.
function restartAfterQuickFollowup({ sessionKey, agentId, origin, savedMessages, leftover }) {
    if (!hasConversation(sessionKey)) return;
    const saved = new Set(userMessageIdsOf(savedMessages));
    const messages = origin.id && !saved.has(origin.id) ? [origin, ...leftover] : leftover;
    if (messages.length) startUserTurn({ sessionKey, agentId, messages });
    else settleStoppedConversation(sessionKey);
}

// 사용자가 멈춘 대화에 남은 대기 메시지는 다시 실행하지 않고 기록으로만 남긴다.
function settleStoppedConversation(sessionKey) {
    try {
        if (settlePendingUserTurns(sessionKey)) emit({ type: "turns_changed", conversationId: sessionKey });
    } catch (err) {
        console.error("Pending user turn settle failed:", err?.stack || err);
    }
}

// 사용자 메시지로 새 턴을 예약한다. 첫 메시지가 턴을 시작하고, 나머지는 실행 중에 합쳐 넣는다.
function startUserTurn({ sessionKey, agentId, messages }) {
    const [first, ...rest] = messages;
    void scheduleWork(
        "user",
        () =>
            runTurn({
                sessionKey,
                agentId,
                userText: first.text,
                displayText: first.text,
                attachments: first.attachments || [],
                messageId: first.id,
                messageAt: first.at,
            }),
        { sessionKey, cancellable: true },
    ).catch((err) => {
        console.error("Agent error:", err?.stack || err);
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: { code: "agent_turn_failed", detail: formatAgentError(err, loadUserConfig().language || "en") },
        });
    });
    // scheduleWork가 세션을 만들어 두므로, 뒤따르는 메시지는 그 세션의 대기열에 쌓인다.
    for (const message of rest) enqueueAgentMessage(sessionKey, message);
}

// 사용자 메시지 한 건을 받는다. 실행 중이면 현재 턴에 끼워 넣고(대기열), 아니면 새 턴을 예약한다.
// 같은 id가 이미 처리됐으면(재전송) 아무것도 하지 않는다.
export function dispatchMessage({ sessionKey, agentId, id = null, userText, attachments = [] }) {
    markUserActivity();
    const message = { id: id || newMessageId(), text: String(userText || "").trim(), attachments, at: new Date().toISOString() };
    try {
        if (!appendPendingUserTurn(sessionKey, message)) return { id: message.id, duplicate: true };
    } catch (err) {
        console.error("Pending user turn save failed:", err?.stack || err);
    }
    if (enqueueAgentMessage(sessionKey, message)) {
        // user_ask·secret_request가 답을 기다리는 중이면 기다림을 끝낸다. 도구가 바로 돌아와야 다음 라운드에서
        // 이 메시지를 읽는다. 안 그러면 질문 시간이 끝날 때까지(최대 10분) 메시지가 대기열에만 머문다.
        cancelPendingAsk(sessionKey, ASK_CANCEL_USER_MESSAGE);
        // 직전 메시지에서 얼마 안 돼 보낸 메시지는 끼워 넣지 않고 실행을 멈춘 뒤 새 턴으로 다시 보낸다.
        restartOnQuickFollowup(sessionKey, message.at);
        return { id: message.id, queued: true };
    }
    startUserTurn({ sessionKey, agentId, messages: [message] });
    return { id: message.id, queued: false };
}

// 재시작으로 끊긴 턴을 이어서 돌린다. 한꺼번에 모델을 호출하지 않도록 하나씩 차례로 이어간다.
// 그룹 방의 멤버 세션도 같다: 끊긴 멤버 턴은 그 세션에서 이어 돌리고, 방의 화면 기록에도 옮겨 적는다.
export function recoverInterruptedTurns({ memberSessions = [] } = {}) {
    const threads = listConversations()
        .filter((conversation) => hasRecoverableChatTurn(conversation.id))
        .map((conversation) => ({ sessionKey: conversation.id, agentId: conversation.agentId }));
    const members = memberSessions.filter((m) => hasRecoverableChatTurn(m.sessionKey));
    const targets = [...threads, ...members];
    void (async () => {
        for (const conversation of targets) {
            const { sessionKey } = conversation;
            if (!prepareChatTurnRecovery(sessionKey)) continue;
            try {
                await scheduleWork(
                    "user",
                    () =>
                        runTurn({
                            sessionKey,
                            agentId: conversation.agentId,
                            mirror: conversation.mirror || null,
                            userText: RECOVERY_PROMPT,
                            recovery: true,
                        }),
                    { sessionKey, cancellable: true },
                );
            } catch (err) {
                console.error("Interrupted turn recovery failed:", err?.stack || err);
            }
        }
    })();
}

export function stopConversation(sessionKey) {
    const stoppedQueued = cancelQueuedAgentWork(sessionKey);
    const stoppedActive = requestAgentStop(sessionKey);
    // 실행 중인 턴은 끝나면서 스스로 정리한다. 예약만 돼 있던 턴은 여기서 대기 메시지를 확정한다.
    if (stoppedQueued && !stoppedActive) settleStoppedConversation(sessionKey);
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

Follow the task for when to speak. If it does not say to report empty results, stay silent unless there is a real finding or a failure the user must know. Do not narrate negative checks (no "I looked", "nothing new", "the list is empty"), and do not post progress updates mid-run ("checking the page", "it loaded, extracting now"). Like a coworker, report only the finished job. Text written next to tool calls never reaches the user. If something cannot wait, send it with the user_say tool. If there is nothing to tell the user, reply with ONLY __SILENT__ as the entire message.`;
}

// 능동 체크인: 봇의 메인 스레드에서 조용히 깨어 할 말이 있을 때만 게시한다.
export function setProactiveHandler() {
    setProactiveRunner(async (agent) => {
        const sessionKey = agent.uuid;
        ensureConversation(sessionKey);
        const result = await runTurn({
            sessionKey,
            agentId: agent.id,
            userText: `${SCHEDULED_TURN_MARKER}\nAutomatic proactive check-in, not a user message.\n\n${CHECKIN_PROMPT}`,
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
                            text: `${item.title}: ${result.errorDetail || result.error}`,
                            conversationId: sessionKey,
                        });
                    }
                    return result;
                }
                const body = result.text?.trim() || t("schedule_no_output", lang);
                emit({
                    type: "notice",
                    level: "info",
                    text: `${item.title}: ${body.slice(0, 400)}`,
                    conversationId: sessionKey,
                });
                emit({ type: "conversations_changed" });
                return result;
            } catch (err) {
                console.error("Todo job error:", err?.stack || err);
                emit({
                    type: "notice",
                    level: "error",
                    text: `${item.title}: ${err?.message || String(err)}`,
                    conversationId: sessionKey,
                });
                return { error: err?.message || String(err), silent: true };
            }
        },
        remindUser({ item }) {
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
