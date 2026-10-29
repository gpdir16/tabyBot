// 설정과 모델 목록 API. 설정 스냅샷 만들기와 패치 적용도 여기에 있다.
import { AVATAR_COLORS, agentBackgroundEnabled, agentColor, listAgents } from "../../agents-store.js";
import { listMemberSessionKeys } from "../../groups-store.js";
import * as conversationsStore from "../conversations.js";
import fs from "node:fs";
import path from "node:path";
import { CODES_DIR } from "../../paths.js";
import { getMergedProvider, getProfileProvider, loadProviderConfig, loadUserConfig, saveUserConfig } from "../../config-loader.js";
import { applyConfiguredTimeZone } from "../../process-timezone.js";
import {
    addPreset,
    applyPresetPatch,
    defaultPreset,
    ensurePresets,
    findPreset,
    presetsOf,
    presetsUsingProfile,
    removePreset,
} from "../../model-presets.js";
import { isOpenRouterAlias, resolvedOpenRouterModel } from "../../llm/openrouter-aliases.js";
import { ensureModelMeta, loadModelMeta } from "../../llm/model-meta.js";
import { getProviderThinkingMeta, normalizeThinkingLevel, thinkingLevelLabel } from "../../thinking-levels.js";
import {
    APPROVAL_LEVELS,
    CONTEXT_TRIGGER_PRESETS,
    NSFW_LEVELS,
    getCompressOnModelChange,
    getContextTriggerPercent,
    normalizeApprovalLevel,
    normalizeNsfwLevel,
} from "../../user-settings.js";
import { compressBotSessions } from "../../agent/summarize.js";
import { loadChatHistory, replaceChatHistoryAfterCompression } from "../../agent/chat-history.js";
import { isAgentSessionRunning } from "../../agent/session.js";
import { stopConversation } from "../turns.js";
import { trackTask } from "../tasks.js";
import { applySelfImprovementPatch, getDreamingConfig, getProactiveConfig, getReviewConfig } from "../../self-improvement.js";
import { emit } from "../bus.js";
import { t as i18nT } from "../../i18n.js";
import { defaultTimeZone, isValidTimeZone } from "../../scheduling/time.js";
import { fetchOpenRouterProviders, fetchProviderModelsDetailed } from "../../llm/models.js";
import { cacheKeepAliveSummary, normalizeCacheKeepAlive } from "../../llm/cache-keepalive.js";
import { usageSummary } from "../../llm/usage-log.js";
import { fetchGithubCopilotRoutingModels } from "../../llm/github-copilot-client.js";
import { startDreamingScheduler } from "../../dreaming/scheduler.js";
import { restartUpdateScheduler } from "../../update/scheduler.js";
import {
    activateProfile,
    activeProfile,
    addProfile,
    ensureProfiles,
    normalizeProfileName,
    removeProfile,
    syncActiveProfile,
    uniqueProfileName,
} from "../../provider-profiles.js";

// ── 에이전트를 클라이언트에 내려줄 때의 공개 모양. ──

export function publicAgent(a) {
    const meta = conversationsStore.getConversationMeta(a.uuid);
    return {
        id: a.id,
        uuid: a.uuid,
        name: a.name,
        persona: a.persona,
        modelPreset: a.modelPreset || "",
        model: a.model || "",
        thinkingLevel: a.thinkingLevel || "",
        color: a.color || agentColor(a.id),
        colorChoice: a.color || "",
        backgroundTasks: agentBackgroundEnabled(a),
        folder: a.folder || "",
        avatar: a.avatar || "",
        createdAt: a.createdAt ?? null,
        preview: typeof meta?.preview === "string" ? meta.preview : "",
    };
}

// ── 설정 화면에 내려주는 스냅샷과 세션 압축 실행 경로. ──

const PROVIDER_LABELS = {
    default: "OpenAI",
    openrouter: "OpenRouter",
    grok: "Grok OAuth",
    codex: "Codex OAuth (ChatGPT Plus/Pro)",
    "github-copilot": "GitHub Copilot OAuth",
    claude: "Claude OAuth (Pro/Max)",
    ollama: "Ollama (local)",
    "ollama-cloud": "Ollama Cloud",
    synthetic: "Synthetic",
    upstage: "Upstage",
    zenmux: "ZenMux",
    orcarouter: "OrcaRouter",
    "opencode-go": "OpenCode Go",
};

function providerPresets() {
    const dir = path.join(CODES_DIR, "config", "provider");
    let files = [];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
        return [{ id: "custom", label: "Custom API URL", type: "openai-compatible", baseURL: null, apiKeyOptional: false, needsBaseURL: true }];
    }
    const byId = new Map(
        files
            .map((f) => {
                try {
                    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                    return [
                        p.id || f.replace(/\.json$/, ""),
                        {
                            id: p.id || f.replace(/\.json$/, ""),
                            label: PROVIDER_LABELS[p.id] || p.id,
                            type: p.type || "openai-compatible",
                            baseURL: p.baseURL || null,
                            apiKeyOptional: Boolean(p.apiKeyOptional),
                            needsBaseURL: Boolean(p.needsBaseURL),
                            keysUrl: p.keysUrl || null,
                        },
                    ];
                } catch {
                    return null;
                }
            })
            .filter(Boolean),
    );
    const presets = [
        "default",
        "openrouter",
        "orcarouter",
        "synthetic",
        "ollama",
        "ollama-cloud",
        "zenmux",
        "upstage",
        "opencode-go",
        "codex",
        "grok",
        "github-copilot",
        "claude",
    ]
        .map((id) => byId.get(id))
        .filter(Boolean);
    presets.push({ id: "custom", label: "Custom API URL", type: "openai-compatible", baseURL: null, apiKeyOptional: false, needsBaseURL: true });
    return presets;
}

// ── 프로바이더 프로필 ──

const CUSTOM_LABEL = "Custom API URL";

// OpenAI 프리셋 id에 다른 주소를 넣은 설정은 커스텀 주소다.
function isCustomProvider(provider) {
    if ((provider?.id || "default") !== "default" || !provider?.baseURL) return false;
    try {
        return provider.baseURL.replace(/\/$/, "") !== String(loadProviderConfig("default").baseURL || "").replace(/\/$/, "");
    } catch {
        return true;
    }
}

function profileLabel(profile) {
    if (profile.custom) return CUSTOM_LABEL;
    const id = profile.provider?.id || "default";
    return PROVIDER_LABELS[id] || id;
}

// 이름을 따로 주지 않은 프로필의 이름. 커스텀 주소는 주소의 호스트가 이름이 된다.
function profileDefaultName(profile) {
    if (profile.custom && profile.provider?.baseURL) {
        try {
            return new URL(profile.provider.baseURL).host;
        } catch {
            // 주소가 아니면 프로바이더 이름을 쓴다
        }
    }
    return profileLabel(profile);
}

const PROFILE_HELPERS = { isCustom: isCustomProvider, labelOf: profileDefaultName };

// 프로필의 접속 정보. 사라진 프리셋 파일이면 null.
function profileProviderSafe(config, uid) {
    try {
        return getProfileProvider(config, uid);
    } catch {
        return null;
    }
}

// 화면에 내려줄 프로바이더 목록(로그인과 키를 담은 프로필). apiKey는 넣지 않고 저장 여부만 알린다.
function publicProfiles(config) {
    return config.providerProfiles.map((p) => {
        const base = profileProviderSafe(config, p.uid);
        const source = p.uid === config.activeProviderProfile ? config.provider || {} : p.provider || {};
        return {
            uid: p.uid,
            name: p.name,
            providerId: p.custom ? "custom" : base?.id || source.id || "default",
            id: base?.id || source.id || "default",
            label: profileLabel(p),
            type: base?.type || "openai-compatible",
            baseURL: source.baseURL || base?.baseURL || "",
            apiKeySet: Boolean(base?.apiKey),
            // 이 프로바이더를 쓰는 모델 프리셋 수. 쓰는 곳이 있으면 지울 수 없다.
            presets: presetsUsingProfile(config, p.uid),
        };
    });
}

function thinkingLevelsOf(providerId, language) {
    const meta = getProviderThinkingMeta(providerId);
    const levels = meta.levels.length ? meta.levels : ["off", "low", "medium", "high"];
    return levels.map((value) => ({ value, label: thinkingLevelLabel(language || "en", value) }));
}

// 화면에 내려줄 모델 프리셋 목록. 이름을 비운 프리셋은 화면이 모델 이름으로 보여 준다.
function publicPresets(config) {
    const def = defaultPreset(config);
    return presetsOf(config).map((p) => {
        let merged = null;
        try {
            merged = getMergedProvider(config, p.uid);
        } catch {
            // 프로바이더 파일이 사라졌으면 캐시 유지 정보 없이 보여 준다
        }
        const providerId = merged?.id || "default";
        return {
            uid: p.uid,
            name: p.name || "",
            profile: merged?.profileUid || p.profile || "",
            providerId,
            model: p.model || "",
            thinkingLevel: normalizeThinkingLevel(p.thinkingLevel, providerId),
            openRouterPin: providerId === "openrouter" ? p.openRouterPin || "" : "",
            autoModelCandidates: Array.isArray(p.autoModelCandidates) ? p.autoModelCandidates : [],
            // 0이면 기본 압축 시점을 쓴다.
            contextTriggerPercent: Number(p.contextTriggerPercent) || 0,
            isDefault: p.uid === def.uid,
            // 효율적인 운영 탭: 이 프리셋의 캐시 유지 설정과 예상. 핑이 이득이 없는 프로바이더(요청 수 과금, 로컬)는 null.
            cacheKeepAlive: merged ? cacheKeepAliveSummary(merged, config) : null,
        };
    });
}

// 세션 압축 진행 상태: 수동 버튼과 모델 변경 확인 알림이 같은 실행 경로를 쓴다.
// 동시에 하나만 돌리고, 시작/종료를 SSE로 알려 새로고침해도 진행 상태가 보이게 한다.
let sessionCompressInFlight = false;

function isSessionCompressing() {
    return sessionCompressInFlight;
}

async function runSessionCompression(chatIds = null) {
    if (sessionCompressInFlight) return null;
    sessionCompressInFlight = true;
    emit({ type: "sessions_compress", running: true });
    try {
        return await trackTask("session_compress", (progress) => compressBotSessions(chatIds, progress));
    } finally {
        sessionCompressInFlight = false;
        emit({ type: "sessions_compress", running: false });
    }
}

// 세션 다시 시작: 압축해도 요약에 꼬인 흐름이 남는 경우를 위해, 실행 중인 턴을 멈추고 기록을 보관한 뒤 빈 세션으로 연다.
// 멈춘 턴은 끝나면서 기록을 저장하므로, 끝날 때까지 기다린 뒤 보관해야 새 세션에 섞이지 않는다.
let sessionRestartInFlight = false;
const RESTART_STOP_WAIT_MS = 60_000;

async function waitForStop(chatId) {
    const deadline = Date.now() + RESTART_STOP_WAIT_MS;
    while (isAgentSessionRunning(chatId)) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return true;
}

async function restartBotSessions() {
    const result = { restarted: 0, skipped: 0, failed: 0 };
    const keys = [
        ...listAgents()
            .map((a) => a.uuid)
            .filter(Boolean),
        ...listMemberSessionKeys(),
    ];
    for (const chatId of keys) {
        try {
            const running = stopConversation(chatId);
            if (running && !(await waitForStop(chatId))) {
                result.failed += 1;
                continue;
            }
            if (!running && !loadChatHistory(chatId).length) {
                result.skipped += 1;
                continue;
            }
            if (replaceChatHistoryAfterCompression(chatId, [], "", { reason: "manual_restart" })) result.restarted += 1;
            else result.skipped += 1;
        } catch (err) {
            console.warn(`tabyBot: session restart failed for ${chatId}:`, err?.message || err);
            result.failed += 1;
        }
    }
    return result;
}

// GET/PUT 공용 설정 스냅샷. apiKey는 절대 포함하지 않는다.
function buildSettingsPayload() {
    const config = loadUserConfig();
    // 프로필과 프리셋이 없던 설정도 있는 것처럼 보여 준다. 저장은 다음 변경 때 한다.
    ensureProfiles(config, PROFILE_HELPERS);
    let merged = null;
    try {
        merged = getMergedProvider(config);
    } catch {
        // 삭제되거나 이름이 바뀐 provider도 설정창에서 복구할 수 있게 한다.
    }
    const pid = merged?.id || config.provider?.id || "default";
    const presets = providerPresets();
    if (!presets.some((p) => p.id === pid)) {
        presets.push({
            id: pid,
            label: PROVIDER_LABELS[pid] || pid,
            type: "openai-compatible",
            baseURL: null,
            apiKeyOptional: false,
            needsBaseURL: true,
        });
    }
    const profiles = publicProfiles(config);
    const defaultProfile = profiles.find((p) => p.uid === merged?.profileUid);
    // 프로바이더마다 고를 수 있는 추론 깊이(프리셋 편집 화면이 프리셋의 프로바이더에 맞춰 쓴다).
    const thinkingLevelsByProvider = {};
    for (const p of profiles) thinkingLevelsByProvider[p.id] ??= thinkingLevelsOf(p.id, config.language);
    return {
        language: config.language || "en",
        languages: ["en", "ko", "ja"],
        timezone: config.timezone || "",
        // 서버가 실제로 쓰는 시간대(설정값, 비면 서버 기본값). 화면도 이 시간대로 시각을 보여 준다.
        serverTimezone: defaultTimeZone(),
        // 기본 모델 프리셋의 추론 깊이(온보딩과 예전 화면이 쓴다).
        thinkingLevel: normalizeThinkingLevel(merged?.thinkingLevel, pid),
        thinkingLevels: thinkingLevelsOf(pid, config.language),
        thinkingLevelsByProvider,
        showReplyFooter: config.showReplyFooter !== false,
        updateCheckEnabled: config.updateCheckEnabled !== false,
        allTabExcludesFoldered: config.allTabExcludesFoldered === true,
        foldersInList: config.foldersInList === true,
        onboardingDismissed: config.onboardingDismissed === true,
        nsfwLevel: normalizeNsfwLevel(config.nsfwLevel),
        nsfwLevels: NSFW_LEVELS,
        approvalLevel: normalizeApprovalLevel(config.approvalLevel),
        approvalLevels: APPROVAL_LEVELS,
        contextTriggerPercent: getContextTriggerPercent(config),
        contextTriggerOptions: CONTEXT_TRIGGER_PRESETS,
        compressOnModelChange: getCompressOnModelChange(config),
        sessionsCompressing: sessionCompressInFlight,
        // 채움 한도 드롭다운이 %를 실제 토큰 수로 환산해 보여주는 데 쓴다.
        contextWindow: loadModelMeta().contextWindow || 128000,
        // 기본 모델 프리셋을 푼 값(온보딩과 대화 화면이 쓴다).
        provider: {
            id: pid,
            label: PROVIDER_LABELS[pid] || pid,
            custom: defaultProfile?.providerId === "custom",
            type: merged?.type || "openai-compatible",
            baseURL: merged?.baseURL || "",
            model: merged?.model || "",
            apiKeySet: Boolean(merged?.apiKey),
            autoMode: Boolean(merged?.autoMode),
        },
        cacheKeepAlive: merged ? cacheKeepAliveSummary(merged, config) : null,
        // 효율적인 운영 탭의 지표와 사용 기록: 날짜별, 프로바이더와 모델별 토큰 수.
        usage: usageSummary(),
        providers: presets,
        profiles,
        modelPresets: publicPresets(config),
        defaultModelPreset: defaultPreset(config).uid,
        agents: listAgents().map(publicAgent),
        agentColors: AVATAR_COLORS,
        selfImprovement: {
            dreaming: getDreamingConfig(),
            review: getReviewConfig(),
            proactive: getProactiveConfig(),
        },
    };
}

// 모델 변경 시 압축은 묻기만 하고 실행하지 않는다. 사용자가 알림을 눌러
// 확인해야 compressBotSessions가 돈다(압축 = 대화 기록 재작성 + LLM 호출).
export function askSessionCompression(lang, chatIds = null) {
    const action = { kind: "compress_sessions" };
    if (Array.isArray(chatIds) && chatIds.length) action.chatIds = chatIds;
    emit({ type: "notice", level: "info", text: i18nT("sessions_compress_ask", lang), action });
}

// ── PUT /api/settings 본문을 사용자 설정(config.json 내용)에 반영한다. 저장은 호출자가 한다. ──

const LANGUAGES = ["en", "ko", "ja"];
const BOOLEAN_FIELDS = [
    "showReplyFooter",
    "updateCheckEnabled",
    "allTabExcludesFoldered",
    "foldersInList",
    "onboardingDismissed",
    "compressOnModelChange",
];
const MAX_AUTO_MODEL_CANDIDATES = 30;

// 일반 설정(언어, 추론 깊이, 시간대, 단계 값). 값이 잘못되면 오류 코드를 돌려준다.
function applyGeneralFields(config, patch) {
    if (patch.language !== undefined) {
        if (!LANGUAGES.includes(patch.language)) return "invalid_language";
        config.language = patch.language;
    }
    if (patch.thinkingLevel !== undefined) {
        // 추론 깊이는 기본 모델 프리셋의 것이다(온보딩과 예전 화면이 보낸다).
        ensurePresets(config);
        defaultPreset(config).thinkingLevel = normalizeThinkingLevel(patch.thinkingLevel, getMergedProvider(config).id);
    }
    for (const field of BOOLEAN_FIELDS) {
        if (patch[field] !== undefined) config[field] = Boolean(patch[field]);
    }
    if (patch.timezone !== undefined) {
        const tz = String(patch.timezone || "").trim();
        if (tz && !isValidTimeZone(tz)) return "invalid_timezone";
        if (tz) config.timezone = tz;
        else delete config.timezone;
    }
    if (patch.nsfwLevel !== undefined) config.nsfwLevel = normalizeNsfwLevel(patch.nsfwLevel);
    if (patch.approvalLevel !== undefined) config.approvalLevel = normalizeApprovalLevel(patch.approvalLevel);
    if (patch.cacheKeepAlive !== undefined) applyCacheKeepAlive(config, patch);
    return null;
}

// 캐시 유지는 모델 프리셋마다 따로 둔다(cacheKeepAlivePreset, 없으면 기본 프리셋). 자동이 기본이라 끔이나 사용자 지정만 적는다.
// 예전에 프로바이더 종류로 적은 값이 있으면 자동을 따로 적어 그 값을 덮는다.
function applyCacheKeepAlive(config, patch) {
    const preset = findPreset(config, String(patch.cacheKeepAlivePreset || ""));
    let legacyKey = "default";
    try {
        legacyKey = getMergedProvider(config, preset.uid).id;
    } catch {
        // 프로바이더 파일이 사라졌으면 예전 값은 없는 것으로 본다
    }
    const all = { ...config.cacheKeepAlive };
    const value = normalizeCacheKeepAlive(patch.cacheKeepAlive);
    if (value) all[preset.uid] = value;
    else if (all[legacyKey] !== undefined) all[preset.uid] = { mode: "auto" };
    else delete all[preset.uid];
    if (Object.keys(all).length) config.cacheKeepAlive = all;
    else delete config.cacheKeepAlive;
}

function normalizeCandidates(list) {
    return [
        ...new Set(
            list
                .map(String)
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    ].slice(0, MAX_AUTO_MODEL_CANDIDATES);
}

// 프로바이더 접속 정보(종류, 주소, 키)를 provider 객체에 적용한다. 프리셋 id가 바뀌었는지(providerChanged)와 오류 코드를 돌려준다.
function applyProviderFields(provider, providerPatch) {
    const prevId = provider.id || "default";
    let providerChanged = false;
    if (providerPatch.id !== undefined) {
        const requestedId = String(providerPatch.id).trim() || "default";
        const custom = requestedId === "custom";
        const id = custom ? "default" : requestedId;
        if (custom || id !== prevId) {
            providerChanged = true;
            // provider를 바꾸면 기존 커스텀 URL을 초기화한다.
            delete provider.baseURL;
        }
        provider.id = id;
    }
    if (providerPatch.baseURL !== undefined) {
        // 엔드포인트 전체 주소(/chat/completions, /models)를 붙여 넣은 경우 baseURL만 남긴다.
        const url = String(providerPatch.baseURL || "")
            .trim()
            .replace(/\/+$/, "")
            .replace(/\/(?:chat\/completions|completions|models|responses)$/i, "");
        if (url) provider.baseURL = url;
        else delete provider.baseURL;
    }
    if (providerPatch.apiKey !== undefined) {
        const key = String(providerPatch.apiKey ?? "");
        if (key !== "") provider.apiKey = key;
        else if (providerPatch.clearApiKey === true) delete provider.apiKey;
    }
    return { providerChanged };
}

// 예전 모양의 프로바이더 설정 고침(온보딩이 보낸다): 기본 모델 프리셋의 프로바이더와 모델을 바꾼다.
function applyProviderPatch(config, providerPatch) {
    ensurePresets(config);
    const preset = defaultPreset(config);
    // 기본 프리셋의 프로필을 고른 프로필로 둔다. 접속 정보는 config.provider(고른 프로필의 정본)에 적는다.
    if (preset.profile && preset.profile !== config.activeProviderProfile) activateProfile(config, preset.profile);
    preset.profile = config.activeProviderProfile;
    config.provider = config.provider || {};
    const { providerChanged } = applyProviderFields(config.provider, providerPatch);
    const profile = activeProfile(config);
    if (profile && providerPatch.id !== undefined) {
        if (String(providerPatch.id).trim() === "custom") profile.custom = true;
        else delete profile.custom;
    }
    syncActiveProfile(config);
    const providerId = config.provider.id || "default";
    if (providerChanged) {
        // 프로바이더가 바뀌면 이전 모델과 고정은 쓸 수 없다.
        preset.model = providerId === "github-copilot" ? "auto" : "";
        delete preset.openRouterPin;
        delete preset.autoModelCandidates;
        preset.thinkingLevel = normalizeThinkingLevel(preset.thinkingLevel, providerId);
    }
    if (providerPatch.model !== undefined) applyPresetPatch(preset, { model: providerPatch.model }, [preset.profile]);
    if (providerPatch.autoMode !== undefined) {
        if (providerPatch.autoMode) preset.model = "auto";
        else if (preset.model === "auto") preset.model = "";
    }
    if (providerPatch.openRouterProvider !== undefined) applyPresetPatch(preset, { openRouterPin: providerPatch.openRouterProvider }, []);
    if (providerPatch.autoModelCandidates !== undefined) {
        if (!Array.isArray(providerPatch.autoModelCandidates)) return { error: "invalid_auto_model_candidates" };
        applyPresetPatch(preset, { autoModelCandidates: normalizeCandidates(providerPatch.autoModelCandidates) }, []);
    }
    return { providerChanged };
}

// 반환: { error } 또는 { selfImprovementChanged }.
function applySettingsPatch(config, patch) {
    const generalError = applyGeneralFields(config, patch);
    if (generalError) return { error: generalError };

    let selfImprovementChanged = false;
    if (patch.selfImprovement !== undefined) {
        config.selfImprovement = config.selfImprovement || {};
        const error = applySelfImprovementPatch(config.selfImprovement, patch.selfImprovement);
        if (error) return { error };
        selfImprovementChanged = true;
    }

    if (patch.provider !== undefined && typeof patch.provider === "object") {
        ensureProfiles(config, PROFILE_HELPERS);
        const result = applyProviderPatch(config, patch.provider);
        if (result.error) return { error: result.error };
        // 이름을 직접 정하지 않은 커스텀 프로필은 주소를 바꾸면 그 호스트로 이름이 바뀐다.
        const profile = activeProfile(config);
        if (profile?.custom && !profile.named && patch.provider.baseURL !== undefined) {
            const others = config.providerProfiles.filter((p) => p !== profile);
            profile.name = uniqueProfileName(others, profileDefaultName(profile));
        }
    }

    return { selfImprovementChanged };
}

// ── 설정과 모델 목록 API. ──

// 기본 프리셋의 모델을 읽는다. 읽을 수 없으면 "".
function defaultModelOf(config) {
    try {
        return getMergedProvider(config).model;
    } catch {
        return "";
    }
}

// 모델이 바뀌었으면 새 모델의 정보를 받아 두고, 압축 옵션이 켜져 있으면 세션 압축 여부를 묻는다.
// 실행은 사용자가 알림을 눌러 확인할 때만 한다. 모델이 비워진 상태(프로바이더 전환 중)에는 묻지 않는다.
// presetUid: 바뀐 프리셋. chatIds: 그 프리셋을 쓰는 봇들(null이면 모두).
function afterModelSaved(config, prevModel, presetUid = "", chatIds = null) {
    let merged;
    try {
        merged = getMergedProvider(config, presetUid);
    } catch {
        return;
    }
    if (!merged.model || merged.model === prevModel) return;
    // 설정 화면의 채움 한도 토큰 표시가 이전 모델 값으로 남지 않도록 컨텍스트 윈도우를 미리 받아 둔다.
    void ensureModelMeta(merged).catch((err) => console.error("tabyBot: model meta refresh failed:", err?.message || err));
    if (getCompressOnModelChange(config) && (!chatIds || chatIds.length)) askSessionCompression(config.language || "en", chatIds);
}

// 프리셋을 쓰는 봇의 대화 id. 기본 프리셋이면 프리셋을 고르지 않은 봇도 포함한다.
function chatsUsingPreset(config, uid) {
    const isDefault = defaultPreset(config).uid === uid;
    const known = new Set(presetsOf(config).map((p) => p.uid));
    return listAgents()
        .filter((a) => a.modelPreset === uid || (isDefault && !a.model && (!a.modelPreset || !known.has(a.modelPreset))))
        .map((a) => a.uuid)
        .filter(Boolean);
}

function substituteEnvSafe(value) {
    return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

// 프로필과 프리셋을 고치기 전에 둘 다 저장할 모양으로 만들고, 고른 프로필의 변경을 프로필 목록에 옮겨 적는다.
function loadEditableConfig() {
    const config = loadUserConfig();
    ensureProfiles(config, PROFILE_HELPERS);
    syncActiveProfile(config);
    ensurePresets(config);
    return config;
}

function profileUids(config) {
    return config.providerProfiles.map((p) => p.uid);
}

// 새 프리셋이나 고친 프리셋의 추론 깊이를 그 프로바이더의 단계로 맞춘다.
function normalizePresetThinking(config, preset) {
    try {
        preset.thinkingLevel = normalizeThinkingLevel(preset.thinkingLevel, getMergedProvider(config, preset.uid).id);
    } catch {
        // 프로바이더 파일이 사라졌으면 그대로 둔다
    }
}

function registerProfileRoutes(router) {
    // 프로바이더 추가: 고른 프로바이더로 새 프로필을 만든다. 키와 로그인은 그 다음에 넣는다.
    router.add("POST", "/api/provider-profiles", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        const requested = String(body?.providerId || "").trim();
        if (!providerPresets().some((p) => p.id === requested)) return ctx.json400("unknown_provider");
        const config = loadEditableConfig();
        const custom = requested === "custom";
        const id = custom ? "default" : requested;
        const name = normalizeProfileName(body?.name);
        const profile = addProfile(config, {
            name: uniqueProfileName(config.providerProfiles, name || profileLabel({ custom, provider: { id } })),
            provider: { id },
            custom,
        });
        if (name) profile.named = true;
        saveUserConfig(config);
        ctx.json200({ ...buildSettingsPayload(), createdProfile: profile.uid });
    });

    // 프로필 고침: 이름과 접속 정보(주소, 키). 모델은 프리셋에서 고른다.
    router.add("PUT", "/api/provider-profiles/:uid", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        const config = loadEditableConfig();
        const profile = config.providerProfiles.find((p) => p.uid === ctx.params.uid);
        if (!profile) return ctx.json404();
        if (body?.name !== undefined) {
            // 이름을 비우면 프로바이더 이름으로 돌아간다.
            const others = config.providerProfiles.filter((p) => p !== profile);
            const name = normalizeProfileName(body.name);
            profile.name = uniqueProfileName(others, name || profileDefaultName(profile));
            if (name) profile.named = true;
            else delete profile.named;
        }
        if (body?.provider && typeof body.provider === "object") {
            const patch = { ...body.provider };
            // 종류는 바꾸지 않는다(다른 프로바이더는 새로 추가한다).
            delete patch.id;
            const active = profile.uid === config.activeProviderProfile;
            if (active) config.provider ||= {};
            else profile.provider ||= {};
            const target = active ? config.provider : profile.provider;
            applyProviderFields(target, patch);
            if (active) syncActiveProfile(config);
            // 이름을 직접 정하지 않은 커스텀 프로필은 주소를 바꾸면 그 호스트로 이름이 바뀐다.
            if (profile.custom && !profile.named && patch.baseURL !== undefined) {
                const others = config.providerProfiles.filter((p) => p !== profile);
                profile.name = uniqueProfileName(others, profileDefaultName(profile));
            }
        }
        saveUserConfig(config);
        ctx.json200(buildSettingsPayload());
    });

    // 프로필 삭제. 그 프로바이더를 쓰는 프리셋이 있으면 지우지 않는다.
    router.add("DELETE", "/api/provider-profiles/:uid", (ctx) => {
        const config = loadEditableConfig();
        if (presetsUsingProfile(config, ctx.params.uid)) return ctx.json400("profile_in_use");
        const removed = removeProfile(config, ctx.params.uid);
        if (removed.error === "not_found") return ctx.json404();
        if (removed.error) return ctx.json400(removed.error);
        // 고른 프로필(접속 정보의 정본)을 지웠으면 다음 프로필을 고른 프로필로 둔다.
        if (removed.nextUid) {
            const next = config.providerProfiles.find((p) => p.uid === removed.nextUid);
            config.activeProviderProfile = next.uid;
            config.provider = JSON.parse(JSON.stringify(next.provider));
        }
        saveUserConfig(config);
        ctx.json200(buildSettingsPayload());
    });
}

function registerPresetRoutes(router) {
    // 프리셋 추가: 프로바이더, 모델, 추론 깊이, 고정을 한 번에 받는다.
    router.add("POST", "/api/model-presets", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        const config = loadEditableConfig();
        const profile = String(body?.profile || defaultPreset(config).profile || config.activeProviderProfile);
        const preset = addPreset(config, { profile });
        const error = applyPresetPatch(preset, { ...body, profile }, profileUids(config));
        if (error) return ctx.json400(error.error);
        normalizePresetThinking(config, preset);
        saveUserConfig(config);
        ctx.json200({ ...buildSettingsPayload(), createdPreset: preset.uid });
    });

    router.add("PUT", "/api/model-presets/:uid", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        const config = loadEditableConfig();
        const preset = config.modelPresets.find((p) => p.uid === ctx.params.uid);
        if (!preset) return ctx.json404();
        const prevModel = getMergedProvider(config, preset.uid).model;
        const error = applyPresetPatch(preset, body || {}, profileUids(config));
        if (error) return ctx.json400(error.error);
        normalizePresetThinking(config, preset);
        saveUserConfig(config);
        afterModelSaved(config, prevModel, preset.uid, chatsUsingPreset(config, preset.uid));
        ctx.json200(buildSettingsPayload());
    });

    // 기본 프리셋으로 지정: 프리셋을 고르지 않은 에이전트가 이 프리셋을 쓴다.
    router.add("POST", "/api/model-presets/:uid/default", (ctx) => {
        const config = loadEditableConfig();
        if (!config.modelPresets.some((p) => p.uid === ctx.params.uid)) return ctx.json404();
        const prevModel = defaultModelOf(config);
        const before = new Set(chatsUsingPreset(config, defaultPreset(config).uid));
        config.defaultModelPreset = ctx.params.uid;
        saveUserConfig(config);
        afterModelSaved(config, prevModel, "", [...before]);
        ctx.json200(buildSettingsPayload());
    });

    // 프리셋 삭제. 이 프리셋을 고른 에이전트는 기본 프리셋을 쓰게 된다.
    router.add("DELETE", "/api/model-presets/:uid", (ctx) => {
        const config = loadEditableConfig();
        const removed = removePreset(config, ctx.params.uid);
        if (removed.error === "not_found") return ctx.json404();
        if (removed.error) return ctx.json400(removed.error);
        if (config.cacheKeepAlive?.[ctx.params.uid] !== undefined) {
            delete config.cacheKeepAlive[ctx.params.uid];
            if (!Object.keys(config.cacheKeepAlive).length) delete config.cacheKeepAlive;
        }
        saveUserConfig(config);
        ctx.json200(buildSettingsPayload());
    });
}

// 모델 목록을 받을 접속 정보. body.profile이면 그 프로필, 프로바이더와 주소를 직접 주면(온보딩) 그것, 아니면 기본 프리셋.
function modelsRequestProvider(config, body) {
    if (body.profile) {
        if (!(config.providerProfiles || []).some((p) => p.uid === body.profile)) return null;
        return getProfileProvider(config, String(body.profile));
    }
    if (!body.providerId && !body.baseURL && !body.apiKey) return getMergedProvider(config);
    const current = getMergedProvider(config);
    const requested = String(body.providerId || current.id || "default");
    const providerId = requested === "custom" ? "default" : requested;
    const base = loadProviderConfig(providerId);
    const provider = {
        id: base.id || "custom",
        type: base.type,
        baseURL: String(body.baseURL || base.baseURL || "").replace(/\/$/, ""),
        apiKey: substituteEnvSafe(body.apiKey || ""),
        extraHeaders: base.extraHeaders || {},
        apiKeyOptional: Boolean(base.apiKeyOptional),
    };
    if (base.defaultContextWindow) provider.defaultContextWindow = base.defaultContextWindow;
    if (base.modelsDev) provider.modelsDev = base.modelsDev;
    // 저장된 키는 기본 프리셋과 같은 주소로 목록을 받을 때만 쓴다. 다른 곳으로 보내지 않는다.
    if (!provider.apiKey && !provider.apiKeyOptional && current.id === providerId && current.baseURL === provider.baseURL) {
        provider.apiKey = current.apiKey;
    }
    return provider;
}

export function registerSettingsRoutes(router) {
    router.add("GET", "/api/settings", (ctx) => {
        ctx.json200(buildSettingsPayload());
    });

    router.add("PUT", "/api/settings", async (ctx) => {
        const patch = await ctx.json();
        const config = loadUserConfig();
        const prevModel = defaultModelOf(config);

        const applied = applySettingsPatch(config, patch);
        if (applied.error) return ctx.json400(applied.error);

        saveUserConfig(config);
        if (patch.timezone !== undefined) applyConfiguredTimeZone(config.timezone);
        if (patch.updateCheckEnabled !== undefined) restartUpdateScheduler();
        // proactive는 매 틱 설정을 다시 읽으므로 재시작 불필요. dreaming 크론은 재등록이 필요하다(시간대 포함).
        if (applied.selfImprovementChanged || patch.timezone !== undefined) startDreamingScheduler();
        afterModelSaved(config, prevModel);
        // 프론트가 부분 객체로 상태를 덮어쓰지 않도록 항상 전체 스냅샷을 돌려준다.
        ctx.json200(buildSettingsPayload());
    });

    registerProfileRoutes(router);
    registerPresetRoutes(router);

    // 봇의 활성 세션을 즉시 압축한다(설정의 모델 탭 고급 항목, 또는 모델 변경 확인 알림에서 호출).
    // body.chatIds를 주면 그 봇들만, 없으면 모든 봇을 압축한다.
    router.add("POST", "/api/sessions/compress-all", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        let chatIds = null;
        if (Array.isArray(body?.chatIds)) chatIds = body.chatIds.map(String).filter(Boolean).slice(0, 50);
        if (isSessionCompressing() || sessionRestartInFlight) return ctx.json409("already_running");
        try {
            ctx.json200(await runSessionCompression(chatIds));
        } catch (err) {
            ctx.json400(err?.message || String(err));
        }
    });

    router.add("POST", "/api/sessions/restart-all", async (ctx) => {
        // 압축과 동시에 돌면 압축이 옛 기록의 요약으로 새 세션을 덮어쓴다.
        if (isSessionCompressing() || sessionRestartInFlight) return ctx.json409("already_running");
        sessionRestartInFlight = true;
        try {
            ctx.json200(await restartBotSessions());
        } catch (err) {
            ctx.json400(err?.message || String(err));
        } finally {
            sessionRestartInFlight = false;
        }
    });

    // OpenRouter 모델을 실제로 서빙하는 업스트림 프로바이더 목록(고정 선택지). query.profile: 쓸 OpenRouter 프로필.
    // 별칭 모델(~)은 서빙 목록이 비어 있다. 마지막으로 답한 실제 모델의 목록을 대신 보여 준다.
    router.add("GET", "/api/providers/openrouter/endpoints", async (ctx) => {
        const config = loadUserConfig();
        try {
            const profileUid = String(ctx.query.profile || "");
            if (profileUid && !(config.providerProfiles || []).some((p) => p.uid === profileUid)) return ctx.json404();
            const provider = profileUid ? getProfileProvider(config, profileUid) : getMergedProvider(config);
            if (provider.id !== "openrouter") return ctx.json400("not_openrouter");
            const model = String(ctx.query.model || provider.model || "").trim();
            const alias = isOpenRouterAlias(model);
            const resolved = alias ? resolvedOpenRouterModel(model) : "";
            const providers = alias && !resolved ? [] : await fetchOpenRouterProviders(provider, resolved || model);
            ctx.json200({ providers, alias, resolved });
        } catch (err) {
            ctx.json400(err?.message || String(err));
        }
    });

    router.add("POST", "/api/models/fetch", async (ctx) => {
        const body = await ctx.json().catch((err) => {
            if (err?.code === "BAD_JSON") throw err;
            return {};
        });
        const config = loadUserConfig();
        try {
            const provider = modelsRequestProvider(config, body || {});
            if (!provider) return ctx.json404();
            const { models, baseURL } = await fetchProviderModelsDetailed(provider, { useCache: false });
            let routingModels = [];
            if (provider.type === "github-copilot-oauth") {
                try {
                    routingModels = await fetchGithubCopilotRoutingModels();
                } catch {
                    // Auto 모델 목록은 기본 모델 목록만으로도 표시한다.
                }
            }
            // 입력한 주소에 /v1을 붙여야 목록이 나왔다: 화면이 그 주소로 바로잡는다.
            const suggestedBaseURL = baseURL && baseURL !== provider.baseURL ? baseURL : undefined;
            ctx.json200({ models, routingModels, suggestedBaseURL });
        } catch (err) {
            ctx.json400(err?.message || String(err));
        }
    });
}
