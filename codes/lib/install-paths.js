import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_HOME_MARKER = `${path.sep}.tabyagent`;
export const MANAGED_CODES_SUFFIX = `${MANAGED_HOME_MARKER}${path.sep}app${path.sep}codes`;

function homeFromManagedCodesPath(resolvedPath) {
    const markerIdx = resolvedPath.indexOf(MANAGED_CODES_SUFFIX);
    if (markerIdx < 0) return null;
    return path.resolve(resolvedPath.slice(0, markerIdx + MANAGED_HOME_MARKER.length));
}

const APP_CODES_SUFFIX = `${path.sep}app${path.sep}codes`;

export function homeFromAppCodesLayout(targetPath) {
    if (!targetPath) return null;
    const resolved = path.resolve(String(targetPath));
    if (resolved.endsWith(APP_CODES_SUFFIX)) {
        return path.resolve(resolved.slice(0, resolved.length - APP_CODES_SUFFIX.length));
    }
    const needle = `${APP_CODES_SUFFIX}${path.sep}`;
    const idx = resolved.indexOf(needle);
    if (idx >= 0) {
        return path.resolve(resolved.slice(0, idx));
    }
    return null;
}

export function resolveManagedInstallHome(entry = process.argv[1], codesDir = process.env.CODES_DIR) {
    for (const candidate of [entry, codesDir]) {
        if (!candidate) continue;
        const resolved = path.resolve(String(candidate));
        const fromManaged = homeFromManagedCodesPath(resolved);
        if (fromManaged) return fromManaged;
        const fromLayout = homeFromAppCodesLayout(candidate);
        if (fromLayout) return fromLayout;
    }
    return null;
}

export function parseEnvValue(raw) {
    let value = String(raw ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    return value.replace(/\\([\\"$])/g, "$1");
}

let dockerContainerCache = null;

export function isDockerContainer() {
    if (dockerContainerCache !== null) return dockerContainerCache;
    try {
        if (fs.existsSync("/.dockerenv")) {
            dockerContainerCache = true;
            return true;
        }
    } catch {
        // fs access denied
    }
    const mode = process.env.TABYAGENT_MODE?.trim().toLowerCase();
    const appRoot = process.env.APP_ROOT?.trim();
    dockerContainerCache = mode === "docker" && appRoot === "/app";
    return dockerContainerCache;
}

export function hasManagedInstallMarker(home) {
    const resolved = path.resolve(home);
    try {
        const envFile = path.join(resolved, ".env");
        if (!fs.existsSync(envFile)) return false;
        const text = fs.readFileSync(envFile, "utf8");
        const modeMatch = text.match(/^TABYAGENT_MODE=(.+)$/m);
        if (!modeMatch) return false;
        const mode = parseEnvValue(modeMatch[1]).trim().toLowerCase();
        if (mode !== "docker" && mode !== "local") return false;
        const tokenMatch = text.match(/^TELEGRAM_BOT_TOKEN=(.*)$/m);
        if (!tokenMatch || !parseEnvValue(tokenMatch[1]).trim()) return false;
        const homeMatch = text.match(/^TABYAGENT_HOME=(.+)$/m);
        if (homeMatch && path.resolve(parseEnvValue(homeMatch[1])) === resolved) return true;
        return fs.existsSync(path.join(resolved, "app", "codes", "index.js"));
    } catch {
        return false;
    }
}

export function defaultInstallHome() {
    return path.join(process.env.HOME || os.homedir() || "/tmp", ".tabyagent");
}

export function detectInstallHome(entry = process.argv[1]) {
    const fromLayout = resolveManagedInstallHome(entry);
    if (fromLayout) return fromLayout;

    const fromEnv = process.env.TABYAGENT_HOME?.trim();
    if (fromEnv) return path.resolve(fromEnv);

    return defaultInstallHome();
}

export function isManagedInstallEntry(entry = process.argv[1]) {
    if (!entry) return false;

    const resolvedEntry = path.resolve(entry);

    const fromEnv = process.env.TABYAGENT_HOME?.trim();
    if (fromEnv) {
        const installHome = path.resolve(fromEnv);
        const appCodes = path.join(installHome, "app", "codes");
        if (hasManagedInstallMarker(installHome) && (resolvedEntry === appCodes || resolvedEntry.startsWith(`${appCodes}${path.sep}`))) {
            return true;
        }
    }

    const layoutHome = homeFromAppCodesLayout(resolvedEntry);
    if (layoutHome && hasManagedInstallMarker(layoutHome)) {
        return true;
    }

    if (!resolvedEntry.includes(MANAGED_CODES_SUFFIX)) return false;
    return hasManagedInstallMarker(detectInstallHome(entry));
}

export function managedInstallPathEnv(home) {
    return {
        TABYAGENT_HOME: home,
        APP_ROOT: path.join(home, "app"),
        USER_DIR: path.join(home, "user"),
        CODES_DIR: path.join(home, "app", "codes"),
        CONFIG_DIR: path.join(home, "app", "codes", "config"),
    };
}
