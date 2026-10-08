import { streamWithFallback, throwIfAborted } from "./transport.js";
import { buildPayload, buildStreamResult } from "./responses-request.js";
import { loadGrokTokens, ensureFreshToken } from "./grok-tokens.js";
import { consumeResponsesStream } from "./responses-stream.js";

// OAuth 세션은 개발자 API(api.x.ai)가 아니라 CLI 프록시를 사용
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";

function buildAuthHeaders(accessToken) {
    // CLI 프록시는 Grok CLI 식별 헤더가 없으면 미권한 API 클라이언트로 취급
    return {
        Authorization: `Bearer ${accessToken}`,
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-identifier": "grok-shell",
        "x-grok-client-version": "0.2.93",
        "User-Agent": "xai-grok-cli",
    };
}

function buildHeaders(accessToken) {
    return {
        ...buildAuthHeaders(accessToken),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
    };
}

async function getAuth() {
    const stored = loadGrokTokens();
    return ensureFreshToken(stored);
}

export async function grokComplete({
    model,
    messages,
    tools,
    tool_choice,
    stream = false,
    onTextDelta,
    signal,
    thinkingLevel,
    thinkingParam = "reasoning",
}) {
    throwIfAborted(signal);

    const { accessToken } = await getAuth();
    const headers = buildHeaders(accessToken);
    const payload = buildPayload({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam });

    // 스트리밍 중에도 function_call 이벤트를 조립할 수 있으므로 툴 라운드에서도 스트리밍한다.
    // 비활성화하면 중간 라운드 텍스트가 프론트엔드에 도달하지 않는다.
    const useStream = Boolean(stream && onTextDelta);
    const requestOptions = { method: "POST", headers, signal };

    if (useStream) {
        return streamWithFallback({
            signal,
            runStream: async () => {
                const res = await fetchGrokResponses(headers, { ...payload, stream: true }, requestOptions);
                const result = await consumeResponsesStream(res, signal, onTextDelta);
                return buildStreamResult(result.content, result.toolCalls, result.usage);
            },
            runFallback: () => grokCompleteCollected({ headers, payload, signal }),
        });
    }
    return grokCompleteCollected({ headers, payload, signal });
}

async function fetchGrokResponses(headers, body, requestOptions, { allowRefresh = true } = {}) {
    const res = await fetch(`${BASE_URL}/responses`, {
        ...requestOptions,
        headers,
        body: JSON.stringify(body),
    });
    if (res.ok) return res;

    const errBody = await res.text().catch(() => "");
    if (res.status === 401 && allowRefresh) {
        const stored = loadGrokTokens();
        if (stored?.refreshToken) {
            const { accessToken } = await ensureFreshToken(stored, { forceRefresh: true });
            const retryHeaders = buildHeaders(accessToken);
            return fetchGrokResponses(retryHeaders, body, { ...requestOptions, headers: retryHeaders }, { allowRefresh: false });
        }
    }
    throw new Error(`Grok API error: ${res.status} ${errBody}`);
}

async function grokCompleteCollected({ headers, payload, signal }) {
    const res = await fetchGrokResponses(headers, { ...payload, stream: true }, { method: "POST", headers, signal });
    const { content, usage, toolCalls } = await consumeResponsesStream(res, signal, null);
    return buildStreamResult(content, toolCalls, usage);
}

const SKIP_MODEL = /embed|moderat|whisper|dall-e|dalle|tts|sora|transcrib|rerank|guard|imagine|video|image/i;

function normalizeGrokModel(raw) {
    const id = raw?.id || raw?.name || raw?.slug || raw?.model;
    if (!id || SKIP_MODEL.test(id)) return null;
    if (id === "grok-build-0.1") return null;

    const contextWindow = raw.context_window || raw.context_length || raw.max_model_len || raw.max_context || raw.contextWindow || 500000;
    const modalities = raw.inputModalities || raw.input_modalities || raw.architecture?.input_modalities;
    let supportsVision = typeof raw.acceptsImages === "boolean" ? raw.acceptsImages : null;
    if (supportsVision === null && Array.isArray(modalities)) {
        supportsVision = modalities.includes("image");
    }
    if (supportsVision === null) {
        supportsVision = /grok-4/i.test(id);
    }
    const label = (raw.display_name || raw.displayName || raw.name || id).trim();
    return { id, label, contextWindow, supportsVision };
}

function extractModelList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.models)) return payload.models;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
}

export async function fetchGrokModels() {
    const { accessToken } = await getAuth();
    const headers = { ...buildAuthHeaders(accessToken), Accept: "application/json" };
    let res = await fetch(`${BASE_URL}/models-v2`, { headers });
    if (!res.ok) {
        res = await fetch(`${BASE_URL}/models`, { headers });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = payload.error?.message || res.statusText || "Failed to fetch Grok models";
        throw new Error(msg);
    }

    const out = [];
    const seen = new Set();
    for (const raw of extractModelList(payload)) {
        const entry = normalizeGrokModel(raw);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }
    out.sort((a, b) => a.label.localeCompare(b.label, "en"));
    return out;
}
