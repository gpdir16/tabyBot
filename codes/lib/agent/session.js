export const STOP_BY_USER_HINT = "The user sent /stop. Stop immediately. Do not call more tools. Reply briefly with progress and what remains.";

const sessions = new Map();

export class AgentSession {
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

    addPendingMessage(text) {
        const trimmed = String(text || "").trim();
        if (!trimmed) return;
        this.pendingUserMessages.push(trimmed);
    }

    drainPendingMessages() {
        return this.pendingUserMessages.splice(0);
    }

    isAborted() {
        return this.signal.aborted;
    }
}

export function beginAgentSession(chatId) {
    const key = String(chatId);
    const existing = sessions.get(key);
    if (existing?.running) return existing;
    const session = new AgentSession(key);
    sessions.set(key, session);
    return session;
}

export function endAgentSession(chatId) {
    sessions.delete(String(chatId));
}

export function getActiveAgentSession(chatId) {
    const session = sessions.get(String(chatId));
    return session?.running ? session : null;
}

export function isAgentSessionRunning(chatId) {
    return Boolean(getActiveAgentSession(chatId));
}

export function requestAgentStop(chatId) {
    const session = getActiveAgentSession(chatId);
    if (!session) return false;
    session.requestStop();
    return true;
}

export function enqueueAgentMessage(chatId, text) {
    const session = getActiveAgentSession(chatId);
    if (!session) return false;
    session.addPendingMessage(text);
    return true;
}
