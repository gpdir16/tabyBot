// 첨부는 디스크 파일로 둔다. 사용자 메시지에는 원문과 이미지만 넣고, 경로는 시스템 프롬프트에만 둔다.
import fs from "node:fs";
import path from "node:path";
import { isVisionImageMime, visionImagePart } from "../llm/vision.js";
import { sanitizeTextForLlm } from "../llm/sanitize-messages.js";
import { getFile } from "./files.js";

export function resolveAttachedFile(file) {
    if (!file) return null;
    if (file.id) {
        const found = getFile(file.id);
        if (found) {
            return {
                id: found.id,
                name: file.name || found.name,
                mime: file.mime || found.mime,
                size: file.size ?? found.size,
                filePath: found.uploadPath || found.filePath,
                relPath: found.relPath || file.relPath,
            };
        }
    }
    if (file.filePath && fs.existsSync(file.filePath)) {
        return {
            id: file.id,
            name: file.name || path.basename(file.filePath),
            mime: file.mime || file.mimeType || "application/octet-stream",
            size: file.size,
            filePath: file.filePath,
            relPath: file.relPath,
        };
    }
    if (file.path && fs.existsSync(file.path)) {
        return {
            id: file.id,
            name: file.name || path.basename(file.path),
            mime: file.mime || file.mimeType || "application/octet-stream",
            size: file.size,
            filePath: file.path,
        };
    }
    return null;
}

// ATTACHED_FILES 목록은 매 프롬프트마다 들어간다 — 히스토리가 길어져도
// 무한정 커지지 않게 최신 첨부 위주로 상한을 둔다.
const MAX_HISTORY_FILES = 16;

export function collectFilesFromHistory(history, extra = []) {
    const files = [];
    for (const turn of history || []) {
        for (const message of turn?.messages || []) {
            if (Array.isArray(message?.attachments)) files.push(...message.attachments);
        }
    }
    if (Array.isArray(extra)) files.push(...extra);
    return files.map(resolveAttachedFile).filter(Boolean).slice(-MAX_HISTORY_FILES);
}

export function formatAttachedFilesPrompt(files) {
    const lines = [];
    const seen = new Set();
    for (const file of files || []) {
        const resolved = resolveAttachedFile(file);
        if (!resolved?.filePath || seen.has(resolved.filePath)) continue;
        seen.add(resolved.filePath);
        const kind = isVisionImageMime(resolved.mime) ? "image, also sent as vision" : resolved.mime || "file";
        lines.push(`- \`${resolved.name}\` (${kind})\n  \`${resolved.filePath}\``);
    }
    return lines.length ? lines.join("\n") : "- (none)";
}

function typedUserText(text) {
    let s = String(text || "");
    const marks = ["[User attached files]", "\n\n[첨부 이미지:", "\n\n[첨부 파일:", "\n\n[Image too large:"];
    let cut = -1;
    for (const mark of marks) {
        const i = s.indexOf(mark);
        if (i !== -1 && (cut === -1 || i < cut)) cut = i;
    }
    if (cut !== -1) s = s.slice(0, cut);
    return s.trim();
}

export function hydrateUserContent(text, files, { visionEnabled = false } = {}) {
    const body = sanitizeTextForLlm(typedUserText(text));
    if (!visionEnabled) return body;

    const parts = [];
    if (body) parts.push({ type: "text", text: body });
    for (const file of files || []) {
        const resolved = resolveAttachedFile(file);
        if (!resolved || !isVisionImageMime(resolved.mime)) continue;
        const part = visionImagePart(resolved.filePath, resolved.mime);
        if (part) parts.push(part);
    }
    if (!parts.length) return body;
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    if (!parts.some((p) => p.type === "text")) parts.unshift({ type: "text", text: body });
    return parts;
}
