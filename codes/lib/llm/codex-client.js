import { sanitizeMessagesForApi } from "./sanitize-messages.js";
import { loadCodexTokens, ensureFreshToken } from "./codex-tokens.js";

const ORIGINATOR = "tabyagent";

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
            // Assistant message with tool calls: emit function_call items
            // If there's also text content, emit a message item first
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

        // Regular user/assistant message
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
        // Could be text parts or image_url parts
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

/**
 * Parse Responses API output items → Chat Completions format.
 * Returns { choices: [{ message, finish_reason }], usage }
 */
function parseResponsesOutput(body) {
    const outputItems = body.output || [];
    let textContent = "";
    const toolCalls = [];

    for (const item of outputItems) {
        if (item.type === "message" && item.role === "assistant") {
            // content is an array of parts
            if (Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part.type === "output_text" || part.type === "text") {
                        textContent += part.text || "";
                    }
                }
            } else if (typeof item.content === "string") {
                textContent += item.content;
            }
        } else if (item.type === "function_call") {
            toolCalls.push({
                id: item.call_id,
                type: "function",
                function: {
                    name: item.name,
                    arguments: item.arguments || "{}",
                },
            });
        }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (toolCalls.length) message.tool_calls = toolCalls;

    const finish_reason = toolCalls.length ? "tool_calls" : "stop";

    return {
        choices: [{ message, finish_reason }],
        usage: body.usage ?? null,
    };
}

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
            // Responses API: reasoning is an object with effort field
            payload.reasoning = { effort: level };
        } else {
            // Chat Completions: reasoning_effort is a string
            payload[thinkingParam || "reasoning_effort"] = level;
        }
    }

    return payload;
}

async function getAuth() {
    const stored = loadCodexTokens();
    return ensureFreshToken(stored);
}

/**
 * Codex Responses API client — same interface as chatCompletions().
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
    if (signal?.aborted) {
        const err = new Error("Stopped by user.");
        err.name = "AbortError";
        throw err;
    }

    const { accessToken, accountId } = await getAuth();
    const headers = buildHeaders(accessToken, accountId);
    const baseURL = "https://chatgpt.com/backend-api/codex";
    const payload = buildPayload({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam });

    const includeTools = Boolean(tools?.length) && tool_choice !== "none";
    const useStream = Boolean(stream && onTextDelta && !includeTools);

    const requestOptions = { method: "POST", headers, signal };

    if (useStream) {
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let content = "";
            let usage = null;
            try {
                const res = await fetch(`${baseURL}/responses`, {
                    ...requestOptions,
                    body: JSON.stringify({ ...payload, stream: true }),
                });
                if (!res.ok) {
                    const errBody = await res.text().catch(() => "");
                    throw new Error(`Codex API error: ${res.status} ${errBody}`);
                }

                const result = await consumeStream(res, signal, onTextDelta);
                content = result.content;
                usage = result.usage;

                return buildStreamResult(content, result.toolCalls, usage);
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

        // Fallback: collect stream without onTextDelta
        try {
            return await codexCompleteCollected({ baseURL, headers, payload, signal });
        } catch (fallbackErr) {
            if (signal?.aborted || isAbortError(fallbackErr)) {
                const abortErr = new Error("Stopped by user.");
                abortErr.name = "AbortError";
                throw abortErr;
            }
            throw lastErr || fallbackErr;
        }
    }
    return codexCompleteCollected({ baseURL, headers, payload, signal });
}

async function consumeStream(res, signal, onTextDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = null;
    const toolCalls = [];
    // Accumulate function call argument deltas by item_id
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
                    // Accumulate argument deltas by item_id
                    if (evt.item_id && argBuffers[evt.item_id] !== undefined) {
                        argBuffers[evt.item_id] += evt.delta;
                    }
                } else if (evt.type === "response.function_call_arguments.done") {
                    // Final arguments — use accumulated buffer or event item
                    const finalArgs = evt.item?.arguments || argBuffers[evt.item_id] || "{}";
                    const tc = toolCalls.find((t) => t.id === evt.item?.call_id);
                    if (tc) tc.function.arguments = finalArgs;
                } else if (evt.type === "response.completed" || evt.type === "response.done") {
                    if (evt.response?.usage || evt.usage) usage = evt.response?.usage || evt.usage;
                    // Final safety net: overwrite toolCalls from completed response output
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
