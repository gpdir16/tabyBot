import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "../paths.js";

const CRON_PATH = path.join(USER_DIR, "cron.json");

function defaultStore() {
    return { jobs: [] };
}

export function loadCronStore() {
    if (!fs.existsSync(CRON_PATH)) return defaultStore();
    try {
        const data = JSON.parse(fs.readFileSync(CRON_PATH, "utf8"));
        return { jobs: Array.isArray(data.jobs) ? data.jobs : [] };
    } catch {
        return defaultStore();
    }
}

function saveCronStore(store) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(CRON_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function listCronJobs() {
    return loadCronStore().jobs;
}

export function addCronJob({ name, schedule, prompt, chatId, enabled = true }) {
    const store = loadCronStore();
    const job = {
        id: crypto.randomBytes(6).toString("hex"),
        name: String(name || "task").trim(),
        schedule: String(schedule || "").trim(),
        prompt: String(prompt || "").trim(),
        chatId: String(chatId || "").trim(),
        enabled: enabled !== false,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
    };
    store.jobs.push(job);
    saveCronStore(store);
    return job;
}

export function removeCronJob(id) {
    const store = loadCronStore();
    const before = store.jobs.length;
    store.jobs = store.jobs.filter((j) => j.id !== id);
    saveCronStore(store);
    return { removed: before - store.jobs.length };
}

export function updateCronJob(id, patch) {
    const store = loadCronStore();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return null;
    if (patch.name != null) job.name = String(patch.name).trim();
    if (patch.schedule != null) job.schedule = String(patch.schedule).trim();
    if (patch.prompt != null) job.prompt = String(patch.prompt).trim();
    if (patch.enabled != null) job.enabled = Boolean(patch.enabled);
    saveCronStore(store);
    return job;
}

export function markCronJobRun(id) {
    const store = loadCronStore();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return;
    job.lastRunAt = new Date().toISOString();
    saveCronStore(store);
}
