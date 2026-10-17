import { redactText } from "../secrets/vault.js";
import { defaultTimeZone } from "../scheduling/time.js";
import { formatStateUpdate } from "../agent/prompt-sections.js";

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

// 하네스가 사용자 메시지에 붙이는 정보(보낸 시각, 함께 온 첨부, 세션 시작 뒤 바뀐 시스템 프롬프트 항목)를 한 블록으로
// 만든다. 사용자가 쓴 글에 섞지 않고 그 앞에 따로 둔다. 저장된 at·첨부 메타·stateUpdate로만 만들어 매 턴 같은 문자열이
// 나오므로 프롬프트 캐시를 깨지 않는다. 이 정보를 시스템 프롬프트에 두면 바뀔 때마다 그 뒤 대화 기록 전체의 캐시가 깨진다.
function userMessageHeader(m) {
    const lines = [];
    const stamp = formatMessageStamp(m.at);
    if (stamp) lines.push(stamp);
    for (const file of Array.isArray(m.attachments) ? m.attachments : []) {
        const filePath = file?.filePath || file?.relPath;
        if (filePath) lines.push(`[attached file: ${file.name || "file"} (${file.mime || "file"}) ${filePath}]`);
    }
    const update = formatStateUpdate(m.stateUpdate);
    if (update) lines.push(lines.length ? `\n${update}` : update);
    return lines.join("\n");
}

function withHeaderBlock(content, header) {
    let parts = [];
    if (typeof content === "string") parts = content ? [{ type: "text", text: content }] : [];
    else if (Array.isArray(content)) parts = content;
    return [{ type: "text", text: header }, ...parts];
}

const MAX_IMAGES = 50; // API limit is 60; keep 50 for safety margin

function trimImages(messages) {
    let imageCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!Array.isArray(m.content)) continue;
        let removed = false;
        for (let j = 0; j < m.content.length; j++) {
            const part = m.content[j];
            if (part?.type === "image_url") {
                imageCount++;
                if (imageCount > MAX_IMAGES) {
                    m.content[j] = { type: "text", text: "[screenshot removed to stay under API image limit]" };
                    removed = true;
                }
            }
        }
        // 이미지를 덜어 낸 메시지만 문자열로 되돌린다. 원래 텍스트 블록만 있던 메시지(하네스 블록 + 사용자 글)는
        // 블록을 나눈 채 둔다.
        if (removed && !m.content.some((p) => p.type === "image_url")) {
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
        // 화면 표시·저장용 메타(발화 시각, 메시지 id, 합쳐 넣은 메시지 목록, 첨부, 항목 갱신): API 페이로드로는 보내지 않는다.
        // 시각·첨부·항목 갱신은 아래에서 메시지 앞 블록으로 바뀐다.
        delete out.at;
        delete out.id;
        delete out.queued;
        delete out.attachments;
        delete out.stateUpdate;

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

        // 사용자 메시지 앞에 보낸 시각·첨부·항목 갱신을 별도 블록으로 둔다. 셋 다 없는 메시지(내부 지시문, 예전 기록)는 그대로 둔다.
        const header = out.role === "user" ? sanitizeTextForLlm(userMessageHeader(m)) : "";
        if (header) out.content = withHeaderBlock(out.content, header);

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
