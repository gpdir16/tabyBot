import { beginAgentSession, endAgentSession } from "./agent/session.js";

// 세션 키마다 따로 돈다. 같은 방에서만 직렬, 다른 토픽은 동시에 진행.
const lanes = new Map();

function laneKey(opts = {}) {
    return String(opts.sessionKey || opts.chatId || "_");
}

function getLane(key) {
    let lane = lanes.get(key);
    if (!lane) {
        lane = { queue: [], running: false };
        lanes.set(key, lane);
    }
    return lane;
}

export function scheduleWork(priority, fn, opts = {}) {
    const key = laneKey(opts);
    const cancellable = Boolean(opts.cancellable && key !== "_");

    if (priority === "user" && cancellable) {
        beginAgentSession(key);
    }

    return new Promise((resolve, reject) => {
        const lane = getLane(key);
        lane.queue.push({ priority, fn, resolve, reject, sessionKey: key, cancellable });
        pump(key);
    });
}

export function cancelQueuedAgentWork(sessionKey) {
    const key = String(sessionKey);
    const lane = lanes.get(key);
    if (!lane) return false;

    let cancelled = false;
    for (let i = lane.queue.length - 1; i >= 0; i -= 1) {
        const item = lane.queue[i];
        if (!item.cancellable) continue;
        lane.queue.splice(i, 1);
        item.resolve({ error: "stopped_by_user", queued: true });
        cancelled = true;
    }

    if (cancelled && !lane.running) {
        endAgentSession(key);
    }

    return cancelled;
}

function pickNextIndex(queue) {
    const userIdx = queue.findIndex((q) => q.priority === "user");
    if (userIdx >= 0) return userIdx;
    return queue.findIndex((q) => q.priority === "cron");
}

async function pump(sessionKey) {
    const lane = lanes.get(sessionKey);
    if (!lane || lane.running) return;
    const idx = pickNextIndex(lane.queue);
    if (idx < 0) return;

    const item = lane.queue.splice(idx, 1)[0];
    lane.running = true;
    try {
        item.resolve(await item.fn());
    } catch (err) {
        console.error("Queue work failed:", err?.stack || err);
        item.reject(err);
    } finally {
        lane.running = false;
        pump(sessionKey);
    }
}
