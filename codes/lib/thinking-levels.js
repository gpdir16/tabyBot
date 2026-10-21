import { loadUserConfig, loadProviderConfig, providerConfigOf } from "./config-loader.js";
import { defaultPreset } from "./model-presets.js";

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

// 기본 모델 프리셋의 추론 깊이.
export function getThinkingLevelForUser(config = loadUserConfig()) {
    const preset = defaultPreset(config);
    const pid = providerConfigOf(config, preset.profile).provider?.id || "default";
    return normalizeThinkingLevel(preset.thinkingLevel || config.reasoningEffort, pid);
}

export function getProviderThinkingMeta(providerId) {
    return getProviderThinking(providerId);
}

export function getCachedProviderThinkingMeta(providerId, _model) {
    return getProviderThinking(providerId);
}
