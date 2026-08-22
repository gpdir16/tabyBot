import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, USER_DIR } from "../paths.js";

const STATE_PATH = path.join(USER_DIR, "temp", "update-state.json");
const BAKED_VERSION_PATH = path.join(APP_ROOT, "VERSION");

function defaultState() {
    return { lastNotifiedVersion: null, lastCheckedAt: null, watchStartedAt: null };
}

export function loadUpdateState() {
    if (!fs.existsSync(STATE_PATH)) return defaultState();
    try {
        const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
        return {
            lastNotifiedVersion: data.lastNotifiedVersion ?? null,
            lastCheckedAt: data.lastCheckedAt ?? null,
            watchStartedAt: data.watchStartedAt ?? null,
        };
    } catch {
        return defaultState();
    }
}

export function saveUpdateState(patch) {
    const state = { ...loadUpdateState(), ...patch };
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return state;
}

export function getLastNotifiedVersion() {
    return loadUpdateState().lastNotifiedVersion;
}

export function getWatchStartedAt() {
    return loadUpdateState().watchStartedAt;
}

export function setLastNotifiedVersion(version) {
    return saveUpdateState({ lastNotifiedVersion: version });
}

function readBakedVersionFile() {
    try {
        return fs.readFileSync(BAKED_VERSION_PATH, "utf8").trim();
    } catch {
        return null;
    }
}

function isUsableVersion(v) {
    const trimmed = String(v || "").trim();
    return Boolean(trimmed) && trimmed !== "dev" && !/^sha-/i.test(trimmed);
}

export function getRunningVersion() {
    const fromEnv = process.env.TABYAGENT_VERSION?.trim();
    if (isUsableVersion(fromEnv)) return fromEnv;

    const fromFile = readBakedVersionFile();
    if (isUsableVersion(fromFile)) return fromFile;

    return null;
}

export function isRunningVersionKnown() {
    return getRunningVersion() !== null;
}
