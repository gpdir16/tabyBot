// 진행 중인 턴의 저장: 대기 메시지, 체크포인트, 중단 복구, 완료 기록.
import { RECOVERABLE_TURN_STATUSES, cloneStoredMessage, isStandalonePendingTurn, sanitizeTurnStats, userMessageIdsOf } from "./messages.js";
import { loadChatHistory, replaceChatHistory } from "./sessions.js";
import { writePreview } from "./preview.js";

// 사용자 메시지를 대기 턴으로 적는다. 실행이 시작되면 그 실행의 턴이 이 자리를 넘겨받는다.
// 같은 id가 이미 기록에 있으면(재전송) 다시 적지 않고 false를 돌려준다.
export function appendPendingUserTurn(chatId, { id, text, attachments = [], at = null } = {}) {
    const content = String(text || "").trim();
    if (!chatId || (!content && !attachments.length)) return false;

    const turns = loadChatHistory(chatId);
    if (id && turns.some((turn) => userMessageIdsOf(turn?.messages).includes(id))) return false;

    const now = at || new Date().toISOString();
    turns.push({
        at: now,
        status: "pending",
        messages: [{ role: "user", ...(id ? { id } : {}), content, at: now, ...(attachments.length ? { attachments } : {}) }],
    });
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
    return true;
}

// 끝에 줄지어 있는 대기 턴(아직 어느 실행에도 합쳐지지 않은 메시지)의 시작 위치.
function trailingPendingStart(turns) {
    let start = turns.length;
    while (start > 0 && isStandalonePendingTurn(turns[start - 1])) start -= 1;
    return start;
}

// 실행 턴의 기록(record)을 제자리에 놓는다.
// - 이 실행이 이미 가져간 메시지의 대기 턴은 걷어 낸다(같은 말이 두 번 남지 않게).
// - 같은 실행의 이전 체크포인트가 있으면 그 자리를 덮는다.
// - 없으면 실행을 시작시킨 메시지의 대기 턴이 있던 자리에 놓는다.
// - 그것도 없으면(자동 실행 등) 아직 처리되지 않은 대기 메시지들 앞에 놓는다.
function placeRunTurn(turns, record, { turnId, recovery }) {
    const owned = new Set(userMessageIdsOf(record.messages));
    let originIndex = -1;
    let originAt = null;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (!isStandalonePendingTurn(turns[i])) continue;
        const id = turns[i].messages[0].id;
        if (!id || !owned.has(id)) continue;
        originIndex = i;
        originAt = turns[i].at || null;
        turns.splice(i, 1);
    }

    let index = turnId ? turns.findIndex((turn) => turn?.id === turnId) : -1;
    // 복구 실행은 끊긴 턴을 이어 쓴다. 그 뒤에 새로 온 대기 메시지는 건너뛰고 찾는다.
    if (index < 0 && recovery) {
        const candidate = trailingPendingStart(turns) - 1;
        if (candidate >= 0 && turns[candidate]?.status === "interrupted") index = candidate;
    }

    if (index >= 0) {
        record.at = turns[index].at || record.at;
        turns[index] = record;
        return;
    }
    if (originAt) record.at = originAt;
    turns.splice(originIndex >= 0 ? originIndex : trailingPendingStart(turns), 0, record);
}

export function checkpointChatTurn(chatId, turnMessages, { turnId = null, baseMessages = null } = {}) {
    if (!chatId || !turnMessages?.length) return;

    const turns = loadChatHistory(chatId);
    const recovery = Array.isArray(baseMessages);
    const messages = recovery
        ? [...baseMessages.map(cloneStoredMessage), ...turnMessages.map(cloneStoredMessage)]
        : turnMessages.map(cloneStoredMessage);
    const now = new Date().toISOString();
    placeRunTurn(turns, { ...(turnId ? { id: turnId } : {}), at: now, status: "in_progress", checkpointAt: now, messages }, { turnId, recovery });
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

// 사용자가 멈춘 대화에 남은 대기 메시지를 일반 기록으로 확정한다.
// 대기 상태로 두면 다음 서버 시작 때 끊긴 턴으로 보고 다시 실행한다.
export function settlePendingUserTurns(chatId) {
    if (!chatId) return false;
    const turns = loadChatHistory(chatId);
    let changed = false;
    for (const turn of turns) {
        if (!isStandalonePendingTurn(turn)) continue;
        delete turn.status;
        changed = true;
    }
    if (changed) replaceChatHistory(chatId, turns);
    return changed;
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

// 실행이 끝난 턴을 확정한다. 체크포인트가 있었으면 그 자리를 덮고, 복구 실행이면
// 끊긴 턴(baseMessages)과 새 실행분을 하나의 완료 턴으로 합친다.
export function appendChatTurn(chatId, turnMessages, extra = {}) {
    if (!chatId || !turnMessages?.length) return;

    const turns = loadChatHistory(chatId);
    const stats = sanitizeTurnStats(extra.stats);
    const recovery = Array.isArray(extra.baseMessages);
    const storedMessages = turnMessages.map(cloneStoredMessage);
    const messages = recovery ? [...extra.baseMessages.map(cloneStoredMessage), ...storedMessages] : storedMessages;
    placeRunTurn(
        turns,
        {
            ...(extra.turnId ? { id: extra.turnId } : {}),
            at: new Date().toISOString(),
            messages,
            ...(stats ? { stats } : {}),
            ...(extra.deliveredAttachments?.length ? { attachments: extra.deliveredAttachments } : {}),
        },
        { turnId: extra.turnId || null, recovery },
    );

    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}
