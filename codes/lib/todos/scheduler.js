import {
    clearTodoRun,
    dispatchTodoRun,
    getTodo,
    isTodoRunCurrent,
    listDueTodos,
    markTodoNotified,
    markTodoRun,
    reconcileRuns,
    skipTodoOccurrence,
} from "./store.js";
import { sameWallClock } from "../scheduling/time.js";
import { scheduleWork } from "../agent-queue.js";
import { firstAgent, getAgent } from "../agents-store.js";

const TICK_MS = 1000;
const inFlight = new Set();

let runAgentTodo = null;
let remindUserTodo = null;
let timer = null;
let emitEvent = null;

export function setTodoHandlers({ runAgent, remindUser, emit } = {}) {
    runAgentTodo = runAgent || null;
    remindUserTodo = remindUser || null;
    emitEvent = emit || null;
}

function flightKey(todoId) {
    return `todo:${todoId}`;
}

function notifyChanged() {
    try {
        emitEvent?.({ type: "todos_changed" });
    } catch {}
}

async function tick() {
    if (!runAgentTodo && !remindUserTodo) return;
    for (const due of listDueTodos()) {
        const item = due.item;
        const key = flightKey(item.id);
        if (inFlight.has(key)) continue;
        if (item.kind === "cron" && item.consumedSlot && item.nextRunAt && sameWallClock(item.consumedSlot, item.nextRunAt, item.timezone)) {
            if (skipTodoOccurrence(item.id, item.nextRunAt)) notifyChanged();
            continue;
        }
        const dispatch = dispatchTodoRun(item.id);
        if (!dispatch?.token) continue;
        const token = dispatch.token;
        inFlight.add(key);
        notifyChanged();

        const assignee = item.assigneeId ? getAgent(item.assigneeId) : null;
        const sessionKey = assignee ? assignee.uuid || "" : `todo-remind:${item.id}`;

        scheduleWork(
            "todo",
            async () => {
                try {
                    if (!isTodoRunCurrent(item.id, token)) return { skipped: true };
                    const fresh = getTodo(item.id);
                    if (!fresh) return { skipped: true };
                    if (assignee) {
                        if (!runAgentTodo) {
                            clearTodoRun(item.id, token);
                            return { skipped: true };
                        }
                        const result = await runAgentTodo({ agent: assignee, item: fresh, sessionKey });
                        markTodoRun(item.id, { error: result?.error || null, token });
                        return result;
                    }
                    if (remindUserTodo) await remindUserTodo({ item: fresh });
                    markTodoNotified(item.id, { token });
                } finally {
                    inFlight.delete(key);
                    notifyChanged();
                }
            },
            { sessionKey, cancellable: true },
        )
            .then((res) => {
                if (res?.error === "stopped_by_user" || res?.skipped) {
                    inFlight.delete(key);
                    clearTodoRun(item.id, token);
                    notifyChanged();
                }
            })
            .catch((err) => {
                inFlight.delete(key);
                markTodoRun(item.id, { error: err?.message || String(err), token });
                notifyChanged();
                console.error(`tabyBot: todo tick failed (${key}):`, err?.stack || err);
            });
    }
}

export function startTodoScheduler() {
    try {
        if (reconcileRuns()) emitEvent?.({ type: "todos_changed" });
    } catch (err) {
        console.error("tabyBot: todo reconcile failed:", err?.stack || err);
    }
    if (!timer) {
        timer = setInterval(() => {
            tick().catch((err) => console.error("tabyBot: todo tick failed:", err?.stack || err));
        }, TICK_MS);
        timer.unref?.();
    }
}

export function stopTodoScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    inFlight.clear();
}

export function queueTodoNow(agent, item) {
    if (!runAgentTodo || !agent || !item) return { error: "scheduler not ready" };
    const key = flightKey(item.id);
    if (inFlight.has(key)) return { error: "already running" };
    const sessionKey = agent.uuid || "";
    const dispatch = dispatchTodoRun(item.id, { advance: false });
    if (!dispatch?.token) return { error: "already running" };
    const token = dispatch.token;
    inFlight.add(key);
    notifyChanged();
    scheduleWork(
        "todo",
        async () => {
            try {
                if (!isTodoRunCurrent(item.id, token)) return { skipped: true };
                const fresh = getTodo(item.id);
                if (!fresh) return { skipped: true };
                const result = await runAgentTodo({ agent, item: fresh, sessionKey });
                markTodoRun(item.id, { error: result?.error || null, token });
                return result;
            } finally {
                inFlight.delete(key);
                notifyChanged();
            }
        },
        { sessionKey, cancellable: true },
    )
        .then((res) => {
            if (res?.error === "stopped_by_user" || res?.skipped) {
                inFlight.delete(key);
                clearTodoRun(item.id, token);
                notifyChanged();
            }
        })
        .catch((err) => {
            inFlight.delete(key);
            markTodoRun(item.id, { error: err?.message || String(err), token });
            notifyChanged();
            console.error(`tabyBot: todo run-now failed (${key}):`, err?.stack || err);
        });
    return { ok: true, queued: true };
}
