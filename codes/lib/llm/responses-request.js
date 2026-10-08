// Responses API(Codex, Grok OAuth) 요청 조립과 결과 변환. 채팅 메시지 형식을 Responses 형식으로 바꾼다.
import { sanitizeMessagesForApi } from "./sanitize-messages.js";

function extractTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (part.type === "text") return { type: "input_text", text: part.text };
            if (part.type === "image_url") {
                return { type: "input_image", image_url: part.image_url?.url || part.image_url };
            }
            return part;
        });
    }
    return content;
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
            // 도구 호출이 있는 assistant 메시지: 본문이 있으면 message 항목을 먼저, 이어서 function_call 항목들
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

function convertToolChoice(toolChoice) {
    if (!toolChoice || toolChoice === "auto") return "auto";
    if (toolChoice === "none") return "none";
    if (toolChoice === "required") return "required";
    if (typeof toolChoice === "object") {
        return { type: "function", name: toolChoice.function?.name };
    }
    return "auto";
}

export function buildPayload({ model, messages, tools, tool_choice, thinkingLevel, thinkingParam }) {
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
            // Responses API는 reasoning이 { effort } 객체
            payload.reasoning = { effort: level };
        } else {
            // Chat Completions 계열은 문자열 파라미터
            payload[thinkingParam || "reasoning_effort"] = level;
        }
    }

    return payload;
}

// 스트림을 다 모은 결과를 Chat Completions 응답 모양으로 바꾼다.
export function buildStreamResult(content, toolCalls, usage) {
    const message = { role: "assistant" };
    if (content) message.content = content;
    if (toolCalls?.length) message.tool_calls = toolCalls;
    const finish_reason = toolCalls?.length ? "tool_calls" : "stop";
    return { choices: [{ message, finish_reason }], usage };
}
