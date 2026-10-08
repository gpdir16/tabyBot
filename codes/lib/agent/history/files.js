// 대화 폴더 배치(manifest, 세션 파일) 읽기/쓰기.
import fs from "node:fs";
import path from "node:path";
import { SESSION_DIR } from "../../paths.js";
import { getAgentByUuid } from "../../agents-store.js";
import { readJsonFile, writeJsonAtomic } from "../../atomic-file.js";

const HISTORY_VERSION = 3;

const MANIFEST_VERSION = 1;

export function conversationDir(chatId) {
    const agent = getAgentByUuid(chatId);
    if (!agent?.uuid) return null;
    return path.join(SESSION_DIR, agent.uuid);
}

function manifestPath(chatId) {
    const root = conversationDir(chatId);
    return root ? path.join(root, "manifest.json") : null;
}

function activeSessionPath(chatId) {
    const root = conversationDir(chatId);
    const manifest = loadManifest(chatId);
    if (!root || !manifest?.activeSessionId) return null;
    const entry = manifest.sessions?.find((s) => s.id === manifest.activeSessionId);
    if (!entry?.file) return null;
    return path.join(root, entry.file);
}

export function nextSessionId(manifest) {
    let max = 0;
    for (const entry of manifest.sessions || []) {
        const m = /^s(\d+)$/.exec(entry.id || "");
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `s${String(max + 1).padStart(6, "0")}`;
}

export function sessionPayload({ sessionId, turns, extra = {} }) {
    return {
        version: HISTORY_VERSION,
        sessionId,
        turns: turns || [],
        ...extra,
    };
}

export function ensureManifest(chatId) {
    const root = conversationDir(chatId);
    const mPath = manifestPath(chatId);
    if (!root || !mPath) return null;
    let manifest = readJsonFile(mPath, null);
    if (manifest?.activeSessionId && Array.isArray(manifest.sessions) && manifest.sessions.length) {
        return manifest;
    }

    // 매니페스트가 깨졌을 때 기존 세션 파일을 덮어쓰지 않는다. 디스크에 남은
    // sNNNNNN.json 중 가장 큰 번호 다음으로 새 세션을 잡는다.
    let maxSeq = 0;
    try {
        for (const name of fs.readdirSync(path.join(root, "sessions"))) {
            const m = /^s(\d+)\.json$/.exec(name);
            if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
        }
    } catch {
        // sessions 디렉터리가 아직 없으면 첫 세션부터 시작한다.
    }
    const sessionId = `s${String(maxSeq + 1).padStart(6, "0")}`;
    const relFile = `sessions/${sessionId}.json`;
    const now = new Date().toISOString();

    writeJsonAtomic(path.join(root, relFile), sessionPayload({ sessionId, turns: [] }));
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
    writeJsonAtomic(mPath, manifest);
    return manifest;
}

export function loadManifest(chatId) {
    const mPath = manifestPath(chatId);
    if (!chatId || !mPath) return null;
    return readJsonFile(mPath, null);
}

export function saveManifest(chatId, manifest) {
    const mPath = manifestPath(chatId);
    if (!mPath) return;
    writeJsonAtomic(mPath, manifest);
}

export function readActiveSessionData(chatId) {
    if (!chatId) return { turns: [] };
    ensureManifest(chatId);
    const filePath = activeSessionPath(chatId);
    if (!filePath || !fs.existsSync(filePath)) {
        return { turns: [] };
    }
    const data = readJsonFile(filePath, {});
    return { turns: Array.isArray(data.turns) ? data.turns : [] };
}

export function writeActiveSessionData(chatId, turns) {
    if (!chatId) return;
    const root = conversationDir(chatId);
    const manifest = ensureManifest(chatId);
    const entry = manifest?.sessions.find((s) => s.id === manifest.activeSessionId);
    if (!root || !entry?.file) return;
    const filePath = path.join(root, entry.file);
    writeJsonAtomic(
        filePath,
        sessionPayload({
            sessionId: manifest.activeSessionId,
            turns,
        }),
    );
}
