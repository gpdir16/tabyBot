// 대화 인덱스: 에이전트당 하나의 스레드. 디스크는 user/session/<agent-uuid>/.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../atomic-file.js";
import { firstAgentId, getAgentByUuid, listAgents } from "../agents-store.js";
import { isAgentSessionRunning } from "../agent/session.js";
import {
    RECOVERY_PROMPT,
    conversationDir,
    isSilentMarkedText,
    lastActivityAtFromTurns,
    loadChatHistory,
    markChatRead,
    previewSnippetFromTurns,
    sayTextsFromMessage,
    stripMarkdownForPreview,
} from "../agent/chat-history.js";

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
    writeJsonAtomic(file, data);
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
    const createdAt = statTime(mPath, "birthtimeMs") || statTime(mPath);
    // 목록 정렬은 실제 발화 시각(lastActivityAt)이 정본이다. mtime은
    // 압축·백필 같은 내부 쓰기에도 갱신돼 최신 순서를 깨뜨린다.
    let lastActivityAt = typeof manifest.lastActivityAt === "string" ? manifest.lastActivityAt : "";
    let turnsCache = null;
    const ensureTurns = () => (turnsCache ??= loadChatHistory(id));
    let manifestDirty = false;
    if (!lastActivityAt) {
        try {
            lastActivityAt = lastActivityAtFromTurns(ensureTurns());
            if (lastActivityAt) {
                manifest.lastActivityAt = lastActivityAt;
                manifestDirty = true;
            }
        } catch {
            /* 세션 읽기 실패 시 mtime으로 폴백한다 */
        }
    }
    const updatedAt = lastActivityAt || toIso(Math.max(statTime(mPath), statTime(path.join(dir, "sessions", `${manifest.activeSessionId}.json`))));
    let preview = typeof manifest.preview === "string" ? stripMarkdownForPreview(manifest.preview) : "";
    // preview가 없거나 빈 문자열이면 히스토리에서 마지막 발화를 채운다.
    if (!preview) {
        try {
            preview = previewSnippetFromTurns(ensureTurns());
        } catch {
            preview = "";
        }
    }
    if (preview && manifest.preview !== preview) {
        manifest.preview = preview;
        manifestDirty = true;
    }
    if (manifestDirty) {
        try {
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
        // 클라이언트가 SSE 재접속 사이에 놓친 turn_done을 정합한다.
        running: isAgentSessionRunning(id),
        // 사용자가 아직 읽지 않은 에이전트 발화 수(사이드바 배지).
        unread: Number(manifest.unread) > 0 ? Number(manifest.unread) : 0,
    };
}

// 대화를 읽음 처리한다. 상태가 실제로 바뀌었으면 true.
export function markConversationRead(id) {
    if (!isValidId(id)) return false;
    return markChatRead(id);
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
    // 실행 중 주입된 큐 메시지 텍스트: 같은 발화의 단독 pending 턴이 남아 있으면
    // 화면에 두 번 보이므로, 이미 래핑 본문으로 표시된 텍스트는 여기서 기억한다.
    const queuedSeen = new Set();
    for (const turn of rawTurns || []) {
        const rawMessages = turn?.messages || [];
        if (
            turn?.status === "pending" &&
            rawMessages.length === 1 &&
            rawMessages[0]?.role === "user" &&
            typeof rawMessages[0].content === "string" &&
            queuedSeen.has(stripAttachedFilesPrompt(rawMessages[0].content).trim())
        ) {
            continue;
        }
        const messages = [];
        for (const m of rawMessages) {
            // 비전 도구의 스크린샷 결과는 user role + 배열 본문으로 주입된다.
            // 사용자 발화가 아닌 내부 도구 에코이므로 버블로 만들지 않는다.
            if (m?.role === "user" && Array.isArray(m.content)) continue;
            // 도구 결과 프레임은 라이브 카드로만 보여준다. 발화 텍스트는 메신저 기록으로 남긴다.
            if (m?.role === "tool") continue;
            if (m?.role === "assistant") {
                // 툴 호출이 딸린 메시지의 본문은 내부 메모: user_say 호출의
                // text 인자만 사용자용 발화로 꺼내 버블로 남긴다.
                if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
                    for (const said of sayTextsFromMessage(m)) {
                        if (isSilentMarkedText(said)) continue;
                        messages.push({ role: "assistant", content: said, ...(m.at ? { at: m.at } : {}) });
                    }
                    continue;
                }
                const text = String(m.content || "").trim();
                if (!text && !m.attachments?.length) continue;
                // 침묵 마커는 그 메시지 하나만 숨긴다. 이미 보낸 중간 발화까지 소급 회수하지 않는다.
                if (isSilentMarkedText(text)) continue;
                messages.push(m?.attachments ? publicUserMessage(m) : m);
                continue;
            }
            if (m?.role === "user" && typeof m.content === "string" && m.content.includes("[tabybot-scheduled]")) continue;
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
                    if (clean) queuedSeen.add(clean);
                    if (clean || m.attachments?.length) {
                        messages.push(
                            publicUserMessage({
                                role: "user",
                                content: clean,
                                ...(m.at ? { at: m.at } : {}),
                                ...(m.attachments ? { attachments: m.attachments } : {}),
                            }),
                        );
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

// 메시지 전문 검색: 모든 에이전트의 활성 세션에서 표시용 발화 텍스트를 찾는다.
// 반환 인덱스는 toDisplayTurns 기준: 클라이언트는 같은 순서로 턴을 받으므로
// turnIndex/messageIndex로 곧장 그 행을 찾을 수 있다.
export function searchMessages(query, { limit = 30 } = {}) {
    const q = String(query || "")
        .trim()
        .toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const agent of listAgents()) {
        let turns;
        try {
            turns = toDisplayTurns(loadChatHistory(agent.uuid));
        } catch {
            continue;
        }
        for (let t = turns.length - 1; t >= 0; t--) {
            const messages = turns[t].messages || [];
            for (let m = messages.length - 1; m >= 0; m--) {
                const msg = messages[m];
                const text = typeof msg.content === "string" ? msg.content : "";
                const idx = text.toLowerCase().indexOf(q);
                if (idx === -1) continue;
                const from = Math.max(0, idx - 60);
                const to = Math.min(text.length, idx + q.length + 60);
                hits.push({
                    conversationId: agent.uuid,
                    turnIndex: t,
                    messageIndex: m,
                    role: msg.role,
                    at: msg.at || turns[t].at || null,
                    snippet: `${from ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`,
                });
                if (hits.length >= limit * 4) break;
            }
            if (hits.length >= limit * 4) break;
        }
        if (hits.length >= limit * 4) break;
    }
    hits.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return hits.slice(0, limit);
}
