import { loadUserConfig } from "../config-loader.js";
import { t } from "../i18n.js";
import { getRunningVersion } from "./store.js";
import { sendMessageSafe } from "../telegram-api.js";

export function formatUpdateMessage(update, lang) {
    const running = getRunningVersion() || update.currentVersion || "—";
    const lines = [
        t("update_notify_title", lang, { version: update.tagName }),
        "",
        t("update_notify_script_label", lang),
        "",
        update.installScript,
        "",
        t("update_notify_current", lang, { version: running }),
    ];
    return lines.join("\n");
}

export async function sendUpdateNotification(bot, chatId, update) {
    const lang = loadUserConfig().language || "en";
    const body = formatUpdateMessage(update, lang);
    const buttonLabel = t("update_notify_button", lang);

    const sent = await sendMessageSafe(bot, chatId, body, {
        reply_markup: {
            inline_keyboard: [[{ text: buttonLabel, url: update.releaseUrl }]],
        },
    });

    if (!sent.ok) {
        const plain = [t("update_notify_title", lang, { version: update.tagName }), update.installScript, update.releaseUrl].join("\n\n");
        await sendMessageSafe(bot, chatId, plain);
    }

    return true;
}
