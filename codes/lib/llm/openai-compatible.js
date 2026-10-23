import { sanitizeMessagesForApi } from "./sanitize-messages.js";
import { requestOnce, stoppedError, streamWithFallback, throwIfAborted } from "./transport.js";

// openai SDK는 불러오기만 해도 메모리를 15MB쯤 쓴다. OpenAI 호환 업체를 처음 부를 때 불러온다.
let OpenAI;

export async function createOpenAIClient({ baseURL, apiKey, extraHeaders = {} }) {
    OpenAI ??= (await import("openai")).default;
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
        // 실제로 답한 모델(OpenRouter 별칭이 넘겨 준 모델을 알아내는 데 쓴다)
        model: completion.model || null,
    };
}

// OpenAI 호환 업체 중에는 본문이 텍스트 블록 배열이면 받지 못하는 곳이 있다. 이미지가 없는 메시지는
// 블록(하네스 블록과 사용자 글)을 빈 줄로 이어 문자열로 보낸다. 이미지가 있으면 원래대로 배열이다.
function joinTextOnlyContent(messages) {
    return messages.map((m) =>
        Array.isArray(m.content) && m.content.every((part) => part?.type === "text")
            ? { ...m, content: m.content.map((part) => part.text).join("\n\n") }
            : m,
    );
}

function buildParams({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam, providerRouting }) {
    const params = { model, messages: joinTextOnlyContent(sanitizeMessagesForApi(messages)) };

    const level = String(thinkingLevel || "").toLowerCase();
    if (level && level !== "off") {
        params[thinkingParam || "reasoning_effort"] = level;
    }

    // OpenRouter: 지정한 업스트림 프로바이더만 쓰고 폴백을 끈다.
    if (providerRouting) params.provider = providerRouting;

    if (tools?.length && tool_choice !== "none") {
        params.tools = tools;
        params.tool_choice = tool_choice ?? "auto";
    }
    return params;
}

const REASONING_TEXT_KEYS = new Set(["text", "summary", "data"]);

// 스트림 조각을 모아 최종 응답 모양으로 만든다.
class StreamAccumulator {
    constructor() {
        this.content = "";
        this.usage = null;
        this.finishReason = null;
        this.toolCalls = new Map(); // delta의 index별로 이어 붙인다
        this.model = null;
        // 추론 내용. 다음 호출에 돌려주므로 버리지 않고 모은다(messages.js의 pickReasoning).
        this.reasoning = "";
        this.reasoningContent = "";
        this.reasoningDetails = new Map(); // index별로 글을 이어 붙인다
    }

    add(chunk, onTextDelta) {
        if (chunk.usage) this.usage = chunk.usage;
        if (chunk.model) this.model = chunk.model;
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
        if (typeof delta.reasoning === "string") this.reasoning += delta.reasoning;
        if (typeof delta.reasoning_content === "string") this.reasoningContent += delta.reasoning_content;
        if (Array.isArray(delta.reasoning_details)) {
            for (const detail of delta.reasoning_details) this.addReasoningDetail(detail);
        }
    }

    // 조각마다 같은 index의 글(text, summary, data)은 이어 붙이고 나머지(서명, 형식)는 최신 값으로 둔다.
    addReasoningDetail(detail) {
        if (!detail || typeof detail !== "object") return;
        const idx = Number.isInteger(detail.index) ? detail.index : 0;
        const acc = this.reasoningDetails.get(idx);
        if (!acc) {
            this.reasoningDetails.set(idx, { ...detail });
            return;
        }
        for (const [key, value] of Object.entries(detail)) {
            if (value == null) continue;
            if (REASONING_TEXT_KEYS.has(key) && typeof value === "string") acc[key] = (acc[key] || "") + value;
            else acc[key] = value;
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
        if (this.reasoningDetails.size) {
            message.reasoning_details = [...this.reasoningDetails.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        }
        if (this.reasoningContent) message.reasoning_content = this.reasoningContent;
        if (this.reasoning) message.reasoning = this.reasoning;
        return { choices: [{ message, finish_reason: this.finishReason || "stop" }], usage: this.usage, model: this.model };
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
    providerRouting,
    headers,
}) {
    const params = buildParams({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam, providerRouting });
    throwIfAborted(signal);

    // headers: 요청마다 붙일 헤더(대화별 세션 id 등)
    const requestOptions = signal || headers ? { signal, headers } : undefined;

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

// 모델별로 받아 준 출력 길이 제한 이름. OpenAI 추론 모델은 max_tokens를 거절하고 max_completion_tokens만 받는다.
const pingCapField = new Map();

// 캐시 유지 핑. 같은 앞부분으로 출력 1토큰만 받아 앞부분을 캐시에서 다시 읽게 한다. usage를 돌려준다.
export async function chatCompletionsPing({
    client,
    model,
    messages,
    tools,
    tool_choice,
    signal,
    thinkingLevel,
    thinkingParam = "reasoning_effort",
    providerRouting,
    headers,
}) {
    const params = buildParams({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam, providerRouting });
    const id = `${client.baseURL}|${model}`;
    const fields =
        pingCapField.get(id) === "max_completion_tokens" ? ["max_completion_tokens", "max_tokens"] : ["max_tokens", "max_completion_tokens"];
    let lastErr = null;
    for (const field of fields) {
        try {
            const completion = await client.chat.completions.create({ ...params, stream: false, [field]: 1 }, { signal, headers, maxRetries: 0 });
            pingCapField.set(id, field);
            return completion.usage ?? undefined;
        } catch (err) {
            // 제한 이름을 거절한 경우(400)에만 다른 이름으로 다시 보낸다.
            if (signal?.aborted || err?.status !== 400) throw err;
            lastErr = err;
        }
    }
    throw lastErr;
}
