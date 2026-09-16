import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { writeJsonAtomic } from "../atomic-file.js";

export const DREAMS_DIR = path.join(USER_DIR, "dreams");
export const DREAMS_DIARY_PATH = path.join(DREAMS_DIR, "DREAMS.md");
const STATE_PATH = path.join(DREAMS_DIR, "state.json");
const STATE_VERSION = 1;

function defaultState() {
    return {
        version: STATE_VERSION,
        lastSweepAt: null,
        // "<agentUuid>/<sessionFile>" -> mtimeMs. 스윕이 이미 삼킨 세션 파일.
        ingested: {},
        // "<sessionKey>" -> 마지막으로 리뷰한 턴의 at 타임스탬프.
        reviews: {},
        // "<agentId>/<key>" -> {days:[], text, lastSeen}. 루틴 관찰 누적 — 3일 되면 승격.
        routineWatch: {},
    };
}

export function loadDreamingState() {
    try {
        if (!fs.existsSync(STATE_PATH)) return defaultState();
        const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
        return {
            ...defaultState(),
            ...raw,
            ingested: raw?.ingested || {},
            reviews: raw?.reviews || {},
            routineWatch: raw?.routineWatch || {},
        };
    } catch (err) {
        console.error("tabyBot: invalid dreaming state.json:", err?.message || err);
        return defaultState();
    }
}

const MAX_INGESTED_KEYS = 500;

export function saveDreamingState(state) {
    // ingested는 세션 파일마다 한 키 — 오래된 것부터 버려 무한 증가를 막는다.
    const keys = Object.keys(state.ingested || {});
    if (keys.length > MAX_INGESTED_KEYS) {
        const keep = new Set(keys.sort((a, b) => (state.ingested[b]?.mtime || 0) - (state.ingested[a]?.mtime || 0)).slice(0, MAX_INGESTED_KEYS));
        for (const k of keys) if (!keep.has(k)) delete state.ingested[k];
    }
    writeJsonAtomic(STATE_PATH, state);
}

export function dreamBackupDir(now = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    return path.join(DREAMS_DIR, "backups", stamp);
}

export function appendDreamDiary(entry) {
    fs.mkdirSync(DREAMS_DIR, { recursive: true });
    if (!fs.existsSync(DREAMS_DIARY_PATH)) {
        fs.writeFileSync(DREAMS_DIARY_PATH, "# Dream diary\n\nBackground memory consolidation and session reviews.\n", "utf8");
    }
    fs.appendFileSync(DREAMS_DIARY_PATH, `\n${entry.trim()}\n`, "utf8");
}
