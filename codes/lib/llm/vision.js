import fs from "node:fs";
import path from "node:path";
import { loadAgentConfig } from "../config-loader.js";
import { sanitizeTextForLlm } from "./sanitize-messages.js";

const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

export function isVisionImageMime(mimeType) {
    return IMAGE_MIMES.has(String(mimeType || "").toLowerCase());
}

export function isVisionImageAttachment(attachment) {
    return Boolean(attachment?.path && isVisionImageMime(attachment.mimeType));
}

const EXT_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function maxImageBytes() {
    return loadAgentConfig().visionMaxImageBytes ?? 5_000_000;
}

function imageContentFromFile(text, imagePath, mime, { visionEnabled = false } = {}) {
    const safeText = sanitizeTextForLlm(String(text || ""));
    if (!visionEnabled || !imagePath) return safeText;
    try {
        if (!fs.existsSync(imagePath)) return `${safeText}\n\n[Image missing: ${imagePath}]`;
        const stat = fs.statSync(imagePath);
        if (stat.size > maxImageBytes()) return `${safeText}\n\n[Image too large: ${stat.size} bytes]`;
        const buf = fs.readFileSync(imagePath);
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        return [
            { type: "text", text: safeText },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ];
    } catch (err) {
        return `${safeText}\n\n[Image load failed: ${err.message}]`;
    }
}

export function buildUserMessageContent(text, { visionEnabled = false, attachment = null } = {}) {
    if (!visionEnabled || !isVisionImageAttachment(attachment)) {
        return sanitizeTextForLlm(String(text || ""));
    }

    return imageContentFromFile(text, attachment.path, attachment.mimeType.toLowerCase(), { visionEnabled });
}

export function buildToolResultContent(text, imagePath, { visionEnabled = false } = {}) {
    const ext = path.extname(imagePath || "").toLowerCase();
    return imageContentFromFile(text, imagePath, EXT_MIME[ext] || "image/png", { visionEnabled });
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
