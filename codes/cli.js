#!/usr/bin/env node
import { ensureUserDir } from "./lib/bootstrap.js";
import { loadUserConfig, getMergedProvider } from "./lib/config-loader.js";
import { isConfigReady } from "./lib/onboarding.js";
import { getRunningVersion } from "./lib/update/store.js";

ensureUserDir();

const [, , command] = process.argv;

if (command === "status") {
    const config = loadUserConfig();
    const provider = (() => {
        try {
            return getMergedProvider(config);
        } catch {
            return null;
        }
    })();
    console.log(`tabyBot ${getRunningVersion() || process.env.TABYBOT_VERSION || "dev"}`);
    console.log(`configured: ${isConfigReady() ? "yes" : "no"}`);
    if (provider) console.log(`provider: ${provider.id} · model: ${provider.model || "(unset)"}`);
    console.log("web UI: http://127.0.0.1:8999");
    process.exit(0);
}

console.error("Usage: node cli.js status");
console.error("Setup and conversations are managed in the web UI.");
process.exit(command && command !== "status" ? 1 : 0);
