import OpenAI from "openai";
import { sanitizeMessagesForApi } from "./sanitize-messages.js";
import { requestOnce, stoppedError, streamWithFallback, throwIfAborted } from "./transport.js";

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

function buildParams({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam }) {
    const params = { model, messages: sanitizeMessagesForApi(messages) };

    const level = String(thinkingLevel || "").toLowerCase();
    if (level && level !== "off") {
        params[thinkingParam || "reasoning_effort"] = level;
    }

    if (tools?.length && tool_choice !== "none") {
        params.tools = tools;
        params.tool_choice = tool_choice ?? "auto";
    }
    return params;
}

// 스트림 조각을 모아 최종 응답 모양으로 만든다.
class StreamAccumulator {
    constructor() {
        this.content = "";
        this.usage = null;
        this.finishReason = null;
        this.toolCalls = new Map(); // delta의 index별로 이어 붙인다
    }

    add(chunk, onTextDelta) {
        if (chunk.usage) this.usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) this.finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) return;
        if (delta.content) {
            this.content += delta.content;
            onTextDelta(delta.content, this.content);
        }
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) this.addToolCallDelta(tc);
        }
    }

    addToolCallDelta(tc) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        const acc = this.toolCalls.get(idx) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) acc.id = tc.id;
        if (tc.type) acc.type = tc.type;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        this.toolCalls.set(idx, acc);
    }

    toResult() {
        const message = { role: "assistant", content: this.content || "" };
        if (this.toolCalls.size) {
            message.tool_calls = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        }
        return { choices: [{ message, finish_reason: this.finishReason || "stop" }], usage: this.usage };
    }
}

export function chatCompletions({
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
    const params = buildParams({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam });
    throwIfAborted(signal);

    const requestOptions = signal ? { signal } : undefined;

    const requestNonStream = async () => completionPayload(await client.chat.completions.create({ ...params, stream: false }, requestOptions));

    const runStream = async (partial) => {
        const acc = new StreamAccumulator();
        const streamResp = await client.chat.completions.create({ ...params, stream: true, stream_options: { include_usage: true } }, requestOptions);
        for await (const chunk of streamResp) {
            if (signal?.aborted) throw stoppedError(acc.content);
            acc.add(chunk, onTextDelta);
            partial.text = acc.content;
        }
        return acc.toResult();
    };

    if (stream && onTextDelta) {
        return streamWithFallback({ signal, runStream, runFallback: requestNonStream });
    }
    return requestOnce(signal, requestNonStream);
}
