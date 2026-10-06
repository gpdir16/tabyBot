import { emit } from "../web/bus.js";
import { loadUserConfig } from "../config-loader.js";

function formatUpdateNotice(update, lang) {
    if (lang === "ko") return `새 버전 ${update.tagName}이 출시되었습니다. ${update.releaseUrl}`;
    if (lang === "ja") return `新しいバージョン ${update.tagName} がリリースされました。${update.releaseUrl}`;
    return `Version ${update.tagName} is available. ${update.releaseUrl}`;
}

export function sendUpdateNotification(update) {
    const lang = loadUserConfig().language || "en";
    emit({ type: "notice", level: "info", text: formatUpdateNotice(update, lang) });
    return true;
}
