import fs from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "./paths.js";

function safeFileName(name) {
    const base = path.basename(String(name || "file").replace(/[^\w.\-()+가-힣 ]/g, "_"));
    return base.slice(0, 180) || "file";
}

function uniquePath(dir, fileName) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext) || "file";
    let candidate = path.join(dir, fileName);
    let n = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}_${n}${ext}`);
        n += 1;
    }
    return candidate;
}

async function downloadTelegramFile(api, fileId, destPath) {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram file_path missing");
    const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return { sizeBytes: buf.length, telegramPath: file.file_path };
}

export async function saveIncomingTelegramFile(ctx) {
    const msg = ctx.message;
    const chatId = String(ctx.chat.id);
    const messageId = msg.message_id;
    const subDir = path.join(DOWNLOAD_DIR, chatId);
    fs.mkdirSync(subDir, { recursive: true });

    let fileId;
    let fileName;
    let mimeType = "application/octet-stream";
    let kind = "document";

    if (msg.document) {
        kind = "document";
        fileId = msg.document.file_id;
        fileName = safeFileName(msg.document.file_name || `document_${messageId}`);
        mimeType = msg.document.mime_type || mimeType;
    } else if (msg.photo?.length) {
        kind = "photo";
        const largest = msg.photo[msg.photo.length - 1];
        fileId = largest.file_id;
        fileName = safeFileName(`photo_${messageId}.jpg`);
        mimeType = "image/jpeg";
    } else if (msg.video) {
        kind = "video";
        fileId = msg.video.file_id;
        fileName = safeFileName(msg.video.file_name || `video_${messageId}.mp4`);
        mimeType = msg.video.mime_type || "video/mp4";
    } else if (msg.audio) {
        kind = "audio";
        fileId = msg.audio.file_id;
        fileName = safeFileName(msg.audio.file_name || `audio_${messageId}.mp3`);
        mimeType = msg.audio.mime_type || "audio/mpeg";
    } else if (msg.voice) {
        kind = "voice";
        fileId = msg.voice.file_id;
        fileName = safeFileName(`voice_${messageId}.ogg`);
        mimeType = msg.voice.mime_type || "audio/ogg";
    } else {
        throw new Error("Unsupported attachment type");
    }

    const destPath = uniquePath(subDir, fileName);
    const { sizeBytes } = await downloadTelegramFile(ctx.api, fileId, destPath);

    return {
        path: destPath,
        fileName: path.basename(destPath),
        mimeType,
        sizeBytes,
        kind,
        caption: msg.caption?.trim() || "",
    };
}

export function formatFileUserMessage(saved, { visionAttached = false } = {}) {
    const lines = [
        "[User sent a file]",
        `Path: ${saved.path}`,
        `Name: ${saved.fileName}`,
        `Type: ${saved.mimeType} (${saved.kind})`,
        `Size: ${saved.sizeBytes} bytes`,
    ];
    if (saved.caption) lines.push(`Caption: ${saved.caption}`);
    if (visionAttached) {
        lines.push("", "The image is attached for vision in this turn — describe or answer from what you see.");
    } else {
        lines.push("", `The file is stored under ${DOWNLOAD_DIR}. Use terminal_run to inspect if needed.`);
    }
    return lines.join("\n");
}
