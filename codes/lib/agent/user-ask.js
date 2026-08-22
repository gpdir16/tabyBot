import { InlineKeyboard } from "grammy";
import { loadUserConfig } from "../config-loader.js";
import { sendMessageSafe, editMessageTextSafe } from "../telegram-api.js";
import { t } from "../i18n.js";
import { telegramThreadOpts } from "../agent-route.js";

// chatId -> { key, id, bot, lang, question, options, messageId, resolve, timer, settled }
const pendingAsks = new Map();

function trimLabel(label, max = 60) {
    const s = String(label);
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function hintFor(lang, hasOptions) {
    return hasOptions ? t("user_ask_hint_button", lang) : t("user_ask_hint_text", lang);
}

export function hasPendingAsk(sessionKey) {
    return pendingAsks.has(String(sessionKey));
}

// 테스트 및 핸들러에서 사용하는 대기 중 ask의 id 조회
export function pendingAskIdFor(sessionKey) {
    return pendingAsks.get(String(sessionKey))?.id ?? null;
}

function settle(entry, result) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    pendingAsks.delete(entry.key);
    entry.resolve(result);
}

async function finishAskMessage(entry, text) {
    try {
        await editMessageTextSafe(entry.bot, entry.chatId || entry.key, entry.messageId, trimLabel(text, 3500));
    } catch {
        // 편집 실패는 무시 (메시지 삭제, 봇 재시작 등)
    }
}

export function resolvePendingAskByButton(sessionKey, askId, optionIndex) {
    const entry = pendingAsks.get(String(sessionKey));
    if (!entry || entry.id !== askId) return null;
    const option = entry.options[optionIndex];
    if (option === undefined) return null;
    settle(entry, { answer: option, option: optionIndex, custom: false });
    void finishAskMessage(entry, `✅ ${option}`);
    return option;
}

export function resolvePendingAskByText(sessionKey, text) {
    const entry = pendingAsks.get(String(sessionKey));
    if (!entry) return false;
    const answer = String(text || "")
        .trim()
        .slice(0, 1000);
    if (!answer) return false;
    settle(entry, { answer, option: null, custom: true });
    void finishAskMessage(entry, `✍️ ${answer}`);
    return true;
}

export function cancelPendingAsk(sessionKey, reason = "aborted") {
    const entry = pendingAsks.get(String(sessionKey));
    if (!entry) return false;
    settle(entry, { error: reason });
    void finishAskMessage(entry, `${entry.question}\n\n✖️ ${t("user_ask_cancelled", entry.lang)}`);
    return true;
}

export async function askUser({ bot, chatId, sessionKey, threadId, question, options = [], timeoutMs = 120_000 }) {
    const key = String(sessionKey || chatId);
    if (pendingAsks.has(key)) {
        return { error: "Another user_ask is already pending for this chat." };
    }

    let lang = "en";
    try {
        lang = loadUserConfig().language || "en";
    } catch {
        // 설정을 읽지 못하면 영어 사용
    }

    const id = Math.random().toString(36).slice(2, 8);
    const hasOptions = options.length > 0;
    const body = `${question}\n\n${hintFor(lang, hasOptions)}`;

    const kb = hasOptions ? new InlineKeyboard() : null;
    if (kb) {
        for (let i = 0; i < options.length; i += 1) {
            kb.text(trimLabel(options[i]).replace(/\s+/g, " "), `ask:${id}:${i}`).row();
        }
    }

    const extra = {
        ...telegramThreadOpts(threadId),
        ...(kb ? { reply_markup: kb } : {}),
    };
    const sent = await sendMessageSafe(bot, chatId, trimLabel(body, 4000), extra);
    const messageId = sent.messageIds?.[0];
    if (!messageId) return { error: "Failed to send the question message." };

    return new Promise((resolve) => {
        const entry = {
            key,
            chatId: String(chatId),
            id,
            bot,
            lang,
            question: trimLabel(question, 1500),
            options,
            messageId,
            resolve,
            timer: null,
            settled: false,
        };
        entry.timer = setTimeout(() => {
            settle(entry, { error: "timeout" });
            void finishAskMessage(entry, `${entry.question}\n\n⏱️ ${t("user_ask_timeout", lang)}`);
        }, timeoutMs);
        pendingAsks.set(key, entry);
    });
}
