import { loadUserConfig } from "./config-loader.js";
import { sendMessageSafe, sendRichMessageSafe } from "./telegram-api.js";
import { isReplyFooterEnabled } from "./user-settings.js";

function formatNumber(n) {
    return Number(n).toLocaleString("en-US");
}

export function formatStatsFooterPlain(stats) {
    const lang = loadUserConfig().language || "en";
    const used = formatNumber(stats?.tokensUsed ?? 0);
    const window = formatNumber(stats?.contextWindow ?? 128000);
    const tools = formatNumber(stats?.toolCallCount ?? 0);
    const models = formatNumber(stats?.modelCallCount ?? 0);

    if (lang === "ko") {
        return `모델 ${models}회 · 툴 ${tools}회 · ${used}/${window}`;
    }
    if (lang === "ja") {
        return `モデル ${models}回 · ツール ${tools}回 · ${used}/${window}`;
    }
    return `${models} model calls · ${tools} tool calls · ${used}/${window}`;
}

export function buildReplyMarkdown(bodyText, stats) {
    const body = String(bodyText || "").trim() || "…";
    if (!stats || !isReplyFooterEnabled()) return body;

    const footer = formatStatsFooterPlain(stats);
    // Use a blockquote for the stats footer.
    return `${body}\n\n> ${footer}`;
}

export async function sendTelegramReply(bot, chatId, bodyText, stats, extra = {}) {
    const markdown = buildReplyMarkdown(bodyText, stats);

    const res = await sendRichMessageSafe(bot, chatId, markdown, extra);
    if (res.ok) return;

    // Final fallback to plain text if rich messages fail entirely.
    console.warn("sendRichMessage failed, falling back to plain text:", res.error);
    const plain = String(bodyText || "").trim() || "…";
    await sendMessageSafe(bot, chatId, plain, extra);
}
