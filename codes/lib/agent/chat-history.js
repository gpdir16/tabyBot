import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";

import { STOP_BY_USER_HINT } from "./session.js";

const HISTORY_VERSION = 3;
const MANIFEST_VERSION = 1;

export const RECOVERY_PROMPT =
    "Internal continuation instruction: continue the same task naturally from the current conversation state. Treat the existing messages and tool results as completed work, do not restart completed work, and inspect the current state before retrying an incomplete tool. Do not mention this continuation or any internal recovery to the user.";

const INTERNAL_USER_HINTS = new Set([
    "You have enough tool output. Stop calling tools. Reply to the user in plain text now using results you already have.",
    STOP_BY_USER_HINT,
    RECOVERY_PROMPT,
]);

const RECOVERABLE_TURN_STATUSES = new Set(["pending", "in_progress", "interrupted"]);

function safeSessionKey(sessionKey) {
    return (
        String(sessionKey || "")
            .replace(/:/g, "-")
            .replace(/[^0-9A-Za-z_-]/g, "") || "unknown"
    );
}

function chatTempRoot(sessionKey) {
    return path.join(USER_DIR, "temp", `chat-${safeSessionKey(sessionKey)}`);
}

function manifestPath(chatId) {
    return path.join(chatTempRoot(chatId), "manifest.json");
}

function activeSessionPath(chatId) {
    const manifest = loadManifest(chatId);
    if (!manifest?.activeSessionId) return null;
    const entry = manifest.sessions?.find((s) => s.id === manifest.activeSessionId);
    if (!entry?.file) return null;
    return path.join(chatTempRoot(chatId), entry.file);
}

function readJson(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function nextSessionId(manifest) {
    let max = 0;
    for (const entry of manifest.sessions || []) {
        const m = /^s(\d+)$/.exec(entry.id || "");
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `s${String(max + 1).padStart(6, "0")}`;
}

function sessionPayload({ sessionId, turns, extra = {} }) {
    return {
        version: HISTORY_VERSION,
        sessionId,
        turns: turns || [],
        ...extra,
    };
}

function ensureManifest(chatId) {
    const mPath = manifestPath(chatId);
    let manifest = readJson(mPath, null);
    if (manifest?.activeSessionId && Array.isArray(manifest.sessions) && manifest.sessions.length) {
        return manifest;
    }

    const sessionId = "s000001";
    const relFile = `sessions/${sessionId}.json`;
    const root = chatTempRoot(chatId);
    const now = new Date().toISOString();

    writeJson(path.join(root, relFile), sessionPayload({ sessionId, turns: [] }));
    manifest = {
        version: MANIFEST_VERSION,
        activeSessionId: sessionId,
        sessions: [
            {
                id: sessionId,
                file: relFile,
                startedAt: now,
                closedAt: null,
                kind: "active",
            },
        ],
    };
    writeJson(mPath, manifest);
    return manifest;
}

function loadManifest(chatId) {
    if (!chatId) return null;
    return readJson(manifestPath(chatId), null);
}

function saveManifest(chatId, manifest) {
    writeJson(manifestPath(chatId), manifest);
}

function readActiveSessionData(chatId) {
    if (!chatId) return { turns: [] };
    ensureManifest(chatId);
    const filePath = activeSessionPath(chatId);
    if (!filePath || !fs.existsSync(filePath)) {
        return { turns: [] };
    }
    const data = readJson(filePath, {});
    let turns = Array.isArray(data.turns) ? data.turns : [];
    // Backward compat: old session files stored compressedSummary as a separate field.
    // Migrate it into a system-message turn so the session file is purely turns.
    if (typeof data.compressedSummary === "string" && data.compressedSummary.trim()) {
        const hasSummaryTurn = turns.some(
            (t) =>
                Array.isArray(t?.messages) &&
                t.messages.some((m) => m?.role === "system" && typeof m?.content === "string" && m.content.includes("compressed summary")),
        );
        if (!hasSummaryTurn) {
            turns = [
                {
                    at: new Date().toISOString(),
                    messages: [
                        {
                            role: "system",
                            content: `## Earlier conversation (compressed summary — your own past context, not a user message)\n\n${data.compressedSummary.trim()}`,
                        },
                    ],
                },
                ...turns,
            ];
        }
    }
    return { turns };
}

function writeActiveSessionData(chatId, turns) {
    if (!chatId) return;
    const manifest = ensureManifest(chatId);
    const entry = manifest.sessions.find((s) => s.id === manifest.activeSessionId);
    if (!entry?.file) return;
    const filePath = path.join(chatTempRoot(chatId), entry.file);
    writeJson(
        filePath,
        sessionPayload({
            sessionId: manifest.activeSessionId,
            turns,
        }),
    );
}

export function cloneStoredMessage(message) {
    return JSON.parse(JSON.stringify(message));
}

export function isInternalStoredMessage(message) {
    return message?.role === "user" && INTERNAL_USER_HINTS.has(message.content);
}

export function stripMarkdownForPreview(text) {
    let s = String(text || "");
    if (!s) return "";
    s = s.replace(/```[\s\S]*?```/g, " ");
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
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
    if (typeof message.content !== "string") return "";
    const cut = message.content.indexOf("[User attached files]");
    const text = cut === -1 ? message.content : message.content.slice(0, cut).trim();
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

export function turnToMessages(turn) {
    if (Array.isArray(turn?.messages) && turn.messages.length) {
        return turn.messages;
    }
    const out = [];
    if (turn?.user?.trim()) out.push({ role: "user", content: turn.user });
    if (turn?.assistant?.trim()) out.push({ role: "assistant", content: turn.assistant });
    return out;
}

export function extractTurnMessages(messages, fromIndex) {
    return messages
        .slice(fromIndex)
        .filter((m) => !isInternalStoredMessage(m))
        .map(cloneStoredMessage);
}

export function loadChatHistory(chatId) {
    return readActiveSessionData(chatId).turns;
}

export function clearChatHistory(chatId) {
    if (!chatId) return;
    const manifest = ensureManifest(chatId);
    const now = new Date().toISOString();
    const activeEntry = manifest.sessions.find((s) => s.id === manifest.activeSessionId);
    if (activeEntry) {
        activeEntry.closedAt = now;
        activeEntry.kind = "archived";
    }

    const newId = nextSessionId(manifest);
    const relFile = `sessions/${newId}.json`;
    writeJson(path.join(chatTempRoot(chatId), relFile), sessionPayload({ sessionId: newId, turns: [], extra: { startedAfterClear: true } }));

    manifest.sessions.push({
        id: newId,
        file: relFile,
        startedAt: now,
        closedAt: null,
        kind: "active",
        parentSessionId: activeEntry?.id || null,
    });
    manifest.activeSessionId = newId;
    saveManifest(chatId, manifest);
}

export function replaceChatHistory(chatId, turns) {
    if (!chatId) return;
    writeActiveSessionData(chatId, turns);
}

// After compression: archive full session on disk; active file keeps recent turns.
// The compressed summary is stored as a system-message turn at the start of the new session.
export function replaceChatHistoryAfterCompression(chatId, recentTurns, summary) {
    if (!chatId) return null;
    const manifest = ensureManifest(chatId);
    const oldId = manifest.activeSessionId;
    const now = new Date().toISOString();

    const oldEntry = manifest.sessions.find((s) => s.id === oldId);
    if (oldEntry) {
        oldEntry.closedAt = now;
        oldEntry.kind = "archived";
        oldEntry.archiveReason = "context_compression";
    }

    const summaryTurn = summary?.trim()
        ? [
              {
                  at: now,
                  messages: [
                      {
                          role: "system",
                          content: `## Earlier conversation (compressed summary — your own past context, not a user message)\n\n${summary.trim()}`,
                      },
                  ],
              },
          ]
        : [];
    const cleanRecentTurns = recentTurns.filter(
        (t) =>
            !Array.isArray(t?.messages) ||
            !t.messages.some((m) => m?.role === "system" && typeof m?.content === "string" && m.content.includes("compressed summary")),
    );
    const turns = [...summaryTurn, ...cleanRecentTurns];

    const newId = nextSessionId(manifest);
    const relFile = `sessions/${newId}.json`;
    writeJson(
        path.join(chatTempRoot(chatId), relFile),
        sessionPayload({
            sessionId: newId,
            turns,
            extra: {
                parentSessionId: oldId,
                compressedFromSessionId: oldId,
                compressedAt: now,
            },
        }),
    );

    manifest.sessions.push({
        id: newId,
        file: relFile,
        startedAt: now,
        closedAt: null,
        kind: "active",
        parentSessionId: oldId,
        compressedFromSessionId: oldId,
    });
    manifest.activeSessionId = newId;
    manifest.lastCompressedAt = now;
    saveManifest(chatId, manifest);

    console.log(`tabyBot: archived session ${oldId}, active session is now ${newId} (${turns.length} turns including compressed summary)`);
    return { archivedSessionId: oldId, activeSessionId: newId, sessionFile: relFile };
}

function sanitizeTurnStats(stats) {
    if (!stats || typeof stats !== "object") return null;
    const toolCallCount = Number(stats.toolCallCount);
    const modelCallCount = Number(stats.modelCallCount);
    const tokensUsed = Number(stats.tokensUsed);
    const contextWindow = Number(stats.contextWindow);
    if (![toolCallCount, modelCallCount, tokensUsed, contextWindow].some((n) => Number.isFinite(n) && n > 0)) return null;
    return {
        toolCallCount: Number.isFinite(toolCallCount) ? toolCallCount : 0,
        modelCallCount: Number.isFinite(modelCallCount) ? modelCallCount : 0,
        tokensUsed: Number.isFinite(tokensUsed) ? tokensUsed : 0,
        contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
    };
}

function writePreview(chatId, turns) {
    try {
        const manifest = loadManifest(chatId);
        if (!manifest) return;
        const text = previewSnippetFromTurns(turns);
        if (text) manifest.preview = text;
        saveManifest(chatId, manifest);
    } catch (_) {}
}

const PENDING_USER_PREFIX = "The user sent additional message(s) while you were working:";

function userContentsFromTurnMessages(turnMessages) {
    const out = [];
    for (const m of turnMessages || []) {
        if (m?.role !== "user" || typeof m.content !== "string") continue;
        if (isInternalStoredMessage(m)) continue;
        const content = m.content;
        if (content.startsWith(PENDING_USER_PREFIX)) {
            for (const part of content.slice(PENDING_USER_PREFIX.length).split("\n\n")) {
                const clean = part.trim();
                if (clean) out.push(clean);
            }
            continue;
        }
        out.push(content);
    }
    return out;
}

export function appendPendingUserTurn(chatId, userText, attachments = []) {
    const text = String(userText || "").trim();
    if (!chatId || (!text && !attachments.length)) return;

    const turns = loadChatHistory(chatId);
    const last = turns[turns.length - 1];
    const lastMsgs = last?.messages || [];
    const lastMsg = lastMsgs[lastMsgs.length - 1];
    if (lastMsgs.length === 1 && lastMsg?.role === "user" && lastMsg.content === text) return;

    turns.push({
        at: new Date().toISOString(),
        status: "pending",
        messages: [{ role: "user", content: text, ...(attachments.length ? { attachments } : {}) }],
    });
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}

export function checkpointChatTurn(chatId, turnMessages, { baseMessages = null } = {}) {
    if (!chatId || !turnMessages?.length) return;

    const turns = loadChatHistory(chatId);
    let targetIndex = turns.length - 1;
    while (targetIndex > 0 && RECOVERABLE_TURN_STATUSES.has(turns[targetIndex - 1]?.status)) targetIndex -= 1;
    const target = turns[targetIndex];
    const messages = Array.isArray(baseMessages) ? [...baseMessages, ...turnMessages.map(cloneStoredMessage)] : turnMessages.map(cloneStoredMessage);
    const checkpoint = {
        at: target?.at || new Date().toISOString(),
        status: "in_progress",
        checkpointAt: new Date().toISOString(),
        messages,
    };

    if (target && RECOVERABLE_TURN_STATUSES.has(target.status)) turns[targetIndex] = checkpoint;
    else turns.push(checkpoint);
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}

export function markChatTurnInterrupted(chatId) {
    if (!chatId) return false;
    const turns = loadChatHistory(chatId);
    let start = turns.length;
    while (start > 0 && RECOVERABLE_TURN_STATUSES.has(turns[start - 1]?.status)) start -= 1;
    if (start === turns.length) return false;
    const interruptedAt = new Date().toISOString();
    for (let i = start; i < turns.length; i += 1) {
        turns[i].status = "interrupted";
        turns[i].interruptedAt = interruptedAt;
    }
    replaceChatHistory(chatId, turns);
    return true;
}

export function hasRecoverableChatTurn(chatId) {
    const turns = loadChatHistory(chatId);
    return RECOVERABLE_TURN_STATUSES.has(turns.at(-1)?.status);
}

export function prepareChatTurnRecovery(chatId) {
    if (!chatId) return false;
    const turns = loadChatHistory(chatId);
    let start = turns.length;
    while (start > 0 && RECOVERABLE_TURN_STATUSES.has(turns[start - 1]?.status)) start -= 1;
    if (start === turns.length) return false;

    const recoverable = turns.slice(start);
    const messages = recoverable.flatMap((turn) => (turn.messages || []).map(cloneStoredMessage));
    const completedToolCalls = new Set(messages.filter((message) => message?.role === "tool").map((message) => message.tool_call_id));
    const repairedMessages = [];
    for (const message of messages) {
        repairedMessages.push(message);
        if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
        for (const toolCall of message.tool_calls) {
            if (!toolCall?.id || completedToolCalls.has(toolCall.id)) continue;
            repairedMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: "No durable result was recorded for this tool call. Inspect the current state before retrying it if needed.",
            });
        }
    }

    turns.splice(start, recoverable.length, {
        at: recoverable[0]?.at || new Date().toISOString(),
        status: "interrupted",
        interruptedAt: new Date().toISOString(),
        messages: repairedMessages,
    });
    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
    return true;
}

export function lastChatTurnMessages(chatId) {
    const last = loadChatHistory(chatId).at(-1);
    return last?.messages?.map(cloneStoredMessage) || [];
}

export function appendChatTurn(chatId, turnMessages, extra = {}) {
    if (!chatId || !turnMessages?.length) return;

    const turns = loadChatHistory(chatId);
    const stats = sanitizeTurnStats(extra.stats);
    const storedMessages = turnMessages.map(cloneStoredMessage);
    if (extra.attachments?.length) {
        const userMessage = storedMessages.find((message) => message?.role === "user");
        if (userMessage) userMessage.attachments = extra.attachments;
    }

    const incomingUsers = userContentsFromTurnMessages(turnMessages);
    while (turns.length && incomingUsers.length) {
        const pending = turns[turns.length - 1];
        const msgs = pending?.messages || [];
        if (msgs.length !== 1 || msgs[0]?.role !== "user") break;
        const idx = incomingUsers.lastIndexOf(msgs[0].content);
        if (idx < 0) break;
        incomingUsers.splice(idx, 1);
        turns.pop();
    }

    const last = turns[turns.length - 1];
    // 복구 턴은 기존 체크포인트와 새 실행분을 하나의 완료 턴으로 확정한다.
    if (last && (last.status === "in_progress" || last.status === "interrupted")) {
        const completedMessages = Array.isArray(extra.baseMessages)
            ? [...extra.baseMessages.map(cloneStoredMessage), ...storedMessages]
            : storedMessages;
        turns[turns.length - 1] = {
            at: last.at || new Date().toISOString(),
            messages: completedMessages,
            ...(stats ? { stats } : {}),
        };
    } else {
        turns.push({
            at: new Date().toISOString(),
            messages: storedMessages,
            ...(stats ? { stats } : {}),
        });
    }

    replaceChatHistory(chatId, turns);
    writePreview(chatId, turns);
}

export function listArchivedSessionFiles(chatId) {
    const manifest = loadManifest(chatId);
    if (!manifest?.sessions?.length) return [];
    const activeId = manifest.activeSessionId;
    const root = chatTempRoot(chatId);
    return manifest.sessions
        .filter((s) => s.id !== activeId)
        .map((s) => ({
            ...s,
            absolutePath: path.join(root, s.file),
        }))
        .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}

const PAST_SESSIONS_PROMPT_LIMIT = 4;

export function formatPastSessionsForPrompt(chatId) {
    if (!chatId) return "- (none archived)";
    const archived = listArchivedSessionFiles(chatId).slice(0, PAST_SESSIONS_PROMPT_LIMIT);
    if (!archived.length) return "- (none archived)";

    return archived
        .map((s) => {
            const data = readJson(s.absolutePath, {});
            const turnCount = Array.isArray(data.turns) ? data.turns.length : 0;
            const rel = path.relative(USER_DIR, s.absolutePath).split(path.sep).join("/");
            const parts = [`session ${s.id}`, `${turnCount} turns`];
            if (s.archiveReason === "context_compression") parts.push("archived before context compression");
            if (s.closedAt) parts.push(`closed ${s.closedAt}`);
            return `- \`${rel}\` — ${parts.join(", ")}`;
        })
        .join("\n");
}
