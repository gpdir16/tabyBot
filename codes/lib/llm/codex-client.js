import { streamWithFallback, throwIfAborted } from "./transport.js";
import { buildPayload, buildStreamResult } from "./responses-request.js";
import { loadCodexTokens, ensureFreshToken } from "./codex-tokens.js";
import { consumeResponsesStream } from "./responses-stream.js";

const ORIGINATOR = "tabybot";

function buildHeaders(accessToken, accountId) {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        originator: ORIGINATOR,
        "OpenAI-Beta": "responses=experimental",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    return headers;
}

function getAuth() {
    const stored = loadCodexTokens();
    return ensureFreshToken(stored);
}

/**
 * Codex Responses API client. Same interface as chatCompletions().
 */
export async function codexComplete({
    model,
    messages,
    tools,
    tool_choice,
    stream = false,
    onTextDelta,
    signal,
    thinkingLevel,
    thinkingParam = "reasoning_effort",
}) {
    throwIfAborted(signal);

    const { accessToken, accountId } = await getAuth();
    const headers = buildHeaders(accessToken, accountId);
    const baseURL = "https://chatgpt.com/backend-api/codex";
    const payload = buildPayload({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam });

    // 스트리밍 중에도 function_call 이벤트를 조립할 수 있으므로 툴 라운드에서도 스트리밍한다.
    // 비활성화하면 중간 라운드 텍스트가 프론트엔드에 도달하지 않는다.
    const useStream = Boolean(stream && onTextDelta);

    const requestOptions = { method: "POST", headers, signal };

    if (useStream) {
        return streamWithFallback({
            signal,
            runStream: async () => {
                const res = await fetch(`${baseURL}/responses`, {
                    ...requestOptions,
                    body: JSON.stringify({ ...payload, stream: true }),
                });
                if (!res.ok) {
                    const errBody = await res.text().catch(() => "");
                    throw new Error(`Codex API error: ${res.status} ${errBody}`);
                }
                const result = await consumeResponsesStream(res, signal, onTextDelta);
                return buildStreamResult(result.content, result.toolCalls, result.usage);
            },
            runFallback: () => codexCompleteCollected({ baseURL, headers, payload, signal }),
        });
    }
    return codexCompleteCollected({ baseURL, headers, payload, signal });
}

async function codexCompleteCollected({ baseURL, headers, payload, signal }) {
    // Codex backend requires stream=true; collect without onTextDelta
    const res = await fetch(`${baseURL}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Codex API error: ${res.status} ${errBody}`);
    }
    const { content, usage, toolCalls } = await consumeResponsesStream(res, signal, null);
    return buildStreamResult(content, toolCalls, usage);
}

export async function fetchCodexModels() {
    const { accessToken, accountId } = await getAuth();
    const headers = { ...buildHeaders(accessToken, accountId), Accept: "application/json" };
    const urls = ["https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", "https://chatgpt.com/backend-api/models?client_version=1.0.0"];

    let lastErr = null;
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                lastErr = new Error(payload.error?.message || `Codex models failed: ${res.status}`);
                continue;
            }
            const list = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
            const out = [];
            const seen = new Set();
            for (const raw of list) {
                const id = String(raw?.slug || raw?.id || "").trim();
                if (!id || seen.has(id)) continue;
                const visibility = String(raw?.visibility || "").toLowerCase();
                if (visibility === "hide" || visibility === "hidden") continue;
                seen.add(id);
                const modalities = raw?.input_modalities;
                out.push({
                    id,
                    label: String(raw?.display_name || id).trim(),
                    contextWindow: Number(raw?.context_window) || null,
                    supportsVision: Array.isArray(modalities) ? modalities.includes("image") : true,
                });
            }
            if (out.length) {
                out.sort((a, b) => a.label.localeCompare(b.label, "en"));
                return out;
            }
            lastErr = new Error("Codex models list empty");
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error("Failed to fetch Codex models");
}
