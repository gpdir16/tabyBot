import cron from "node-cron";
import { scheduleWork } from "../agent-queue.js";
import { getDreamingConfig } from "../self-improvement.js";
import { isUserIdle, DEFAULT_IDLE_REQUIRED_MS } from "../user-activity.js";
import { isValidTimeZone, defaultTimeZone } from "../scheduling/time.js";
import { runDreamSweep } from "./sweep.js";

let task = null;
let idleTimer = null;
let sweepRunning = false;
let sweepPending = false;

function idleRequiredMs() {
    const m = getDreamingConfig().idleMin;
    return Number.isFinite(m) ? m * 60_000 : DEFAULT_IDLE_REQUIRED_MS;
}

function queueSweep(trigger) {
    if (getDreamingConfig().enabled === false) {
        sweepPending = false;
        return;
    }
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

// 재진입 가능: 설정이 바뀌면 다시 호출해 크론을 재설정한다.
export function startDreamingScheduler() {
    if (task) {
        task.stop();
        task = null;
    }
    const cfg = getDreamingConfig();
    if (cfg.enabled === false) {
        console.log("tabyBot: dreaming disabled");
        return;
    }

    const expr = cron.validate(cfg.cron || "") ? cfg.cron : "0 4 * * *";
    if (!cron.validate(cfg.cron || "")) {
        console.warn(`tabyBot: invalid dreaming.cron "${cfg.cron}", using "0 4 * * *"`);
    }

    // 도커는 시스템 시간이 UTC라 시스템 기본값에만 맡기면 "새벽 4시"가 엉뚱한 시각이 된다.
    const tz = isValidTimeZone(cfg.timezone) ? cfg.timezone : defaultTimeZone();
    task = cron.schedule(expr, () => queueSweep("cron"), { scheduled: true, timezone: tz });
    if (!idleTimer) {
        idleTimer = setInterval(() => {
            if (sweepPending) queueSweep("idle-deferred");
        }, 60_000);
        idleTimer.unref?.();
    }
    console.log(`tabyBot: dream sweep scheduled (${expr}, ${tz})`);
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
