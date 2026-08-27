import OpenAI from "openai";
import { sanitizeMessagesForApi } from "./sanitize-messages.js";

export function createOpenAIClient({ baseURL, apiKey, extraHeaders = {} }) {
    return new OpenAI({
        apiKey,
        baseURL,
        defaultHeaders: extraHeaders,
    });
}

function completionPayload(completion) {
    const choice = completion.choices?.[0];
    if (!choice) throw new Error("Empty LLM response");
    return {
        choices: [
            {
                message: choice.message,
                finish_reason: choice.finish_reason,
            },
        ],
        usage: completion.usage ?? null,
    };
}

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

export async function chatCompletions({
    client,
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
    const includeTools = Boolean(tools?.length) && tool_choice !== "none";
    const params = { model, messages: sanitizeMessagesForApi(messages) };

    const level = String(thinkingLevel || "").toLowerCase();
    if (level && level !== "off") {
        const param = thinkingParam || "reasoning_effort";
        params[param] = level;
    }

    if (includeTools) {
        params.tools = tools;
        params.tool_choice = tool_choice ?? "auto";
    }

    const useStream = Boolean(stream && onTextDelta);

    if (signal?.aborted) {
        const err = new Error("Stopped by user.");
        err.name = "AbortError";
        throw err;
    }

    const requestOptions = signal ? { signal } : undefined;

    const requestNonStream = async () => {
        const completion = await client.chat.completions.create(
            {
                ...params,
                stream: false,
            },
            requestOptions,
        );
        return completionPayload(completion);
    };
    if (useStream) {
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let content = "";
            let usage = null;
            const toolAcc = new Map();
            try {
                const streamResp = await client.chat.completions.create(
                    {
                        ...params,
                        stream: true,
                        stream_options: { include_usage: true },
                    },
                    requestOptions,
                );

                let finishReason = null;
                for await (const chunk of streamResp) {
                    if (signal?.aborted) {
                        const err = new Error("Stopped by user.");
                        err.name = "AbortError";
                        err.partialText = content;
                        throw err;
                    }
                    if (chunk.usage) usage = chunk.usage;
                    const choice = chunk.choices?.[0];
                    if (!choice) continue;
                    if (choice.finish_reason) finishReason = choice.finish_reason;
                    const delta = choice.delta;
                    if (!delta) continue;
                    if (delta.content) {
                        content += delta.content;
                        onTextDelta(delta.content, content);
                    }
                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            const idx = Number.isInteger(tc.index) ? tc.index : 0;
                            const acc = toolAcc.get(idx) || { id: "", type: "function", function: { name: "", arguments: "" } };
                            if (tc.id) acc.id = tc.id;
                            if (tc.type) acc.type = tc.type;
                            if (tc.function?.name) acc.function.name += tc.function.name;
                            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                            toolAcc.set(idx, acc);
                        }
                    }
                }

                const message = { role: "assistant", content: content || "" };
                if (toolAcc.size) {
                    message.tool_calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
                }
                return {
                    choices: [{ message, finish_reason: finishReason || "stop" }],
                    usage,
                };
            } catch (err) {
                if (signal?.aborted || isAbortError(err)) {
                    const abortErr = new Error("Stopped by user.");
                    abortErr.name = "AbortError";
                    abortErr.partialText = content;
                    throw abortErr;
                }
                lastErr = err;
                if (!isTransientTransportError(err)) {
                    throw err;
                }
                if (attempt === 0) {
                    continue;
                }
            }
        }

        // Transient stream errors: retry once without streaming.
        try {
            return await requestNonStream();
        } catch (fallbackErr) {
            if (signal?.aborted || isAbortError(fallbackErr)) {
                const abortErr = new Error("Stopped by user.");
                abortErr.name = "AbortError";
                throw abortErr;
            }
            throw lastErr || fallbackErr;
        }
    }

    try {
        return await requestNonStream();
    } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
            const abortErr = new Error("Stopped by user.");
            abortErr.name = "AbortError";
            throw abortErr;
        }
        throw err;
    }
}
