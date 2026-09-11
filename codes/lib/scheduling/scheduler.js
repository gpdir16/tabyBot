import { listScheduleJobs, markScheduleJobRun } from "./store.js";
import { scheduleWork } from "../agent-queue.js";
import { firstAgent, getAgent } from "../agents-store.js";
import { isValidId } from "../web/conversations.js";

const TICK_MS = 1000;
const tasksInFlight = new Set();

let runJobHandler = null;
let timer = null;

export function setScheduleJobHandler(handler) {
    runJobHandler = handler;
}

function conversationKey(job) {
    const id = String(job.conversationId || "").trim();
    if (isValidId(id)) return id;
    return getAgent(job.agentId)?.uuid || firstAgent()?.uuid || "";
}

async function tick() {
    if (!runJobHandler) return;
    const now = Date.now();
    for (const job of listScheduleJobs()) {
        if (!job.enabled) continue;
        if (tasksInFlight.has(job.id)) continue;
        const next = Date.parse(job.nextRunAt || "");
        if (!Number.isFinite(next) || next > now) continue;

        tasksInFlight.add(job.id);
        const sessionKey = conversationKey(job);
        scheduleWork(
            "schedule",
            async () => {
                try {
                    const result = await runJobHandler(job);
                    markScheduleJobRun(job.id, {
                        silent: Boolean(result?.silent),
                        error: result?.error || null,
                    });
                    return result;
                } catch (err) {
                    markScheduleJobRun(job.id, { silent: true, error: err?.message || String(err) });
                    throw err;
                } finally {
                    tasksInFlight.delete(job.id);
                }
            },
            { sessionKey },
        ).catch((err) => {
            tasksInFlight.delete(job.id);
            console.error(`tabyBot: schedule job failed (${job.id}):`, err?.stack || err);
        });
    }
}

export function reloadScheduleJobs() {
    const jobs = listScheduleJobs().filter((job) => job.enabled);
    return { scheduled: jobs.length };
}

export function startScheduleScheduler() {
    reloadScheduleJobs();
    if (!timer) {
        timer = setInterval(() => {
            tick().catch((err) => console.error("tabyBot: schedule tick failed:", err?.stack || err));
        }, TICK_MS);
        timer.unref?.();
    }
    console.log(`tabyBot: scheduling loaded (${listScheduleJobs().filter((job) => job.enabled).length} job(s))`);
}

export function stopScheduleScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    tasksInFlight.clear();
}

export function queueScheduleJobNow(job) {
    if (!runJobHandler || !job) return { error: "scheduler not ready" };
    if (tasksInFlight.has(job.id)) return { error: "job already running" };
    tasksInFlight.add(job.id);
    const sessionKey = conversationKey(job);
    const pending = scheduleWork(
        "schedule",
        async () => {
            try {
                return await runJobHandler(job);
            } finally {
                tasksInFlight.delete(job.id);
            }
        },
        { sessionKey },
    );
    pending.catch((err) => {
        tasksInFlight.delete(job.id);
        console.error(`tabyBot: schedule run-now failed (${job.id}):`, err?.stack || err);
    });
    return { ok: true, queued: true };
}
