import { redactText } from "../secrets/vault.js";
import { defaultTimeZone } from "../scheduling/time.js";

const ANGLE_SPECIAL_TOKEN = /<\|[^|\n]{1,128}\|>/g;

const LLAMA_CHAT_MARKERS = /\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>/g;

export function sanitizeTextForLlm(text) {
    if (typeof text !== "string" || text.length === 0) return text;

    // 금고의 값이 대화 기록·메모리·사용자 메시지로 섞여 들어와도 모델에는 자리표시자만 보낸다.
    let out = redactText(text).replace(ANGLE_SPECIAL_TOKEN, (match) => {
        const inner = match.slice(2, -2);
        return `⟨${inner}⟩`;
    });

    out = out.replace(LLAMA_CHAT_MARKERS, (m) => `[${m}]`);
    return out;
}

const stampFormatters = new Map(); // 시간대별 포매터

function stampFormatter(timeZone) {
    if (!stampFormatters.has(timeZone)) {
        stampFormatters.set(
            timeZone,
            new Intl.DateTimeFormat("en-US", {
                timeZone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
                timeZoneName: "longOffset",
            }),
        );
    }
    return stampFormatters.get(timeZone);
}

// 사용자 메시지 앞에 붙이는 시각 표기. 저장된 at에서 만들어 매 턴 같은 문자열이 나오므로,
// 시스템 프롬프트에 시계를 둘 때와 달리 뒤따르는 대화 기록의 프롬프트 캐시를 깨지 않는다.
export function formatMessageStamp(at, timeZone = defaultTimeZone()) {
    const date = new Date(at);
    if (typeof at !== "string" || Number.isNaN(date.getTime())) return "";
    try {
        const parts = Object.fromEntries(
            stampFormatter(timeZone)
                .formatToParts(date)
                .map((part) => [part.type, part.value]),
        );
        return `[${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute} ${parts.timeZoneName} ${timeZone}]`;
    } catch {
        return "";
    }
}

function withMessageStamp(content, stamp) {
    if (typeof content === "string") return content ? `${stamp}\n${content}` : stamp;
    if (!Array.isArray(content)) return content;
    const textIndex = content.findIndex((part) => part?.type === "text" && typeof part.text === "string");
    if (textIndex === -1) return [{ type: "text", text: stamp }, ...content];
    return content.map((part, i) => (i === textIndex ? { ...part, text: `${stamp}\n${part.text}` } : part));
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
        // 화면 표시·저장용 메타(발화 시각, 메시지 id, 합쳐 넣은 메시지 목록): API 페이로드로는 보내지 않는다.
        delete out.at;
        delete out.id;
        delete out.queued;

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

        // 사용자 메시지에는 보낸 시각을 붙인다. at이 없는 메시지(내부 지시문, 예전 기록)는 그대로 둔다.
        const stamp = out.role === "user" ? formatMessageStamp(m.at) : "";
        if (stamp) out.content = withMessageStamp(out.content, stamp);

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
