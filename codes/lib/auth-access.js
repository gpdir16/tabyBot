import { loadUserConfig } from "./config-loader.js";
import { claimOwnerIfNone, hasOwner, isApproved, issuePendingCode, approveCode } from "./auth.js";
import { t } from "./i18n.js";
import { getApproveCliHint } from "./runtime.js";
import { sendMessageSafe } from "./telegram-api.js";

export async function replyAuthPending(ctx, chatId) {
    const lang = loadUserConfig().language || "en";
    const { code, minutes } = issuePendingCode(chatId);
    await sendMessageSafe(ctx.api, String(ctx.chat.id), t("auth_pending", lang, { code, minutes, approveCmd: getApproveCliHint(code) }));
}

export async function notifyOwnerTransfer(bot, { previousOwner, newChatId, approvedByChatId }) {
    const lang = loadUserConfig().language || "en";
    if (previousOwner && previousOwner !== newChatId) {
        await sendMessageSafe(bot, previousOwner, t("auth_disconnected", lang));
    }
    if (newChatId && newChatId !== approvedByChatId) {
        await sendMessageSafe(bot, newChatId, t("auth_granted", lang));
    }
}

export async function runOwnerApprove(bot, ownerChatId, code) {
    const lang = loadUserConfig().language || "en";
    const result = approveCode(code);
    if (!result.ok) {
        return { ok: false, message: t("auth_approve_fail", lang) };
    }
    await notifyOwnerTransfer(bot, {
        previousOwner: result.previousOwner,
        newChatId: result.chatId,
        approvedByChatId: ownerChatId,
    });
    const message = result.chatId === ownerChatId ? t("auth_approve_self", lang) : t("auth_approve_ok", lang, { chatId: result.chatId });
    return { ok: true, message };
}

export async function requireApprovedAccess(ctx, { claimFirst = false } = {}) {
    const chatId = String(ctx.chat.id);

    if (isApproved(chatId)) {
        return true;
    }

    if (claimFirst && !hasOwner()) {
        const claimed = claimOwnerIfNone(chatId);
        if (claimed.ok) return true;
    }

    await replyAuthPending(ctx, chatId);
    return false;
}
