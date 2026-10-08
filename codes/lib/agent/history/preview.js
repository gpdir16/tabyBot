// 목록 미리보기·마지막 활동 시각·안 읽음 수 계산과 읽음 표시.
import { loadManifest, saveManifest } from "./files.js";
import { isScheduledTurnText, stripAttachedFiles } from "./messages.js";
import { isInternalStoredMessage, isSilentMarkedText, sayTextsFromMessage } from "./messages.js";

// 미리보기 자리 표시 문자(사설 영역): 표·코드 블록·이미지. 클라이언트(markdown.js)가 아이콘으로 그린다.
const PREVIEW_TABLE = "\uE000";

const PREVIEW_CODE = "\uE001";

const PREVIEW_IMAGE = "\uE002";

// 표의 구분 행 한 칸(":---:" 등)과 구분 행 전체.
const TABLE_CELL = "[ \\t]*:?-+:?[ \\t]*";

const TABLE_DELIM = `(?:\\|${TABLE_CELL}(?:\\|${TABLE_CELL})*\\|?|${TABLE_CELL}(?:\\|${TABLE_CELL})+\\|?)`;

const PREVIEW_TABLE_RE = new RegExp(`(^|\\n)[ \\t]*[^\\n]*\\|[^\\n]*\\n[ \\t]*${TABLE_DELIM}[ \\t]*(?=\\n|$)(?:\\n[ \\t]*[^\\n]*\\|[^\\n]*)*`, "g");

export function stripMarkdownForPreview(text) {
    let s = String(text || "");
    if (!s) return "";
    // 한 줄에 옮기기 어려운 블록은 자리 표시 문자로 남긴다(목록에서 아이콘으로 그린다).
    // 코드 블록: 줄 머리에서 시작하는 펜스만 잡는다(글 속에서 백틱 세 개를 언급한 것은 건드리지 않는다).
    s = s.replace(/(^|\n)[ \t]*```[\s\S]*?(\n[ \t]*```|$)/g, `$1 ${PREVIEW_CODE} `);
    // 표: 머리 행 + 구분 행 + 본문 행들. 구분 행은 파이프가 하나는 있어야 하고 줄 끝까지 구분 행이어야 한다
    // (파이프가 든 문장 다음 줄의 "---"나 "--help"를 표로 잡지 않게).
    s = s.replace(PREVIEW_TABLE_RE, `$1 ${PREVIEW_TABLE} `);
    // 이미 한 줄로 펴져 저장된 표(예전 미리보기)
    s = s.replace(/\|[^\n]*\|[ \t]*:?-{2,}:?[ \t]*\|[^\n]*/g, ` ${PREVIEW_TABLE} `);
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ` ${PREVIEW_IMAGE} `);
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    s = s.replace(/(\*\*|__)([^*_\n]+)\1/g, "$2");
    s = s.replace(/([*_])([^*_\n]+)\1/g, "$2");
    s = s.replace(/~~(.*?)~~/g, "$1");
    s = s.replace(/(^|\s)#{1,6}\s+/g, "$1");
    s = s.replace(/(^|\s)>\s+/g, "$1");
    s = s.replace(/(^|\s)[-*+]\s+/g, "$1");
    s = s.replace(/(^|\s)\d+\.\s+/g, "$1");
    return s.replace(/\s+/g, " ").trim();
}

function previewTextFromMessage(message) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) return "";
    if (isInternalStoredMessage(message)) return "";
    // 툴 호출이 딸린 발화는 내부 메모: 프리뷰에는 user_say로 보낸 말만 쓴다.
    if (message.role === "assistant" && message.tool_calls?.length) {
        const said = sayTextsFromMessage(message)
            .filter((t) => !isSilentMarkedText(t))
            .at(-1);
        return said ? stripMarkdownForPreview(said) : "";
    }
    if (typeof message.content !== "string") return "";
    if (message.role === "assistant" && isSilentMarkedText(message.content)) return "";
    if (message.role === "user" && isScheduledTurnText(message.content)) return "";
    const text = stripAttachedFiles(message.content);
    if (text) return stripMarkdownForPreview(text);
    return message.attachments?.[0]?.name || "";
}

export function previewSnippetFromTurns(turns) {
    for (let i = (turns || []).length - 1; i >= 0; i--) {
        const messages = turns[i]?.messages || [];
        for (let j = messages.length - 1; j >= 0; j--) {
            const text = previewTextFromMessage(messages[j]);
            if (text) return text.slice(0, 120);
        }
    }
    return "";
}

// 히스토리에서 가장 최근 발화 시각을 찾는다. 목록 정렬(updatedAt)의 정본이다.
// 파일 mtime은 압축·백필 같은 내부 쓰기에도 바뀌므로 정렬 근거로 쓰지 않는다.
export function lastActivityAtFromTurns(turns) {
    for (let i = (turns || []).length - 1; i >= 0; i--) {
        const messages = turns[i]?.messages || [];
        for (let j = messages.length - 1; j >= 0; j--) {
            if (messages[j]?.at) return messages[j].at;
        }
        if (turns[i]?.at) return turns[i].at;
    }
    return "";
}

// 사용자가 마지막으로 읽은 시각(readAt) 뒤에 도착한 에이전트 발화 수.
// 화면에 버블로 보이는 것만 센다. 침묵 마커·빈 본문·툴 호출의 내부 메모는 제외.
function unreadCountFromTurns(turns, readAt) {
    let count = 0;
    for (const turn of turns || []) {
        for (const m of turn?.messages || []) {
            if (m?.role !== "assistant") continue;
            const at = String(m.at || turn.at || "");
            if (!at || at <= readAt) continue;
            if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
                count += sayTextsFromMessage(m).filter((text) => !isSilentMarkedText(text)).length;
                continue;
            }
            const text = typeof m.content === "string" ? m.content.trim() : "";
            if ((text && !isSilentMarkedText(text)) || m.attachments?.length) count += 1;
        }
    }
    return count;
}

export function writePreview(chatId, turns) {
    try {
        const manifest = loadManifest(chatId);
        if (!manifest) return;
        // 읽음 표시가 없던 대화(이전 버전에서 넘어온 기록)는 지금까지를 읽은 것으로 본다.
        if (typeof manifest.readAt !== "string") manifest.readAt = manifest.lastActivityAt || lastActivityAtFromTurns(turns) || "";
        const text = previewSnippetFromTurns(turns);
        if (text) manifest.preview = text;
        const lastAt = lastActivityAtFromTurns(turns);
        if (lastAt) manifest.lastActivityAt = lastAt;
        manifest.unread = unreadCountFromTurns(turns, manifest.readAt);
        saveManifest(chatId, manifest);
    } catch (err) {
        console.error(`tabyBot: preview write failed (${chatId}):`, err?.message || err);
    }
}

// 대화를 읽음으로 표시한다. 안 읽은 발화가 있었으면 true.
export function markChatRead(chatId) {
    const manifest = loadManifest(chatId);
    if (!manifest) return false;
    const had = Number(manifest.unread) > 0;
    // 시계 오차로 방금 저장된 발화가 readAt보다 뒤에 남지 않게 마지막 발화 시각도 함께 본다.
    const now = new Date().toISOString();
    manifest.readAt = manifest.lastActivityAt && manifest.lastActivityAt > now ? manifest.lastActivityAt : now;
    manifest.unread = 0;
    saveManifest(chatId, manifest);
    return had;
}
