// tabyBot 웹 서버: 정적 클라이언트 + JSON API + SSE 이벤트 스트림.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CODES_DIR } from "../paths.js";
import { isDockerRuntime } from "../runtime.js";
import { loadUserConfig, saveUserConfig, getMergedProvider, loadProviderConfig } from "../config-loader.js";
import { getConfigIssue, isConfigReady } from "../onboarding.js";
import { getRunningVersion } from "../update/store.js";
import { fetchProviderModels } from "../llm/models.js";
import { fetchGithubCopilotRoutingModels } from "../llm/github-copilot-client.js";
import { normalizeThinkingLevel, thinkingLevelLabel, getProviderThinkingMeta } from "../thinking-levels.js";
import { hasCodexAuth, clearCodexTokens, startDeviceFlow, pollDeviceFlow } from "../llm/codex-tokens.js";
import { hasGrokAuth, clearGrokTokens, startGrokDeviceFlow, pollGrokDeviceFlow } from "../llm/grok-tokens.js";
import {
    hasGithubCopilotAuth,
    clearGithubCopilotTokens,
    startGithubCopilotDeviceFlow,
    pollGithubCopilotDeviceFlow,
} from "../llm/github-copilot-tokens.js";
import { NSFW_LEVELS, normalizeNsfwLevel, APPROVAL_LEVELS, normalizeApprovalLevel } from "../user-settings.js";
import { getDreamingConfig, getProactiveConfig, getReviewConfig, applySelfImprovementPatch } from "../self-improvement.js";
import { startDreamingScheduler } from "../dreaming/scheduler.js";
import { isValidTimeZone } from "../scheduling/time.js";
import {
    listAgents,
    addAgent,
    updateAgent as storeUpdateAgent,
    removeAgent,
    agentColor,
    firstAgent,
    DEFAULT_AGENT_NAME,
    getAgent,
    AVATAR_COLORS,
} from "../agents-store.js";
import {
    acceptHandoff,
    addTodo,
    approveSuggestion,
    clearAssignee,
    completeTodo,
    getTodo,
    listTodos,
    purgeAgentTodos,
    reopenTodo,
    rejectSuggestion,
    removeTodo,
    updateTodo,
} from "../todos/store.js";
import { queueTodoNow } from "../todos/scheduler.js";
import * as conversationsStore from "./conversations.js";
import { getFile, saveUploadStream, publicAttachment, storedAttachment, MAX_UPLOAD_BYTES, UploadTooLargeError, EmptyUploadError } from "./files.js";
import { subscribe, emit, eventsSince, currentSeq } from "./bus.js";
import { getVapidPublicKey, saveSubscription, removeSubscription } from "./push.js";
import * as accountAuth from "./auth.js";
import { createRouter } from "./http.js";
import { registerComputerRoutes, initComputerWs, handleComputerUpgrade, purgeAgentComputer } from "./computer.js";
import { dispatchMessage, recoverInterruptedTurns, stopConversation } from "./turns.js";
import { restartUpdateScheduler } from "../update/scheduler.js";
import { listRunningSessionKeys, requestAgentStop } from "../agent/session.js";
import { cancelQueuedAgentWork } from "../agent-queue.js";
import { resolvePendingAskByAskId } from "../agent/user-ask.js";

const PUBLIC_DIR = path.join(CODES_DIR, "public");
// 계정이 만들어져 있으면 세션 인증이 켜진다 — 계정이 없으면 열려 있다(첫 방문에 생성 유도).
const AUTH = {
    enabled: () => accountAuth.hasAccount(),
    verify: (token) => Boolean(accountAuth.resolveSession(token)),
    publicPaths: ["/api/account/state", "/api/account/login", "/api/account/setup"],
};
// 도커 안에서는 항상 8999로 듣는다 — 호스트 포트는 compose 매핑이 담당한다
// (TABYBOT_PORT를 컨테이너에 주입하면 커스텀 포트에서 매핑이 깨진다).
const PORT = isDockerRuntime() ? 8999 : Number(process.env.TABYBOT_PORT || 8999);
// 기본은 모든 인터페이스에 연다. 이 머신만 쓰려면 TABYBOT_HOST=127.0.0.1로 명시한다.
const HOST = process.env.TABYBOT_HOST?.trim() || "0.0.0.0";

const PROVIDER_LABELS = {
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
        "codex",
        "grok",
        "github-copilot",
    ]
        .map((id) => byId.get(id))
        .filter(Boolean);
    presets.push({ id: "custom", label: "Custom API URL", type: "openai-compatible", baseURL: null, apiKeyOptional: false, needsBaseURL: true });
    return presets;
}

// 진행 중인 OAuth 디바이스 플로우. kind별로 AbortController 1개만 유지한다.
const activeOauthLogins = new Map();

async function startOauthLogin(kind) {
    const prev = activeOauthLogins.get(kind);
    if (prev) prev.abort.abort();
    // 기존 토큰을 지운 뒤 새 로그인을 시작한다(원본 설정 마법사와 동일 동작).
    if (kind === "codex") clearCodexTokens();
    else if (kind === "grok") clearGrokTokens();
    else clearGithubCopilotTokens();

    const flow = kind === "codex" ? await startDeviceFlow() : kind === "grok" ? await startGrokDeviceFlow() : await startGithubCopilotDeviceFlow();

    const abort = new AbortController();
    activeOauthLogins.set(kind, { abort });

    const poller =
        kind === "codex"
            ? pollDeviceFlow({ deviceAuthId: flow.deviceAuthId, userCode: flow.userCode, intervalMs: flow.intervalMs, signal: abort.signal })
            : kind === "grok"
              ? pollGrokDeviceFlow({ deviceCode: flow.deviceCode, intervalMs: flow.intervalMs, expiresAt: flow.expiresAt, signal: abort.signal })
              : pollGithubCopilotDeviceFlow({
                    deviceCode: flow.deviceCode,
                    intervalMs: flow.intervalMs,
                    expiresAt: flow.expiresAt,
                    signal: abort.signal,
                });
    poller
        .then(() => emit({ type: "oauth_done", kind, ok: true }))
        .catch((err) => {
            if (!abort.signal.aborted) emit({ type: "oauth_done", kind, ok: false, detail: err?.message || String(err) });
        })
        .finally(() => {
            if (activeOauthLogins.get(kind)?.abort === abort) activeOauthLogins.delete(kind);
        });

    return { userCode: flow.userCode, deviceUrl: flow.deviceUrl };
}

// 로그인 스로틀의 출발지 키. X-Forwarded-For는 loopback 프록시(터널/로컬 리버스
// 프록시)에서 온 요청에만 신뢰한다 — LAN에서 직접 오는 요청이 헤더를 조작해
// 남의 IP인 척하며 스로틀을 회피/유도하는 걸 막는다.
function clientKey(req) {
    const remote = String(req.socket?.remoteAddress || "");
    const localProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const xff = String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    return (localProxy && xff) || remote || "unknown";
}

function publicAgent(a) {
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
        createdAt: a.createdAt ?? null,
        preview: typeof meta?.preview === "string" ? meta.preview : "",
    };
}

function resolveConversationMeta(id) {
    return conversationsStore.getConversationMeta(id) || conversationsStore.ensureConversation(id);
}

function substituteEnvSafe(value) {
    return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

// GET/PUT 공용 설정 스냅샷. apiKey는 절대 포함하지 않는다.
function buildSettingsPayload() {
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
        onboardingDismissed: config.onboardingDismissed === true,
        nsfwLevel: normalizeNsfwLevel(config.nsfwLevel),
        nsfwLevels: NSFW_LEVELS,
        approvalLevel: normalizeApprovalLevel(config.approvalLevel),
        approvalLevels: APPROVAL_LEVELS,
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

export function startWebServer() {
    const router = createRouter({ publicDir: PUBLIC_DIR, auth: AUTH });
    router.setSseSubscribe(subscribe);
    router.setSeqNow(currentSeq);

    // ---- 상태 ----
    router.add("GET", "/api/bootstrap", (ctx) => {
        const config = loadUserConfig();
        ctx.json200({
            version: getRunningVersion() || process.env.TABYBOT_VERSION || "dev",
            dockerRuntime: isDockerRuntime(),
            configured: isConfigReady(),
            language: config.language || "en",
            agentName: firstAgent()?.name || DEFAULT_AGENT_NAME,
            authRequired: accountAuth.hasAccount(),
            account: accountAuth.accountInfo()?.username || null,
        });
    });

    // ---- 계정(웹 UI 로그인/세션) ----
    // state/login/setup은 publicPaths로 인증 없이 열린다 — 클라이언트가
    // 로그인/계정 생성/앱 진입 중 어떤 화면을 띄울지 이 응답으로 결정한다.
    router.add("GET", "/api/account/state", (ctx) => {
        const has = accountAuth.hasAccount();
        const authed = has ? Boolean(accountAuth.resolveSession(ctx.token)) : true;
        const info = authed ? accountAuth.accountInfo() : null;
        ctx.json200({
            hasAccount: has,
            authed,
            username: info?.username || null,
            createdAt: info?.createdAt || null,
            sessionCount: info?.sessions ?? null,
        });
    });

    router.add("POST", "/api/account/setup", async (ctx) => {
        const body = await ctx.json();
        const result = accountAuth.createAccount({ username: body.username, password: body.password });
        if (result.error === "account_exists") return ctx.json409("account_exists");
        if (result.error) return ctx.json400(result.error);
        const session = accountAuth.createSession();
        ctx.json200({ ok: true, username: result.account.username, ...session });
    });

    router.add("POST", "/api/account/login", async (ctx) => {
        const body = await ctx.json();
        const result = await accountAuth.login({ key: clientKey(ctx.req), username: body.username, password: body.password });
        if (result.error === "too_many_attempts") {
            ctx.res.setHeader("Retry-After", String(result.retryAfter));
            return ctx.sendJson(429, { error: "too_many_attempts", retryAfter: result.retryAfter });
        }
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ ok: true, username: result.account.username, ...result.session });
    });

    router.add("POST", "/api/account/logout", (ctx) => {
        accountAuth.revokeSession(ctx.token);
        ctx.json200({ ok: true });
    });

    router.add("PUT", "/api/account", async (ctx) => {
        const body = await ctx.json();
        const result = accountAuth.updateAccount({
            currentPassword: body.currentPassword,
            username: body.username,
            password: body.password,
            keepToken: ctx.token,
        });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ ok: true, account: result.account });
    });

    // ---- 실시간 이벤트 (SSE) ----
    router.add("GET", "/api/events", (ctx) => {
        ctx.sse();
        // 새로고침 직후 진행 중 턴을 바로 붙인다. 다음 phase 이벤트까지 기다리지 않는다.
        for (const conversationId of listRunningSessionKeys()) {
            emit({ type: "status", conversationId, phase: "generating" });
        }
    });
    router.add("GET", "/api/events/poll", (ctx) => {
        ctx.json200(eventsSince(ctx.query.since, ctx.query.recentMs));
    });

    // ---- 대화 ----
    router.add("GET", "/api/conversations", (ctx) => {
        ctx.json200({ conversations: conversationsStore.listConversations() });
    });

    router.add("GET", "/api/conversations/:id", (ctx) => {
        const id = ctx.params.id;
        if (!conversationsStore.getConversationMeta(id)) resolveConversationMeta(id);
        const detail = conversationsStore.getConversationDetail(id);
        if (!detail) return ctx.json404();
        ctx.json200(detail);
    });

    router.add("POST", "/api/conversations/:id/messages", async (ctx) => {
        const id = ctx.params.id;
        const meta = resolveConversationMeta(id);
        if (!meta) return ctx.json404();
        const configIssue = getConfigIssue();
        if (configIssue) return ctx.json409("not_configured", { reason: configIssue });

        const body = await ctx.json();
        const text = String(body.text ?? "").trim();
        const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
        if (!text && !attachmentIds.length) return ctx.json400("empty_message");
        if (text.length > 32_000) return ctx.json400("message_too_long");

        const stored = [];
        for (const fid of attachmentIds) {
            const file = getFile(fid);
            if (!file) continue;
            stored.push(storedAttachment(file));
        }
        if (!text && !stored.length) return ctx.json400("empty_message");

        const published = stored.map(publicAttachment);
        dispatchMessage({
            sessionKey: id,
            agentId: meta.agentId,
            userText: text,
            displayText: text,
            attachments: stored,
        });
        // 멀티탭 동기화: 다른 클라이언트에도 사용자 메시지를 즉시 반영
        emit({
            type: "user_message",
            conversationId: id,
            text,
            attachments: published,
        });
        ctx.json200({ ok: true });
    });

    router.add("POST", "/api/conversations/:id/stop", (ctx) => {
        ctx.json200({ ok: stopConversation(ctx.params.id) });
    });

    // ---- 업로드/파일 ----
    router.add("POST", "/api/uploads", async (ctx) => {
        const mime = String(ctx.req.headers["content-type"] || "application/octet-stream")
            .split(";")[0]
            .trim();
        let originalName = "";
        try {
            originalName = decodeURIComponent(String(ctx.req.headers["x-file-name"] || ""));
        } catch {
            originalName = String(ctx.req.headers["x-file-name"] || "");
        }
        try {
            const entry = await saveUploadStream(ctx.req, mime, originalName);
            ctx.json200({
                id: entry.id,
                kind: entry.mime.startsWith("image/") ? "image" : "file",
                url: `/api/files/${entry.id}`,
                name: entry.name,
                mime: entry.mime,
                size: entry.size,
            });
        } catch (err) {
            if (err instanceof UploadTooLargeError || err?.code === "UPLOAD_TOO_LARGE") {
                return ctx.json413("upload_too_large", { maxBytes: MAX_UPLOAD_BYTES });
            }
            if (err instanceof EmptyUploadError || err?.code === "EMPTY_UPLOAD") {
                return ctx.json400("empty_upload");
            }
            throw err;
        }
    });

    router.add("GET", "/api/files/:id", (ctx) => {
        const file = getFile(ctx.params.id);
        if (!file) return ctx.json404();
        const stat = fs.statSync(file.filePath);
        ctx.res.writeHead(200, {
            "Content-Type": file.mime,
            "Content-Length": stat.size,
            "Content-Disposition": file.mime.startsWith("image/") ? "inline" : `attachment; filename="${encodeURIComponent(file.name)}"`,
            "Cache-Control": "private, max-age=3600",
        });
        fs.createReadStream(file.filePath)
            .on("error", () => ctx.res.destroy())
            .pipe(ctx.res);
    });

    // ---- OAuth 디바이스 플로우 ----
    router.add("GET", "/api/auth/status", (ctx) => {
        ctx.json200({ codex: hasCodexAuth(), grok: hasGrokAuth(), "github-copilot": hasGithubCopilotAuth() });
    });

    router.add("POST", "/api/auth/:kind/start", async (ctx) => {
        const kind = ctx.params.kind;
        if (kind !== "codex" && kind !== "grok" && kind !== "github-copilot") return ctx.json404();
        try {
            ctx.json200(await startOauthLogin(kind));
        } catch (err) {
            ctx.json400(err?.message || String(err));
        }
    });

    router.add("POST", "/api/auth/:kind/cancel", (ctx) => {
        const kind = ctx.params.kind;
        if (kind !== "codex" && kind !== "grok" && kind !== "github-copilot") return ctx.json404();
        const prev = activeOauthLogins.get(kind);
        if (prev) prev.abort.abort();
        activeOauthLogins.delete(kind);
        ctx.json200({ ok: true });
    });

    // ---- 웹 푸시 구독 ----
    router.add("GET", "/api/push/config", (ctx) => {
        ctx.json200({ publicKey: getVapidPublicKey() });
    });

    router.add("POST", "/api/push/subscribe", async (ctx) => {
        const body = await ctx.json();
        if (!saveSubscription(body)) return ctx.json400("invalid_subscription");
        ctx.json200({ ok: true });
    });

    router.add("POST", "/api/push/unsubscribe", async (ctx) => {
        const body = await ctx.json();
        removeSubscription(body);
        ctx.json200({ ok: true });
    });

    // ---- 질문(user_ask) 응답 ----
    router.add("POST", "/api/asks/:askId/answer", async (ctx) => {
        const body = await ctx.json();
        const answer = resolvePendingAskByAskId(ctx.params.askId, {
            choiceIndex: Number.isInteger(body.choiceIndex) ? body.choiceIndex : null,
            text: String(body.text ?? ""),
        });
        if (answer === null) return ctx.json404();
        ctx.json200({ ok: true, answer });
    });

    // ---- 설정 ----
    router.add("GET", "/api/settings", (ctx) => {
        ctx.json200(buildSettingsPayload());
    });

    router.add("PUT", "/api/settings", async (ctx) => {
        const patch = await ctx.json();
        const config = loadUserConfig();
        const prevPid = config.provider?.id || "default";
        let providerChanged = false;

        if (patch.language !== undefined) {
            if (!["en", "ko", "ja"].includes(patch.language)) return ctx.json400("invalid_language");
            config.language = patch.language;
        }
        if (patch.thinkingLevel !== undefined) {
            config.thinkingLevel = normalizeThinkingLevel(patch.thinkingLevel, prevPid);
        }
        if (patch.showReplyFooter !== undefined) config.showReplyFooter = Boolean(patch.showReplyFooter);
        if (patch.updateCheckEnabled !== undefined) config.updateCheckEnabled = Boolean(patch.updateCheckEnabled);
        if (patch.onboardingDismissed !== undefined) config.onboardingDismissed = Boolean(patch.onboardingDismissed);
        if (patch.timezone !== undefined) {
            const tz = String(patch.timezone || "").trim();
            if (tz && !isValidTimeZone(tz)) return ctx.json400("invalid_timezone");
            if (tz) config.timezone = tz;
            else delete config.timezone;
        }
        if (patch.nsfwLevel !== undefined) config.nsfwLevel = normalizeNsfwLevel(patch.nsfwLevel);
        if (patch.approvalLevel !== undefined) config.approvalLevel = normalizeApprovalLevel(patch.approvalLevel);

        let selfImprovementChanged = false;
        if (patch.selfImprovement !== undefined) {
            const err = applySelfImprovementPatch((config.selfImprovement = config.selfImprovement || {}), patch.selfImprovement);
            if (err) return ctx.json400(err);
            selfImprovementChanged = true;
        }

        if (patch.provider !== undefined && typeof patch.provider === "object") {
            config.provider = config.provider || {};
            if (patch.provider.id !== undefined) {
                const requestedPid = String(patch.provider.id).trim() || "default";
                const custom = requestedPid === "custom";
                const pid = custom ? "default" : requestedPid;
                if (custom || pid !== prevPid) {
                    providerChanged = true;
                    // provider를 바꾸면 기존 모델과 커스텀 URL을 초기화한다.
                    delete config.provider.baseURL;
                }
                config.provider.id = pid;
            }
            if (patch.provider.baseURL !== undefined) {
                const url = String(patch.provider.baseURL || "")
                    .trim()
                    .replace(/\/+$/, "");
                if (url) config.provider.baseURL = url;
                else delete config.provider.baseURL;
            }
            if (patch.provider.model !== undefined) {
                config.provider.model = String(patch.provider.model || "").trim();
            }
            if (patch.provider.apiKey !== undefined) {
                const key = String(patch.provider.apiKey ?? "");
                if (key === "") {
                    if (patch.provider.clearApiKey === true) delete config.provider.apiKey;
                } else {
                    config.provider.apiKey = key;
                }
            }
            if (patch.provider.autoMode !== undefined) config.provider.autoMode = Boolean(patch.provider.autoMode);
            if (patch.provider.autoModelCandidates !== undefined) {
                if (!Array.isArray(patch.provider.autoModelCandidates)) return ctx.json400("invalid_auto_model_candidates");
                config.provider.autoModelCandidates = [
                    ...new Set(
                        patch.provider.autoModelCandidates
                            .map(String)
                            .map((id) => id.trim())
                            .filter(Boolean),
                    ),
                ].slice(0, 30);
            }
        }

        const newPid = config.provider?.id || "default";
        if (providerChanged) {
            // 프리셋이 바뀌면 사고수준을 새 프리셋 기준으로 재정규화하고, 이전 모델은 비운다.
            config.thinkingLevel = normalizeThinkingLevel(config.thinkingLevel, newPid);
            if (patch.provider.model === undefined) config.provider.model = newPid === "github-copilot" ? "auto" : "";
        }

        saveUserConfig(config);
        if (patch.updateCheckEnabled !== undefined) restartUpdateScheduler();
        // proactive는 매 틱 설정을 다시 읽으므로 재시작 불필요. dreaming 크론은 재등록이 필요하다(시간대 포함).
        if (selfImprovementChanged || patch.timezone !== undefined) startDreamingScheduler();
        // 프론트가 부분 객체로 상태를 덮어쓰지 않도록 항상 전체 스냅샷을 돌려준다.
        ctx.json200(buildSettingsPayload());
    });

    // ---- 모델 목록 ----
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

    // ---- 봇(에이전트) ----
    router.add("GET", "/api/agents", (ctx) => {
        ctx.json200({ agents: listAgents().map(publicAgent) });
    });

    router.add("POST", "/api/agents", async (ctx) => {
        const body = await ctx.json();
        const result = addAgent({
            name: body.name,
            persona: body.persona,
            model: body.model,
            thinkingLevel: body.thinkingLevel,
            color: body.color,
        });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ agents: listAgents().map(publicAgent), agent: publicAgent(result.agent) });
    });

    router.add("PATCH", "/api/agents/:id", async (ctx) => {
        const body = await ctx.json();
        const result = storeUpdateAgent(ctx.params.id, {
            name: body.name,
            persona: body.persona,
            model: body.model,
            thinkingLevel: body.thinkingLevel,
            color: body.color,
        });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ agents: listAgents().map(publicAgent), agent: publicAgent(result.agent) });
    });

    router.add("DELETE", "/api/agents/:id", (ctx) => {
        // 마지막으로 남은 봇은 삭제할 수 없다.
        const result = removeAgent(ctx.params.id);
        if (result.error === "last_agent") return ctx.json400("last_agent");
        if (result.error) return ctx.json404();
        if (result.agent?.uuid) {
            try {
                cancelQueuedAgentWork(result.agent.uuid);
                requestAgentStop(result.agent.uuid);
            } catch (_) {}
        }
        // 삭제된 봇의 컴퓨터 자원(브라우저 세션·프로필·PTY)을 해제한다.
        void purgeAgentComputer(ctx.params.id).catch(() => {});
        if (purgeAgentTodos(ctx.params.id).changed) emit({ type: "todos_changed" });
        emit({ type: "conversations_changed" });
        ctx.json200({ agents: listAgents().map(publicAgent) });
    });

    function todoPayload() {
        return listTodos();
    }

    function emitTodos() {
        emit({ type: "todos_changed" });
    }

    router.add("GET", "/api/todos", (ctx) => {
        ctx.json200(todoPayload());
    });

    router.add("POST", "/api/todos", async (ctx) => {
        const body = await ctx.json().catch(() => null);
        if (body == null || typeof body !== "object" || Array.isArray(body)) return ctx.json400("invalid_json");
        const result = addTodo({ ...body, createdBy: "user" });
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("PATCH", "/api/todos/:todoId", async (ctx) => {
        const body = await ctx.json().catch(() => null);
        if (body == null || typeof body !== "object" || Array.isArray(body)) return ctx.json400("invalid_json");
        const result = updateTodo(ctx.params.todoId, body);
        if (result.error === "not_found") return ctx.json404();
        if (result.error === "conflict") return ctx.json409("conflict");
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("DELETE", "/api/todos/:todoId", (ctx) => {
        const result = removeTodo(ctx.params.todoId);
        if (result.error) return ctx.json404();
        emitTodos();
        ctx.json200(todoPayload());
    });

    router.add("POST", "/api/todos/:todoId/complete", (ctx) => {
        const result = completeTodo(ctx.params.todoId);
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/:todoId/reopen", (ctx) => {
        const result = reopenTodo(ctx.params.todoId);
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/suggestions/:id/approve", async (ctx) => {
        const body = await ctx.json().catch(() => null);
        const result = approveSuggestion(ctx.params.id, { fallbackTimeZone: body?.timezone });
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), ...result });
    });

    router.add("POST", "/api/todos/suggestions/:id/reject", (ctx) => {
        const result = rejectSuggestion(ctx.params.id);
        if (result.error) return ctx.json404();
        emitTodos();
        ctx.json200(todoPayload());
    });

    router.add("POST", "/api/todos/:todoId/handoff/:agentId", (ctx) => {
        const result = acceptHandoff(ctx.params.todoId, ctx.params.agentId);
        if (result.error === "not_found") return ctx.json404();
        if (result.error === "offer_not_found") return ctx.json400("offer_not_found");
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/:todoId/unassign", (ctx) => {
        const result = clearAssignee(ctx.params.todoId);
        if (result.error) return ctx.json404();
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/:todoId/run", (ctx) => {
        const item = getTodo(ctx.params.todoId);
        if (!item) return ctx.json404();
        if (item.status !== "open") return ctx.json400("not_open");
        const agent = item.executor?.id ? getAgent(item.executor.id) : null;
        if (!agent) return ctx.json400("not_assigned");
        const queued = queueTodoNow(agent, item);
        if (queued.error) return ctx.json400(queued.error);
        ctx.json200({ ok: true, ...todoPayload() });
    });

    registerComputerRoutes(router);

    const server = http.createServer((req, res) => router.handle(req, res));
    initComputerWs(AUTH);
    server.on("upgrade", (req, socket, head) => {
        try {
            handleComputerUpgrade(req, socket, head);
        } catch {
            socket.destroy();
        }
    });
    server.listen(PORT, HOST, () => {
        console.log(`tabyBot: web UI ready at http://${HOST}:${PORT}${accountAuth.hasAccount() ? " (account required)" : ""}`);
        if (isConfigReady()) recoverInterruptedTurns();
    });
    return server;
}
