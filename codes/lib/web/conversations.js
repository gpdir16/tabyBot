// 대화 인덱스: 에이전트당 하나의 스레드. 디스크는 user/session/<agent-uuid>/.
import fs from "node:fs";
import path from "node:path";
import { firstAgentId, getAgentByUuid, listAgents } from "../agents-store.js";
import { RECOVERY_PROMPT, conversationDir, loadChatHistory, previewSnippetFromTurns, stripMarkdownForPreview } from "../agent/chat-history.js";

function manifestPath(id) {
    const dir = conversationDir(id);
    return dir ? path.join(dir, "manifest.json") : null;
}

function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function isValidId(id) {
    return Boolean(conversationDir(id));
}

export function ensureConversation(id) {
    if (!isValidId(id)) return null;
    if (!readMeta(id)) loadChatHistory(id);
    return readMeta(id);
}

function statTime(file, key = "mtimeMs") {
    try {
        return fs.statSync(file)[key];
    } catch {
        return 0;
    }
}

function toIso(ms) {
    return ms ? new Date(ms).toISOString() : null;
}

function readMeta(id) {
    const mPath = manifestPath(id);
    const dir = conversationDir(id);
    if (!mPath || !dir) return null;
    const manifest = readJson(mPath);
    if (!manifest?.activeSessionId) return null;
    const updatedAt = Math.max(statTime(mPath), statTime(path.join(dir, "sessions", `${manifest.activeSessionId}.json`)));
    const createdAt = statTime(mPath, "birthtimeMs") || statTime(mPath);
    let preview = typeof manifest.preview === "string" ? stripMarkdownForPreview(manifest.preview) : "";
    // preview가 없거나 빈 문자열이면 히스토리에서 마지막 발화를 채운다.
    if (!preview) {
        try {
            preview = previewSnippetFromTurns(loadChatHistory(id));
        } catch {
            preview = "";
        }
    }
    if (preview && manifest.preview !== preview) {
        try {
            manifest.preview = preview;
            writeJson(mPath, manifest);
        } catch {
            /* 목록 응답은 유지 */
        }
    }
    return {
        id,
        preview: typeof preview === "string" ? preview : "",
        agentId: getAgentByUuid(id)?.id || firstAgentId(),
        createdAt: toIso(createdAt),
        updatedAt: toIso(updatedAt),
    };
}

export function listConversations() {
    const metas = [];
    for (const agent of listAgents()) {
        const meta = readMeta(agent.uuid);
        if (meta) metas.push(meta);
    }
    metas.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return metas;
}

export function getConversationMeta(id) {
    if (!isValidId(id)) return null;
    return readMeta(id);
}

// 히스토리의 내부 주입 프롬프트를 화면용으로 정규화한다.
const PENDING_PREFIX = "The user sent additional message(s) while you were working:";
const ATTACHED_FILES_MARK = "[User attached files]";
const INTERNAL_HINTS = [
    "You have enough tool output. Stop calling tools. Reply to the user in plain text now using results you already have.",
    "The user pressed Stop. Stop immediately. Do not call more tools. Reply briefly with progress and what remains.",
    RECOVERY_PROMPT,
];
function stripAttachedFilesPrompt(content) {
    const s = String(content || "");
    const i = s.indexOf(ATTACHED_FILES_MARK);
    return i === -1 ? s : s.slice(0, i).trim();
}
function publicUserMessage(message) {
    if (!message?.attachments) return message;
    return {
        ...message,
        attachments: message.attachments.map(({ filePath, ...rest }) => rest),
    };
}
function toDisplayTurns(rawTurns) {
    const turns = [];
    for (const turn of rawTurns || []) {
        const messages = [];
        for (const m of turn?.messages || []) {
            // 도구 호출/결과 프레임은 라이브 카드로만 보여준다. 히스토리에는 최종 텍스트만.
            if (m?.role === "tool") continue;
            if (m?.role === "assistant" && String(m.content || "").trim() === "__SILENT__") continue;
            if (m?.role === "user" && typeof m.content === "string" && m.content.includes("[tabybot-scheduled]")) continue;
            if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length && !String(m.content || "").trim()) continue;
            if (m?.role !== "user" || typeof m.content !== "string") {
                messages.push(m?.attachments ? publicUserMessage(m) : m);
                continue;
            }
            const content = stripAttachedFilesPrompt(m.content);
            if (INTERNAL_HINTS.includes(content.trim())) continue; // 순수 내부 지시는 숨김
            if (content.startsWith(PENDING_PREFIX)) {
                // 실행 중 보낸 메시지들은 일반 사용자 메시지로 분해해 표시
                for (const part of content.slice(PENDING_PREFIX.length).split("\n\n")) {
                    const clean = stripAttachedFilesPrompt(part.trim());
                    if (clean || m.attachments?.length) {
                        messages.push(publicUserMessage({ role: "user", content: clean, ...(m.attachments ? { attachments: m.attachments } : {}) }));
                    }
                }
                continue;
            }
            if (!content && !m.attachments?.length) continue;
            messages.push(publicUserMessage({ ...m, content }));
        }
        // 도구 프레임 제거로 빈 turn이 되면 아예 생략
        if (messages.some((m) => m.role === "user" || m.role === "assistant")) turns.push({ ...turn, messages });
    }
    return turns;
}

export function getConversationDetail(id) {
    const meta = getConversationMeta(id);
    if (!meta) return null;
    let turns = [];
    try {
        turns = loadChatHistory(id);
    } catch {
        turns = [];
    }
    return { ...meta, turns: toDisplayTurns(turns) };
}
