import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const AUTH_FILE = path.join(USER_DIR, "github-copilot-auth.json");
const COPILOT_HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
};
const EXPIRY_MARGIN_MS = 5 * 60_000;

function normalizeStored(raw) {
    if (!raw || typeof raw !== "object") return null;
    const accessToken = raw.githubAccessToken || raw.refreshToken;
    if (!accessToken) return null;
    return {
        githubAccessToken: accessToken,
        copilotAccessToken: raw.copilotAccessToken || raw.accessToken || null,
        expiresAt: Number(raw.expiresAt) || 0,
        baseURL: raw.baseURL || null,
    };
}

function loadStored() {
    if (!fs.existsSync(AUTH_FILE)) return null;
    try {
        return normalizeStored(JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")));
    } catch {
        return null;
    }
}

function saveStored(tokens) {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(
        AUTH_FILE,
        `${JSON.stringify(
            {
                githubAccessToken: tokens.githubAccessToken,
                copilotAccessToken: tokens.copilotAccessToken,
                expiresAt: tokens.expiresAt,
                baseURL: tokens.baseURL,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    try {
        fs.chmodSync(AUTH_FILE, 0o600);
    } catch {
        // 일부 파일시스템에서는 chmod가 실패할 수 있음
    }
}

function getBaseURL(data, token) {
    const endpoint = data?.endpoints?.api;
    if (typeof endpoint === "string" && /^https:\/\//.test(endpoint)) return endpoint.replace(/\/$/, "");

    const proxyEndpoint = token?.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
    if (proxyEndpoint) return `https://${proxyEndpoint.replace(/^proxy\./, "api.")}`;
    return "https://api.individual.githubcopilot.com";
}

async function fetchCopilotToken(githubAccessToken) {
    const res = await fetch(COPILOT_TOKEN_URL, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${githubAccessToken}`,
            ...COPILOT_HEADERS,
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = data.message || data.error || "";
        throw new Error(`GitHub Copilot token refresh failed: ${res.status} ${detail}`.trim());
    }
    if (typeof data.token !== "string" || !data.token) throw new Error("GitHub Copilot token refresh failed: missing token");
    if (!Number.isFinite(Number(data.expires_at))) throw new Error("GitHub Copilot token refresh failed: missing expires_at");
    return {
        githubAccessToken,
        copilotAccessToken: data.token,
        expiresAt: Number(data.expires_at) * 1000,
        baseURL: getBaseURL(data, data.token),
    };
}

export function hasGithubCopilotAuth() {
    return Boolean(loadStored()?.githubAccessToken);
}

export function clearGithubCopilotTokens() {
    try {
        fs.unlinkSync(AUTH_FILE);
    } catch {
        // ignore
    }
}

export async function ensureFreshGithubCopilotToken(stored = loadStored()) {
    if (!stored) throw new Error("No GitHub Copilot OAuth tokens. Use /config → GitHub Copilot to log in.");
    if (stored.copilotAccessToken && stored.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
        return { accessToken: stored.copilotAccessToken, baseURL: stored.baseURL || getBaseURL(null, stored.copilotAccessToken) };
    }
    const refreshed = await fetchCopilotToken(stored.githubAccessToken);
    saveStored(refreshed);
    return { accessToken: refreshed.copilotAccessToken, baseURL: refreshed.baseURL };
}

export async function startGithubCopilotDeviceFlow() {
    const res = await fetch(DEVICE_CODE_URL, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            ...COPILOT_HEADERS,
        },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = data.error_description || data.error || "";
        throw new Error(`GitHub Copilot device flow init failed: ${res.status} ${detail}`.trim());
    }
    if (!data.device_code || !data.user_code || !data.verification_uri) throw new Error("GitHub Copilot device flow init failed: invalid response");
    const intervalMs = Math.max(Number(data.interval) || 5, 1) * 1000;
    const expiresIn = Math.max(Number(data.expires_in) || 900, 60);
    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        intervalMs,
        expiresAt: Date.now() + expiresIn * 1000,
        deviceUrl: data.verification_uri,
    };
}

export async function pollGithubCopilotDeviceFlow({ deviceCode, intervalMs, expiresAt, signal }) {
    let waitMs = intervalMs;
    for (;;) {
        if (signal?.aborted) throw new Error("Login cancelled.");
        if (expiresAt && Date.now() >= expiresAt) throw new Error("Device code expired.");
        await sleep(waitMs, signal);

        const res = await fetch(ACCESS_TOKEN_URL, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                ...COPILOT_HEADERS,
            },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                device_code: deviceCode,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }).toString(),
            signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.access_token) {
            const tokens = await fetchCopilotToken(data.access_token);
            saveStored({ ...tokens, githubAccessToken: data.access_token });
            return tokens;
        }

        const error = String(data.error || "");
        if (error === "authorization_pending" || res.status === 428) continue;
        if (error === "slow_down") {
            waitMs = Math.min(waitMs + 5000, 30_000);
            continue;
        }
        if (error === "access_denied" || error === "authorization_denied") throw new Error("Authorization denied.");
        if (error === "expired_token") throw new Error("Device code expired.");
        const detail = data.error_description || error || res.statusText;
        throw new Error(`GitHub Copilot device auth failed: ${res.status} ${detail}`.trim());
    }
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Login cancelled."));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Login cancelled."));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
