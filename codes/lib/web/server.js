// tabyBot 웹 서버: 정적 클라이언트 + JSON API + SSE 이벤트 스트림.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CODES_DIR } from "../paths.js";
import { isDockerRuntime } from "../runtime.js";
import { loadUserConfig, saveUserConfig, getMergedProvider, loadProviderConfig } from "../config-loader.js";
import { isConfigReady } from "../onboarding.js";
import { getRunningVersion } from "../update/store.js";
import { fetchProviderModels } from "../llm/models.js";
import { normalizeThinkingLevel, thinkingLevelLabel, getProviderThinkingMeta } from "../thinking-levels.js";
import { hasCodexAuth, clearCodexTokens, startDeviceFlow, pollDeviceFlow } from "../llm/codex-tokens.js";
import { hasGrokAuth, clearGrokTokens, startGrokDeviceFlow, pollGrokDeviceFlow } from "../llm/grok-tokens.js";
import { NSFW_LEVELS, normalizeNsfwLevel, APPROVAL_LEVELS, normalizeApprovalLevel } from "../user-settings.js";
import {
    listAgents,
    addAgent,
    updateAgent as storeUpdateAgent,
    removeAgent,
    agentColor,
    agentThreadId,
    firstAgent,
    firstAgentId,
    DEFAULT_AGENT_NAME,
} from "../agents-store.js";
import * as conversationsStore from "./conversations.js";
import { getFile, saveUploadStream, publicAttachment, storedAttachment, MAX_UPLOAD_BYTES, UploadTooLargeError, EmptyUploadError } from "./files.js";
import { subscribe, emit } from "./bus.js";
import { getVapidPublicKey, saveSubscription, removeSubscription } from "./push.js";
import { createRouter } from "./http.js";
import { dispatchMessage, recoverInterruptedTurns, stopConversation } from "./turns.js";
import { listRunningSessionKeys } from "../agent/session.js";
import { resolvePendingAskByAskId } from "../agent/user-ask.js";

const PUBLIC_DIR = path.join(CODES_DIR, "public");
const WEB_TOKEN = process.env.TABYBOT_WEB_TOKEN?.trim() || "";
const PORT = Number(process.env.TABYBOT_PORT || 8999);
const HOST = process.env.TABYBOT_HOST || "127.0.0.1";

const PROVIDER_LABELS = {
    default: "OpenAI",
    openrouter: "OpenRouter",
    grok: "Grok OAuth",
    codex: "Codex OAuth (ChatGPT Plus/Pro)",
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
    const presets = ["default", "openrouter", "orcarouter", "synthetic", "ollama", "ollama-cloud", "zenmux", "upstage", "codex", "grok"]
        .map((id) => byId.get(id))
        .filter(Boolean);
    // tabyAgent와 동일하게 실제 프리셋 10개에 Custom API URL을 별도 선택지로 제공한다.
    presets.push({ id: "custom", label: "Custom API URL", type: "openai-compatible", baseURL: null, apiKeyOptional: false, needsBaseURL: true });
    return presets;
}

// 진행 중인 OAuth 디바이스 플로우. kind(codex|grok)별로 AbortController 1개만 유지한다.
const activeOauthLogins = new Map();

async function startOauthLogin(kind) {
    const prev = activeOauthLogins.get(kind);
    if (prev) prev.abort.abort();
    // 기존 토큰을 지운 뒤 새 로그인을 시작한다(원본 설정 마법사와 동일 동작).
    if (kind === "codex") clearCodexTokens();
    else clearGrokTokens();

    const flow = kind === "codex" ? await startDeviceFlow() : await startGrokDeviceFlow();

    const abort = new AbortController();
    activeOauthLogins.set(kind, { abort });

    const poller =
        kind === "codex"
            ? pollDeviceFlow({ deviceAuthId: flow.deviceAuthId, userCode: flow.userCode, intervalMs: flow.intervalMs, signal: abort.signal })
            : pollGrokDeviceFlow({ deviceCode: flow.deviceCode, intervalMs: flow.intervalMs, expiresAt: flow.expiresAt, signal: abort.signal });

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

function publicAgent(a) {
    const threadId = agentThreadId(a.id);
    const meta = conversationsStore.getConversationMeta(threadId);
    return {
        id: a.id,
        uuid: a.uuid,
        name: a.name,
        persona: a.persona,
        color: agentColor(a.id),
        createdAt: a.createdAt ?? null,
        threadId,
        preview: typeof meta?.preview === "string" ? meta.preview : "",
    };
}

// 봇 스레드(web-agent-*)는 접근 시 자동 생성된다.
function resolveConversationMeta(id) {
    return (
        conversationsStore.getConversationMeta(id) ||
        (id.startsWith("web-agent-") ? conversationsStore.ensureAgentThread(id.slice("web-agent-".length)) : null)
    );
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
        },
        providers: presets,
        agents: listAgents().map(publicAgent),
    };
}

export function startWebServer() {
    const router = createRouter({ publicDir: PUBLIC_DIR, token: WEB_TOKEN });
    router.setSseSubscribe(subscribe);

    // ---- 상태 ----
    router.add("GET", "/api/bootstrap", (ctx) => {
        const config = loadUserConfig();
        ctx.json200({
            version: getRunningVersion() || process.env.TABYBOT_VERSION || "dev",
            dockerRuntime: isDockerRuntime(),
            configured: isConfigReady(),
            language: config.language || "en",
            agentName: firstAgent()?.name || DEFAULT_AGENT_NAME,
            authRequired: Boolean(WEB_TOKEN),
        });
    });

    // ---- 실시간 이벤트 (SSE) ----
    router.add("GET", "/api/events", (ctx) => {
        ctx.sse();
        // 새로고침 직후 진행 중 턴을 바로 붙인다. 다음 phase 이벤트까지 기다리지 않는다.
        for (const conversationId of listRunningSessionKeys()) {
            emit({ type: "status", conversationId, phase: "generating" });
        }
    });

    // ---- 대화 ----
    router.add("GET", "/api/conversations", (ctx) => {
        ctx.json200({ conversations: conversationsStore.listConversations() });
    });

    router.add("POST", "/api/conversations", (ctx) => {
        ctx.json200({ conversation: conversationsStore.createConversation(firstAgentId()) });
    });

    router.add("GET", "/api/conversations/:id", (ctx) => {
        const id = ctx.params.id;
        if (!conversationsStore.getConversationMeta(id)) resolveConversationMeta(id);
        const detail = conversationsStore.getConversationDetail(id);
        if (!detail) return ctx.json404();
        ctx.json200(detail);
    });

    router.add("PATCH", "/api/conversations/:id", async (ctx) => {
        const body = await ctx.json();
        const updated = conversationsStore.renameConversation(ctx.params.id, body.title);
        if (!updated) return ctx.json404();
        ctx.json200({ conversation: updated });
    });

    router.add("DELETE", "/api/conversations/:id", (ctx) => {
        if (!conversationsStore.deleteConversation(ctx.params.id)) return ctx.json404();
        ctx.json200({ ok: true });
    });

    router.add("POST", "/api/conversations/:id/messages", async (ctx) => {
        const id = ctx.params.id;
        const meta = resolveConversationMeta(id);
        if (!meta) return ctx.json404();
        if (!isConfigReady()) return ctx.json409("not_configured");

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
        fs.createReadStream(file.filePath).pipe(ctx.res);
    });

    // ---- OAuth 디바이스 플로우(Codex/Grok) ----
    router.add("GET", "/api/auth/status", (ctx) => {
        ctx.json200({ codex: hasCodexAuth(), grok: hasGrokAuth() });
    });

    router.add("POST", "/api/auth/:kind/start", async (ctx) => {
        const kind = ctx.params.kind;
        if (kind !== "codex" && kind !== "grok") return ctx.json404();
        try {
            ctx.json200(await startOauthLogin(kind));
        } catch (err) {
            ctx.json400(err?.message || String(err));
        }
    });

    router.add("POST", "/api/auth/:kind/cancel", (ctx) => {
        const kind = ctx.params.kind;
        if (kind !== "codex" && kind !== "grok") return ctx.json404();
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
        if (patch.nsfwLevel !== undefined) config.nsfwLevel = normalizeNsfwLevel(patch.nsfwLevel);
        if (patch.approvalLevel !== undefined) config.approvalLevel = normalizeApprovalLevel(patch.approvalLevel);

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
        }

        const newPid = config.provider?.id || "default";
        if (providerChanged) {
            // 프리셋이 바뀌면 사고수준을 새 프리셋 기준으로 재정규화하고, 이전 모델은 비운다.
            config.thinkingLevel = normalizeThinkingLevel(config.thinkingLevel, newPid);
            if (patch.provider.model === undefined) config.provider.model = "";
        }

        saveUserConfig(config);
        // 프론트가 부분 객체로 상태를 덮어쓰지 않도록 항상 전체 스냅샷을 돌려준다.
        ctx.json200(buildSettingsPayload());
    });

    // ---- 모델 목록 ----
    router.add("POST", "/api/models/fetch", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
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
            ctx.json200({ models });
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
        const result = addAgent({ name: body.name, persona: body.persona });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ agents: listAgents().map(publicAgent), agent: publicAgent(result.agent) });
    });

    router.add("PATCH", "/api/agents/:id", async (ctx) => {
        const body = await ctx.json();
        const result = storeUpdateAgent(ctx.params.id, { name: body.name, persona: body.persona });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ agents: listAgents().map(publicAgent), agent: publicAgent(result.agent) });
    });

    router.add("DELETE", "/api/agents/:id", (ctx) => {
        // 마지막으로 남은 봇은 삭제할 수 없다.
        const result = removeAgent(ctx.params.id);
        if (result.error === "last_agent") return ctx.json400("last_agent");
        if (result.error) return ctx.json404();
        conversationsStore.deleteConversation(agentThreadId(ctx.params.id));
        emit({ type: "conversations_changed" });
        ctx.json200({ agents: listAgents().map(publicAgent) });
    });

    const server = http.createServer((req, res) => router.handle(req, res));
    server.listen(PORT, HOST, () => {
        console.log(`tabyBot: web UI ready at http://${HOST}:${PORT}${WEB_TOKEN ? " (token required)" : ""}`);
        if (isConfigReady()) recoverInterruptedTurns();
    });
    return server;
}
