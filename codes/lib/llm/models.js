import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { fetchCodexModels } from "./codex-client.js";
import { fetchGrokModels } from "./grok-client.js";
import { fetchGithubCopilotModels } from "./github-copilot-client.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

function buildHeaders(provider) {
    return {
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.extraHeaders || {}),
    };
}

function shouldSkipModel(id) {
    return /embed|moderat|whisper|dall-e|dalle|tts|sora|transcrib|rerank|guard/i.test(id);
}

function normalizeEntry(raw) {
    const id = raw?.id || raw?.name;
    if (!id || shouldSkipModel(id)) return null;

    const contextWindow = raw.context_window || raw.context_length || raw.max_model_len || raw.top_provider?.context_length || null;

    const modalities = raw.architecture?.input_modalities;
    const modalityStr = raw.architecture?.modality || "";
    let supportsVision = Array.isArray(modalities) && modalities.includes("image") ? true : /image/i.test(modalityStr) ? true : null;

    if (supportsVision === null) {
        supportsVision = guessVisionFromModelId(id);
    }

    const label = (raw.name && raw.name !== id ? raw.name : id).trim();
    return { id, label, contextWindow, supportsVision };
}

function normalizeModelsList(payload) {
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const out = [];
    const seen = new Set();

    for (const raw of list) {
        const entry = normalizeEntry(raw);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }

    out.sort((a, b) => a.label.localeCompare(b.label, "en"));
    return out;
}

function cachePath(provider) {
    const safeBase = Buffer.from(provider.baseURL || "")
        .toString("base64url")
        .slice(0, 32);
    return path.join(USER_DIR, "temp", `models-cache-${provider.id}-${safeBase}.json`);
}

export async function fetchProviderModels(provider, { useCache = true } = {}) {
    if (provider?.type === "codex-oauth") {
        return fetchCodexModels();
    }
    if (provider?.type === "grok-oauth") {
        return fetchGrokModels();
    }
    if (provider?.type === "github-copilot-oauth") {
        return fetchGithubCopilotModels();
    }
    if (!provider?.apiKey?.trim()) {
        throw new Error("API key required to list models");
    }
    if (!provider?.baseURL?.trim()) {
        throw new Error("baseURL required to list models");
    }

    const filePath = cachePath(provider);
    if (useCache && fs.existsSync(filePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
                return cached.models;
            }
        } catch {
            // refetch
        }
    }

    const res = await fetch(`${provider.baseURL}/models`, {
        headers: buildHeaders(provider),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = payload.error?.message || res.statusText || "Failed to fetch models";
        throw new Error(msg);
    }

    const models = normalizeModelsList(payload);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ fetchedAt: Date.now(), models }, null, 2)}\n`, "utf8");
    return models;
}

export function findModelContextWindow(models, modelId) {
    const found = models?.find((m) => m.id === modelId);
    return found?.contextWindow || null;
}

function guessVisionFromModelId(modelId) {
    const id = String(modelId || "").toLowerCase();
    if (!id || /embed|whisper|dall-e|dalle|tts|sora|moderat|rerank/i.test(id)) return false;
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|claude-3|claude-sonnet|claude-opus|claude-haiku|gemini|pixtral|llava|qwen.*vl|\/vl|vision|kimi|moonshot|internvl|glm-4v|grok-4/i.test(
        id,
    );
}

export function findModelVisionSupport(models, modelId) {
    const found = models?.find((m) => m.id === modelId);
    if (found && typeof found.supportsVision === "boolean") return found.supportsVision;
    return guessVisionFromModelId(modelId);
}
