import cron from "node-cron";
import { loadAgentConfig } from "../config-loader.js";
import { scheduleWork } from "../agent-queue.js";
import { isUserIdle, DEFAULT_IDLE_REQUIRED_MS } from "../user-activity.js";
import { runDreamSweep } from "./sweep.js";

let task = null;
let idleTimer = null;
let sweepRunning = false;
let sweepPending = false;

function idleRequiredMs() {
    const m = loadAgentConfig().dreaming?.idleMin;
    return Number.isFinite(m) ? m * 60_000 : DEFAULT_IDLE_REQUIRED_MS;
}

function queueSweep(trigger) {
    if (sweepRunning) return;
    if (!isUserIdle(idleRequiredMs())) {
        sweepPending = true;
        return;
    }
    sweepPending = false;
    sweepRunning = true;
    scheduleWork("dream", () => runDreamSweep({ trigger }), { sessionKey: "dream:sweep" })
        .catch((err) => console.error(`tabyBot: ${trigger} dream sweep failed:`, err?.stack || err))
        .finally(() => {
            sweepRunning = false;
        });
}

export function startDreamingScheduler() {
    const cfg = loadAgentConfig().dreaming || {};
    if (cfg.enabled === false) {
        console.log("tabyBot: dreaming disabled");
        return;
    }

    const expr = cron.validate(cfg.cron || "") ? cfg.cron : "0 4 * * *";
    if (!cron.validate(cfg.cron || "")) {
        console.warn(`tabyBot: invalid dreaming.cron "${cfg.cron}", using "0 4 * * *"`);
    }

    if (task) task.stop();
    task = cron.schedule(expr, () => queueSweep("cron"), { scheduled: true });
    if (!idleTimer) {
        idleTimer = setInterval(() => {
            if (sweepPending) queueSweep("idle-deferred");
        }, 60_000);
        idleTimer.unref?.();
    }
    console.log(`tabyBot: dream sweep scheduled (${expr})`);
}

export function runDreamSweepNow(trigger = "manual") {
    queueSweep(trigger);
}

export function isSweepPending() {
    return sweepPending;
}

export function stopDreamingScheduler() {
    if (task) {
        task.stop();
        task = null;
    }
    if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
    }
}
