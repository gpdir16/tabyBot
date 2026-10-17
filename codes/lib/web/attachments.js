// 첨부는 디스크 파일로 둔다. 사용자 메시지에는 원문과 이미지만 넣는다. 파일 이름과 경로는 API로 보낼 때
// 그 메시지 앞에 별도 블록으로 붙는다(sanitize-messages.js의 userMessageHeader).
import fs from "node:fs";
import path from "node:path";
import { isVisionImageMime, visionImagePart } from "../llm/vision.js";
import { sanitizeTextForLlm } from "../llm/sanitize-messages.js";
import { ATTACHED_FILES_MARK } from "../agent/history/messages.js";
import { getFile } from "./files.js";

function resolveAttachedFile(file) {
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

function typedUserText(text) {
    let s = String(text || "");
    const marks = [ATTACHED_FILES_MARK, "\n\n[첨부 이미지:", "\n\n[첨부 파일:", "\n\n[Image too large:"];
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
