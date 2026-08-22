import fs from "node:fs";
import path from "node:path";
import { detectInstallHome, isDockerContainer, isManagedInstallEntry, managedInstallPathEnv, parseEnvValue } from "./install-paths.js";

function parseEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;
    const key = trimmed.slice(0, eq).trim();
    return { key, value: parseEnvValue(trimmed.slice(eq + 1)) };
}

function applyManagedInstallPaths(home) {
    for (const [key, value] of Object.entries(managedInstallPathEnv(home))) {
        process.env[key] = value;
    }
    // Host-managed installs always run Node locally; .env TABYAGENT_MODE is for install.sh routing.
    process.env.TABYAGENT_MODE = "local";
}

export function loadInstallEnv() {
    if (process.env.__TABYAGENT_ENV_LOADED) return;
    process.env.__TABYAGENT_ENV_LOADED = "1";

    if (isDockerContainer()) return;

    if (!isManagedInstallEntry()) return;

    const entry = process.argv[1];
    const home = detectInstallHome(entry);

    const envFile = path.join(home, ".env");
    if (fs.existsSync(envFile)) {
        const text = fs.readFileSync(envFile, "utf8");
        for (const line of text.split("\n")) {
            const parsed = parseEnvLine(line);
            if (!parsed) continue;
            process.env[parsed.key] = parsed.value;
        }
    }

    applyManagedInstallPaths(home);
}

loadInstallEnv();
