// 앱 상태, 계정(웹 UI 로그인/세션), OAuth 디바이스 플로우 API.
import { isDockerRuntime } from "../../runtime.js";
import { loadUserConfig } from "../../config-loader.js";
import { isConfigReady } from "../../onboarding.js";
import { getRunningVersion } from "../../update/store.js";
import { DEFAULT_AGENT_NAME, firstAgent } from "../../agents-store.js";
import * as accountAuth from "../auth.js";
import { clearCodexTokens, hasCodexAuth, pollDeviceFlow, startDeviceFlow } from "../../llm/codex-tokens.js";
import { clearGrokTokens, hasGrokAuth, pollGrokDeviceFlow, startGrokDeviceFlow } from "../../llm/grok-tokens.js";
import {
    clearGithubCopilotTokens,
    hasGithubCopilotAuth,
    pollGithubCopilotDeviceFlow,
    startGithubCopilotDeviceFlow,
} from "../../llm/github-copilot-tokens.js";
import { emit } from "../bus.js";

// ── 앱 상태 API. ──

function registerBootstrapRoutes(router) {
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
}

// ── 계정(웹 UI 로그인/세션) API. ──

// 로그인 스로틀의 출발지 키. X-Forwarded-For는 loopback 프록시(터널/로컬 리버스
// 프록시)에서 온 요청에만 신뢰한다. LAN에서 직접 오는 요청이 헤더를 조작해
// 남의 IP인 척하며 스로틀을 회피/유도하는 걸 막는다.
function clientKey(req) {
    const remote = String(req.socket?.remoteAddress || "");
    const localProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const xff = String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    return (localProxy && xff) || remote || "unknown";
}

function registerLoginRoutes(router) {
    // state/login/setup은 publicPaths로 인증 없이 열린다. 클라이언트가
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
}

// ── OAuth 디바이스 플로우 API. ──

function registerOauthRoutes(router) {
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
        cancelOauthLogin(kind);
        ctx.json200({ ok: true });
    });
}

// ── OAuth 디바이스 플로우 시작/취소. ──

// 진행 중인 OAuth 디바이스 플로우. kind별로 AbortController 1개만 유지한다.
const activeOauthLogins = new Map();

export async function startOauthLogin(kind) {
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

// 진행 중인 로그인을 취소한다.
export function cancelOauthLogin(kind) {
    const prev = activeOauthLogins.get(kind);
    if (prev) prev.abort.abort();
    activeOauthLogins.delete(kind);
}

export function registerAccountRoutes(router) {
    registerBootstrapRoutes(router);
    registerLoginRoutes(router);
    registerOauthRoutes(router);
}
