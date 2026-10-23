// 모델 프리셋: 프로바이더(로그인이나 키를 담은 프로필), 모델, 추론 깊이, OpenRouter 고정을 한 묶음으로 저장해 두고 이름으로 고른다.
// config.modelPresets = [{ uid, name, named?, profile, model, thinkingLevel, openRouterPin?, autoModelCandidates? }]
// config.defaultModelPreset = uid. 에이전트는 프리셋 uid를 고르고, 고르지 않으면 기본 프리셋을 쓴다.
// 프리셋이 없던 설정은 지금 프로바이더와 모델로 만든 첫 프리셋이 있는 것으로 읽는다(저장은 다음 변경 때 한다).
import crypto from "node:crypto";

const MAX_NAME = 60;
const MAX_MODEL = 200;
const MAX_PIN = 64;
const MAX_AUTO_MODEL_CANDIDATES = 30;

const INITIAL_PRESET_UID = "initial";

function legacyPin(config, model) {
    const pins = config.provider?.openRouterPins;
    if (pins && typeof pins === "object" && pins[model]) return String(pins[model]);
    return String(config.provider?.openRouterProvider || "");
}

// 프리셋이 없을 때 지금 설정(config.provider, config.thinkingLevel)으로 만든 첫 프리셋.
function initialPreset(config) {
    let model = String(config.provider?.model || "").trim();
    // 예전 GitHub Copilot 설정은 자동 모드가 따로 켜져 있었다(기본으로 켜짐). 이제는 모델 "auto"다.
    if (config.provider?.id === "github-copilot" && config.provider.autoMode !== false) model = "auto";
    const preset = {
        uid: INITIAL_PRESET_UID,
        name: "",
        profile: config.activeProviderProfile || "",
        model,
        thinkingLevel: String(config.thinkingLevel || ""),
    };
    const pin = model ? legacyPin(config, model) : "";
    if (pin) preset.openRouterPin = pin;
    if (Array.isArray(config.provider?.autoModelCandidates)) preset.autoModelCandidates = config.provider.autoModelCandidates.map(String);
    return preset;
}

// 읽기 전용 목록. 저장된 것이 없으면 첫 프리셋 하나.
export function presetsOf(config) {
    const list = Array.isArray(config?.modelPresets) ? config.modelPresets.filter((p) => p && typeof p === "object" && p.uid) : [];
    return list.length ? list : [initialPreset(config || {})];
}

export function defaultPreset(config) {
    const list = presetsOf(config);
    return list.find((p) => p.uid === config?.defaultModelPreset) || list[0];
}

// uid의 프리셋. 없거나 비었으면 기본 프리셋.
export function findPreset(config, uid = "") {
    if (uid) {
        const found = presetsOf(config).find((p) => p.uid === uid);
        if (found) return found;
    }
    return defaultPreset(config);
}

// 고치기 전에 부른다: 읽기 전용 첫 프리셋을 실제로 저장할 목록으로 만든다. 바꾼 것이 있으면 true.
export function ensurePresets(config) {
    let changed = false;
    if (!Array.isArray(config.modelPresets) || !config.modelPresets.some((p) => p?.uid)) {
        config.modelPresets = presetsOf(config).map((p) => ({ ...p }));
        changed = true;
    }
    if (!config.modelPresets.some((p) => p.uid === config.defaultModelPreset)) {
        config.defaultModelPreset = config.modelPresets[0].uid;
        changed = true;
    }
    return changed;
}

function normalizePresetName(name) {
    return String(name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NAME);
}

// 프리셋 고침을 적용한다. profiles: 있는 프로바이더 프로필 uid 목록. 잘못되면 { error }.
export function applyPresetPatch(preset, patch, profiles) {
    if (patch.name !== undefined) {
        const name = normalizePresetName(patch.name);
        preset.name = name;
        if (name) preset.named = true;
        else delete preset.named;
    }
    if (patch.profile !== undefined) {
        const uid = String(patch.profile || "");
        if (!profiles.includes(uid)) return { error: "unknown_profile" };
        if (uid !== preset.profile) {
            // 다른 프로바이더의 모델과 고정은 그대로 쓸 수 없다.
            preset.profile = uid;
            if (patch.model === undefined) preset.model = "";
            delete preset.openRouterPin;
            delete preset.autoModelCandidates;
        }
    }
    if (patch.model !== undefined) {
        const model = String(patch.model || "").trim();
        if (model.length > MAX_MODEL) return { error: "model_too_long" };
        if (model !== preset.model && patch.openRouterPin === undefined) delete preset.openRouterPin;
        preset.model = model;
    }
    if (patch.thinkingLevel !== undefined) preset.thinkingLevel = String(patch.thinkingLevel || "").slice(0, 16);
    if (patch.openRouterPin !== undefined) {
        const tag = String(patch.openRouterPin || "")
            .trim()
            .slice(0, MAX_PIN);
        if (tag) preset.openRouterPin = tag;
        else delete preset.openRouterPin;
    }
    if (patch.autoModelCandidates !== undefined) {
        if (!Array.isArray(patch.autoModelCandidates)) return { error: "invalid_auto_model_candidates" };
        const list = [...new Set(patch.autoModelCandidates.map((id) => String(id).trim()).filter(Boolean))].slice(0, MAX_AUTO_MODEL_CANDIDATES);
        if (list.length) preset.autoModelCandidates = list;
        else delete preset.autoModelCandidates;
    }
    return null;
}

export function addPreset(config, preset) {
    ensurePresets(config);
    const created = { uid: crypto.randomUUID(), name: "", profile: "", model: "", thinkingLevel: "", ...preset };
    config.modelPresets.push(created);
    return created;
}

// 마지막 남은 프리셋은 지우지 않는다. 기본 프리셋을 지우면 다음 프리셋이 기본이 된다.
export function removePreset(config, uid) {
    ensurePresets(config);
    const idx = config.modelPresets.findIndex((p) => p.uid === uid);
    if (idx < 0) return { error: "not_found" };
    if (config.modelPresets.length <= 1) return { error: "last_preset" };
    config.modelPresets.splice(idx, 1);
    if (config.defaultModelPreset === uid) config.defaultModelPreset = config.modelPresets[Math.min(idx, config.modelPresets.length - 1)].uid;
    return {};
}

// 프로필을 쓰는 프리셋 수(프로필을 지워도 되는지 볼 때).
export function presetsUsingProfile(config, profileUid) {
    return presetsOf(config).filter((p) => p.profile === profileUid).length;
}
