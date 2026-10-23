import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import { USER_DIR } from "../paths.js";
import { fetchCodexModels } from "./codex-client.js";
import { fetchGrokModels } from "./grok-client.js";
import { fetchGithubCopilotModels } from "./github-copilot-client.js";
import { fetchClaudeModels } from "./claude-agent-client.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

// 키가 없으면 인증 헤더를 붙이지 않는다(키 없이 여는 로컬 서버: vLLM, LM Studio 등).
function buildHeaders(provider) {
    const key = String(provider.apiKey || "").trim();
    return {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(provider.extraHeaders || {}),
    };
}

function shouldSkipModel(id) {
    return /embed|moderat|whisper|dall-e|dalle|tts|sora|transcrib|rerank|guard/i.test(id);
}

function normalizeEntry(entry) {
    // 모델 이름만 문자열로 주는 서버도 있다.
    const raw = typeof entry === "string" ? { id: entry } : entry;
    const id = raw?.id || raw?.name || raw?.model;
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
    // OpenAI 형식(data), 배열 그대로, Ollama 등의 models 필드를 모두 받는다.
    const list = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.models)
            ? payload.models
            : [];
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

// 엔드포인트마다 캐시를 따로 둔다. 주소 전체의 해시를 써서 앞부분이 같은 주소끼리 섞이지 않게 한다.
// models.dev로 채우는 목록은 채우기 전에 받아 둔 캐시와 섞이지 않게 키를 달리한다.
function cachePath(provider) {
    const safeBase = crypto
        .createHash("sha256")
        .update(provider.modelsDev?.length ? `${provider.baseURL || ""}|${provider.modelsDev.join(",")}|cost` : provider.baseURL || "")
        .digest("base64url")
        .slice(0, 24);
    return path.join(USER_DIR, "temp", `models-cache-${provider.id}-${safeBase}.json`);
}

// 오류 응답에서 사람이 읽을 메시지를 꺼낸다. 형식이 제각각이고 HTML이 올 때도 있다.
function errorMessageOf(res, payload) {
    const err = payload?.error;
    const msg = (typeof err === "string" ? err : err?.message) || payload?.message || payload?.detail;
    return msg ? `${msg} (HTTP ${res.status})` : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

async function requestModels(baseURL, provider) {
    let res;
    try {
        res = await fetch(`${baseURL}/models`, { headers: buildHeaders(provider), signal: AbortSignal.timeout(15_000) });
    } catch (err) {
        // 연결 자체가 안 됐다("fetch failed"만으로는 이유를 알 수 없다): 원인 코드와 주소를 함께 알린다.
        throw new Error(`Cannot reach ${baseURL}/models (${err?.cause?.code || err?.name || err?.message || "network error"})`);
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(errorMessageOf(res, payload));
    const list = payload?.data ?? payload?.models ?? payload;
    if (!Array.isArray(list)) throw new Error(`Unexpected /models response from ${baseURL}`);
    return normalizeModelsList(payload);
}

// 모델 목록이 id만 주는 곳(OpenCode Go)은 models.dev에서 이름, 컨텍스트 크기, 이미지 입력 여부, 캐시 읽기 단가를 채운다.
// providerKeys는 찾아볼 models.dev 프로바이더 키를 앞에서부터 쓴다(Go에 없으면 같은 회사의 Zen).
// 어디에도 없는 모델의 크기는 채운 모델 중 가장 작은 크기로 둔다. 모르는 크기를 크게 잡으면 요청이 넘친다.
// models.dev를 못 받으면 목록에 있던 값 그대로 둔다.
const MODELS_DEV_URL = "https://models.dev/api.json";

async function fillFromModelsDev(models, providerKeys) {
    let catalogs;
    try {
        const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const all = await res.json();
        catalogs = providerKeys.map((key) => all?.[key]?.models).filter((c) => c && typeof c === "object");
    } catch (err) {
        console.warn(`tabyBot: models.dev unavailable (${err?.message || err}), using model list as is`);
        return models;
    }
    if (!catalogs.length) return models;
    const filled = models.map((m) => {
        const info = catalogs.map((c) => c[m.id]).find(Boolean);
        if (!info) return m;
        const input = info.modalities?.input;
        const filledEntry = {
            ...m,
            label: String(info.name || m.label).trim(),
            contextWindow: info.limit?.context || m.contextWindow,
            supportsVision: Array.isArray(input) ? input.includes("image") : m.supportsVision,
        };
        // 입력 단가 대비 캐시 읽기 단가. 캐시 유지가 핑 값을 셈할 때 쓴다(무료 모델은 단가가 0이라 비워 둔다).
        const price = Number(info.cost?.input);
        const cacheRead = Number(info.cost?.cache_read);
        if (price > 0 && cacheRead >= 0 && info.cost?.cache_read != null) filledEntry.cacheReadRatio = cacheRead / price;
        return filledEntry;
    });
    const known = filled.map((m) => m.contextWindow).filter((n) => n > 0);
    if (known.length) {
        const smallest = Math.min(...known);
        for (const m of filled) m.contextWindow ||= smallest;
    }
    filled.sort((a, b) => a.label.localeCompare(b.label, "en"));
    return filled;
}

export async function fetchProviderModels(provider, opts = {}) {
    return (await fetchProviderModelsDetailed(provider, opts)).models;
}

// 모델 목록과 실제로 목록을 받은 baseURL. 입력한 주소에 /v1을 빠뜨렸으면 붙여서 한 번 더 시도한다.
export async function fetchProviderModelsDetailed(provider, { useCache = true } = {}) {
    if (provider?.type === "codex-oauth") {
        return { models: await fetchCodexModels(), baseURL: provider.baseURL };
    }
    if (provider?.type === "grok-oauth") {
        return { models: await fetchGrokModels(), baseURL: provider.baseURL };
    }
    if (provider?.type === "github-copilot-oauth") {
        return { models: await fetchGithubCopilotModels(), baseURL: provider.baseURL };
    }
    if (provider?.type === "claude-agent-sdk") {
        return { models: await fetchClaudeModels(), baseURL: provider.baseURL };
    }
    const baseURL = String(provider?.baseURL || "")
        .trim()
        .replace(/\/+$/, "");
    if (!baseURL) {
        throw new Error("baseURL required to list models");
    }

    const filePath = cachePath(provider);
    if (useCache && fs.existsSync(filePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
                return { models: cached.models, baseURL };
            }
        } catch {
            // 캐시가 깨졌으면 새로 받는다
        }
    }

    let models;
    let usedURL = baseURL;
    try {
        models = await requestModels(baseURL, provider);
    } catch (err) {
        // OpenAI 호환 서버는 대개 /v1 아래에 있다. 빠뜨린 주소면 붙여서 다시 시도하고, 안 되면 처음 오류를 알린다.
        if (/\/v\d+$/.test(baseURL)) throw err;
        try {
            models = await requestModels(`${baseURL}/v1`, provider);
            usedURL = `${baseURL}/v1`;
        } catch {
            throw err;
        }
    }
    if (provider.modelsDev?.length) models = await fillFromModelsDev(models, provider.modelsDev);
    writeFileAtomic(filePath, `${JSON.stringify({ fetchedAt: Date.now(), models }, null, 2)}\n`);
    return { models, baseURL: usedURL };
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

// 받아 둔 모델 목록에서 이 모델의 입력 단가 대비 캐시 읽기 단가. 목록을 새로 받지 않는다(만료된 목록도 읽는다).
// 모르면 null. 캐시 유지가 핑 값을 셈하고 설정 화면에 예상을 보여 줄 때 쓴다.
export function cachedCacheReadRatio(provider) {
    if (!provider?.modelsDev?.length || !provider.model) return null;
    try {
        const cached = JSON.parse(fs.readFileSync(cachePath(provider), "utf8"));
        const ratio = cached.models?.find((m) => m.id === provider.model)?.cacheReadRatio;
        return Number.isFinite(ratio) ? ratio : null;
    } catch {
        return null;
    }
}

export function findModelVisionSupport(models, modelId) {
    const found = models?.find((m) => m.id === modelId);
    if (found && typeof found.supportsVision === "boolean") return found.supportsVision;
    return guessVisionFromModelId(modelId);
}
