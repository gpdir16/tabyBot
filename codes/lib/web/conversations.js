// 대화 인덱스: 에이전트당 하나의 스레드. 디스크는 user/session/<agent-uuid>/.
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../atomic-file.js";
import { firstAgentId, getAgentByUuid, listAgents } from "../agents-store.js";
import { isGroupId, listGroups, parseMemberKey } from "../groups-store.js";
import { isAgentSessionAutomated, isAgentSessionRunning } from "../agent/session.js";
import {
    conversationDir,
    lastActivityAtFromTurns,
    loadChatHistory,
    loadFullChatHistory,
    markChatRead,
    previewSnippetFromTurns,
    stripMarkdownForPreview,
} from "../agent/chat-history.js";
import {
    PENDING_USER_PREFIX,
    isScheduledTurnText,
    isStandalonePendingTurn,
    stripAttachedFiles,
    userMessageIdsOf,
} from "../agent/history/messages.js";
import { isInternalHintText, isSilentMarkedText } from "../agent/history/messages.js";

// ── 대화 인덱스: 에이전트당 하나의 스레드. 디스크는 user/session/<agent-uuid>/. ──

function manifestPath(id) {
    const dir = conversationDir(id);
    return dir ? path.join(dir, "manifest.json") : null;
}

// 화면에서 여는 대화: 에이전트 스레드나 그룹 방. 그룹 안의 에이전트 세션은 내부용이라 열지 않는다.
function isValidId(id) {
    return Boolean(conversationDir(id)) && !parseMemberKey(id);
}

// 에이전트 하나의 스레드인가(예약 작업 결과처럼 에이전트가 혼자 올리는 곳).
export function isAgentThreadId(id) {
    return Boolean(getAgentByUuid(id));
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
        agentId: getAgentByUuid(id)?.id || (isGroupId(id) ? null : firstAgentId()),
        ...(isGroupId(id) ? { group: true } : {}),
        createdAt: toIso(createdAt),
        updatedAt: toIso(updatedAt),
        // 클라이언트가 SSE 재접속 사이에 놓친 turn_done을 정합한다.
        running: isAgentSessionRunning(id),
        // 자동 실행(예약·능동 체크인)은 답이 나오기 전까지 목록 순서를 건드리지 않는다.
        runningAutomated: isAgentSessionAutomated(id) || undefined,
        // 사용자가 아직 읽지 않은 에이전트 발화 수(사이드바 배지).
        unread: Number(manifest.unread) > 0 ? Number(manifest.unread) : 0,
    };
}

// 대화를 읽음 처리한다. 상태가 실제로 바뀌었으면 true.
export function markConversationRead(id) {
    if (!isValidId(id)) return false;
    return markChatRead(id);
}

// 화면에서 여는 대화의 id: 에이전트 스레드와 그룹 방.
function threadIds() {
    return [...listAgents().map((a) => a.uuid), ...listGroups().map((g) => g.id)];
}

export function listConversations() {
    const metas = [];
    for (const id of threadIds()) {
        const meta = readMeta(id);
        if (meta) metas.push(meta);
    }
    metas.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return metas;
}

// 기록 폴더가 있는 대화인가. 그룹 안의 에이전트 세션처럼 화면에서 열지 않는 대화도 포함한다.
export function hasConversation(id) {
    return Boolean(conversationDir(id) && readMeta(id));
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
    for (const id of threadIds()) {
        let turns;
        try {
            turns = toDisplayTurns(loadFullChatHistory(id));
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
                    conversationId: id,
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

// 실행 턴에 이미 합쳐진 메시지의 대기 턴이 남아 있으면 화면에 두 번 보인다. id로 가려낸다.
// id가 없는 예전 기록만 본문으로 비교한다(예전 방식으로 합쳐 넣은 발화와 같은 본문일 때).
function isDuplicateOfQueued(turn, absorbedIds, legacyQueuedSeen) {
    if (!isStandalonePendingTurn(turn)) return false;
    const message = turn.messages[0];
    if (message.id) return absorbedIds.has(message.id);
    return typeof message.content === "string" && legacyQueuedSeen.has(stripAttachedFiles(message.content).trim());
}

// 턴 안의 도구 결과를 호출 id로 찾는다. 질문 카드의 답·만료 상태를 되살리는 데 쓴다.
function toolResultsOf(messages) {
    const results = new Map();
    for (const m of messages || []) {
        if (m?.role !== "tool" || !m.tool_call_id) continue;
        try {
            results.set(m.tool_call_id, JSON.parse(m.content));
        } catch {
            results.set(m.tool_call_id, null);
        }
    }
    return results;
}

function parseToolArgs(tc) {
    try {
        return JSON.parse(tc?.function?.arguments || "{}");
    } catch {
        return null;
    }
}

// 저장된 user_ask·secret_request 호출을 질문 카드 메시지로 바꾼다.
// answer/error/resolved는 뒤따르는 도구 결과에서 나온다. 결과가 아직 없으면 답을 기다리는 카드다.
function askMessageFromToolCall(tc, result, at) {
    const name = tc?.function?.name;
    if (name !== "user_ask" && name !== "secret_request") return null;
    const args = parseToolArgs(tc);
    if (!args) return null;
    const secret = name === "secret_request";
    const meta = tc.ask && typeof tc.ask === "object" ? tc.ask : {};
    // 도구 호출 인자에는 모델이 쓴 원문이, ask 메타에는 설명을 분리한 질문이 들어 있다.
    // 화면 카드는 짧은 질문(meta.question)을 쓰고, 분리된 설명은 앞선 발화로 낸다.
    const question = String(meta.question || (secret ? args.name : args.question) || "").trim();
    if (!question) return null;
    const msg = {
        role: "ask",
        askId: typeof meta.askId === "string" ? meta.askId : null,
        question,
        preamble: typeof meta.preamble === "string" ? meta.preamble.trim() : "",
        options: secret ? [] : Array.isArray(args.options) ? args.options.map(String) : [],
        expiresAt: typeof meta.expiresAt === "string" ? meta.expiresAt : null,
        secret: secret ? String(args.name || "") : null,
        answer: null,
        resolved: result != null,
        ...(at ? { at } : {}),
    };
    if (result) {
        if (result.saved === true) msg.answer = { secretSaved: true };
        else if (typeof result.text === "string" && result.text) msg.answer = { text: result.text };
        else if (result.error) msg.error = String(result.error);
    }
    return msg;
}

// assistant 메시지 → 화면용 메시지 목록(보이지 않으면 빈 배열).
function displayAssistant(m, toolResults) {
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        // 툴 호출이 딸린 메시지의 본문은 내부 메모: user_say 호출의 text 인자만 사용자용 발화로 꺼내 버블로 남긴다.
        // 질문 카드는 도구 호출 순서 그대로 끼워 넣어 발화와 시간 순서가 섞이지 않게 한다.
        const out = [];
        for (const tc of m.tool_calls) {
            if (tc?.function?.name === "user_say") {
                const args = parseToolArgs(tc);
                const said = String(args?.text || "").trim();
                if (said && !isSilentMarkedText(said)) out.push({ role: "assistant", content: said, ...withTime(m) });
                continue;
            }
            const ask = askMessageFromToolCall(tc, toolResults?.get(tc.id), m.at);
            if (ask) {
                if (ask.preamble) out.push({ role: "assistant", content: ask.preamble, ...withTime(m) });
                out.push(ask);
            }
        }
        return out;
    }
    const text = String(m.content || "").trim();
    if (!text && !m.attachments?.length) return [];
    // 침묵 마커는 그 메시지 하나만 숨긴다. 이미 보낸 중간 발화까지 소급 회수하지 않는다.
    if (isSilentMarkedText(text)) return [];
    return [m.attachments ? publicMessage(m) : m];
}

// 작업 중에 합쳐 넣은 메시지 묶음을 메시지별 버블로 푼다. 저장된 메타가 정본이라
// 빈 줄이 든 메시지도 쪼개지지 않고, 메시지마다 제 id·시각·첨부를 갖는다.
function displayQueuedMessages(m) {
    return m.queued
        .filter((item) => String(item?.text || "").trim() || item?.attachments?.length)
        .map((item) =>
            publicMessage({
                role: "user",
                ...(item.id ? { id: item.id } : {}),
                content: String(item.text || "").trim(),
                ...(item.at || m.at ? { at: item.at || m.at } : {}),
                ...(item.attachments?.length ? { attachments: item.attachments } : {}),
            }),
        );
}

// 메타가 없는 예전 기록: 머리말 뒤에 빈 줄로 이어 붙은 본문을 일반 사용자 메시지로 분해한다.
function splitPendingUserMessage(m, content, legacyQueuedSeen) {
    const out = [];
    for (const part of content.slice(PENDING_USER_PREFIX.length).split("\n\n")) {
        const clean = stripAttachedFiles(part.trim());
        if (clean) legacyQueuedSeen.add(clean);
        if (clean || m.attachments?.length) {
            out.push(publicMessage({ role: "user", content: clean, ...withTime(m), ...(m.attachments ? { attachments: m.attachments } : {}) }));
        }
    }
    return out;
}

// user 메시지 → 화면용 메시지 목록.
function displayUser(m, legacyQueuedSeen) {
    if (isScheduledTurnText(m.content)) return [];
    if (Array.isArray(m.queued)) return displayQueuedMessages(m);
    const content = stripAttachedFiles(m.content);
    if (isInternalHintText(content.trim())) return []; // 순수 내부 지시는 숨김
    if (content.startsWith(PENDING_USER_PREFIX)) return splitPendingUserMessage(m, content, legacyQueuedSeen);
    if (!content && !m.attachments?.length) return [];
    return [publicMessage({ ...m, content })];
}

function displayMessage(m, legacyQueuedSeen, toolResults) {
    if (m?.role === "user" && Array.isArray(m.content)) {
        // 비전 도구의 스크린샷 결과는 user role + 배열 본문으로 주입된다.
        // 사용자 발화가 아닌 내부 도구 에코이므로 버블로 만들지 않는다.
        if (!m.id) return [];
        // id가 있으면 사용자가 보낸 메시지다(이미지 파트가 붙은 채 저장된 경우). 글 부분만 보인다.
        return displayUser({ ...m, content: m.content.find((part) => part?.type === "text")?.text || "" }, legacyQueuedSeen);
    }
    // 도구 결과 프레임은 라이브 카드로만 보여준다. 발화 텍스트는 메신저 기록으로 남긴다.
    if (m?.role === "tool") return [];
    if (m?.role === "assistant") return displayAssistant(m, toolResults);
    if (m?.role === "user" && typeof m.content === "string") return displayUser(m, legacyQueuedSeen);
    return [m?.attachments ? publicMessage(m) : m];
}

export function toDisplayTurns(rawTurns) {
    const turns = [];
    // 실행 턴(대기 턴이 아닌 턴)에 이미 들어 있는 사용자 메시지 id.
    const absorbedIds = new Set();
    for (const turn of rawTurns || []) {
        if (isStandalonePendingTurn(turn)) continue;
        for (const id of userMessageIdsOf(turn?.messages)) absorbedIds.add(id);
    }
    const legacyQueuedSeen = new Set();
    for (const turn of rawTurns || []) {
        if (isDuplicateOfQueued(turn, absorbedIds, legacyQueuedSeen)) continue;
        const toolResults = toolResultsOf(turn?.messages);
        const messages = (turn?.messages || []).flatMap((m) => displayMessage(m, legacyQueuedSeen, toolResults));
        // 도구 프레임 제거로 빈 turn이 되면 아예 생략. 질문 카드만 남은 턴도 화면에 남긴다.
        if (messages.some((m) => m.role === "user" || m.role === "assistant" || m.role === "ask")) turns.push({ ...turn, messages });
    }
    return turns;
}
