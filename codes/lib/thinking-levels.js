import { loadUserConfig, loadProviderConfig } from "./config-loader.js";

const LABELS = {
    en: { off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" },
    ko: { off: "끔", none: "없음", minimal: "최소", low: "낮음", medium: "중간", high: "높음", xhigh: "매우 높음", max: "최대" },
    ja: { off: "オフ", none: "なし", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" },
};

function getProviderThinking(providerId) {
    try {
        const p = loadProviderConfig(providerId);
        const levels = Array.isArray(p.thinkingLevels) ? p.thinkingLevels.map(String) : [];
        return {
            levels: levels.map((l) => l.toLowerCase()),
            defaultLevel: String(p.defaultThinkingLevel || levels[0] || "medium").toLowerCase(),
            param: p.thinkingParam || "reasoning_effort",
        };
    } catch {
        return { levels: [], defaultLevel: "medium", param: "reasoning_effort" };
    }
}

export function thinkingLevelLabel(lang, level) {
    const L = String(level || "").toLowerCase();
    const map = LABELS[lang] || LABELS.en;
    return map[L] || L;
}

export function normalizeThinkingLevel(value, providerIdOrMeta) {
    let pid = "default";
    if (typeof providerIdOrMeta === "string") {
        pid = providerIdOrMeta;
    } else if (providerIdOrMeta && typeof providerIdOrMeta === "object") {
        pid = providerIdOrMeta.providerId || "default";
    }
    const meta = getProviderThinking(pid);
    const v = String(value ?? "")
        .toLowerCase()
        .trim();
    if (!v) return meta.defaultLevel;
    if (!meta.levels.length) return v;
    if (meta.levels.includes(v)) return v;
    return meta.defaultLevel;
}

export function getThinkingLevelForUser(config = loadUserConfig()) {
    const pid = config.provider?.id || "default";
    return normalizeThinkingLevel(config.thinkingLevel ?? config.reasoningEffort, pid);
}

export function getProviderThinkingMeta(providerId) {
    return getProviderThinking(providerId);
}

export function getCachedProviderThinkingMeta(providerId, _model) {
    return getProviderThinking(providerId);
}
