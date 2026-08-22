import fs from "node:fs";
import path from "node:path";
import { InputFile } from "grammy";
import { formatAllowedPaths, isAllowedFilePath } from "./paths.js";
import { sendMessageSafe, sendPhotoSafe, safeTelegramApi } from "./telegram-api.js";

const MAX_BYTES = 50 * 1024 * 1024;

function isImagePath(filePath, mimeType) {
    if (mimeType?.startsWith("image/")) return true;
    return /\.(png|jpe?g|gif|webp)$/i.test(filePath);
}

export async function sendTelegramFile(bot, chatId, filePath, { caption = "" } = {}) {
    if (!bot?.api) return { error: "Telegram bot is not available in this context" };
    if (!chatId) return { error: "chatId is required" };

    const resolved = path.resolve(String(filePath || "").trim());
    if (!resolved) return { error: "path is required" };
    if (!isAllowedFilePath(resolved, { write: true })) {
        return { error: `path must be under ${formatAllowedPaths({ write: true })}` };
    }
    if (!fs.existsSync(resolved)) return { error: `file not found: ${resolved}` };

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { error: "path is not a file" };
    if (stat.size > MAX_BYTES) return { error: "file too large for Telegram (max 50MB)" };

    const fileName = path.basename(resolved);
    const input = new InputFile(resolved, fileName);
    const cap =
        String(caption || "")
            .trim()
            .slice(0, 1024) || undefined;
    const opts = cap ? { caption: cap } : {};

    if (isImagePath(resolved)) {
        const sent = await sendPhotoSafe(bot, chatId, input, opts);
        if (sent.ok) {
            return {
                ok: true,
                kind: sent.kind,
                fallback: sent.fallback || false,
                path: resolved,
                fileName,
                sizeBytes: stat.size,
            };
        }
    }

    const doc = await safeTelegramApi(() => bot.api.sendDocument(chatId, input, opts));
    if (doc.ok) {
        return { ok: true, kind: "document", path: resolved, fileName, sizeBytes: stat.size };
    }

    const note = cap ? `${fileName}\n${cap}` : fileName;
    await sendMessageSafe(bot, chatId, `📎 ${note} (file send failed — saved at ${resolved})`);
    return {
        ok: false,
        error: doc.error || "file send failed",
        path: resolved,
        fileName,
        sizeBytes: stat.size,
        notified: true,
    };
}
