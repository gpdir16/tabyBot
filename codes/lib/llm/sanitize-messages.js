const ANGLE_SPECIAL_TOKEN = /<\|[^|\n]{1,128}\|>/g;

const LLAMA_CHAT_MARKERS = /\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>/g;

export function sanitizeTextForLlm(text) {
    if (typeof text !== "string" || text.length === 0) return text;

    let out = text.replace(ANGLE_SPECIAL_TOKEN, (match) => {
        const inner = match.slice(2, -2);
        return `⟨${inner}⟩`;
    });

    out = out.replace(LLAMA_CHAT_MARKERS, (m) => `[${m}]`);
    return out;
}

const MAX_IMAGES = 50; // API limit is 60; keep 50 for safety margin

function trimImages(messages) {
    let imageCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!Array.isArray(m.content)) continue;
        for (let j = 0; j < m.content.length; j++) {
            const part = m.content[j];
            if (part?.type === "image_url") {
                imageCount++;
                if (imageCount > MAX_IMAGES) {
                    m.content[j] = { type: "text", text: "[screenshot removed to stay under API image limit]" };
                }
            }
        }
        if (Array.isArray(m.content) && !m.content.some((p) => p.type === "image_url")) {
            const text = m.content.map((p) => p.text || "").join("");
            if (text) m.content = text;
        }
    }
    return messages;
}
export function sanitizeMessagesForApi(messages) {
    if (!Array.isArray(messages)) return messages;

    const sanitized = messages.map((m) => {
        const out = { ...m };

        if (typeof out.content === "string") {
            out.content = sanitizeTextForLlm(out.content);
        } else if (Array.isArray(out.content)) {
            out.content = out.content.map((part) => {
                if (part?.type === "text" && typeof part.text === "string") {
                    return { ...part, text: sanitizeTextForLlm(part.text) };
                }
                return part;
            });
        }

        if (out.tool_calls?.length) {
            out.tool_calls = out.tool_calls.map((tc) => ({
                ...tc,
                function: tc.function
                    ? {
                          ...tc.function,
                          arguments: typeof tc.function.arguments === "string" ? sanitizeTextForLlm(tc.function.arguments) : tc.function.arguments,
                      }
                    : tc.function,
            }));
        }

        return out;
    });

    return trimImages(sanitized);
}
