import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_FILE = path.join(USER_DIR, "codex-auth.json");

function parseJwtClaims(token) {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        return null;
    }
}

function extractAccountId(tokens) {
    const fromIdToken = tokens.id_token ? parseJwtClaims(tokens.id_token) : null;
    if (fromIdToken) {
        const id =
            fromIdToken.chatgpt_account_id || fromIdToken["https://api.openai.com/auth"]?.chatgpt_account_id || fromIdToken.organizations?.[0]?.id;
        if (id) return id;
    }
    const fromAccess = tokens.access_token ? parseJwtClaims(tokens.access_token) : null;
    if (fromAccess) {
        return fromAccess.chatgpt_account_id || fromAccess["https://api.openai.com/auth"]?.chatgpt_account_id || fromAccess.organizations?.[0]?.id;
    }
    return null;
}

export function codexAuthFilePath() {
    return AUTH_FILE;
}

export function loadCodexTokens() {
    if (!fs.existsSync(AUTH_FILE)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
        const tokens = raw.tokens || raw;
        const accessToken = tokens.access_token || tokens.accessToken;
        if (!accessToken) return null;
        const accountId = tokens.account_id || tokens.accountId || extractAccountId(tokens);
        const expiresIn = tokens.expires_in || tokens.expiresIn;
        const expiresAt = tokens.expires_at || tokens.expiresAt || (expiresIn ? Date.now() + expiresIn * 1000 : undefined);
        return {
            accessToken,
            refreshToken: tokens.refresh_token || tokens.refreshToken || null,
            idToken: tokens.id_token || tokens.idToken || null,
            accountId,
            expiresAt,
        };
    } catch {
        return null;
    }
}

export function saveCodexTokens(tokens) {
    try {
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
        const data = {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            id_token: tokens.idToken,
            expires_at: tokens.expiresAt,
        };
        if (tokens.accountId) data.account_id = tokens.accountId;
        fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch {
        // best-effort
    }
}

export function hasCodexAuth() {
    return Boolean(loadCodexTokens());
}

export function clearCodexTokens() {
    try {
        fs.unlinkSync(AUTH_FILE);
    } catch {
        // ignore
    }
}

export async function refreshCodexToken(refreshToken) {
    const res = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }).toString(),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Codex token refresh failed: ${res.status} ${body}`);
    }
    const data = await res.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        idToken: data.id_token || null,
        accountId: extractAccountId(data),
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
}

export async function ensureFreshToken(stored) {
    if (!stored) throw new Error("No Codex OAuth tokens. Use /config → Codex to log in with your ChatGPT account.");
    const now = Date.now();
    const margin = 60_000;
    if (stored.expiresAt && now < stored.expiresAt - margin && stored.accessToken) {
        return { accessToken: stored.accessToken, accountId: stored.accountId };
    }
    if (!stored.refreshToken) {
        if (stored.accessToken) return { accessToken: stored.accessToken, accountId: stored.accountId };
        throw new Error("Codex OAuth token expired and no refresh token available.");
    }
    const refreshed = await refreshCodexToken(stored.refreshToken);
    const accountId = refreshed.accountId || stored.accountId;
    saveCodexTokens({ ...refreshed, accountId });
    return { accessToken: refreshed.accessToken, accountId };
}

// --- Device flow OAuth (self-contained, no codex CLI needed) ---

export async function startDeviceFlow() {
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Device flow init failed: ${res.status} ${body}`);
    }
    const data = await res.json();
    const interval = Math.max(parseInt(data.interval, 10) || 5, 1) * 1000;
    return { deviceAuthId: data.device_auth_id, userCode: data.user_code, intervalMs: interval, deviceUrl: `${ISSUER}/codex/device` };
}

export async function pollDeviceFlow({ deviceAuthId, userCode, intervalMs, signal }) {
    const safetyMargin = 3000;
    for (;;) {
        if (signal?.aborted) throw new Error("Login cancelled.");
        await sleep(intervalMs + safetyMargin, signal);

        const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
            signal,
        });

        if (res.ok) {
            const data = await res.json();
            const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code: data.authorization_code,
                    redirect_uri: `${ISSUER}/deviceauth/callback`,
                    client_id: CLIENT_ID,
                    code_verifier: data.code_verifier,
                }).toString(),
            });
            if (!tokenRes.ok) {
                const body = await tokenRes.text().catch(() => "");
                throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
            }
            const tokens = await tokenRes.json();
            const accountId = extractAccountId(tokens);
            const tokenState = {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token || null,
                idToken: tokens.id_token || null,
                accountId,
                expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
            };
            saveCodexTokens(tokenState);
            return tokenState;
        }

        if (res.status !== 403 && res.status !== 404) {
            const body = await res.text().catch(() => "");
            throw new Error(`Device auth failed: ${res.status} ${body}`);
        }
    }
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal)
            signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("Login cancelled."));
            });
    });
}
