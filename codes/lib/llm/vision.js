import fs from "node:fs";
import path from "node:path";
import { sanitizeTextForLlm } from "./sanitize-messages.js";

const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

export function isVisionImageMime(mimeType) {
    return IMAGE_MIMES.has(
        String(mimeType || "")
            .toLowerCase()
            .split(";")[0]
            .trim(),
    );
}

const EXT_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export function visionImagePart(imagePath, mime) {
    try {
        if (!imagePath || !fs.existsSync(imagePath)) return null;
        const stat = fs.statSync(imagePath);
        if (!stat.isFile() || !stat.size) return null;
        const useMime =
            String(mime || "image/png")
                .toLowerCase()
                .split(";")[0]
                .trim() || "image/png";
        const buf = fs.readFileSync(imagePath);
        return {
            type: "image_url",
            image_url: { url: `data:${useMime};base64,${buf.toString("base64")}`, detail: "high" },
        };
    } catch {
        return null;
    }
}

function buildVisionParts(text, imageItems, { visionEnabled = false } = {}) {
    const safeText = sanitizeTextForLlm(String(text || ""));
    if (!visionEnabled) return safeText;
    const parts = [];
    if (safeText) parts.push({ type: "text", text: safeText });
    for (const item of imageItems) {
        const part = visionImagePart(item.path, item.mimeType);
        if (part) parts.push(part);
    }
    if (!parts.length) return safeText;
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    if (!parts.some((p) => p.type === "text")) parts.unshift({ type: "text", text: safeText });
    return parts;
}

export function buildToolResultContent(text, imagePath, { visionEnabled = false } = {}) {
    const ext = path.extname(imagePath || "").toLowerCase();
    return buildVisionParts(text, imagePath ? [{ path: imagePath, mimeType: EXT_MIME[ext] || "image/png" }] : [], { visionEnabled });
}

export function estimateContentTokens(content) {
    if (typeof content === "string") {
        return Math.ceil(content.length / 4);
    }
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const part of content) {
        if (part.type === "text") n += Math.ceil((part.text || "").length / 4);
        if (part.type === "image_url") n += 1100;
    }
    return n;
}
