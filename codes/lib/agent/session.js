export const STOP_BY_USER_HINT = "The user pressed Stop. Stop immediately. Do not call more tools. Reply briefly with progress and what remains.";

export const EMPTY_REPLY_HINT =
    "Your previous assistant reply was empty. Reply to the user in plain text now. Summarize what you accomplished and answer their request.";

export const QUIET_EMPTY_HINT = "If the user does not need a message, reply with ONLY __SILENT__. Do not narrate an empty check.";

const sessions = new Map();

class AgentSession {
    constructor(chatId) {
        this.chatId = String(chatId);
        this.abortController = new AbortController();
        this.pendingUserMessages = [];
        this.running = true;
    }

    get signal() {
        return this.abortController.signal;
    }

    requestStop() {
        this.abortController.abort();
    }

    // message: { id, text, attachments, at }. 첨부만 있는 메시지도 받는다.
    addPendingMessage(message) {
        const text = String(message?.text || "").trim();
        const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
        if (!text && !attachments.length) return false;
        this.pendingUserMessages.push({ ...message, text, attachments });
        return true;
    }

    drainPendingMessages() {
        return this.pendingUserMessages.splice(0);
    }

    pendingMessageIds() {
        return this.pendingUserMessages.map((message) => message.id).filter(Boolean);
    }

    // 이미 다른 경로로 대화에 들어간 메시지는 대기열에서 뺀다.
    dropPendingMessages(ids) {
        this.pendingUserMessages = this.pendingUserMessages.filter((message) => !ids.has(message.id));
    }

    isAborted() {
        return this.signal.aborted;
    }
}

export function beginAgentSession(chatId, { automated = null } = {}) {
    const key = String(chatId);
    const existing = sessions.get(key);
    if (existing?.running) {
        if (automated != null) existing.automated = automated;
        return existing;
    }
    const session = new AgentSession(key);
    session.automated = automated === true;
    sessions.set(key, session);
    return session;
}

export function endAgentSession(chatId) {
    sessions.delete(String(chatId));
}

function getActiveAgentSession(chatId) {
    const session = sessions.get(String(chatId));
    return session?.running ? session : null;
}

export function isAgentSessionRunning(chatId) {
    return Boolean(getActiveAgentSession(chatId));
}

// 실행 중인 턴이 자동 실행(예약·능동 체크인)인가.
export function isAgentSessionAutomated(chatId) {
    return Boolean(getActiveAgentSession(chatId)?.automated);
}

export function requestAgentStop(chatId) {
    const session = getActiveAgentSession(chatId);
    if (!session) return false;
    session.requestStop();
    return true;
}

export function enqueueAgentMessage(chatId, message) {
    const session = getActiveAgentSession(chatId);
    if (!session) return false;
    if (session.automated) return false;
    return session.addPendingMessage(message);
}
