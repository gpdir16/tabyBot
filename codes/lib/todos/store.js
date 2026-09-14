import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "../paths.js";
import { agentColor, agentHomeDir, getAgent, listAgents } from "../agents-store.js";
import { computeNextRun, defaultTimeZone, describeSchedule, isValidTimeZone, parseAt, parseCron, parseEvery } from "../scheduling/time.js";

const STORE_PATH = path.join(USER_DIR, "todos.json");
const MAX_ITEMS = 80;
const MAX_RUNS = 20;
const MAX_TITLE = 200;
const MAX_PROMPT = 4000;
const MAX_REASON = 500;
const MAX_SUGGESTIONS = 50;
const STATUSES = new Set(["open", "done"]);
const SUGGEST_KINDS = new Set(["add", "edit", "delete"]);

function defaultStore() {
    return { items: [], suggestions: [] };
}

function newId() {
    return crypto.randomBytes(6).toString("hex");
}

function clip(value, max) {
    if (value != null && typeof value === "object") return "";
    return String(value ?? "")
        .replace(/^[\s\u200B-\u200D\u2060\uFEFF\u00AD]+|[\s\u200B-\u200D\u2060\uFEFF\u00AD]+$/g, "")
        .slice(0, max);
}

function migrateLegacy() {
    const items = [];
    const suggestions = [];
    const seenIds = new Set();
    for (const agent of listAgents()) {
        const file = path.join(agentHomeDir(agent.id), "todos.json");
        if (!fs.existsSync(file)) continue;
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            continue;
        }
        const rows = Array.isArray(raw?.items) ? raw.items : [];
        for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            if (row.id && seenIds.has(row.id)) continue;
            if (row.id) seenIds.add(row.id);
            if (row.lane === "suggestion") {
                suggestions.push({
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
                });
                continue;
            }
            items.push({
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
            });
        }
    }
    return { items, suggestions };
}

let lastRecovery = null;

function readStore() {
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
            const bak = `${STORE_PATH}.corrupt-${Date.now()}.bak`;
            fs.copyFileSync(STORE_PATH, bak);
            lastRecovery = { at: new Date().toISOString(), backup: path.basename(bak) };
        } catch {
            lastRecovery = { at: new Date().toISOString(), backup: "" };
        }
        return defaultStore();
    }
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, STORE_PATH);
}

function scheduleShape(item) {
    return {
        kind: item.kind || "none",
        cron: item.cron || "",
        every: item.every || "",
        at: item.at || "",
        timezone: item.timezone || defaultTimeZone(),
    };
}

export function describeTodoWhen(item) {
    if (!item || item.kind === "none" || !item.kind) return "";
    const tz = item.timezone || defaultTimeZone();
    if (item.kind === "cron") {
        const m = /^(\d+) (\d+) \* \* \*$/.exec(String(item.cron || ""));
        if (m && Number(m[1]) <= 59 && Number(m[2]) <= 23) {
            const hh = String(m[2]).padStart(2, "0");
            const mm = String(m[1]).padStart(2, "0");
            return `every day ${hh}:${mm} (${tz})`;
        }
    }
    return describeSchedule(scheduleShape(item));
}

const RUNNING_STALE_MS = 30 * 60 * 1000;

function isRunning(item) {
    if (!item?.running?.at) return false;
    const at = Date.parse(item.running.at);
    return Number.isFinite(at) && Date.now() - at < RUNNING_STALE_MS;
}

export function isPeriodDone(item) {
    if (!item || item.status !== "open") return item?.status === "done";
    if (item.kind === "none" || !item.kind) return false;
    if (!item.lastDoneAt) return false;
    const done = Date.parse(item.lastDoneAt);
    const next = Date.parse(item.nextRunAt || "");
    const notified = Math.max(Date.parse(item.lastNotifiedAt || "") || 0, Date.parse(item.lastRunAt || "") || 0);
    if (!Number.isFinite(done)) return false;
    if (Number.isFinite(next) && next <= Date.now()) return false;
    if (Number.isFinite(notified) && done < notified) return false;
    return Number.isFinite(next) ? done < next : false;
}

function agentBrief(id) {
    const agent = getAgent(id);
    if (!agent) return null;
    return { id: agent.id, name: agent.name, color: agentColor(agent.id) };
}

// 실행 주체: assignee가 우선이고, 없으면 봇 소유 리스트(list !== "user")의 주인 봇.
export function executorIdOf(item) {
    if (!item) return null;
    if (item.assigneeId) return item.assigneeId;
    const list = item.list || "user";
    return list === "user" ? null : list;
}

function publicOffer(offer) {
    const agent = agentBrief(offer.agentId);
    return {
        agentId: offer.agentId,
        reason: offer.reason || "",
        prompt: offer.prompt || "",
        createdAt: offer.createdAt,
        name: agent?.name || offer.agentId,
        color: agent?.color || "#0a84ff",
    };
}

export function publicTodo(item) {
    if (!item) return null;
    const list = item.list || "user";
    const executorId = executorIdOf(item);
    return {
        ...item,
        list,
        conversationId: item.conversationId || "",
        enabled: item.enabled !== false,
        status: STATUSES.has(item.status) ? item.status : "open",
        when: describeTodoWhen(item),
        periodDone: isPeriodDone(item),
        assignee: item.assigneeId ? agentBrief(item.assigneeId) : null,
        executor: executorId ? agentBrief(executorId) : null,
        offers: (Array.isArray(item.offers) ? item.offers : []).map(publicOffer),
        running: isRunning(item),
        lastError: item.lastError || null,
        waiting: item.status === "open" && item.waiting ? item.waiting : null,
        runs: Array.isArray(item.runs) ? item.runs.slice(-MAX_RUNS) : [],
    };
}

export function publicSuggestion(row) {
    if (!row) return null;
    const agent = agentBrief(row.agentId);
    return {
        ...row,
        agentName: agent?.name || row.agentId || "",
        agentColor: agent?.color || "#0a84ff",
    };
}

function resolveWhen(input = {}, fallback = {}, mode = "create") {
    const timezone = String(input.timezone || fallback.timezone || defaultTimeZone()).trim() || defaultTimeZone();
    if (!isValidTimeZone(timezone)) return { error: `invalid timezone: ${timezone}` };

    const clear = input.kind === "none" || input.clearWhen === true;
    const explicit = input.cron != null || input.every != null || input.at != null || clear;
    const cron = input.cron != null ? String(input.cron).trim() : !explicit && fallback.kind === "cron" ? fallback.cron || "" : "";
    const every = input.every != null ? String(input.every).trim() : !explicit && fallback.kind === "every" ? fallback.every || "" : "";
    const at = input.at != null ? String(input.at).trim() : !explicit && fallback.kind === "at" ? fallback.at || "" : "";
    const present = [cron && "cron", every && "every", at && "at"].filter(Boolean);

    if (!present.length) {
        if (input.kind && input.kind !== "none" && !clear) return { error: `kind "${input.kind}" needs a matching schedule value` };
        const blankOnly = ["cron", "every", "at"].some((k) => input[k] != null && !String(input[k]).trim());
        if (blankOnly && !clear && mode !== "create") return { error: "Provide exactly one of cron, every, or at." };
        return { kind: "none", cron: "", every: "", at: "", timezone, nextRunAt: null };
    }
    if (present.length !== 1) return { error: "Provide exactly one of cron, every, or at." };

    const kind = present[0];
    if (input.kind && input.kind !== kind) return { error: `kind "${input.kind}" does not match the provided schedule` };
    if (kind === "cron") {
        if (!parseCron(cron)) return { error: `invalid cron expression: ${cron}` };
        const next = computeNextRun({ kind, cron, timezone }, new Date());
        if (!next) return { error: `cron never fires: ${cron}` };
        return { kind, cron, every: "", at: "", timezone, nextRunAt: next.toISOString() };
    }
    if (kind === "every") {
        const parsed = parseEvery(every);
        if (parsed.error) return { error: parsed.error };
        if (
            (mode === "update" || mode === "reopen" || mode === "apply") &&
            fallback.kind === "every" &&
            fallback.every === parsed.label &&
            fallback.nextRunAt
        ) {
            return { kind, cron: "", every: parsed.label, at: "", timezone, nextRunAt: fallback.nextRunAt };
        }
        const next = computeNextRun({ kind, every: parsed.label, timezone }, new Date());
        if (next && !Number.isFinite(next.getTime())) return { error: "interval too large" };
        return { kind, cron: "", every: parsed.label, at: "", timezone, nextRunAt: next?.toISOString() || null };
    }
    const parsed = parseAt(at, timezone);
    if (parsed.error) return { error: parsed.error };
    const sameTz = timezone === (fallback.timezone || defaultTimeZone());
    if (mode === "update" && input.at != null && fallback.kind === "at" && at === String(fallback.at || "") && sameTz) {
        return { kind: "at", cron: "", every: "", at, timezone, nextRunAt: fallback.nextRunAt || null };
    }
    let next = computeNextRun({ kind: "at", at, timezone }, new Date());
    if (!next) {
        const newTime = input.at != null && at !== String(fallback.at || "");
        const fired = !!(fallback.lastNotifiedAt || fallback.lastRunAt || fallback.consumedSlot || fallback.running);
        if (newTime) {
            if (mode === "update") return { error: "at must be in the future" };
            if (mode !== "reopen") next = new Date(Date.now() + 1000);
        } else if (fired) {
            next = null;
        } else if (mode === "apply") {
            next = new Date(Date.now() + 1000);
        } else if (mode === "update") {
            const kept = sameTz ? fallback.nextRunAt : null;
            next = kept ? new Date(kept) : parsed.date || null;
        }
    }
    return { kind: "at", cron: "", every: "", at, timezone, nextRunAt: next?.toISOString() || null };
}

function applyWhen(item, when) {
    const slotChanged = item.nextRunAt !== when.nextRunAt;
    item.kind = when.kind;
    item.cron = when.cron;
    item.every = when.every;
    item.at = when.at;
    item.timezone = when.timezone;
    item.nextRunAt = when.nextRunAt;
    if (slotChanged) item.consumedSlot = null;
}

function bumpNextRun(item, from = new Date()) {
    if (item.kind === "at" || item.kind === "none" || !item.kind) {
        item.nextRunAt = null;
        return;
    }
    const slot = Date.parse(item.nextRunAt || "");
    if (Number.isFinite(slot)) item.consumedSlot = item.nextRunAt;
    if (item.kind === "every") {
        const parsed = parseEvery(item.every);
        if (parsed.error) {
            item.nextRunAt = null;
            return;
        }
        const base = Number.isFinite(slot) ? slot : from.getTime();
        const steps = Math.max(1, Math.floor((from.getTime() - base) / parsed.ms) + 1);
        item.nextRunAt = new Date(base + steps * parsed.ms).toISOString();
        return;
    }
    const base = Number.isFinite(slot) && slot > from.getTime() ? new Date(slot) : from;
    item.nextRunAt = computeNextRun(scheduleShape(item), base)?.toISOString() || null;
}

function pendingSlotDelivered(item) {
    const slot = Date.parse(item.consumedSlot || "");
    if (!Number.isFinite(slot)) return false;
    const delivered = Math.max(Date.parse(item.lastNotifiedAt || "") || 0, Date.parse(item.lastRunAt || "") || 0);
    return delivered >= slot;
}

function openCount(store, list = "user") {
    return store.items.filter((row) => row.status === "open" && (row.list || "user") === list).length;
}

export function listTodos() {
    const store = readStore();
    return {
        items: store.items.map(publicTodo),
        suggestions: store.suggestions.map(publicSuggestion),
        recovered: lastRecovery,
    };
}

export function getTodo(id) {
    const item = readStore().items.find((row) => row.id === id);
    return item ? publicTodo(item) : null;
}

export function listDueTodos(now = new Date()) {
    const ts = now.getTime();
    const due = [];
    for (const item of readStore().items) {
        if (item.status !== "open") continue;
        if (item.enabled === false) continue;
        if (!["at", "cron", "every"].includes(item.kind)) continue;
        const next = Date.parse(item.nextRunAt || "");
        if (!Number.isFinite(next) || next > ts) continue;
        due.push({ item: publicTodo(item) });
    }
    return due;
}

export function addTodo(input = {}) {
    const store = readStore();
    const list = input.list != null && String(input.list).trim() !== "" ? clip(input.list, 24) : "user";
    if (list !== "user" && !getAgent(list)) return { error: "agent_not_found" };
    if (openCount(store, list) >= MAX_ITEMS) return { error: "too_many" };
    const title = clip(input.title, MAX_TITLE);
    if (!title) return { error: "title_required" };
    const when = resolveWhen(input, {});
    if (when.error) return { error: when.error };
    if (list !== "user" && when.kind === "none") return { error: "schedule_required" };
    if (input.assigneeId && !getAgent(input.assigneeId)) return { error: "agent_not_found" };
    const now = new Date().toISOString();
    const item = {
        id: newId(),
        title,
        status: "open",
        kind: "none",
        cron: "",
        every: "",
        at: "",
        timezone: when.timezone,
        prompt: clip(input.prompt, MAX_PROMPT),
        assigneeId: input.assigneeId || null,
        list,
        conversationId: clip(input.conversationId, 64),
        enabled: input.enabled !== false,
        offers: [],
        nextRunAt: null,
        lastRunAt: null,
        lastDoneAt: null,
        lastNotifiedAt: null,
        runs: [],
        createdBy: input.createdBy === "agent" ? "agent" : "user",
        createdAt: now,
        updatedAt: now,
    };
    applyWhen(item, when);
    if (input.fireImmediately === true && item.kind !== "none") item.nextRunAt = new Date(Date.now() - 1).toISOString();
    store.items.push(item);
    writeStore(store);
    return { item: publicTodo(item) };
}

export function updateTodo(id, patch = {}, opts = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item) return { error: "not_found" };
    if (patch.baseUpdatedAt != null && item.updatedAt !== patch.baseUpdatedAt) return { error: "conflict" };
    let changed = false;
    const editedFields = [];
    if (patch.title != null) {
        const title = clip(patch.title, MAX_TITLE);
        if (!title) return { error: "title_required" };
        if (title !== item.title) {
            item.title = title;
            changed = true;
            editedFields.push("title");
        }
    }
    if (patch.prompt != null) {
        const v = clip(patch.prompt, MAX_PROMPT);
        if (v !== (item.prompt || "")) {
            item.prompt = v;
            changed = true;
            editedFields.push("instructions");
        }
    }
    if (patch.status != null && !STATUSES.has(patch.status)) return { error: "invalid_status" };
    if (patch.status === "done" && item.status !== "done" && !isPeriodDone(item)) {
        completeItem(item, new Date());
        changed = true;
        editedFields.push("status");
    } else if (patch.status === "open" && (item.status === "done" || isPeriodDone(item))) {
        const err = reopenWithSlot(item);
        if (err) return { error: err };
        changed = true;
        editedFields.push("status");
    }
    if (patch.assigneeId !== undefined && (patch.assigneeId || null) !== item.assigneeId) {
        if (patch.assigneeId && item.status !== "open") return { error: "not_open" };
        if (patch.assigneeId && !getAgent(patch.assigneeId)) return { error: "agent_not_found" };
        const acceptedOffer = patch.assigneeId ? (item.offers || []).find((row) => row.agentId === patch.assigneeId) : null;
        item.assigneeId = patch.assigneeId || null;
        if (acceptedOffer?.prompt && patch.prompt == null) item.prompt = acceptedOffer.prompt;
        if (item.assigneeId) item.offers = (item.offers || []).filter((row) => row.agentId !== item.assigneeId);
        voidRun(item);
        changed = true;
        editedFields.push("assignee");
    }
    if (patch.list != null) {
        const next = clip(patch.list, 24) || "user";
        if (next !== "user" && !getAgent(next)) return { error: "agent_not_found" };
        if (next !== (item.list || "user")) {
            item.list = next;
            changed = true;
            editedFields.push("list");
        }
    }
    if (patch.conversationId != null) {
        const v = clip(patch.conversationId, 64);
        if (v !== (item.conversationId || "")) {
            item.conversationId = v;
            changed = true;
            editedFields.push("conversation");
        }
    }
    if (patch.enabled != null) {
        const v = Boolean(patch.enabled);
        if (v !== (item.enabled !== false)) {
            item.enabled = v;
            changed = true;
            editedFields.push("enabled");
        }
    }
    const wantsWhen =
        patch.cron != null || patch.every != null || patch.at != null || patch.timezone != null || patch.kind != null || patch.clearWhen;
    if (wantsWhen) {
        const when = resolveWhen(patch, item, opts.whenMode || "update");
        if (when.error) return { error: when.error };
        const before = JSON.stringify([item.kind, item.cron, item.every, item.at, item.timezone, item.nextRunAt]);
        const probe = { ...item };
        applyWhen(probe, when);
        if (JSON.stringify([probe.kind, probe.cron, probe.every, probe.at, probe.timezone, probe.nextRunAt]) !== before) {
            applyWhen(item, when);
            voidRun(item);
            item.lastError = null;
            changed = true;
            editedFields.push("schedule");
        }
    }
    // 봇 소유 항목은 반드시 트리거(스케줄)가 있어야 한다 — 해제 불가.
    if ((item.list || "user") !== "user" && (!item.kind || item.kind === "none")) return { error: "schedule_required" };
    if (item.status === "done" && item.nextRunAt != null) {
        item.nextRunAt = null;
        changed = true;
    }
    if (patch.fireImmediately === true) {
        item.enabled = true;
        if (item.status === "done") {
            item.status = "open";
            item.lastDoneAt = null;
            voidRun(item);
        }
        if (item.kind && item.kind !== "none") {
            item.nextRunAt = new Date(Date.now() - 1).toISOString();
            item.consumedSlot = null;
        }
        changed = true;
        editedFields.push("schedule");
    }
    if (changed) {
        item.updatedAt = new Date().toISOString();
        if (item.assigneeId && editedFields.length) {
            item.lastEdit = { by: opts.editedBy === "agent" ? "agent" : "user", at: item.updatedAt, fields: editedFields };
        }
        writeStore(store);
    }
    return { item: publicTodo(item) };
}

function voidRun(item) {
    if (item.running) item.running.consumed = true;
}

function completeItem(item, now) {
    item.lastDoneAt = now.toISOString();
    item.lastError = null;
    item.waiting = null;
    const advanced = item.running?.advanced === true;
    voidRun(item);
    if (item.kind !== "every" && item.kind !== "cron") {
        item.status = "done";
        item.nextRunAt = null;
    } else {
        item.status = "open";
        if (!advanced && !pendingSlotDelivered(item)) bumpNextRun(item, now);
        if (!item.nextRunAt) item.status = "done";
    }
}

function reopenItem(item, when) {
    item.status = "open";
    item.lastDoneAt = null;
    voidRun(item);
    item.lastError = null;
    applyWhen(item, when);
}

export function completeTodo(id) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item) return { error: "not_found" };
    if ((item.list || "user") !== "user") return { error: "not_a_user_todo" };
    const now = new Date();
    if (item.status === "done" || isPeriodDone(item)) return { item: publicTodo(item) };
    completeItem(item, now);
    item.updatedAt = item.lastDoneAt;
    writeStore(store);
    return { item: publicTodo(item) };
}

function reopenWithSlot(item) {
    const consumedSlot = item.consumedSlot;
    const when = resolveWhen({}, item, "reopen");
    if (when.error) return when.error;
    reopenItem(item, when);
    const consumedMs = Date.parse(consumedSlot || "");
    if (item.kind === "every" && Number.isFinite(consumedMs) && consumedMs > Date.now()) item.nextRunAt = consumedSlot;
    return null;
}

export function reopenTodo(id) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item) return { error: "not_found" };
    if (item.status !== "done" && !isPeriodDone(item)) return { error: "not_done" };
    const err = reopenWithSlot(item);
    if (err) return { error: err };
    item.updatedAt = new Date().toISOString();
    writeStore(store);
    return { item: publicTodo(item) };
}

export function removeTodo(id) {
    const store = readStore();
    const before = store.items.length;
    store.items = store.items.filter((row) => row.id !== id);
    store.suggestions = store.suggestions.filter((row) => row.targetId !== id && row.id !== id);
    if (store.items.length === before) return { error: "not_found" };
    writeStore(store);
    return { removed: true };
}

export function addSuggestion(input = {}) {
    const store = readStore();
    const kind = SUGGEST_KINDS.has(input.kind) ? input.kind : "add";
    const title = clip(input.title, MAX_TITLE);
    if (kind === "add" && !title) return { error: "title_required" };
    if (kind !== "add" && !input.targetId) return { error: "target_required" };
    if (kind !== "add") {
        const target = store.items.find((row) => row.id === input.targetId);
        if (target && (target.list || "user") !== "user") return { error: "not_a_user_todo" };
    }
    const dupe = store.suggestions.find(
        (row) =>
            row.kind === kind &&
            row.agentId === clip(input.agentId, 24) &&
            row.title === title &&
            String(row.targetId || "") === String(input.targetId || ""),
    );
    const patch = (() => {
        const p = input.patch;
        if (!p || typeof p !== "object" || Array.isArray(p)) return null;
        const out = {};
        if (p.title != null) out.title = clip(p.title, MAX_TITLE);
        if (p.prompt != null) out.prompt = clip(p.prompt, MAX_PROMPT);
        if (p.cron != null) out.cron = clip(p.cron, 120);
        if (p.every != null) out.every = clip(p.every, 24);
        if (p.at != null) out.at = clip(p.at, 40);
        if (p.timezone != null) out.timezone = clip(p.timezone, 64);
        if (p.kind != null) out.kind = clip(p.kind, 12);
        if (p.clearWhen === true) out.clearWhen = true;
        return Object.keys(out).length ? out : null;
    })();
    if (dupe) {
        dupe.reason = clip(input.reason, MAX_REASON);
        dupe.patch = patch ?? dupe.patch;
        dupe.cron = input.cron != null ? String(input.cron) : dupe.cron;
        dupe.every = input.every != null ? String(input.every) : dupe.every;
        dupe.at = input.at != null ? String(input.at) : dupe.at;
        dupe.timezone = input.timezone != null ? String(input.timezone) : dupe.timezone;
        dupe.prompt = clip(input.prompt, MAX_PROMPT) || dupe.prompt;
        dupe.createdAt = new Date().toISOString();
        writeStore(store);
        return { suggestion: publicSuggestion(dupe) };
    }
    if (store.suggestions.length >= MAX_SUGGESTIONS) return { error: "too_many_suggestions" };
    const row = {
        id: newId(),
        kind,
        targetId: kind === "add" ? null : clip(input.targetId, 32),
        agentId: clip(input.agentId, 24),
        title,
        reason: clip(input.reason, MAX_REASON),
        patch,
        cron: input.cron != null ? String(input.cron) : "",
        every: input.every != null ? String(input.every) : "",
        at: input.at != null ? String(input.at) : "",
        timezone: input.timezone != null ? String(input.timezone) : "",
        prompt: clip(input.prompt, MAX_PROMPT),
        createdAt: new Date().toISOString(),
    };
    store.suggestions.push(row);
    writeStore(store);
    return { suggestion: publicSuggestion(row) };
}

export function approveSuggestion(id, { fallbackTimeZone } = {}) {
    const suggestion = readStore().suggestions.find((row) => row.id === id);
    if (!suggestion) return { error: "not_found" };
    const tz = isValidTimeZone(fallbackTimeZone) ? fallbackTimeZone : "";

    if (suggestion.kind === "add") {
        const result = addTodo({
            title: suggestion.title,
            prompt: suggestion.prompt,
            cron: suggestion.cron || undefined,
            every: suggestion.every || undefined,
            at: suggestion.at || undefined,
            timezone: suggestion.timezone || tz,
            createdBy: "agent",
        });
        if (result.error) return result;

        const store = readStore();
        store.suggestions = store.suggestions.filter((row) => row.id !== id);
        const item = store.items.find((row) => row.id === result.item.id);
        if (item && suggestion.agentId && getAgent(suggestion.agentId)) {
            item.offers = Array.isArray(item.offers) ? item.offers : [];
            item.offers.push({
                agentId: suggestion.agentId,
                reason: clip(suggestion.reason, MAX_REASON),
                prompt: clip(suggestion.prompt, MAX_PROMPT),
                createdAt: new Date().toISOString(),
            });
        }
        writeStore(store);
        return { item: getTodo(result.item.id) };
    }

    const targetExists = readStore().items.some((row) => row.id === suggestion.targetId);
    if (!targetExists) return { error: "target_missing" };

    if (suggestion.kind === "delete") {
        const store = readStore();
        store.items = store.items.filter((row) => row.id !== suggestion.targetId);
        store.suggestions = store.suggestions.filter((row) => row.targetId !== suggestion.targetId);
        writeStore(store);
        return { removed: true, targetId: suggestion.targetId };
    }

    const patch = suggestion.patch && typeof suggestion.patch === "object" ? suggestion.patch : {};
    const hasWhenPatch =
        patch.cron != null ||
        patch.every != null ||
        patch.at != null ||
        patch.timezone != null ||
        patch.clearWhen ||
        patch.kind != null ||
        Boolean(suggestion.cron || suggestion.every || suggestion.at || suggestion.timezone);
    const result = updateTodo(
        suggestion.targetId,
        {
            title: patch.title != null ? patch.title : undefined,
            prompt: patch.prompt != null ? patch.prompt : undefined,
            cron: patch.cron != null ? patch.cron : suggestion.cron || undefined,
            every: patch.every != null ? patch.every : suggestion.every || undefined,
            at: patch.at != null ? patch.at : suggestion.at || undefined,
            timezone: patch.timezone != null ? patch.timezone : suggestion.timezone || (hasWhenPatch ? tz : "") || undefined,
            clearWhen: patch.clearWhen,
            kind: patch.kind,
        },
        { whenMode: "apply", editedBy: "agent" },
    );
    if (result.error) return result;
    const store = readStore();
    store.suggestions = store.suggestions.filter((row) => row.id !== id);
    writeStore(store);
    return result;
}

export function rejectSuggestion(id) {
    const store = readStore();
    const before = store.suggestions.length;
    store.suggestions = store.suggestions.filter((row) => row.id !== id);
    if (store.suggestions.length === before) return { error: "not_found" };
    writeStore(store);
    return { rejected: true };
}

export function offerHandoff(todoId, { agentId, reason, prompt } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    if ((item.list || "user") !== "user") return { error: "not_a_user_todo" };
    if (item.status !== "open") return { error: "not_open" };
    if (!getAgent(agentId)) return { error: "agent_not_found" };
    if (item.assigneeId === agentId) return { error: "already_assigned" };
    const now = new Date().toISOString();
    item.offers = Array.isArray(item.offers) ? item.offers : [];
    const existing = item.offers.find((row) => row.agentId === agentId);
    if (existing) {
        existing.reason = clip(reason, MAX_REASON);
        existing.prompt = clip(prompt, MAX_PROMPT);
        existing.createdAt = now;
    } else {
        item.offers.push({
            agentId,
            reason: clip(reason, MAX_REASON),
            prompt: clip(prompt, MAX_PROMPT),
            createdAt: now,
        });
    }
    writeStore(store);
    return { item: publicTodo(item) };
}

export function withdrawHandoff(todoId, agentId) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    const before = (item.offers || []).length;
    item.offers = (item.offers || []).filter((row) => row.agentId !== agentId);
    if (item.offers.length === before) return { error: "offer_not_found" };
    writeStore(store);
    return { item: publicTodo(item) };
}

export function acceptHandoff(todoId, agentId) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    if (item.status !== "open") return { error: "not_open" };
    const offer = (item.offers || []).find((row) => row.agentId === agentId);
    if (!offer) return { error: "offer_not_found" };
    if (!getAgent(agentId)) {
        item.offers = (item.offers || []).filter((row) => row.agentId !== agentId);
        writeStore(store);
        return { error: "agent_not_found" };
    }
    item.assigneeId = agentId;
    if (offer.prompt) item.prompt = offer.prompt;
    item.offers = (item.offers || []).filter((row) => row.agentId !== agentId);
    voidRun(item);
    item.updatedAt = new Date().toISOString();
    writeStore(store);
    return { item: publicTodo(item) };
}

export function clearAssignee(todoId) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    if (!item.assigneeId) return { item: publicTodo(item) };
    item.assigneeId = null;
    voidRun(item);
    item.updatedAt = new Date().toISOString();
    writeStore(store);
    return { item: publicTodo(item) };
}

export function purgeAgentTodos(agentId) {
    const store = readStore();
    let changed = false;
    const kept = store.items.filter((row) => (row.list || "user") !== agentId);
    if (kept.length !== store.items.length) {
        store.items = kept;
        changed = true;
    }
    for (const item of store.items) {
        if (item.assigneeId === agentId) {
            item.assigneeId = null;
            voidRun(item);
            changed = true;
        }
        if (Array.isArray(item.offers) && item.offers.length) {
            const next = item.offers.filter((o) => o.agentId !== agentId);
            if (next.length !== item.offers.length) {
                item.offers = next;
                changed = true;
            }
        }
    }
    const next = store.suggestions.filter((row) => row.agentId !== agentId);
    if (next.length !== store.suggestions.length) {
        store.suggestions = next;
        changed = true;
    }
    if (changed) writeStore(store);
    return { changed };
}

export function dispatchTodoRun(id, { advance = true, manual = false } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item || item.status !== "open") return null;
    if (item.running && !item.running.consumed && isRunning(item)) return null;
    const token = crypto.randomBytes(8).toString("hex");
    item.running = { token, slot: item.nextRunAt || null, at: new Date().toISOString(), advanced: advance, manual };
    item.waiting = null;
    if (advance) bumpNextRun(item, new Date());
    writeStore(store);
    return { token };
}

export function skipTodoOccurrence(id, slot) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item || item.status !== "open" || !item.nextRunAt) return false;
    if (slot && item.nextRunAt !== slot) return false;
    const now = new Date();
    if (Date.parse(item.nextRunAt) > now.getTime()) return false;
    bumpNextRun(item, now);
    writeStore(store);
    return true;
}

export function isTodoRunCurrent(id, token) {
    const item = readStore().items.find((row) => row.id === id);
    return Boolean(item && item.status === "open" && item.running?.token === token && !item.running.consumed);
}

export function markTodoWaiting(id, { askId = "", question = "", convId = "" } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item || item.status !== "open") return false;
    item.waiting = {
        askId: String(askId || ""),
        question: clip(question, MAX_REASON),
        convId: String(convId || ""),
        at: new Date().toISOString(),
    };
    writeStore(store);
    return true;
}

export function clearTodoWaiting(id, askId = null) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item?.waiting) return false;
    if (askId && item.waiting.askId !== askId) return false;
    item.waiting = null;
    writeStore(store);
    return true;
}

export function clearTodoRun(id, token = null) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item?.running) return false;
    if (token && item.running.token !== token) return false;
    item.running = null;
    item.waiting = null;
    writeStore(store);
    return true;
}

export function markTodoNotified(id, { token = null } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item) return null;
    const now = new Date();
    const running = item.running;
    const mine = !token || running?.token === token;
    if (!mine) return publicTodo(item);
    item.running = null;
    if (running?.consumed) {
        writeStore(store);
        return publicTodo(item);
    }
    const delivered = pendingSlotDelivered(item);
    item.lastNotifiedAt = now.toISOString();
    if (!running?.advanced && !delivered) bumpNextRun(item, now);
    writeStore(store);
    return publicTodo(item);
}

export function markTodoRun(id, { error = null, token = null, silent = false } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item) return null;
    const now = new Date();
    const running = item.running;
    const mine = !token || running?.token === token;
    if (!mine) return publicTodo(item);
    item.running = null;
    item.waiting = null;
    if (running?.consumed) {
        writeStore(store);
        return publicTodo(item);
    }
    const delivered = pendingSlotDelivered(item);
    item.lastRunAt = now.toISOString();
    item.runs = [...(Array.isArray(item.runs) ? item.runs : []), { at: item.lastRunAt, silent: Boolean(silent), error: error || null }].slice(
        -MAX_RUNS,
    );
    // 수동 실행(테스트 run): 슬롯/상태를 소비하지 않고 기록만 남긴다.
    if (running?.manual) {
        if (error && error !== "stopped_by_user") item.lastError = { at: item.lastRunAt, message: clip(error, 300) };
        else if (!error) item.lastError = null;
        writeStore(store);
        return publicTodo(item);
    }
    const needBump = !running?.advanced && !delivered;
    if (error === "stopped_by_user") {
        if (needBump) bumpNextRun(item, now);
        writeStore(store);
        return publicTodo(item);
    }
    if (error) {
        item.lastError = { at: item.lastRunAt, message: clip(error, 300) };
        if (needBump) bumpNextRun(item, now);
        writeStore(store);
        return publicTodo(item);
    }
    item.lastError = null;
    item.lastDoneAt = item.lastRunAt;
    if (item.kind === "at" || item.kind === "none" || !item.kind) {
        item.status = "done";
        item.nextRunAt = null;
    } else if (needBump) {
        bumpNextRun(item, now);
    }
    writeStore(store);
    return publicTodo(item);
}

export function reconcileRuns() {
    const store = readStore();
    let changed = false;
    const now = Date.now();
    for (const item of store.items) {
        if (item.waiting) {
            item.waiting = null;
            changed = true;
        }
        if (!item.running) continue;
        if (item.running.consumed) {
            item.running = null;
            changed = true;
            continue;
        }
        const slotMs = Date.parse(item.running.slot || "");
        if (item.kind === "at" && Number.isFinite(slotMs) && slotMs > now - 86_400_000) {
            item.nextRunAt = item.running.slot;
        } else if (executorIdOf(item)) {
            item.lastError = { at: new Date().toISOString(), message: "interrupted" };
        }
        item.running = null;
        changed = true;
    }
    if (changed) writeStore(store);
    return changed;
}

export function formatTodosForPrompt(agentId) {
    const { items, suggestions } = listTodos();
    const open = items.filter((row) => row.status === "open" && (row.list || "user") === "user");
    const jobs = items.filter((row) => row.status === "open" && (row.list || "user") === agentId);
    const lines = open.map((row) => {
        const when = row.when ? ` · ${row.when}` : "";
        const assigned = row.assignee ? ` · assigned: ${row.assignee.name} (${row.assignee.id})` : " · assigned: none";
        const offers = row.offers.length ? ` · offers: ${row.offers.map((o) => `${o.name} (${o.agentId})`).join(", ")}` : "";
        const mine = row.assignee?.id === agentId ? " · you are assigned" : "";
        const offered = row.offers.some((o) => o.agentId === agentId) ? " · you already offered" : "";
        const periodDone = row.periodDone ? " · done for this period" : "";
        const lastEdit =
            row.lastEdit?.by === "user"
                ? ` · last edited by user at ${row.lastEdit.at}${row.lastEdit.fields?.length ? ` (${row.lastEdit.fields.join(", ")})` : ""}`
                : "";
        return `- \`${row.id}\` ${row.title}${when}${assigned}${offers}${mine}${offered}${periodDone}${lastEdit}`;
    });
    const pending = suggestions.map((row) => {
        const who = row.agentName || row.agentId || "agent";
        return `- [${row.kind}] ${row.title || row.targetId} — ${who}${row.reason ? `: ${row.reason}` : ""}`;
    });
    const jobLines = jobs.map((row) => {
        const when = row.when ? ` · ${row.when}` : "";
        const paused = row.enabled === false ? " · paused" : "";
        const last = row.lastRunAt ? ` · last run ${row.lastRunAt}` : "";
        const err = row.lastError?.message ? ` · last error: ${String(row.lastError.message).slice(0, 80)}` : "";
        const running = row.running ? " · running" : "";
        return `- \`${row.id}\` ${row.title}${when}${paused}${running}${last}${err}`;
    });
    return {
        list: lines.length ? lines.join("\n") : "- (none)",
        suggestions: pending.length ? pending.join("\n") : "- (none)",
        jobs: jobLines.length ? jobLines.join("\n") : "- (none)",
    };
}
