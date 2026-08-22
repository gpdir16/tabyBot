import { loadUserConfig, saveUserConfig } from "../config-loader.js";
import { getCachedProviderThinkingMeta, normalizeThinkingLevel, normalizeNsfwLevel, NSFW_LEVELS } from "../user-settings.js";

const ALLOWED_KEYS = new Set(["language", "thinkingLevel", "showReplyFooter", "updateCheckEnabled", "nsfwLevel"]);

export const configToolDefinitions = [
    {
        type: "function",
        function: {
            name: "config_set",
            description:
                "Update non-secret runtime config. language, thinkingLevel (provider /models), showReplyFooter, updateCheckEnabled, nsfwLevel (strict/moderate/explicit).",
            parameters: {
                type: "object",
                properties: {
                    language: { type: "string", enum: ["en", "ko", "ja"] },
                    thinkingLevel: { type: "string", description: "Level from provider /models metadata" },
                    showReplyFooter: { type: "boolean" },
                    updateCheckEnabled: { type: "boolean" },
                    nsfwLevel: {
                        type: "string",
                        enum: ["strict", "moderate", "explicit"],
                        description:
                            "strict = block all NSFW; moderate = indirect/suggestive allowed, explicit blocked (default); explicit = all NSFW allowed",
                    },
                },
            },
        },
    },
];

export async function executeConfigTool(name, args) {
    if (name !== "config_set") return { error: `Unknown config tool: ${name}` };

    const config = loadUserConfig();
    let updated = false;
    const a = args || {};

    for (const key of Object.keys(a)) {
        if (!ALLOWED_KEYS.has(key)) {
            return { error: `Field not allowed via config_set: ${key}` };
        }
    }

    if (a.language !== undefined) {
        if (!["en", "ko", "ja"].includes(a.language)) {
            return { error: "language must be en, ko, or ja" };
        }
        config.language = a.language;
        updated = true;
    }
    if (a.thinkingLevel !== undefined) {
        const meta = getCachedProviderThinkingMeta(config.provider?.id || "default", config.provider?.model || "");
        config.thinkingLevel = normalizeThinkingLevel(a.thinkingLevel, meta);
        updated = true;
    }
    if (a.showReplyFooter !== undefined) {
        config.showReplyFooter = Boolean(a.showReplyFooter);
        updated = true;
    }
    if (a.updateCheckEnabled !== undefined) {
        config.updateCheckEnabled = Boolean(a.updateCheckEnabled);
        updated = true;
    }
    if (a.nsfwLevel !== undefined) {
        if (!NSFW_LEVELS.includes(normalizeNsfwLevel(a.nsfwLevel))) {
            return { error: "nsfwLevel must be one of: strict, moderate, explicit" };
        }
        config.nsfwLevel = normalizeNsfwLevel(a.nsfwLevel);
        updated = true;
    }

    if (!updated) return { error: "No allowed fields provided" };
    saveUserConfig(config);
    return {
        ok: true,
        language: config.language,
        thinkingLevel: config.thinkingLevel,
        showReplyFooter: config.showReplyFooter,
        updateCheckEnabled: config.updateCheckEnabled,
        nsfwLevel: config.nsfwLevel,
    };
}
