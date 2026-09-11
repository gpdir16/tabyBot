import { emit } from "../web/bus.js";
import { loadUserConfig } from "../config-loader.js";

function formatUpdateNotice(update, lang) {
    if (lang === "ko") return `🆕 새 버전이 출시되었습니다: ${update.tagName} — ${update.releaseUrl}`;
    if (lang === "ja") return `🆕 新しいバージョンがリリースされました: ${update.tagName} — ${update.releaseUrl}`;
    return `🆕 A new version is available: ${update.tagName} — ${update.releaseUrl}`;
}

export function sendUpdateNotification(update) {
    const lang = loadUserConfig().language || "en";
    emit({ type: "notice", level: "info", text: formatUpdateNotice(update, lang) });
    return true;
}
