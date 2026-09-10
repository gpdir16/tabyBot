import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "../paths.js";
import { computeNextRun, defaultTimeZone, describeSchedule, isValidTimeZone, parseAt, parseCron, parseEvery } from "./time.js";

const STORE_PATH = path.join(USER_DIR, "scheduling.json");
const MAX_RUNS = 20;

function defaultStore() {
    return { jobs: [] };
}

export function schedulingStorePath() {
    return STORE_PATH;
}

export function loadScheduleStore() {
    if (!fs.existsSync(STORE_PATH)) return defaultStore();
    try {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
        return { jobs: Array.isArray(data.jobs) ? data.jobs : [] };
    } catch {
        return defaultStore();
    }
}

function saveScheduleStore(store) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function publicJob(job) {
    return {
        ...job,
        schedule: describeSchedule(job),
    };
}

export function listScheduleJobs() {
    return loadScheduleStore().jobs.map(publicJob);
}

export function getScheduleJob(id) {
    const job = loadScheduleStore().jobs.find((item) => item.id === id);
    return job ? publicJob(job) : null;
}

function resolveKind(input) {
    const cron = input.cron != null && String(input.cron).trim() !== "" ? String(input.cron).trim() : "";
    const every = input.every != null && String(input.every).trim() !== "" ? String(input.every).trim() : "";
    const at = input.at != null && String(input.at).trim() !== "" ? String(input.at).trim() : "";
    const present = [cron && "cron", every && "every", at && "at"].filter(Boolean);
    if (present.length !== 1) {
        return { error: "Provide exactly one of cron, every, or at." };
    }
    const kind = present[0];
    const timezone = String(input.timezone || defaultTimeZone()).trim() || defaultTimeZone();
    if (!isValidTimeZone(timezone)) return { error: `invalid timezone: ${timezone}` };

    if (kind === "cron") {
        if (!parseCron(cron)) return { error: `invalid cron expression: ${cron}` };
        return { kind, cron, every: "", at: "", timezone };
    }
    if (kind === "every") {
        const parsed = parseEvery(every);
        if (parsed.error) return { error: parsed.error };
        return { kind, cron: "", every: parsed.label, at: "", timezone };
    }
    const parsed = parseAt(at, timezone);
    if (parsed.error) return { error: parsed.error };
    return { kind, cron: "", every: "", at, timezone };
}

function applyScheduleFields(job, schedule, fireImmediately, from = new Date()) {
    job.kind = schedule.kind;
    job.cron = schedule.cron;
    job.every = schedule.every;
    job.at = schedule.at;
    job.timezone = schedule.timezone;
    if (fireImmediately) {
        job.nextRunAt = new Date(from.getTime() - 1).toISOString();
    } else {
        job.nextRunAt = computeNextRun(job, from)?.toISOString() || null;
    }
}

export function addScheduleJob(input) {
    const schedule = resolveKind(input);
    if (schedule.error) return { error: schedule.error };

    const store = loadScheduleStore();
    const now = new Date();
    const job = {
        id: crypto.randomBytes(6).toString("hex"),
        name: String(input.name || "task").trim() || "task",
        prompt: String(input.prompt || "").trim(),
        conversationId: String(input.conversationId || "").trim(),
        agentId: String(input.agentId || "").trim(),
        enabled: input.enabled !== false,
        kind: schedule.kind,
        cron: schedule.cron,
        every: schedule.every,
        at: schedule.at,
        timezone: schedule.timezone,
        createdAt: now.toISOString(),
        lastRunAt: null,
        nextRunAt: null,
        runs: [],
    };
    applyScheduleFields(job, schedule, Boolean(input.fireImmediately), now);
    store.jobs.push(job);
    saveScheduleStore(store);
    return { job: publicJob(job) };
}

export function removeScheduleJob(id) {
    const store = loadScheduleStore();
    const before = store.jobs.length;
    store.jobs = store.jobs.filter((job) => job.id !== id);
    saveScheduleStore(store);
    return { removed: before - store.jobs.length };
}

export function updateScheduleJob(id, patch) {
    const store = loadScheduleStore();
    const job = store.jobs.find((item) => item.id === id);
    if (!job) return { error: "job not found" };

    if (patch.name != null) job.name = String(patch.name).trim() || job.name;
    if (patch.prompt != null) job.prompt = String(patch.prompt).trim();
    if (patch.conversationId != null) job.conversationId = String(patch.conversationId).trim();
    if (patch.agentId != null) job.agentId = String(patch.agentId).trim();
    if (patch.enabled != null) job.enabled = Boolean(patch.enabled);

    const wantsSchedule = patch.cron != null || patch.every != null || patch.at != null || patch.timezone != null;
    if (wantsSchedule) {
        const schedule = resolveKind({
            cron: patch.cron != null ? patch.cron : job.kind === "cron" ? job.cron : "",
            every: patch.every != null ? patch.every : job.kind === "every" ? job.every : "",
            at: patch.at != null ? patch.at : job.kind === "at" ? job.at : "",
            timezone: patch.timezone != null ? patch.timezone : job.timezone,
        });
        if (schedule.error) return { error: schedule.error };
        applyScheduleFields(job, schedule, Boolean(patch.fireImmediately));
    } else if (patch.fireImmediately) {
        job.nextRunAt = new Date(Date.now() - 1).toISOString();
        job.enabled = true;
    }

    saveScheduleStore(store);
    return { job: publicJob(job) };
}

export function markScheduleJobRun(id, { silent = false, error = null } = {}) {
    const store = loadScheduleStore();
    const job = store.jobs.find((item) => item.id === id);
    if (!job) return null;
    const now = new Date();
    job.lastRunAt = now.toISOString();
    job.runs = [...(Array.isArray(job.runs) ? job.runs : []), { at: job.lastRunAt, silent: Boolean(silent), error: error || null }].slice(-MAX_RUNS);
    if (job.kind === "at") {
        job.enabled = false;
        job.nextRunAt = null;
    } else {
        job.nextRunAt = computeNextRun(job, now)?.toISOString() || null;
    }
    saveScheduleStore(store);
    return publicJob(job);
}
