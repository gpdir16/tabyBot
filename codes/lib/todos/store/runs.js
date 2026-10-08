// 에이전트 실행 상태(배정·대기·완료·재조정)와 시스템 프롬프트용 할 일 목록.
import crypto from "node:crypto";
import { MAX_REASON, MAX_RUNS, clip, readStore, writeStore } from "./persist.js";
import { executorIdOf, isRunning, listTodos, publicTodo } from "./items.js";
import { bumpNextRun, pendingSlotDelivered } from "./when.js";

// ── 에이전트 실행 상태(배정·대기·완료·재조정). ──

export function dispatchTodoRun(id, { advance = true, manual = false } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (item?.status !== "open") return null;
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
    if (item?.status !== "open" || !item.nextRunAt) return false;
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
    if (item?.status !== "open") return false;
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

// ── 시스템 프롬프트에 넣을 할 일 목록 문자열. ──

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
        return `- [${row.kind}] ${row.title || row.targetId}, ${who}${row.reason ? `: ${row.reason}` : ""}`;
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
