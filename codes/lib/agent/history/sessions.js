// 세션 단위 기록: 읽기/교체, 압축 후 새 세션, 지난 세션 요약.
import path from "node:path";
import { USER_DIR } from "../../paths.js";
import { readJsonFile, writeJsonAtomic } from "../../atomic-file.js";
import {
    conversationDir,
    ensureManifest,
    loadManifest,
    nextSessionId,
    readActiveSessionData,
    saveManifest,
    sessionPayload,
    writeActiveSessionData,
} from "./files.js";
import { isInternalStoredMessage, isSilentMarkedText } from "./messages.js";
import { PENDING_USER_PREFIX, isScheduledTurnText, stripAttachedFiles } from "./messages.js";

export function loadChatHistory(chatId) {
    return readActiveSessionData(chatId).turns;
}

export function replaceChatHistory(chatId, turns) {
    if (!chatId) return;
    writeActiveSessionData(chatId, turns);
}

// 압축 요약은 디스크(새 세션 첫 턴)와 진행 중 요청 양쪽에 같은 형태로 들어간다.
export function compressedSummaryTurn(summary) {
    return {
        at: new Date().toISOString(),
        messages: [
            {
                role: "system",
                content: `## Earlier conversation (compressed summary of your own past context, not a user message)\n\n${summary.trim()}`,
            },
        ],
    };
}

// After compression: archive full session on disk; active file keeps recent turns.
// The compressed summary is stored as a system-message turn at the start of the new session.
export function replaceChatHistoryAfterCompression(chatId, recentTurns, summary, { reason = "context_compression" } = {}) {
    if (!chatId) return null;
    const root = conversationDir(chatId);
    const manifest = ensureManifest(chatId);
    if (!root || !manifest) return null;
    const oldId = manifest.activeSessionId;
    const now = new Date().toISOString();

    const oldEntry = manifest.sessions.find((s) => s.id === oldId);
    if (oldEntry) {
        oldEntry.closedAt = now;
        oldEntry.kind = "archived";
        oldEntry.archiveReason = reason;
    }

    const summaryTurn = summary?.trim() ? [{ ...compressedSummaryTurn(summary), at: now }] : [];
    const cleanRecentTurns = recentTurns.filter(
        (t) =>
            !Array.isArray(t?.messages) ||
            !t.messages.some((m) => m?.role === "system" && typeof m?.content === "string" && m.content.includes("compressed summary")),
    );
    const turns = [...summaryTurn, ...cleanRecentTurns];

    const newId = nextSessionId(manifest);
    const relFile = `sessions/${newId}.json`;
    writeJsonAtomic(
        path.join(root, relFile),
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

export function extractSessionTextLines(turns) {
    const lines = [];
    for (const turn of turns || []) {
        for (const m of turn?.messages || []) {
            if (m?.role !== "user" && m?.role !== "assistant") continue;
            if (typeof m.content !== "string") continue;
            if (isInternalStoredMessage(m)) continue;
            let text = m.content;
            if (m.role === "assistant") {
                if (isSilentMarkedText(text)) continue;
            } else {
                if (isScheduledTurnText(text)) continue;
                if (text.startsWith(PENDING_USER_PREFIX)) text = text.slice(PENDING_USER_PREFIX.length).trim();
                text = stripAttachedFiles(text);
            }
            text = text.trim();
            if (text) lines.push({ role: m.role, at: turn.at || null, text });
        }
    }
    return lines;
}

function listArchivedSessionFiles(chatId) {
    const manifest = loadManifest(chatId);
    const root = conversationDir(chatId);
    if (!manifest?.sessions?.length || !root) return [];
    const activeId = manifest.activeSessionId;
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
            const data = readJsonFile(s.absolutePath, {});
            const turnCount = Array.isArray(data.turns) ? data.turns.length : 0;
            const rel = path.relative(USER_DIR, s.absolutePath).split(path.sep).join("/");
            const parts = [`session ${s.id}`, `${turnCount} turns`];
            if (s.archiveReason === "context_compression") parts.push("archived before context compression");
            if (s.closedAt) parts.push(`closed ${s.closedAt}`);
            return `- \`${rel}\`: ${parts.join(", ")}`;
        })
        .join("\n");
}
