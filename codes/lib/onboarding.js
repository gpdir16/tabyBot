import { getMergedProvider, loadUserConfig } from "./config-loader.js";
import { hasCodexAuth } from "./llm/codex-tokens.js";
import { hasGrokAuth } from "./llm/grok-tokens.js";
import { hasGithubCopilotAuth } from "./llm/github-copilot-tokens.js";

const OAUTH_AUTH_CHECKS = {
    codex: hasCodexAuth,
    grok: hasGrokAuth,
    "github-copilot": hasGithubCopilotAuth,
};

export function getConfigIssue(config = loadUserConfig()) {
    if (!config.provider?.model?.trim()) return "model_missing";
    try {
        const provider = getMergedProvider(config);
        if (provider.type.endsWith("-oauth") && !OAUTH_AUTH_CHECKS[provider.id]?.()) return "oauth_missing";
        if (!provider.apiKey?.trim() && !provider.apiKeyOptional) return "api_key_missing";
        return null;
    } catch {
        return "provider_missing";
    }
}

export function isConfigReady(config = loadUserConfig()) {
    return getConfigIssue(config) === null;
}
