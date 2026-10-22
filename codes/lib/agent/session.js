export const STOP_BY_USER_HINT = "The user pressed Stop. Stop immediately. Do not call more tools. Reply briefly with progress and what remains.";

export const EMPTY_REPLY_HINT =
    "Your previous assistant reply was empty. Reply to the user in plain text now. Summarize what you accomplished and answer their request.";

export const QUIET_EMPTY_HINT = "If the user does not need a message, reply with ONLY __SILENT__. Do not narrate an empty check.";

// 직전 사용자 메시지에서 이 시간 안에 다음 메시지가 오면 끼워 넣지 않고 실행을 멈춘 뒤 새 턴으로 다시 시작한다.
export const QUICK_FOLLOWUP_MS = 15_000;

const sessions = new Map();

class AgentSession {
    constructor(chatId) {
        this.chatId = String(chatId);
        this.abortController = new AbortController();
        this.pendingUserMessages = [];
        this.running = true;
        // 이 실행이 받은 마지막 사용자 메시지 시각(ms). 바로 이어 보낸 메시지인지 가늠한다.
        this.lastUserMessageAt = null;
        // 멈춘 뒤 대기 메시지로 새 턴을 시작할지.
        this.restartRequested = false;
        // 도구를 실행하는 중인가. 이때 온 메시지는 멈추지 않고 도구가 끝나는 대로 합쳐 넣는다.
        this.toolRunning = false;
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

    hasPendingMessages() {
        return this.pendingUserMessages.length > 0;
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
    // 사용자가 직접 멈췄으면 바로 이어 보낸 메시지로 다시 시작하지 않는다.
    session.restartRequested = false;
    session.requestStop();
    return true;
}

// 대기열에 넣은 메시지가 직전 메시지에서 QUICK_FOLLOWUP_MS 안에 왔으면 실행을 멈추고 다시 시작하게 표시한다.
export function restartOnQuickFollowup(chatId, at) {
    const session = getActiveAgentSession(chatId);
    const ms = Date.parse(at);
    if (!session || session.automated || !Number.isFinite(ms)) return false;
    const last = session.lastUserMessageAt;
    session.lastUserMessageAt = ms;
    if (last == null || ms - last > QUICK_FOLLOWUP_MS || session.toolRunning) return false;
    session.restartRequested = true;
    session.requestStop();
    return true;
}

export function enqueueAgentMessage(chatId, message) {
    const session = getActiveAgentSession(chatId);
    if (!session) return false;
    if (session.automated) return false;
    return session.addPendingMessage(message);
}
