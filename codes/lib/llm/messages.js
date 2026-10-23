// 추론 모델이 도구를 부르며 세운 계획. 같은 턴의 다음 호출에 돌려줘야 모델이 흐름을 잇는다. 빼면 도구 결과를 받을
// 때마다 계획을 처음부터 다시 세워 "누르겠다"고 해 놓고 다음 호출에서 잊는다. OpenRouter는 reasoning_details를,
// DeepSeek 같은 곳은 reasoning_content를 돌려받는다. 하나만 남긴다(같은 추론을 두 번 보내지 않게).
const REASONING_FIELDS = ["reasoning_details", "reasoning_content", "reasoning"];

function pickReasoning(message) {
    if (Array.isArray(message.reasoning_details) && message.reasoning_details.length) return { reasoning_details: message.reasoning_details };
    if (typeof message.reasoning_content === "string" && message.reasoning_content) return { reasoning_content: message.reasoning_content };
    if (typeof message.reasoning === "string" && message.reasoning) return { reasoning: message.reasoning };
    return {};
}

// 턴이 끝나 기록에 남길 때와 턴 중에 업체가 바뀔 때 지운다. 다음 턴까지 실으면 컨텍스트만 불어난다.
export function stripReasoning(message) {
    if (message?.role === "assistant") for (const field of REASONING_FIELDS) delete message[field];
    return message;
}

export function assistantMessageToPlain(message) {
    if (!message) {
        return { role: "assistant", content: "" };
    }

    if (!message.tool_calls?.length) {
        return {
            role: "assistant",
            content: message.content ?? "",
            ...pickReasoning(message),
        };
    }

    const tool_calls = message.tool_calls.map((tc) => {
        const name = tc.function?.name;
        if (!name) throw new Error("tool_call missing function.name");
        if (!tc.id) {
            throw new Error(`tool_call missing id (function=${name}). The provider is not OpenAI-compatible`);
        }
        return {
            id: tc.id,
            type: tc.type || "function",
            function: {
                name,
                arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
            },
        };
    });

    return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls,
        ...pickReasoning(message),
    };
}
