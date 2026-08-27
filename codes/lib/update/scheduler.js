import cron from "node-cron";
import { loadAgentConfig } from "../config-loader.js";
import { scheduleWork } from "../agent-queue.js";
import { checkForUpdate } from "./checker.js";
import { sendUpdateNotification } from "./notify.js";
import { loadUserConfig } from "../config-loader.js";
import { getUserUpdateCheckEnabled } from "../user-settings.js";
import { isRunningVersionKnown, saveUpdateState, setLastNotifiedVersion } from "./store.js";

let task = null;

let initialTimer = null;

function warnIfUnknownProductionVersion() {
    if (!isRunningVersionKnown()) {
        if (process.env.NODE_ENV === "production") {
            console.warn("tabyBot: TABYBOT_VERSION is unknown — update checks use watch mode until a release-tagged image is deployed");
        }
        return;
    }

    saveUpdateState({ watchStartedAt: null });
}

async function runUpdateCheck() {
    const update = await checkForUpdate();
    saveUpdateState({ lastCheckedAt: new Date().toISOString() });

    if (!update) return;

    sendUpdateNotification(update);
    setLastNotifiedVersion(update.tagName);
    console.log(`tabyBot: update notification sent (${update.tagName})`);
}

function queueUpdateCheck(label) {
    scheduleWork("cron", async () => {
        try {
            await runUpdateCheck();
        } catch (err) {
            console.error(`tabyBot: ${label} update check failed:`, err?.stack || err);
        }
    }).catch((err) => {
        console.error(`tabyBot: ${label} update check queue failed:`, err?.stack || err);
    });
}

export function startUpdateScheduler() {
    const agentCfg = loadAgentConfig().updateCheck ?? {};
    const userOverride = getUserUpdateCheckEnabled(loadUserConfig());
    const enabled = userOverride === null ? agentCfg.enabled !== false : userOverride;
    if (!enabled) {
        console.log("tabyBot: update checker disabled");
        return;
    }

    warnIfUnknownProductionVersion();

    const schedule = agentCfg.intervalCron || "0 * * * *";
    if (!cron.validate(schedule)) {
        console.warn(`tabyBot: invalid updateCheck.intervalCron "${schedule}", using "0 * * * *"`);
    }
    const expr = cron.validate(schedule) ? schedule : "0 * * * *";

    if (task) task.stop();

    task = cron.schedule(expr, () => queueUpdateCheck("scheduled"), { scheduled: true });

    const delayMs = agentCfg.initialDelayMs ?? 60_000;
    clearTimeout(initialTimer);
    initialTimer = setTimeout(() => {
        initialTimer = null;
        queueUpdateCheck("initial");
    }, delayMs);

    console.log(`tabyBot: update checker scheduled (${expr})`);
}

export function restartUpdateScheduler() {
    stopUpdateScheduler();
    startUpdateScheduler();
}

export function stopUpdateScheduler() {
    if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
    }
    if (task) {
        task.stop();
        task = null;
    }
}
