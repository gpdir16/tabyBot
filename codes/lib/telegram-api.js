function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_MAX_TOTAL_WAIT_MS = 120_000;

const RICH_MAX_CHARS = 32_768;

const TEXT_MAX_CHARS = 4096;

function telegramErrorMessage(err) {
    return err?.description || err?.message || String(err);
}

function isRateLimit(err) {
    return err?.error_code === 429;
}

function getRetryAfterMs(err, capMs = DEFAULT_MAX_WAIT_MS) {
    const sec = err?.parameters?.retry_after;
    if (typeof sec === "number" && sec > 0) return Math.min(sec * 1000, capMs);
    const m = String(err?.description || err?.message || "").match(/retry after (\d+)/i);
    if (m) return Math.min(Number(m[1]) * 1000, capMs);
    return Math.min(1000, capMs);
}

export async function callTelegramApi(
    fn,
    { maxAttempts = DEFAULT_MAX_ATTEMPTS, maxWaitMs = DEFAULT_MAX_WAIT_MS, maxTotalWaitMs = DEFAULT_MAX_TOTAL_WAIT_MS } = {},
) {
    let totalWaited = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            return await fn();
        } catch (err) {
            if (!isRateLimit(err) || attempt >= maxAttempts - 1) throw err;
            const wait = getRetryAfterMs(err, maxWaitMs);
            if (totalWaited + wait > maxTotalWaitMs) throw err;
            totalWaited += wait;
            await sleep(wait);
        }
    }
}

export async function safeTelegramApi(fn, opts = {}) {
    try {
        return { ok: true, result: await callTelegramApi(fn, opts) };
    } catch (err) {
        const error = telegramErrorMessage(err);
        console.warn("Telegram API:", error);
        return { ok: false, error, raw: err };
    }
}

export function safeTelegramApiFast(fn) {
    return safeTelegramApi(fn, { maxAttempts: 2, maxWaitMs: 3_000, maxTotalWaitMs: 5_000 });
}

export function splitTextChunks(text, maxLen = TEXT_MAX_CHARS) {
    const body = String(text ?? "");
    if (!body) return ["…"];
    const parts = [];
    for (let i = 0; i < body.length; i += maxLen) {
        parts.push(body.slice(i, i + maxLen));
    }
    return parts.length ? parts : ["…"];
}

export function splitRichChunks(text, maxLen = RICH_MAX_CHARS) {
    const body = String(text ?? "").trim();
    if (!body) return ["…"];
    if (body.length <= maxLen) return [body];

    const parts = [];
    let remaining = body;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf("\n\n", maxLen);
        if (cut < maxLen * 0.5) cut = remaining.lastIndexOf("\n", maxLen);
        if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(" ", maxLen);
        if (cut < maxLen * 0.5) cut = maxLen;
        parts.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).replace(/^\s+/, "");
    }
    if (remaining) parts.push(remaining);
    return parts.length ? parts : ["…"];
}

export async function deleteMessageSafe(bot, chatId, messageId) {
    const api = bot?.api || bot;
    if (!api || !chatId || !messageId) return false;
    const res = await safeTelegramApiFast(() => api.deleteMessage(chatId, messageId));
    return res.ok;
}

function isThreadSendError(error) {
    const s = String(error || "").toLowerCase();
    return s.includes("not a forum") || s.includes("thread not found") || s.includes("message thread not found");
}

function withoutThreadId(opts) {
    const extra = { ...opts };
    delete extra.message_thread_id;
    return extra;
}

async function dropThreadModeAfterSendError(error) {
    if (!isThreadSendError(error)) return;
    const { markTopicsDisabled } = await import("./telegram-topics.js");
    markTopicsDisabled();
}

export async function sendChatActionSafe(bot, chatId, action = "typing", extra = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId) return false;
    let res = await safeTelegramApiFast(() => api.sendChatAction(chatId, action, extra));
    if (!res.ok && extra?.message_thread_id) {
        await dropThreadModeAfterSendError(res.error);
        res = await safeTelegramApiFast(() => api.sendChatAction(chatId, action, withoutThreadId(extra)));
    }
    return res.ok;
}

export async function editMessageTextSafe(bot, chatId, messageId, text, { parseMode, richText } = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId || !messageId) return false;

    const body = String(text ?? "").trim() || "…";

    // editMessageText: string = text mode; { markdown } = rich_message mode.
    if (richText) {
        const res = await safeTelegramApi(() => api.editMessageText(chatId, messageId, { markdown: String(richText) }));
        if (res.ok) return true;
    }

    const opts = parseMode ? { parse_mode: parseMode, link_preview_options: { is_disabled: false } } : {};
    let res = await safeTelegramApi(() => api.editMessageText(chatId, messageId, body, opts));

    if (!res.ok && parseMode) {
        res = await safeTelegramApi(() => api.editMessageText(chatId, messageId, body.replace(/<[^>]+>/g, "")));
    }

    return res.ok;
}

export async function sendRichMessageSafe(bot, chatId, markdown, opts = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId) return { ok: false, messageIds: [] };

    // sendRichMessage does NOT accept link_preview_options — strip it.
    const extra = { ...opts };
    delete extra.parse_mode;
    delete extra.parseMode;
    delete extra.link_preview_options;

    const messageIds = [];
    let allOk = true;

    for (const chunk of splitRichChunks(markdown)) {
        if (!chunk.trim()) continue;

        let sendExtra = extra;
        let res = await safeTelegramApi(() => api.sendRichMessage(chatId, { markdown: chunk }, sendExtra));
        if (!res.ok && sendExtra.message_thread_id && isThreadSendError(res.error)) {
            await dropThreadModeAfterSendError(res.error);
            sendExtra = withoutThreadId(sendExtra);
            res = await safeTelegramApi(() => api.sendRichMessage(chatId, { markdown: chunk }, sendExtra));
        }

        if (res.ok) {
            if (res.result?.message_id) messageIds.push(res.result.message_id);
        } else {
            console.warn("sendRichMessage failed, falling back to sendMessage:", res.error);
            // Fallback to plain sendMessage (no parse mode) if rich messages fail.
            const plainRes = await safeTelegramApi(() => api.sendMessage(chatId, chunk, sendExtra));
            if (plainRes.ok) {
                if (plainRes.result?.message_id) messageIds.push(plainRes.result.message_id);
            } else {
                allOk = false;
            }
        }
    }

    return { ok: allOk, messageIds };
}

export async function sendMessageSafe(bot, chatId, text, opts = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId) return { ok: false, messageIds: [] };

    const parseMode = opts.parse_mode || opts.parseMode;
    let extra = { ...opts };
    delete extra.parse_mode;
    delete extra.parseMode;
    if (!extra.link_preview_options) {
        extra.link_preview_options = { is_disabled: false, prefer_large_media: true };
    }

    const messageIds = [];
    let allOk = true;

    for (const chunk of splitTextChunks(text)) {
        if (!chunk.trim()) continue;

        let res;
        if (parseMode) {
            res = await safeTelegramApi(() => api.sendMessage(chatId, chunk, { ...extra, parse_mode: parseMode }));
            if (!res.ok) {
                res = await safeTelegramApi(() => api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""), extra));
            }
        } else {
            res = await safeTelegramApi(() => api.sendMessage(chatId, chunk, extra));
        }

        if (!res.ok && extra.message_thread_id && isThreadSendError(res.error)) {
            await dropThreadModeAfterSendError(res.error);
            extra = withoutThreadId(extra);
            res = await safeTelegramApi(() => api.sendMessage(chatId, chunk, extra));
        }

        if (res.ok) {
            if (res.result?.message_id) messageIds.push(res.result.message_id);
        } else {
            allOk = false;
        }
    }

    return { ok: allOk, messageIds };
}

export async function createForumTopicSafe(bot, chatId, name, extra = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId || !name) return { ok: false, error: "missing chat or name" };
    return safeTelegramApi(() => api.createForumTopic(chatId, name, extra));
}

export async function deleteForumTopicSafe(bot, chatId, threadId) {
    const api = bot?.api || bot;
    if (!api || !chatId || !threadId) return { ok: false, error: "missing chat or thread" };
    return safeTelegramApi(() => api.deleteForumTopic(chatId, threadId));
}

export async function editForumTopicSafe(bot, chatId, threadId, extra = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId || !threadId) return { ok: false, error: "missing chat or thread" };
    return safeTelegramApi(() => api.editForumTopic(chatId, threadId, extra));
}

export async function sendPhotoSafe(bot, chatId, input, opts = {}) {
    const api = bot?.api || bot;
    if (!api || !chatId) return { ok: false, kind: null };

    let sendOpts = opts;
    let res = await safeTelegramApi(() => api.sendPhoto(chatId, input, sendOpts));
    if (!res.ok && sendOpts?.message_thread_id && isThreadSendError(res.error)) {
        await dropThreadModeAfterSendError(res.error);
        sendOpts = withoutThreadId(sendOpts);
        res = await safeTelegramApi(() => api.sendPhoto(chatId, input, sendOpts));
    }
    if (res.ok) return { ok: true, kind: "photo", result: res.result };

    const desc = String(res.error || "");
    if (desc.includes("PHOTO_INVALID")) {
        res = await safeTelegramApi(() => api.sendDocument(chatId, input, sendOpts));
        if (res.ok) return { ok: true, kind: "document", fallback: true, result: res.result };
    }

    return { ok: false, kind: null, error: res.error };
}
