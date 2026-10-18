import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import { USER_DIR } from "../paths.js";
import { fetchCodexModels } from "./codex-client.js";
import { fetchGrokModels } from "./grok-client.js";
import { fetchGithubCopilotModels } from "./github-copilot-client.js";
import { fetchClaudeModels } from "./claude-agent-client.js";

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
    if (provider?.type === "claude-agent-sdk") {
        return fetchClaudeModels();
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
    writeFileAtomic(filePath, `${JSON.stringify({ fetchedAt: Date.now(), models }, null, 2)}\n`);
    return models;
}

// OpenRouter 모델의 업스트림 프로바이더 목록. 고정(pin) 선택지로 쓴다.
export async function fetchOpenRouterProviders(provider, model) {
    const modelId = String(model || "").trim();
    if (!modelId) throw new Error("model required");
    const base = String(provider.baseURL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    // OpenRouter 경로는 author/slug 형태라 슬래시를 남긴 채 각 조각만 인코딩한다.
    const modelPath = modelId
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
    const url = `${base}/models/${modelPath}/endpoints`;
    // 엔드포인트 목록은 공개 API다. 만료된 키를 실어 401이 나는 일을 피하고,
    // 키가 필요한 커스텀 프록시일 때만 한 번 더 인증 헤더를 붙여 재시도한다.
    const baseHeaders = { Accept: "application/json", ...(provider.extraHeaders || {}) };
    let res = await fetch(url, { headers: baseHeaders });
    if ((res.status === 401 || res.status === 403) && provider.apiKey?.trim()) {
        res = await fetch(url, { headers: { ...baseHeaders, ...buildHeaders(provider) } });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error?.message || res.statusText || "Failed to fetch providers");
    const list = payload?.data?.endpoints || payload?.endpoints;
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const endpoint of list) {
        const tag = String(endpoint?.tag || endpoint?.provider_name || "").trim();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push({ tag, name: String(endpoint?.provider_name || endpoint?.name || tag) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return out;
}

export function findModelContextWindow(models, modelId) {
    const found = models?.find((m) => m.id === modelId);
    return found?.contextWindow || null;
}

function guessVisionFromModelId(modelId) {
    const id = String(modelId || "").toLowerCase();
    if (!id || /embed|whisper|dall-e|dalle|tts|sora|moderat|rerank/i.test(id)) return false;
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku|gemini|pixtral|llava|qwen.*vl|\/vl|vision|kimi|moonshot|internvl|glm-4v|grok-4/i.test(
        id,
    );
}

export function findModelVisionSupport(models, modelId) {
    const found = models?.find((m) => m.id === modelId);
    if (found && typeof found.supportsVision === "boolean") return found.supportsVision;
    return guessVisionFromModelId(modelId);
}
