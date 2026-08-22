import { sanitizeMessagesForApi } from "./sanitize-messages.js";
import { loadGrokTokens, ensureFreshToken } from "./grok-tokens.js";

// OAuth 세션은 개발자 API(api.x.ai)가 아니라 CLI 프록시를 사용
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";

function isAbortError(err) {
    return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function normalizeErrorText(err) {
    return String(err?.message || err || "")
        .toLowerCase()
        .trim();
}

function isTransientTransportError(err) {
    const text = normalizeErrorText(err);
    if (!text) return false;
    return (
        text.includes("premature close") ||
        text.includes("socket hang up") ||
        text.includes("fetch failed") ||
        text.includes("network error") ||
        text.includes("connection reset") ||
        text.includes("connection terminated") ||
        text.includes("econnreset") ||
        text.includes("etimedout") ||
        text.includes("eai_again") ||
        text.includes("und_err_socket") ||
        text.includes("terminated")
    );
}

function messagesToResponsesInput(messages) {
    const sanitized = sanitizeMessagesForApi(messages);
    const instructions = [];
    const input = [];

    for (const msg of sanitized) {
        if (msg.role === "system" || msg.role === "developer") {
            const text = typeof msg.content === "string" ? msg.content : "";
            if (text) instructions.push(text);
            continue;
        }

        if (msg.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: msg.tool_call_id,
                output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            });
            continue;
        }

        if (msg.role === "assistant" && msg.tool_calls?.length) {
            if (msg.content) {
                input.push({
                    type: "message",
                    role: "assistant",
                    content: extractTextContent(msg.content),
                });
            }
            for (const tc of msg.tool_calls) {
                input.push({
                    type: "function_call",
                    call_id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments || "{}",
                });
            }
            continue;
        }

        input.push({
            type: "message",
            role: msg.role === "assistant" ? "assistant" : "user",
            content: extractTextContent(msg.content),
        });
    }

    return { instructions: instructions.join("\n\n") || undefined, input };
}

function extractTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((p) => {
            if (p.type === "text") return { type: "input_text", text: p.text };
            if (p.type === "image_url") {
                return { type: "input_image", image_url: p.image_url?.url || p.image_url };
            }
            return p;
        });
    }
    return content;
}

function convertTools(tools) {
    if (!tools?.length) return undefined;
    return tools.map((t) => {
        if (t.type === "function" && t.function) {
            return {
                type: "function",
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
                ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
            };
        }
        return t;
    });
}

function convertToolChoice(tool_choice) {
    if (!tool_choice || tool_choice === "auto") return "auto";
    if (tool_choice === "none") return "none";
    if (tool_choice === "required") return "required";
    if (typeof tool_choice === "object") {
        return { type: "function", name: tool_choice.function?.name };
    }
    return "auto";
}

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

function buildPayload({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam }) {
    const { instructions, input } = messagesToResponsesInput(messages);
    const payload = {
        model,
        input,
        store: false,
    };
    if (instructions) payload.instructions = instructions;

    const convertedTools = convertTools(tools);
    if (convertedTools) {
        payload.tools = convertedTools;
        payload.tool_choice = convertToolChoice(tool_choice);
    }

    const level = String(thinkingLevel || "").toLowerCase();
    if (level && level !== "off" && level !== "none") {
        if (thinkingParam === "reasoning") {
            payload.reasoning = { effort: level };
        } else {
            payload[thinkingParam || "reasoning_effort"] = level;
        }
    }

    return payload;
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
    if (signal?.aborted) {
        const err = new Error("Stopped by user.");
        err.name = "AbortError";
        throw err;
    }

    const { accessToken } = await getAuth();
    const headers = buildHeaders(accessToken);
    const payload = buildPayload({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam });

    const includeTools = Boolean(tools?.length) && tool_choice !== "none";
    const useStream = Boolean(stream && onTextDelta && !includeTools);
    const requestOptions = { method: "POST", headers, signal };

    if (useStream) {
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let content = "";
            try {
                const res = await fetchGrokResponses(headers, { ...payload, stream: true }, requestOptions);
                const result = await consumeStream(res, signal, onTextDelta);
                content = result.content;
                return buildStreamResult(content, result.toolCalls, result.usage);
            } catch (err) {
                if (signal?.aborted || isAbortError(err)) {
                    const abortErr = new Error("Stopped by user.");
                    abortErr.name = "AbortError";
                    abortErr.partialText = content;
                    throw abortErr;
                }
                lastErr = err;
                if (!isTransientTransportError(err)) throw err;
                if (attempt === 0) continue;
            }
        }

        try {
            return await grokCompleteCollected({ headers, payload, signal });
        } catch (fallbackErr) {
            if (signal?.aborted || isAbortError(fallbackErr)) {
                const abortErr = new Error("Stopped by user.");
                abortErr.name = "AbortError";
                throw abortErr;
            }
            throw lastErr || fallbackErr;
        }
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

async function consumeStream(res, signal, onTextDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = null;
    const toolCalls = [];
    const argBuffers = {};

    for (;;) {
        if (signal?.aborted) {
            const err = new Error("Stopped by user.");
            err.name = "AbortError";
            throw err;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
                const evt = JSON.parse(data);
                if (evt.type === "response.output_text.delta" && evt.delta) {
                    content += evt.delta;
                    if (onTextDelta) onTextDelta(evt.delta, content);
                } else if (evt.type === "response.output_item.added" && evt.item?.type === "function_call") {
                    const tc = {
                        id: evt.item.call_id,
                        type: "function",
                        function: { name: evt.item.name, arguments: evt.item.arguments || "{}" },
                    };
                    toolCalls.push(tc);
                    argBuffers[evt.item.id] = "";
                } else if (evt.type === "response.function_call_arguments.delta") {
                    if (evt.item_id && argBuffers[evt.item_id] !== undefined) {
                        argBuffers[evt.item_id] += evt.delta;
                    }
                } else if (evt.type === "response.function_call_arguments.done") {
                    const finalArgs = evt.item?.arguments || argBuffers[evt.item_id] || "{}";
                    const tc = toolCalls.find((t) => t.id === evt.item?.call_id);
                    if (tc) tc.function.arguments = finalArgs;
                } else if (evt.type === "response.completed" || evt.type === "response.done") {
                    if (evt.response?.usage || evt.usage) usage = evt.response?.usage || evt.usage;
                    const outputItems = evt.response?.output || evt.output || [];
                    for (const item of outputItems) {
                        if (item.type === "function_call") {
                            const tc = toolCalls.find((t) => t.id === item.call_id);
                            if (tc) {
                                tc.function.arguments = item.arguments || tc.function.arguments;
                            } else {
                                toolCalls.push({
                                    id: item.call_id,
                                    type: "function",
                                    function: { name: item.name, arguments: item.arguments || "{}" },
                                });
                            }
                        }
                    }
                }
            } catch {
                // skip unparseable
            }
        }
    }

    return { content, usage, toolCalls };
}

async function grokCompleteCollected({ headers, payload, signal }) {
    const res = await fetchGrokResponses(headers, { ...payload, stream: true }, { method: "POST", headers, signal });
    const { content, usage, toolCalls } = await consumeStream(res, signal, null);
    return buildStreamResult(content, toolCalls, usage);
}

function buildStreamResult(content, toolCalls, usage) {
    const message = { role: "assistant" };
    if (content) message.content = content;
    if (toolCalls?.length) message.tool_calls = toolCalls;
    const finish_reason = toolCalls?.length ? "tool_calls" : "stop";
    return { choices: [{ message, finish_reason }], usage };
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
