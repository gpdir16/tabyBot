import path from "node:path";
import { CONFIG_DIR, USER_DIR } from "./paths.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-file.js";
import { findPreset } from "./model-presets.js";

// 깨진 파일은 경로와 함께 오류로 남기고 fallback을 쓴다.
const readJson = (filePath, fallback = null) => readJsonFile(filePath, fallback, { label: `JSON in ${filePath}` });

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

export function loadAgentConfig() {
    return readJson(path.join(CONFIG_DIR, "agent.json"), {
        maxToolRounds: 300,
        maxToolRoundsPerTurn: 300,
        maxToolCallsPerTurn: 300,
        maxEmptyReplyRetries: 8,
        contextCompressTriggerPercent: 75,
        contextKeepRecentPercent: 20,
        contextThresholdPercent: 90,
    });
}

export function loadMcpConfig() {
    const userPath = path.join(USER_DIR, "mcp.json");
    return readJson(userPath, { servers: [] });
}

export function saveMcpConfig(config) {
    const filePath = path.join(USER_DIR, "mcp.json");
    writeJsonAtomic(filePath, config);
}

export function loadUserConfig() {
    const filePath = path.join(USER_DIR, "config.json");
    return readJson(filePath, {
        language: "en",
        provider: { id: "default", apiKey: "", model: "" },
        thinkingLevel: "high",
        showReplyFooter: true,
        updateCheckEnabled: true,
        onboardingDismissed: false,
        nsfwLevel: "moderate",
        approvalLevel: "model",
    });
}

export function saveUserConfig(config) {
    const filePath = path.join(USER_DIR, "config.json");
    writeJsonAtomic(filePath, config);
}

export function loadProviderConfig(providerId) {
    const filePath = path.join(CONFIG_DIR, "provider", `${providerId}.json`);
    const base = readJson(filePath);
    if (!base) throw new Error(`Provider config not found: ${providerId}`);
    return substituteDeep(base);
}

// 저장된 프로바이더 프로필 하나의 설정(주소, 키). uid가 없거나 못 찾으면 고른 프로필, 즉 config.provider다.
// 고른 프로필의 정본은 config.provider이고 프로필 목록의 것은 사본이다.
export function providerConfigOf(userConfig, uid = "") {
    const active = userConfig?.activeProviderProfile || "";
    if (uid && uid !== active) {
        const profile = (userConfig?.providerProfiles || []).find((p) => p?.uid === uid);
        if (profile?.provider) return { uid, provider: profile.provider };
    }
    return { uid: active, provider: userConfig?.provider || {} };
}

// 프로바이더 프로필 하나의 접속 정보(종류, 주소, 키). 모델은 들어 있지 않다.
export function getProfileProvider(userConfig, profileUid = "") {
    const { uid, provider: providerConfig } = providerConfigOf(userConfig, profileUid);
    const id = providerConfig?.id || "default";
    const providerFile = loadProviderConfig(id);
    const baseURLOverride = providerConfig?.baseURL?.trim();
    const baseURL = (baseURLOverride || providerFile.baseURL || "").replace(/\/$/, "");
    let apiKey = substituteEnv(providerConfig?.apiKey || "");
    if (!apiKey && providerFile.apiKeyOptional) {
        apiKey = substituteEnv(providerFile.defaultApiKey || "");
    }
    const out = {
        profileUid: uid,
        id,
        type: providerFile.type,
        baseURL,
        apiKey,
        extraHeaders: providerFile.extraHeaders || {},
        apiKeyOptional: Boolean(providerFile.apiKeyOptional),
    };
    if (providerFile.defaultContextWindow) out.defaultContextWindow = providerFile.defaultContextWindow;
    return out;
}

// 모델 프리셋 하나를 실제 요청 설정으로 푼다. presetUid를 비우면 기본 프리셋.
// 주소와 키는 프리셋이 가리키는 프로바이더 프로필에서, 모델과 추론 깊이, 고정은 프리셋에서 온다.
export function getMergedProvider(userConfig, presetUid = "") {
    const preset = findPreset(userConfig || {}, presetUid);
    const base = getProfileProvider(userConfig, preset.profile);
    const model = String(preset.model || "").trim();
    const pin = base.id === "openrouter" && model ? String(preset.openRouterPin || "").trim() : "";
    return {
        ...base,
        // 이 설정을 만든 프리셋. 캐시 유지 설정을 프리셋마다 따로 두는 데 쓴다.
        presetUid: preset.uid,
        model,
        thinkingLevel: String(preset.thinkingLevel || ""),
        // GitHub Copilot의 자동 모델은 프리셋의 모델을 "auto"로 고른 것이다.
        autoMode: base.id === "github-copilot" && model === "auto",
        autoModelCandidates: Array.isArray(preset.autoModelCandidates) ? preset.autoModelCandidates.map(String).filter(Boolean) : [],
        // OpenRouter 전용: 이 모델을 서빙할 업스트림 프로바이더 고정.
        openRouterPins: pin ? { [model]: pin } : {},
    };
}
