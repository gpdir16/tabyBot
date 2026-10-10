// 대화 인덱스: 에이전트당 하나의 스레드. 디스크는 user/session/<agent-uuid>/.
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../atomic-file.js";
import { firstAgentId, getAgentByUuid, listAgents } from "../agents-store.js";
import { isAgentSessionRunning } from "../agent/session.js";
import {
    conversationDir,
    lastActivityAtFromTurns,
    loadChatHistory,
    loadFullChatHistory,
    markChatRead,
    previewSnippetFromTurns,
    stripMarkdownForPreview,
} from "../agent/chat-history.js";
import { PENDING_USER_PREFIX, isScheduledTurnText, stripAttachedFiles } from "../agent/history/messages.js";
import { isInternalHintText, isSilentMarkedText, sayTextsFromMessage } from "../agent/history/messages.js";

// ── 대화 인덱스: 에이전트당 하나의 스레드. 디스크는 user/session/<agent-uuid>/. ──

function manifestPath(id) {
    const dir = conversationDir(id);
    return dir ? path.join(dir, "manifest.json") : null;
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
    const manifest = readJsonFile(mPath);
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
            writeJsonAtomic(mPath, manifest);
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

export function getConversationDetail(id) {
    const meta = getConversationMeta(id);
    if (!meta) return null;
    let turns = [];
    try {
        turns = loadFullChatHistory(id);
    } catch {
        turns = [];
    }
    return { ...meta, turns: toDisplayTurns(turns) };
}

// 메시지 전문 검색: 모든 에이전트의 전체 세션(아카이브 포함)에서 표시용 발화 텍스트를 찾는다.
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
            turns = toDisplayTurns(loadFullChatHistory(agent.uuid));
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

// ── 저장된 대화 기록(턴)을 화면에 보여 줄 모양으로 바꾼다. ──

// 도구 결과 프레임, 내부 지시문, 침묵 답변, 예약 실행 표식은 숨기고
// 작업 중에 합쳐 넣은 사용자 메시지는 일반 발화로 풀어 준다.

// 파일 경로 같은 서버 내부 정보를 뺀다.
function publicMessage(message) {
    if (!message?.attachments) return message;
    return {
        ...message,
        attachments: message.attachments.map(({ filePath, ...rest }) => rest),
    };
}

const withTime = (m) => (m.at ? { at: m.at } : {});

// 큐에 들어갔던 같은 발화의 단독 pending 턴이 남아 있으면 화면에 두 번 보인다.
function isDuplicateOfQueued(turn, rawMessages, queuedSeen) {
    return (
        turn?.status === "pending" &&
        rawMessages.length === 1 &&
        rawMessages[0]?.role === "user" &&
        typeof rawMessages[0].content === "string" &&
        queuedSeen.has(stripAttachedFiles(rawMessages[0].content).trim())
    );
}

// assistant 메시지 → 화면용 메시지 목록(보이지 않으면 빈 배열).
function displayAssistant(m) {
    // 툴 호출이 딸린 메시지의 본문은 내부 메모: user_say 호출의 text 인자만 사용자용 발화로 꺼내 버블로 남긴다.
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        return sayTextsFromMessage(m)
            .filter((said) => !isSilentMarkedText(said))
            .map((said) => ({ role: "assistant", content: said, ...withTime(m) }));
    }
    const text = String(m.content || "").trim();
    if (!text && !m.attachments?.length) return [];
    // 침묵 마커는 그 메시지 하나만 숨긴다. 이미 보낸 중간 발화까지 소급 회수하지 않는다.
    if (isSilentMarkedText(text)) return [];
    return [m.attachments ? publicMessage(m) : m];
}

// 작업 중 보낸 메시지들(머리말 뒤에 빈 줄로 이어 붙은 것)을 일반 사용자 메시지로 분해한다.
function splitPendingUserMessage(m, content, queuedSeen) {
    const out = [];
    for (const part of content.slice(PENDING_USER_PREFIX.length).split("\n\n")) {
        const clean = stripAttachedFiles(part.trim());
        if (clean) queuedSeen.add(clean);
        if (clean || m.attachments?.length) {
            out.push(publicMessage({ role: "user", content: clean, ...withTime(m), ...(m.attachments ? { attachments: m.attachments } : {}) }));
        }
    }
    return out;
}

// user 메시지 → 화면용 메시지 목록.
function displayUser(m, queuedSeen) {
    if (isScheduledTurnText(m.content)) return [];
    const content = stripAttachedFiles(m.content);
    if (isInternalHintText(content.trim())) return []; // 순수 내부 지시는 숨김
    if (content.startsWith(PENDING_USER_PREFIX)) return splitPendingUserMessage(m, content, queuedSeen);
    if (!content && !m.attachments?.length) return [];
    return [publicMessage({ ...m, content })];
}

function displayMessage(m, queuedSeen) {
    // 비전 도구의 스크린샷 결과는 user role + 배열 본문으로 주입된다.
    // 사용자 발화가 아닌 내부 도구 에코이므로 버블로 만들지 않는다.
    if (m?.role === "user" && Array.isArray(m.content)) return [];
    // 도구 결과 프레임은 라이브 카드로만 보여준다. 발화 텍스트는 메신저 기록으로 남긴다.
    if (m?.role === "tool") return [];
    if (m?.role === "assistant") return displayAssistant(m);
    if (m?.role === "user" && typeof m.content === "string") return displayUser(m, queuedSeen);
    return [m?.attachments ? publicMessage(m) : m];
}

export function toDisplayTurns(rawTurns) {
    const turns = [];
    // 실행 중 주입된 큐 메시지 텍스트: 이미 래핑 본문으로 표시된 텍스트는 여기서 기억한다.
    const queuedSeen = new Set();
    for (const turn of rawTurns || []) {
        const rawMessages = turn?.messages || [];
        if (isDuplicateOfQueued(turn, rawMessages, queuedSeen)) continue;
        const messages = rawMessages.flatMap((m) => displayMessage(m, queuedSeen));
        // 도구 프레임 제거로 빈 turn이 되면 아예 생략
        if (messages.some((m) => m.role === "user" || m.role === "assistant")) turns.push({ ...turn, messages });
    }
    return turns;
}
