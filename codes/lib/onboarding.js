import { loadUserConfig, loadProviderConfig } from "./config-loader.js";

export function isConfigReady() {
    const config = loadUserConfig();
    if (!config.provider?.model?.trim()) return false;
    const pid = config.provider?.id || "default";
    try {
        const p = loadProviderConfig(pid);
        if (p.apiKeyOptional) return true;
    } catch {}
    return Boolean(config.provider?.apiKey?.trim());
}
