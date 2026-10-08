// 할 일 항목: 공개 모양, 조회·추가·수정·완료·재개·삭제.
import { agentColor, getAgent } from "../../agents-store.js";
import { MAX_ITEMS, MAX_PROMPT, MAX_RUNS, MAX_TITLE, STATUSES, clip, lastRecovery, newId, openCount, readStore, writeStore } from "./persist.js";
import { applyWhen, bumpNextRun, describeTodoWhen, isPeriodDone, pendingSlotDelivered, resolveWhen } from "./when.js";

// ── 클라이언트와 프롬프트에 내보내는 할 일·제안의 공개 모양. ──

const RUNNING_STALE_MS = 30 * 60 * 1000;

export function isRunning(item) {
    if (!item?.running?.at) return false;
    const at = Date.parse(item.running.at);
    return Number.isFinite(at) && Date.now() - at < RUNNING_STALE_MS;
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

// ── 할 일 항목의 조회·추가·수정·완료·재개·삭제. ──

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

// 수정 기록: 무엇이 바뀌었는지(changed)와 바뀐 항목 이름(fields)을 모은다.
class Edit {
    constructor() {
        this.changed = false;
        this.fields = [];
    }

    mark(field) {
        this.changed = true;
        if (field) this.fields.push(field);
    }
}

// 아래 apply* 함수는 patch의 한 항목을 item에 반영한다. 거절할 때는 오류 코드를 돌려주고, 아니면 undefined.
function applyTitle(item, patch, edit) {
    if (patch.title == null) return undefined;
    const title = clip(patch.title, MAX_TITLE);
    if (!title) return "title_required";
    if (title !== item.title) {
        item.title = title;
        edit.mark("title");
    }
    return undefined;
}

function applyPrompt(item, patch, edit) {
    if (patch.prompt == null) return undefined;
    const prompt = clip(patch.prompt, MAX_PROMPT);
    if (prompt !== (item.prompt || "")) {
        item.prompt = prompt;
        edit.mark("instructions");
    }
    return undefined;
}

function applyStatus(item, patch, edit) {
    if (patch.status != null && !STATUSES.has(patch.status)) return "invalid_status";
    if (patch.status === "done" && item.status !== "done" && !isPeriodDone(item)) {
        completeItem(item, new Date());
        edit.mark("status");
    } else if (patch.status === "open" && (item.status === "done" || isPeriodDone(item))) {
        const err = reopenWithSlot(item);
        if (err) return err;
        edit.mark("status");
    }
    return undefined;
}

function applyAssignee(item, patch, edit) {
    if (patch.assigneeId === undefined || (patch.assigneeId || null) === item.assigneeId) return undefined;
    if (patch.assigneeId && item.status !== "open") return "not_open";
    if (patch.assigneeId && !getAgent(patch.assigneeId)) return "agent_not_found";
    const acceptedOffer = patch.assigneeId ? (item.offers || []).find((row) => row.agentId === patch.assigneeId) : null;
    item.assigneeId = patch.assigneeId || null;
    if (acceptedOffer?.prompt && patch.prompt == null) item.prompt = acceptedOffer.prompt;
    if (item.assigneeId) item.offers = (item.offers || []).filter((row) => row.agentId !== item.assigneeId);
    voidRun(item);
    edit.mark("assignee");
    return undefined;
}

function applyList(item, patch, edit) {
    if (patch.list == null) return undefined;
    const next = clip(patch.list, 24) || "user";
    if (next !== "user" && !getAgent(next)) return "agent_not_found";
    if (next !== (item.list || "user")) {
        item.list = next;
        edit.mark("list");
    }
    return undefined;
}

function applyConversation(item, patch, edit) {
    if (patch.conversationId == null) return undefined;
    const conversationId = clip(patch.conversationId, 64);
    if (conversationId !== (item.conversationId || "")) {
        item.conversationId = conversationId;
        edit.mark("conversation");
    }
    return undefined;
}

function applyEnabled(item, patch, edit) {
    if (patch.enabled == null) return undefined;
    const enabled = Boolean(patch.enabled);
    if (enabled !== (item.enabled !== false)) {
        item.enabled = enabled;
        edit.mark("enabled");
    }
    return undefined;
}

const scheduleSignature = (item) => JSON.stringify([item.kind, item.cron, item.every, item.at, item.timezone, item.nextRunAt]);

function applySchedule(item, patch, edit, opts) {
    const wantsWhen =
        patch.cron != null || patch.every != null || patch.at != null || patch.timezone != null || patch.kind != null || patch.clearWhen;
    if (!wantsWhen) return undefined;
    const when = resolveWhen(patch, item, opts.whenMode || "update");
    if (when.error) return when.error;
    // 실제로 바뀌는 경우에만 적용한다(같은 값을 다시 보낸 것은 수정으로 치지 않는다).
    const probe = { ...item };
    applyWhen(probe, when);
    if (scheduleSignature(probe) !== scheduleSignature(item)) {
        applyWhen(item, when);
        voidRun(item);
        item.lastError = null;
        edit.mark("schedule");
    }
    return undefined;
}

// 지금 바로 실행되도록 당긴다: 켜고, 끝난 항목은 다시 열고, 다음 실행 시각을 과거로 둔다.
function applyFireImmediately(item, edit) {
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
    edit.mark("schedule");
}

const FIELD_APPLIERS = [applyTitle, applyPrompt, applyStatus, applyAssignee, applyList, applyConversation, applyEnabled, applySchedule];

export function updateTodo(id, patch = {}, opts = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === id);
    if (!item) return { error: "not_found" };
    if (patch.baseUpdatedAt != null && item.updatedAt !== patch.baseUpdatedAt) return { error: "conflict" };

    const edit = new Edit();
    for (const apply of FIELD_APPLIERS) {
        const error = apply(item, patch, edit, opts);
        if (error) return { error };
    }
    // 봇 소유 항목은 반드시 트리거(스케줄)가 있어야 한다. 해제 불가.
    if ((item.list || "user") !== "user" && (!item.kind || item.kind === "none")) return { error: "schedule_required" };
    if (item.status === "done" && item.nextRunAt != null) {
        item.nextRunAt = null;
        edit.mark();
    }
    if (patch.fireImmediately === true) applyFireImmediately(item, edit);

    if (edit.changed) {
        item.updatedAt = new Date().toISOString();
        if (item.assigneeId && edit.fields.length) {
            item.lastEdit = { by: opts.editedBy === "agent" ? "agent" : "user", at: item.updatedAt, fields: edit.fields };
        }
        writeStore(store);
    }
    return { item: publicTodo(item) };
}

export function voidRun(item) {
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
