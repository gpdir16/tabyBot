// 진행 중인 턴의 저장: 대기 메시지, 체크포인트, 중단 복구, 완료 기록.
import { PENDING_MERGE_STATUSES, RECOVERABLE_TURN_STATUSES, cloneStoredMessage, isInternalStoredMessage, sanitizeTurnStats } from "./messages.js";
import { PENDING_USER_PREFIX } from "./messages.js";
import { loadChatHistory, replaceChatHistory } from "./sessions.js";
import { writePreview } from "./preview.js";

function userContentsFromTurnMessages(turnMessages) {
    const out = [];
    for (const m of turnMessages || []) {
        if (m?.role !== "user" || typeof m.content !== "string") continue;
        if (isInternalStoredMessage(m)) continue;
        const content = m.content;
        if (content.startsWith(PENDING_USER_PREFIX)) {
            for (const part of content.slice(PENDING_USER_PREFIX.length).split("\n\n")) {
                const clean = part.trim();
                if (clean) out.push(clean);
            }
            continue;
        }
        out.push(content);
    }
    return out;
}

// 턴 메시지에 이미 포함된 큐 발화의 단독 pending 턴을 뒤에서부터 소비한다.
// 반환값은 제거된 pending 턴의 user 메시지들: 첨부 복구에 쓴다.
function consumeQueuedUserTurns(turns, turnMessages) {
    const incomingUsers = userContentsFromTurnMessages(turnMessages);
    const popped = [];
    while (turns.length && incomingUsers.length) {
        const pending = turns[turns.length - 1];
        const msgs = pending?.messages || [];
        if (msgs.length !== 1 || msgs[0]?.role !== "user") break;
        const content = msgs[0].content;
        if (typeof content !== "string") break;
        // 빈 줄이 들어간 메시지는 합성 래퍼에서 여러 파트로 쪼개져 있으므로
        // 인접 파트를 다시 이어 붙여서 pending 턴 원문과 맞는지 본다.
        let idx = -1;
        let span = 1;
        for (let i = incomingUsers.length - 1; i >= 0; i -= 1) {
            for (let len = 1; i + len <= incomingUsers.length; len += 1) {
                if (incomingUsers.slice(i, i + len).join("\n\n") === content) {
                    idx = i;
                    span = len;
                    break;
                }
                if (incomingUsers.slice(i, i + len).join("\n\n").length > content.length) break;
            }
            if (idx >= 0) break;
        }
        if (idx < 0) break;
        incomingUsers.splice(idx, span);
        popped.push(turns.pop().messages[0]);
    }
    return popped;
}

// 소비된 pending 턴에 붙어 있던 첨부를 주입된 user 메시지로 옮긴다.
// 큐에 실린 업로드가 히스토리에서 사라지지 않게.
function rescuePoppedAttachments(popped, messages) {
    for (const pm of popped) {
        if (!pm?.attachments?.length) continue;
        const userMessage = [...messages].reverse().find((m) => m?.role === "user");
        if (userMessage && !userMessage.attachments) userMessage.attachments = pm.attachments;
    }
}

export function appendPendingUserTurn(chatId, userText, attachments = []) {
    const text = String(userText || "").trim();
    if (!chatId || (!text && !attachments.length)) return;

    const turns = loadChatHistory(chatId);
    const last = turns[turns.length - 1];
    const lastMsgs = last?.messages || [];
    const lastMsg = lastMsgs[lastMsgs.length - 1];
    if (lastMsgs.length === 1 && lastMsg?.role === "user" && lastMsg.content === text) return;

    const now = new Date().toISOString();
    turns.push({
        at: now,
        status: "pending",
        messages: [{ role: "user", content: text, at: now, ...(attachments.length ? { attachments } : {}) }],
    });
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}

export function checkpointChatTurn(chatId, turnMessages, { baseMessages = null } = {}) {
    if (!chatId || !turnMessages?.length) return;

    const turns = loadChatHistory(chatId);
    // 실행 중 보낸 메시지가 이 체크포인트에 래핑 주입돼 있으면 단독 pending 턴을
    // 여기서 소비한다. 턴 완료까지 남겨 두면 화면에 같은 발화가 두 번 보인다.
    const consumedPending = consumeQueuedUserTurns(turns, turnMessages);
    let targetIndex = turns.length - 1;
    // 복구 실행(baseMessages 있음)이 아니면 interrupted 턴까지 거슬러 합치지 않는다.
    // 이전 턴의 메시지가 새 턴 체크포인트로 교체되며 유실되는 것을 막기 위해서다.
    const mergeable = Array.isArray(baseMessages) ? RECOVERABLE_TURN_STATUSES : PENDING_MERGE_STATUSES;
    while (targetIndex > 0 && mergeable.has(turns[targetIndex - 1]?.status)) targetIndex -= 1;
    const target = turns[targetIndex];
    const messages = Array.isArray(baseMessages) ? [...baseMessages, ...turnMessages.map(cloneStoredMessage)] : turnMessages.map(cloneStoredMessage);
    // 대기열(pending) 턴이 이 턴에 흡수되면 체크포인트가 메시지를 통째로 교체하므로
    // 저장돼 있던 첨부 메타데이터를 새 유저 메시지로 옮겨 둔다.
    const pendingAttachments = target?.messages?.[0]?.attachments;
    if (Array.isArray(pendingAttachments) && pendingAttachments.length) {
        const userMessage = messages.find((m) => m?.role === "user");
        if (userMessage && !userMessage.attachments) userMessage.attachments = pendingAttachments;
    }
    rescuePoppedAttachments(consumedPending, messages);
    const checkpoint = {
        at: target?.at || new Date().toISOString(),
        status: "in_progress",
        checkpointAt: new Date().toISOString(),
        messages,
    };

    if (target && mergeable.has(target.status)) turns[targetIndex] = checkpoint;
    else turns.push(checkpoint);
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}

export function markChatTurnInterrupted(chatId) {
    if (!chatId) return false;
    const turns = loadChatHistory(chatId);
    let start = turns.length;
    while (start > 0 && RECOVERABLE_TURN_STATUSES.has(turns[start - 1]?.status)) start -= 1;
    if (start === turns.length) return false;
    const interruptedAt = new Date().toISOString();
    for (let i = start; i < turns.length; i += 1) {
        turns[i].status = "interrupted";
        turns[i].interruptedAt = interruptedAt;
    }
    replaceChatHistory(chatId, turns);
    return true;
}

export function hasRecoverableChatTurn(chatId) {
    const turns = loadChatHistory(chatId);
    return RECOVERABLE_TURN_STATUSES.has(turns.at(-1)?.status);
}

export function prepareChatTurnRecovery(chatId) {
    if (!chatId) return false;
    const turns = loadChatHistory(chatId);
    let start = turns.length;
    while (start > 0 && RECOVERABLE_TURN_STATUSES.has(turns[start - 1]?.status)) start -= 1;
    if (start === turns.length) return false;

    const recoverable = turns.slice(start);
    const messages = recoverable.flatMap((turn) => (turn.messages || []).map(cloneStoredMessage));
    const completedToolCalls = new Set(messages.filter((message) => message?.role === "tool").map((message) => message.tool_call_id));
    const repairedMessages = [];
    for (const message of messages) {
        repairedMessages.push(message);
        if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
        for (const toolCall of message.tool_calls) {
            if (!toolCall?.id || completedToolCalls.has(toolCall.id)) continue;
            repairedMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: "No durable result was recorded for this tool call. Inspect the current state before retrying it if needed.",
            });
        }
    }

    turns.splice(start, recoverable.length, {
        at: recoverable[0]?.at || new Date().toISOString(),
        status: "interrupted",
        interruptedAt: new Date().toISOString(),
        messages: repairedMessages,
    });
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
    return true;
}

export function lastChatTurnMessages(chatId) {
    const last = loadChatHistory(chatId).at(-1);
    return last?.messages?.map(cloneStoredMessage) || [];
}

export function appendChatTurn(chatId, turnMessages, extra = {}) {
    if (!chatId || !turnMessages?.length) return;

    const turns = loadChatHistory(chatId);
    const stats = sanitizeTurnStats(extra.stats);
    const storedMessages = turnMessages.map(cloneStoredMessage);
    if (extra.attachments?.length) {
        const userMessage = storedMessages.find((message) => message?.role === "user");
        if (userMessage) userMessage.attachments = extra.attachments;
    }

    const poppedPending = consumeQueuedUserTurns(turns, turnMessages);
    rescuePoppedAttachments(poppedPending, storedMessages);

    const last = turns[turns.length - 1];
    // 복구 턴은 기존 체크포인트와 새 실행분을 하나의 완료 턴으로 확정한다.
    // interrupted 턴은 복구 실행(baseMessages 있음)에서만 확정 대상이다. 새 턴이
    // 미완료 이전 턴을 덮어쓰며 사용자 메시지를 지우는 것을 막는다.
    if (last && (last.status === "in_progress" || (last.status === "interrupted" && Array.isArray(extra.baseMessages)))) {
        const completedMessages = Array.isArray(extra.baseMessages)
            ? [...extra.baseMessages.map(cloneStoredMessage), ...storedMessages]
            : storedMessages;
        turns[turns.length - 1] = {
            at: last.at || new Date().toISOString(),
            messages: completedMessages,
            ...(stats ? { stats } : {}),
            ...(extra.deliveredAttachments?.length ? { attachments: extra.deliveredAttachments } : {}),
        };
    } else {
        turns.push({
            at: new Date().toISOString(),
            messages: storedMessages,
            ...(stats ? { stats } : {}),
            ...(extra.deliveredAttachments?.length ? { attachments: extra.deliveredAttachments } : {}),
        });
    }

    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}
