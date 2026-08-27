// 대화(컨버세이션) 인덱스: chat-history의 세션 저장소 위에서 목록·제목·에이전트를 관리한다.
// 저장 구조는 기존과 동일 — user/temp/chat-<sessionKey>/manifest.json + sessions/*.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "../paths.js";
import { firstAgentId } from "../agents-store.js";
import { loadChatHistory, previewSnippetFromTurns, stripMarkdownForPreview } from "../agent/chat-history.js";

const TEMP_ROOT = path.join(USER_DIR, "temp");

function conversationDir(id) {
    return path.join(TEMP_ROOT, `chat-${id}`);
}

function manifestPath(id) {
    return path.join(conversationDir(id), "manifest.json");
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

function isValidId(id) {
    return /^(web|cron)-[0-9a-zA-Z_-]{1,64}$/.test(String(id || ""));
}

function dirToId(dirName) {
    return dirName.startsWith("chat-") ? dirName.slice(5) : null;
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
    const manifest = readJson(manifestPath(id));
    if (!manifest?.activeSessionId) return null;
    const dir = conversationDir(id);
    const updatedAt = Math.max(statTime(manifestPath(id)), statTime(path.join(dir, "sessions", `${manifest.activeSessionId}.json`)));
    const createdAt = statTime(manifestPath(id), "birthtimeMs") || statTime(manifestPath(id));
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
            writeJson(manifestPath(id), manifest);
        } catch {
            /* 목록 응답은 유지 */
        }
    }
    return {
        id,
        title: typeof manifest.title === "string" && manifest.title.trim() ? manifest.title : null,
        preview: typeof preview === "string" ? preview : "",
        agentId: manifest.agentId || firstAgentId(),
        createdAt: toIso(createdAt),
        updatedAt: toIso(updatedAt),
    };
}

export function listConversations() {
    let entries = [];
    try {
        entries = fs.readdirSync(TEMP_ROOT, { withFileTypes: true });
    } catch {
        return [];
    }
    const metas = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const id = dirToId(entry.name);
        if (!id) continue;
        const meta = readMeta(id);
        if (meta) metas.push(meta);
    }
    metas.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return metas;
}

export function getConversationMeta(id) {
    if (!isValidId(id)) return null;
    return readMeta(id);
}

function writeFreshManifest(id, agentId) {
    const now = new Date().toISOString();
    writeJson(manifestPath(id), {
        version: 1,
        activeSessionId: "s000001",
        title: null,
        preview: "",
        agentId: agentId || firstAgentId(),
        createdAt: now,
        sessions: [
            {
                id: "s000001",
                file: "sessions/s000001.json",
                startedAt: now,
                closedAt: null,
                kind: "active",
            },
        ],
    });
    return readMeta(id);
}

export function createConversation(agentId = firstAgentId()) {
    const id = `web-${crypto.randomBytes(4).toString("hex")}`;
    return writeFreshManifest(id, agentId);
}

// 봇의 영구 스레드: 봇마다 하나뿐이며 삭제/초기화되지 않는다.
export function ensureAgentThread(agentId) {
    const id = `web-agent-${agentId}`;
    let meta = getConversationMeta(id);
    if (!meta) {
        meta = writeFreshManifest(id, agentId || firstAgentId());
    } else if (meta.agentId !== (agentId || firstAgentId())) {
        meta = setConversationAgent(id, agentId || firstAgentId()) || meta;
    }
    return meta;
}

export function renameConversation(id, title) {
    const meta = getConversationMeta(id);
    if (!meta) return null;
    const clean = String(title || "")
        .trim()
        .slice(0, 120);
    const manifest = readJson(manifestPath(id));
    manifest.title = clean || null;
    writeJson(manifestPath(id), manifest);
    return { ...meta, title: manifest.title };
}

// 첫 사용자 메시지로 제목을 한 번만 자동 지정한다.
export function ensureTitleFromMessage(id, text) {
    const meta = getConversationMeta(id);
    if (!meta || meta.title) return meta;
    const clean = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!clean) return meta;
    return renameConversation(id, clean.slice(0, 60));
}

export function setConversationAgent(id, agentId) {
    const meta = getConversationMeta(id);
    if (!meta) return null;
    const manifest = readJson(manifestPath(id));
    manifest.agentId = agentId || firstAgentId();
    writeJson(manifestPath(id), manifest);
    return { ...meta, agentId: manifest.agentId };
}

export function deleteConversation(id) {
    if (!isValidId(id)) return false;
    const dir = conversationDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
}

// 히스토리의 내부 주입 프롬프트를 화면용으로 정규화한다.
const PENDING_PREFIX = "The user sent additional message(s) while you were working:";
const ATTACHED_FILES_MARK = "[User attached files]";
const INTERNAL_HINTS = [
    "You have enough tool output. Stop calling tools. Reply to the user in plain text now using results you already have.",
    "The user pressed Stop. Stop immediately. Do not call more tools. Reply briefly with progress and what remains.",
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
