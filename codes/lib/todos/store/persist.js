// 할 일 저장소의 기반: 한도·허용 값, todos.json 읽기/쓰기와 손상 복구, 구버전(에이전트별 todos.json) 이전.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentHomeDir, listAgents } from "../../agents-store.js";
import { defaultTimeZone } from "../../scheduling/time.js";
import { USER_DIR } from "../../paths.js";
import { writeJsonAtomic } from "../../atomic-file.js";

// ── 할 일 저장소가 공유하는 한도, 허용 값, 문자열 정리. ──

export const MAX_ITEMS = 80;
export const MAX_RUNS = 20;
export const MAX_TITLE = 200;
export const MAX_PROMPT = 4000;
export const MAX_REASON = 500;
export const MAX_SUGGESTIONS = 50;
export const STATUSES = new Set(["open", "done"]);
export const SUGGEST_KINDS = new Set(["add", "edit", "delete"]);

export function newId() {
    return crypto.randomBytes(6).toString("hex");
}

// 값을 문자열로 바꿔 앞뒤 공백(보이지 않는 문자 포함)을 지우고 max자로 자른다. 객체는 빈 문자열.
export function clip(value, max) {
    if (value != null && typeof value === "object") return "";
    return String(value ?? "")
        .replace(/^[\s\u200B-\u200D\u2060\uFEFF\u00AD]+|[\s\u200B-\u200D\u2060\uFEFF\u00AD]+$/g, "")
        .slice(0, max);
}

// ── 구버전(에이전트별 todos.json)의 할 일을 통합 저장소 모양으로 옮긴다. ──

function legacySuggestion(row, agent) {
    return {
        id: row.id || newId(),
        kind: SUGGEST_KINDS.has(row.suggestionKind) ? row.suggestionKind : "add",
        targetId: row.targetId || null,
        agentId: row.createdBy === "agent" ? agent.id : "",
        title: clip(row.title, MAX_TITLE),
        reason: clip(row.reason, MAX_REASON),
        patch: row.patch && typeof row.patch === "object" ? row.patch : null,
        cron: row.cron || "",
        every: row.every || "",
        at: row.at || "",
        timezone: row.timezone || "",
        prompt: clip(row.prompt, MAX_PROMPT),
        createdAt: row.createdAt || new Date().toISOString(),
    };
}

function legacyItem(row, agent) {
    return {
        id: row.id || newId(),
        title: clip(row.title, MAX_TITLE),
        status: row.status === "done" ? "done" : "open",
        kind: row.kind || "none",
        cron: row.cron || "",
        every: row.every || "",
        at: row.at || "",
        timezone: row.timezone || defaultTimeZone(),
        prompt: clip(row.prompt, MAX_PROMPT),
        assigneeId: row.lane === "agent" ? agent.id : row.assigneeId || null,
        offers: Array.isArray(row.offers) ? row.offers : [],
        nextRunAt: row.nextRunAt || null,
        lastRunAt: row.lastRunAt || null,
        lastDoneAt: row.lastDoneAt || null,
        lastNotifiedAt: row.lastNotifiedAt || null,
        createdBy: row.createdBy === "agent" ? "agent" : "user",
        createdAt: row.createdAt || new Date().toISOString(),
        updatedAt: row.updatedAt || row.createdAt || new Date().toISOString(),
    };
}

function readLegacyRows(agent) {
    const file = path.join(agentHomeDir(agent.id), "todos.json");
    if (!fs.existsSync(file)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(raw?.items) ? raw.items : [];
    } catch {
        return [];
    }
}

export function migrateLegacy() {
    const items = [];
    const suggestions = [];
    const seenIds = new Set();
    for (const agent of listAgents()) {
        for (const row of readLegacyRows(agent)) {
            if (!row || typeof row !== "object") continue;
            if (row.id && seenIds.has(row.id)) continue;
            if (row.id) seenIds.add(row.id);
            if (row.lane === "suggestion") suggestions.push(legacySuggestion(row, agent));
            else items.push(legacyItem(row, agent));
        }
    }
    return { items, suggestions };
}

// ── 할 일 저장 파일(todos.json) 읽기/쓰기와 손상 복구. ──

const STORE_PATH = path.join(USER_DIR, "todos.json");

function defaultStore() {
    return { items: [], suggestions: [] };
}

export let lastRecovery = null;

// 깨진 스토어 파일을 매 읽기(1초 tick)마다 새 .bak로 복사하지 않게
// 프로세스 수명 동안 한 번만 백업한다.
let corruptBackupPath = null;

export function readStore() {
    if (!fs.existsSync(STORE_PATH)) {
        const migrated = migrateLegacy();
        if (migrated.items.length || migrated.suggestions.length) {
            writeStore(migrated);
            return migrated;
        }
        return defaultStore();
    }
    try {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
        return {
            items: Array.isArray(data.items) ? data.items : [],
            suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
        };
    } catch {
        try {
            if (!corruptBackupPath) {
                corruptBackupPath = `${STORE_PATH}.corrupt-${Date.now()}.bak`;
                fs.copyFileSync(STORE_PATH, corruptBackupPath);
            }
            lastRecovery = { at: new Date().toISOString(), backup: path.basename(corruptBackupPath) };
        } catch {
            lastRecovery = { at: new Date().toISOString(), backup: "" };
        }
        return defaultStore();
    }
}

export function writeStore(store) {
    writeJsonAtomic(STORE_PATH, store);
}

export function openCount(store, list = "user") {
    return store.items.filter((row) => row.status === "open" && (row.list || "user") === list).length;
}
