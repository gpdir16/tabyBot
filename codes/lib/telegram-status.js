import { statusText } from "./i18n.js";
import { deleteMessageSafe, editMessageTextSafe, sendMessageSafe } from "./telegram-api.js";

const REFRESH_MS = 1000;

function formatToolDisplayName(toolName) {
    if (!toolName) return "";
    if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
    }
    return toolName;
}

function formatElapsedSeconds(totalSeconds, lang = "en") {
    const s = Math.max(0, Math.floor(totalSeconds));

    if (s < 60) {
        if (lang === "ko") return `${s}초`;
        if (lang === "ja") return `${s}秒`;
        return `${s}s`;
    }

    const minutes = Math.floor(s / 60);
    const seconds = s % 60;

    if (s < 3600) {
        if (lang === "ko") {
            return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
        }
        if (lang === "ja") {
            return seconds ? `${minutes}分 ${seconds}秒` : `${minutes}分`;
        }
        return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }

    const hours = Math.floor(s / 3600);
    const remMinutes = Math.floor((s % 3600) / 60);
    const remSeconds = s % 60;

    if (lang === "ko") {
        const parts = [`${hours}시간`];
        if (remMinutes) parts.push(`${remMinutes}분`);
        if (remSeconds) parts.push(`${remSeconds}초`);
        return parts.join(" ");
    }
    if (lang === "ja") {
        const parts = [`${hours}時間`];
        if (remMinutes) parts.push(`${remMinutes}分`);
        if (remSeconds) parts.push(`${remSeconds}秒`);
        return parts.join(" ");
    }

    const parts = [`${hours}h`];
    if (remMinutes) parts.push(`${remMinutes}m`);
    if (remSeconds) parts.push(`${remSeconds}s`);
    return parts.join(" ");
}

export class TelegramStatusMessage {
    constructor(bot, chatId, lang = "en", extra = {}) {
        this.bot = bot;
        this.chatId = chatId;
        this.lang = lang;
        this.extra = extra;
        this.phase = "generating";
        this.detail = null;
        this.startedAt = Date.now();
        this.messageId = null;
        this.timer = null;
        this.finished = false;
        this.available = false;
    }

    bodyText() {
        const label = statusText(this.phase, this.lang);
        const elapsed = formatElapsedSeconds((Date.now() - this.startedAt) / 1000, this.lang);
        const parts = [label];

        if (this.detail) {
            const shown = this.phase === "tools" ? formatToolDisplayName(this.detail) : String(this.detail);
            if (shown) parts.push(shown);
        }

        parts.push(elapsed);
        return parts.join(" · ");
    }

    hasMessage() {
        return Boolean(this.messageId);
    }

    async start() {
        const res = await sendMessageSafe(this.bot, this.chatId, this.bodyText(), this.extra);
        if (!res.ok || !res.messageIds.length) {
            this.available = false;
            return false;
        }

        this.messageId = res.messageIds[0];
        this.available = true;
        this.timer = setInterval(() => {
            void this.refresh();
        }, REFRESH_MS);
        return true;
    }

    setPhase(phase, detail = null) {
        if (this.finished) return;
        this.phase = phase;
        this.detail = detail;
    }

    async refresh() {
        if (this.finished || !this.messageId) return;
        await editMessageTextSafe(this.bot, this.chatId, this.messageId, this.bodyText());
    }

    dispose() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async completeSuccess() {
        if (this.finished) return;
        this.finished = true;
        this.dispose();
        if (!this.messageId) return;
        await deleteMessageSafe(this.bot, this.chatId, this.messageId);
        this.messageId = null;
    }

    async completeError(text) {
        if (this.finished) return false;
        this.finished = true;
        this.dispose();
        this.phase = "error";

        if (!this.messageId) return false;

        const elapsed = formatElapsedSeconds((Date.now() - this.startedAt) / 1000, this.lang);
        const label = statusText("error", this.lang);
        const body = `${label} · ${elapsed}\n\n${text}`;
        const ok = await editMessageTextSafe(this.bot, this.chatId, this.messageId, body);
        return ok;
    }

    async sendStandaloneError(text) {
        const elapsed = formatElapsedSeconds((Date.now() - this.startedAt) / 1000, this.lang);
        const label = statusText("error", this.lang);
        const body = `${label} · ${elapsed}\n\n${text}`;
        const res = await sendMessageSafe(this.bot, this.chatId, body, this.extra);
        return res.ok;
    }
}
