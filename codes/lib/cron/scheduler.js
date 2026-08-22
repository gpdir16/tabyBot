import cron from "node-cron";
import { listCronJobs, markCronJobRun } from "./store.js";
import { scheduleWork } from "../agent-queue.js";

const tasks = new Map();

let runJobHandler = null;

export function setCronJobHandler(handler) {
    runJobHandler = handler;
}

export function reloadCronSchedules() {
    for (const task of tasks.values()) {
        task.stop();
    }
    tasks.clear();

    if (!runJobHandler) return { scheduled: 0, invalid: [] };

    const invalid = [];
    let scheduled = 0;

    for (const job of listCronJobs()) {
        if (!job.enabled) continue;
        if (!cron.validate(job.schedule)) {
            invalid.push({ id: job.id, name: job.name, schedule: job.schedule });
            continue;
        }

        const task = cron.schedule(
            job.schedule,
            () => {
                scheduleWork("cron", async () => {
                    await runJobHandler(job);
                    markCronJobRun(job.id);
                }).catch((err) => {
                    console.error(`tabyAgent: cron job failed (${job.id}):`, err?.stack || err);
                });
            },
            { scheduled: true },
        );

        tasks.set(job.id, task);
        scheduled += 1;
    }

    return { scheduled, invalid };
}

export function startCronScheduler() {
    reloadCronSchedules();
    console.log(`tabyAgent: cron scheduler loaded (${tasks.size} job(s))`);
}

export function stopCronScheduler() {
    for (const task of tasks.values()) task.stop();
    tasks.clear();
}
