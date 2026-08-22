import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";

const ISSUER = "https://auth.x.ai";
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const AUTH_FILE = path.join(USER_DIR, "grok-auth.json");
const EXPIRY_MARGIN_MS = 5 * 60_000;

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

function expiresAtFromTokens(tokens, fallbackExpiresIn) {
    const access = tokens.access_token || tokens.accessToken;
    const claims = parseJwtClaims(access);
    if (claims?.exp) return claims.exp * 1000;
    const expiresIn = tokens.expires_in || tokens.expiresIn || fallbackExpiresIn;
    if (expiresIn) return Date.now() + Number(expiresIn) * 1000;
    return undefined;
}

function normalizeStored(raw) {
    if (!raw || typeof raw !== "object") return null;
    const tokens = raw.tokens || raw;
    const accessToken = tokens.access_token || tokens.accessToken;
    if (!accessToken) return null;
    return {
        accessToken,
        refreshToken: tokens.refresh_token || tokens.refreshToken || null,
        idToken: tokens.id_token || tokens.idToken || null,
        expiresAt: tokens.expires_at || tokens.expiresAt || expiresAtFromTokens(tokens),
    };
}

function isFresh(stored, now = Date.now()) {
    return Boolean(stored?.accessToken && stored.expiresAt && now < stored.expiresAt - EXPIRY_MARGIN_MS);
}

export function grokAuthFilePath() {
    return AUTH_FILE;
}

export function loadGrokTokens() {
    if (!fs.existsSync(AUTH_FILE)) return null;
    try {
        return normalizeStored(JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")));
    } catch {
        return null;
    }
}

export function saveGrokTokens(tokens) {
    try {
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
        const data = {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            id_token: tokens.idToken,
            expires_at: tokens.expiresAt,
        };
        fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf8");
        try {
            fs.chmodSync(AUTH_FILE, 0o600);
        } catch {
            // 일부 파일시스템에서는 chmod가 실패할 수 있음
        }
    } catch {
        // best-effort
    }
}

export function hasGrokAuth() {
    return Boolean(loadGrokTokens());
}

export function clearGrokTokens() {
    try {
        fs.unlinkSync(AUTH_FILE);
    } catch {
        // ignore
    }
}

function tokenHeaders() {
    return {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
    };
}

export async function refreshGrokToken(refreshToken) {
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: tokenHeaders(),
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
        }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const desc = data.error_description || data.error || "";
        if (res.status === 403) {
            throw new Error(
                "Grok OAuth account is signed in but this request was not allowed. Use /config → Grok to log in again, or try a different model.",
            );
        }
        if (res.status === 400 || res.status === 401) {
            throw new Error("Grok OAuth token expired or was revoked. Use /config → Grok to log in again.");
        }
        throw new Error(`Grok token refresh failed: ${res.status} ${desc}`.trim());
    }
    if (!data.access_token) {
        throw new Error("Grok token refresh failed: missing access_token");
    }
    return {
        accessToken: data.access_token,
        // 회전된 값이 오면 쓰고, 없으면 기존 refresh_token 유지
        refreshToken: data.refresh_token || refreshToken,
        idToken: data.id_token || null,
        expiresAt: expiresAtFromTokens(data, 900),
    };
}

let refreshInFlight = null;

export async function ensureFreshToken(stored, { forceRefresh = false } = {}) {
    if (!stored) throw new Error("No Grok OAuth tokens. Use /config → Grok to log in.");
    if (!forceRefresh && isFresh(stored)) return { accessToken: stored.accessToken };
    if (!stored.refreshToken) {
        if (!forceRefresh && stored.accessToken && (!stored.expiresAt || Date.now() < stored.expiresAt)) {
            return { accessToken: stored.accessToken };
        }
        throw new Error("Grok OAuth token expired and no refresh token available.");
    }
    if (refreshInFlight) {
        try {
            const result = await refreshInFlight;
            if (!forceRefresh) return result;
            const latest = loadGrokTokens();
            if (latest?.accessToken && latest.accessToken !== stored.accessToken) {
                return { accessToken: latest.accessToken };
            }
        } catch (err) {
            if (!forceRefresh) throw err;
        }
    }

    refreshInFlight = (async () => {
        const latest = loadGrokTokens() || stored;
        if (!forceRefresh && isFresh(latest)) return { accessToken: latest.accessToken };
        const refreshToken = latest.refreshToken || stored.refreshToken;
        if (!refreshToken) throw new Error("Grok OAuth token expired and no refresh token available.");
        const refreshed = await refreshGrokToken(refreshToken);
        saveGrokTokens(refreshed);
        return { accessToken: refreshed.accessToken };
    })().finally(() => {
        refreshInFlight = null;
    });
    return refreshInFlight;
}

export async function startGrokDeviceFlow() {
    const res = await fetch(DEVICE_CODE_URL, {
        method: "POST",
        headers: tokenHeaders(),
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Device flow init failed: ${res.status} ${body}`);
    }
    const data = await res.json();
    if (!data.device_code || !data.user_code) {
        throw new Error("Device flow init failed: missing device_code");
    }
    const interval = Math.max(parseInt(data.interval, 10) || 5, 1) * 1000;
    const expiresIn = Math.max(parseInt(data.expires_in, 10) || 900, 60);
    const deviceUrl = data.verification_uri_complete || data.verification_uri || `${ISSUER}/oauth2/device`;
    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        intervalMs: interval,
        expiresAt: Date.now() + expiresIn * 1000,
        deviceUrl,
    };
}

export async function pollGrokDeviceFlow({ deviceCode, intervalMs, expiresAt, signal }) {
    let waitMs = intervalMs;
    for (;;) {
        if (signal?.aborted) throw new Error("Login cancelled.");
        if (expiresAt && Date.now() >= expiresAt) throw new Error("Device code expired.");
        await sleep(waitMs, signal);

        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: tokenHeaders(),
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: CLIENT_ID,
                device_code: deviceCode,
            }).toString(),
            signal,
        });
        const data = await res.json().catch(() => ({}));
        const err = String(data.error || "");

        if (res.ok && data.access_token) {
            if (!data.refresh_token) throw new Error("Token exchange failed: missing refresh_token");
            const tokenState = {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                idToken: data.id_token || null,
                expiresAt: expiresAtFromTokens(data, 900),
            };
            saveGrokTokens(tokenState);
            return tokenState;
        }

        if (err === "authorization_pending") continue;
        if (err === "slow_down") {
            waitMs = Math.min(waitMs + 5000, 30_000);
            continue;
        }
        if (err === "access_denied" || err === "authorization_denied") {
            throw new Error("Authorization denied.");
        }
        if (err === "expired_token") throw new Error("Device code expired.");
        // 일부 서버는 pending을 428로 반환
        if (res.status === 428) continue;

        const desc = data.error_description || err;
        throw new Error(`Device auth failed: ${res.status} ${desc}`.trim());
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
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
}
