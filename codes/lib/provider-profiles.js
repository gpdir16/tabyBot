// 프로바이더 프로필: 같은 프로바이더나 커스텀 주소를 여러 개 저장해 두고 하나를 골라 쓴다.
// config.providerProfiles = [{ uid, name, named?, custom?, provider }], config.activeProviderProfile = uid.
// named: 사용자가 이름을 직접 정했는지. 정하지 않았으면 커스텀 주소의 호스트를 따라 이름이 바뀐다.
// 대화 경로는 지금처럼 config.provider만 읽는다. config.provider는 고른 프로필의 사본이다.
import crypto from "node:crypto";

const MAX_NAME = 60;

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
}

export function normalizeProfileName(name) {
    return String(name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NAME);
}

// 이미 쓰는 이름이면 뒤에 번호를 붙인다("OpenRouter 2").
export function uniqueProfileName(profiles, base) {
    const taken = new Set(profiles.map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const name = `${base} ${n}`;
        if (!taken.has(name)) return name;
    }
}

// 프로필이 없으면 지금 config.provider로 첫 프로필을 만든다. 만들었거나 고친 것이 있으면 true.
// isCustom(provider): 이 설정이 커스텀 주소인지. labelOf(profile): 이름이 없을 때 붙일 이름.
export function ensureProfiles(config, { isCustom, labelOf }) {
    let changed = false;
    if (!Array.isArray(config.providerProfiles)) config.providerProfiles = [];
    const profiles = config.providerProfiles.filter((p) => p && typeof p === "object" && p.uid);
    if (profiles.length !== config.providerProfiles.length) changed = true;
    config.providerProfiles = profiles;
    if (!profiles.length) {
        const provider = clone(config.provider || { id: "default", model: "" });
        // 저장하기 전에 읽기만 해도 같은 uid가 나오도록 첫 프로필의 uid는 고정한다.
        const profile = { uid: "initial", name: "", provider };
        if (isCustom(provider)) profile.custom = true;
        profile.name = labelOf(profile);
        profiles.push(profile);
        config.activeProviderProfile = profile.uid;
        return true;
    }
    for (const p of profiles) {
        if (!p.provider || typeof p.provider !== "object") {
            p.provider = { id: "default", model: "" };
            changed = true;
        }
        if (!normalizeProfileName(p.name)) {
            p.name = uniqueProfileName(
                profiles.filter((o) => o !== p),
                labelOf(p),
            );
            changed = true;
        }
    }
    if (!profiles.some((p) => p.uid === config.activeProviderProfile)) {
        // 고른 프로필을 잃었으면 지금 config.provider와 같은 쪽이 아니라 첫 프로필을 쓴다.
        config.activeProviderProfile = profiles[0].uid;
        config.provider = clone(profiles[0].provider);
        changed = true;
    }
    return changed;
}

export function activeProfile(config) {
    return (config.providerProfiles || []).find((p) => p.uid === config.activeProviderProfile) || null;
}

// config.provider에 바꾼 내용을 고른 프로필에도 옮겨 적는다.
export function syncActiveProfile(config) {
    const profile = activeProfile(config);
    if (profile) profile.provider = clone(config.provider);
}

// 프로필을 고른다. 지금 프로필의 변경을 먼저 옮겨 적고, 고른 프로필의 사본을 config.provider로 쓴다.
export function activateProfile(config, uid) {
    const target = (config.providerProfiles || []).find((p) => p.uid === uid);
    if (!target) return false;
    syncActiveProfile(config);
    config.activeProviderProfile = uid;
    config.provider = clone(target.provider);
    return true;
}

export function addProfile(config, { name, provider, custom }) {
    const profile = { uid: crypto.randomUUID(), name, provider: clone(provider) };
    if (custom) profile.custom = true;
    config.providerProfiles.push(profile);
    return profile;
}

// 마지막 남은 프로필은 지우지 않는다. 지운 것이 고른 프로필이면 다음 프로필의 uid를 돌려준다.
export function removeProfile(config, uid) {
    const profiles = config.providerProfiles || [];
    const idx = profiles.findIndex((p) => p.uid === uid);
    if (idx < 0) return { error: "not_found" };
    if (profiles.length <= 1) return { error: "last_profile" };
    const wasActive = config.activeProviderProfile === uid;
    profiles.splice(idx, 1);
    return { nextUid: wasActive ? profiles[Math.min(idx, profiles.length - 1)].uid : null };
}
