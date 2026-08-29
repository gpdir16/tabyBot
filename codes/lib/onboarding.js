import { getMergedProvider, loadUserConfig } from "./config-loader.js";

export function isConfigReady() {
    const config = loadUserConfig();
    if (!config.provider?.model?.trim()) return false;
    try {
        const provider = getMergedProvider(config);
        return Boolean(provider.apiKey?.trim()) || Boolean(provider.apiKeyOptional);
    } catch {
        return false;
    }
}
