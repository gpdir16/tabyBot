import { DEFAULT_AGENT_ID, findAgentByThread, getMainThreadId } from "./agents-store.js";
import { getTopicsEnabled } from "./telegram-topics.js";

export function extractThreadId(source) {
    const raw = source?.message_thread_id ?? source?.message?.message_thread_id ?? source?.callbackQuery?.message?.message_thread_id;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 1) return null;
    return n;
}

export function telegramThreadOpts(threadId) {
    if (getTopicsEnabled() !== true) return {};
    const n = Number(threadId);
    if (Number.isFinite(n) && n > 1) return { message_thread_id: n };
    const main = getMainThreadId();
    if (main) return { message_thread_id: main };
    return {};
}

export function routeFromCtx(ctx) {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? "");
    const inbound = extractThreadId(ctx);
    const extra = findAgentByThread(inbound);
    if (extra) {
        return {
            chatId,
            threadId: inbound,
            sessionKey: `${chatId}:t${inbound}`,
            agentId: extra.id,
            agent: extra,
        };
    }
    const main = getTopicsEnabled() === true ? getMainThreadId() : null;
    return {
        chatId,
        threadId: inbound || main,
        sessionKey: chatId,
        agentId: DEFAULT_AGENT_ID,
        agent: null,
    };
}
