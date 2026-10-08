// 설정과 모델 목록 API. 설정 스냅샷 만들기와 패치 적용도 여기에 있다.
import { AVATAR_COLORS, agentColor, listAgents } from "../../agents-store.js";
import * as conversationsStore from "../conversations.js";
import fs from "node:fs";
import path from "node:path";
import { CODES_DIR } from "../../paths.js";
import { getMergedProvider, loadProviderConfig, loadUserConfig, saveUserConfig } from "../../config-loader.js";
import { ensureModelMeta, loadModelMeta } from "../../llm/model-meta.js";
import { getProviderThinkingMeta, normalizeThinkingLevel, thinkingLevelLabel } from "../../thinking-levels.js";
import {
    APPROVAL_LEVELS,
    CONTEXT_TRIGGER_PRESETS,
    NSFW_LEVELS,
    getCompressOnModelChange,
    getContextTriggerPercent,
    normalizeApprovalLevel,
    normalizeContextTriggerPercent,
    normalizeNsfwLevel,
} from "../../user-settings.js";
import { compressBotSessions } from "../../agent/summarize.js";
import { applySelfImprovementPatch, getDreamingConfig, getProactiveConfig, getReviewConfig } from "../../self-improvement.js";
import { emit } from "../bus.js";
import { t as i18nT } from "../../i18n.js";
import { isValidTimeZone } from "../../scheduling/time.js";
import { fetchProviderModels } from "../../llm/models.js";
import { fetchGithubCopilotRoutingModels } from "../../llm/github-copilot-client.js";
import { startDreamingScheduler } from "../../dreaming/scheduler.js";
import { restartUpdateScheduler } from "../../update/scheduler.js";

// ── 에이전트를 클라이언트에 내려줄 때의 공개 모양. ──

export function publicAgent(a) {
    const meta = conversationsStore.getConversationMeta(a.uuid);
    return {
        id: a.id,
        uuid: a.uuid,
        name: a.name,
        persona: a.persona,
        model: a.model || "",
        thinkingLevel: a.thinkingLevel || "",
        color: a.color || agentColor(a.id),
        colorChoice: a.color || "",
        folder: a.folder || "",
        createdAt: a.createdAt ?? null,
        preview: typeof meta?.preview === "string" ? meta.preview : "",
    };
}

// ── 설정 화면에 내려주는 스냅샷과 세션 압축 실행 경로. ──

export const PROVIDER_LABELS = {
    default: "OpenAI",
    openrouter: "OpenRouter",
    grok: "Grok OAuth",
    codex: "Codex OAuth (ChatGPT Plus/Pro)",
    "github-copilot": "GitHub Copilot OAuth",
    ollama: "Ollama (local)",
    "ollama-cloud": "Ollama Cloud",
    synthetic: "Synthetic",
    upstage: "Upstage",
    zenmux: "ZenMux",
    orcarouter: "OrcaRouter",
};

export function providerPresets() {
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
        "codex",
        "grok",
        "github-copilot",
    ]
        .map((id) => byId.get(id))
        .filter(Boolean);
    presets.push({ id: "custom", label: "Custom API URL", type: "openai-compatible", baseURL: null, apiKeyOptional: false, needsBaseURL: true });
    return presets;
}

// 세션 압축 진행 상태: 수동 버튼과 모델 변경 확인 알림이 같은 실행 경로를 쓴다.
// 동시에 하나만 돌리고, 시작/종료를 SSE로 알려 새로고침해도 진행 상태가 보이게 한다.
let sessionCompressInFlight = false;

export function isSessionCompressing() {
    return sessionCompressInFlight;
}

export async function runSessionCompression(chatIds = null) {
    if (sessionCompressInFlight) return null;
    sessionCompressInFlight = true;
    emit({ type: "sessions_compress", running: true });
    try {
        return await compressBotSessions(chatIds);
    } finally {
        sessionCompressInFlight = false;
        emit({ type: "sessions_compress", running: false });
    }
}

// GET/PUT 공용 설정 스냅샷. apiKey는 절대 포함하지 않는다.
export function buildSettingsPayload() {
    const config = loadUserConfig();
    const pid = config.provider?.id || "default";
    const meta = getProviderThinkingMeta(pid);
    let currentPreset = null;
    try {
        currentPreset = loadProviderConfig(pid);
    } catch {
        // 사용자 지정 커스텀 프로바이더일 수 있다
    }
    let merged = null;
    try {
        merged = getMergedProvider(config);
    } catch {
        // 삭제되거나 이름이 바뀐 provider도 설정창에서 복구할 수 있게 한다.
    }
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
    const levels = meta.levels.length ? meta.levels : ["off", "low", "medium", "high"];
    return {
        language: config.language || "en",
        languages: ["en", "ko", "ja"],
        timezone: config.timezone || "",
        thinkingLevel: normalizeThinkingLevel(config.thinkingLevel, pid),
        thinkingLevels: levels.map((value) => ({ value, label: thinkingLevelLabel(config.language || "en", value) })),
        showReplyFooter: config.showReplyFooter !== false,
        updateCheckEnabled: config.updateCheckEnabled !== false,
        allTabExcludesFoldered: config.allTabExcludesFoldered === true,
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
        provider: {
            id: pid,
            label: PROVIDER_LABELS[pid] || pid,
            type: currentPreset?.type || "openai-compatible",
            baseURL: config.provider?.baseURL || currentPreset?.baseURL || "",
            model: config.provider?.model || "",
            apiKeySet: Boolean(merged?.apiKey),
            autoMode: Boolean(merged?.autoMode),
            autoModelCandidates: merged?.autoModelCandidates || [],
        },
        providers: presets,
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
const BOOLEAN_FIELDS = ["showReplyFooter", "updateCheckEnabled", "allTabExcludesFoldered", "onboardingDismissed", "compressOnModelChange"];
const MAX_AUTO_MODEL_CANDIDATES = 30;

// 일반 설정(언어·사고 수준·시간대·단계 값). 값이 잘못되면 오류 코드를 돌려준다.
function applyGeneralFields(config, patch, providerId) {
    if (patch.language !== undefined) {
        if (!LANGUAGES.includes(patch.language)) return "invalid_language";
        config.language = patch.language;
    }
    if (patch.thinkingLevel !== undefined) {
        config.thinkingLevel = normalizeThinkingLevel(patch.thinkingLevel, providerId);
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
    if (patch.contextTriggerPercent !== undefined) {
        config.contextTriggerPercent = normalizeContextTriggerPercent(patch.contextTriggerPercent);
    }
    return null;
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

// 프로바이더 설정. 프리셋 id가 바뀌었는지(providerChanged)와 오류 코드를 돌려준다.
function applyProviderPatch(config, providerPatch, prevProviderId) {
    config.provider = config.provider || {};
    const provider = config.provider;
    let providerChanged = false;

    if (providerPatch.id !== undefined) {
        const requestedId = String(providerPatch.id).trim() || "default";
        const custom = requestedId === "custom";
        const id = custom ? "default" : requestedId;
        if (custom || id !== prevProviderId) {
            providerChanged = true;
            // provider를 바꾸면 기존 모델과 커스텀 URL을 초기화한다.
            delete provider.baseURL;
        }
        provider.id = id;
    }
    if (providerPatch.baseURL !== undefined) {
        const url = String(providerPatch.baseURL || "")
            .trim()
            .replace(/\/+$/, "");
        if (url) provider.baseURL = url;
        else delete provider.baseURL;
    }
    if (providerPatch.model !== undefined) {
        provider.model = String(providerPatch.model || "").trim();
    }
    if (providerPatch.apiKey !== undefined) {
        const key = String(providerPatch.apiKey ?? "");
        if (key !== "") provider.apiKey = key;
        else if (providerPatch.clearApiKey === true) delete provider.apiKey;
    }
    if (providerPatch.autoMode !== undefined) provider.autoMode = Boolean(providerPatch.autoMode);
    if (providerPatch.autoModelCandidates !== undefined) {
        if (!Array.isArray(providerPatch.autoModelCandidates)) return { error: "invalid_auto_model_candidates" };
        provider.autoModelCandidates = normalizeCandidates(providerPatch.autoModelCandidates);
    }
    return { providerChanged };
}

// 반환: { error } 또는 { providerChanged, selfImprovementChanged }.
export function applySettingsPatch(config, patch) {
    const prevProviderId = config.provider?.id || "default";

    const generalError = applyGeneralFields(config, patch, prevProviderId);
    if (generalError) return { error: generalError };

    let selfImprovementChanged = false;
    if (patch.selfImprovement !== undefined) {
        config.selfImprovement = config.selfImprovement || {};
        const error = applySelfImprovementPatch(config.selfImprovement, patch.selfImprovement);
        if (error) return { error };
        selfImprovementChanged = true;
    }

    let providerChanged = false;
    if (patch.provider !== undefined && typeof patch.provider === "object") {
        const result = applyProviderPatch(config, patch.provider, prevProviderId);
        if (result.error) return { error: result.error };
        providerChanged = result.providerChanged;
    }

    if (providerChanged) {
        // 프리셋이 바뀌면 사고수준을 새 프리셋 기준으로 재정규화하고, 이전 모델은 비운다.
        const newProviderId = config.provider?.id || "default";
        config.thinkingLevel = normalizeThinkingLevel(config.thinkingLevel, newProviderId);
        if (patch.provider.model === undefined) config.provider.model = newProviderId === "github-copilot" ? "auto" : "";
    }

    return { providerChanged, selfImprovementChanged };
}

// ── 설정과 모델 목록 API. ──

function substituteEnvSafe(value) {
    return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

export function registerSettingsRoutes(router) {
    router.add("GET", "/api/settings", (ctx) => {
        ctx.json200(buildSettingsPayload());
    });

    router.add("PUT", "/api/settings", async (ctx) => {
        const patch = await ctx.json();
        const config = loadUserConfig();
        const prevModel = String(config.provider?.model || "").trim();

        const applied = applySettingsPatch(config, patch);
        if (applied.error) return ctx.json400(applied.error);

        saveUserConfig(config);
        if (patch.updateCheckEnabled !== undefined) restartUpdateScheduler();
        // proactive는 매 틱 설정을 다시 읽으므로 재시작 불필요. dreaming 크론은 재등록이 필요하다(시간대 포함).
        if (applied.selfImprovementChanged || patch.timezone !== undefined) startDreamingScheduler();
        // 모델이 바뀌었고 압축 옵션이 켜져 있으면 모든 세션 압축 여부를 묻는다.
        // 실행은 사용자가 알림을 눌러 확인할 때만 한다. 자동 실행은 하지 않는다.
        // 모델이 비워진 상태(프로바이더 전환 중)에는 묻지 않는다.
        const modelChanged = String(config.provider?.model || "").trim() !== prevModel;
        if (modelChanged && config.provider?.model) {
            // 새 모델의 컨텍스트 윈도우를 미리 받아 둔다. 설정 화면의 채움 한도
            // 토큰 표시가 이전 모델 값으로 남지 않도록.
            void ensureModelMeta(getMergedProvider(config)).catch((err) => console.error("tabyBot: model meta refresh failed:", err?.message || err));
            if (getCompressOnModelChange(config)) askSessionCompression(config.language || "en");
        }
        // 프론트가 부분 객체로 상태를 덮어쓰지 않도록 항상 전체 스냅샷을 돌려준다.
        ctx.json200(buildSettingsPayload());
    });

    // 봇의 활성 세션을 즉시 압축한다(설정의 모델 탭 고급 항목, 또는 모델 변경 확인 알림에서 호출).
    // body.chatIds를 주면 그 봇들만, 없으면 모든 봇을 압축한다.
    router.add("POST", "/api/sessions/compress-all", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        let chatIds = null;
        if (Array.isArray(body?.chatIds)) chatIds = body.chatIds.map(String).filter(Boolean).slice(0, 50);
        if (isSessionCompressing()) return ctx.json409("already_running");
        try {
            ctx.json200(await runSessionCompression(chatIds));
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
            let provider;
            if (body.providerId || body.baseURL || body.apiKey) {
                const providerId =
                    String(body.providerId || config.provider?.id || "default") === "custom"
                        ? "default"
                        : String(body.providerId || config.provider?.id || "default");
                const base = loadProviderConfig(providerId);
                provider = {
                    id: base.id || "custom",
                    type: base.type,
                    baseURL: String(body.baseURL || base.baseURL || "").replace(/\/$/, ""),
                    apiKey: substituteEnvSafe(body.apiKey || ""),
                    extraHeaders: base.extraHeaders || {},
                    apiKeyOptional: Boolean(base.apiKeyOptional),
                };
                if (base.defaultContextWindow) provider.defaultContextWindow = base.defaultContextWindow;
                if (!provider.apiKey && !provider.apiKeyOptional) {
                    provider.apiKey = substituteEnvSafe(config.provider?.apiKey || "");
                }
            } else {
                provider = getMergedProvider(config);
            }
            const models = await fetchProviderModels(provider, { useCache: false });
            let routingModels = [];
            if (provider.type === "github-copilot-oauth") {
                try {
                    routingModels = await fetchGithubCopilotRoutingModels();
                } catch {
                    // Auto 모델 목록은 기본 모델 목록만으로도 표시한다.
                }
            }
            ctx.json200({ models, routingModels });
        } catch (err) {
            ctx.json400(err?.message || String(err));
        }
    });
}
