import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, USER_DIR } from "./paths.js";

function substituteEnv(value) {
    if (typeof value !== "string") return value;
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

function substituteDeep(obj) {
    if (typeof obj === "string") return substituteEnv(obj);
    if (Array.isArray(obj)) return obj.map(substituteDeep);
    if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            out[k] = substituteDeep(v);
        }
        return out;
    }
    return obj;
}

function readJson(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        console.error(`tabyAgent: invalid JSON in ${filePath}:`, err.message);
        return fallback;
    }
}

export function loadAgentConfig() {
    return readJson(path.join(CONFIG_DIR, "agent.json"), {
        maxToolRounds: 300,
        maxToolRoundsPerTurn: 300,
        maxToolCallsPerTurn: 300,
        maxSameToolRepeat: 8,
        maxEmptyReplyRetries: 8,
        contextCompressTriggerPercent: 75,
        contextKeepRecentPercent: 20,
        contextThresholdPercent: 90,
        authCodeTtlMinutes: 15,
    });
}

export function loadMcpConfig() {
    const userPath = path.join(USER_DIR, "mcp.json");
    return readJson(userPath, { servers: [] });
}

export function loadUserConfig() {
    const filePath = path.join(USER_DIR, "config.json");
    return readJson(filePath, {
        language: "en",
        telegram: { botToken: "" },
        provider: { id: "default", apiKey: "", model: "" },
        thinkingLevel: "high",
        showReplyFooter: true,
        updateCheckEnabled: true,
        nsfwLevel: "moderate",
        approvalLevel: "model",
    });
}

export function saveUserConfig(config) {
    const filePath = path.join(USER_DIR, "config.json");
    fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function loadProviderConfig(providerId) {
    const filePath = path.join(CONFIG_DIR, "provider", `${providerId}.json`);
    const base = readJson(filePath);
    if (!base) throw new Error(`Provider config not found: ${providerId}`);
    return substituteDeep(base);
}

export function getMergedProvider(userConfig) {
    const id = userConfig?.provider?.id || "default";
    const providerFile = loadProviderConfig(id);
    const baseURLOverride = userConfig?.provider?.baseURL?.trim();
    const baseURL = (baseURLOverride || providerFile.baseURL || "").replace(/\/$/, "");
    let apiKey = substituteEnv(userConfig?.provider?.apiKey || "");
    if (!apiKey && providerFile.apiKeyOptional) {
        apiKey = substituteEnv(providerFile.defaultApiKey || "");
    }
    return {
        id,
        type: providerFile.type,
        baseURL,
        apiKey,
        model: userConfig?.provider?.model || "",
        extraHeaders: providerFile.extraHeaders || {},
        apiKeyOptional: Boolean(providerFile.apiKeyOptional),
    };
}
