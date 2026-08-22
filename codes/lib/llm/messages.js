export function assistantMessageToPlain(message) {
    if (!message) {
        return { role: "assistant", content: "" };
    }

    if (!message.tool_calls?.length) {
        return {
            role: "assistant",
            content: message.content ?? "",
        };
    }

    const tool_calls = message.tool_calls.map((tc) => {
        const name = tc.function?.name;
        if (!name) throw new Error("tool_call missing function.name");
        if (!tc.id) {
            throw new Error(`tool_call missing id (function=${name}) — provider is not OpenAI-compatible`);
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
    };
}
