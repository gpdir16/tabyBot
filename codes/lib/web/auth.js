// 단일 계정 인증: user/auth.json에 계정(scrypt 해시)과 세션을 영속화한다.
// 세션 토큰은 sha256으로 해시해 저장한다 — 파일이 유출돼도 원본 토큰은 모른다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { writeJsonAtomic } from "../atomic-file.js";

const AUTH_FILE = path.join(USER_DIR, "auth.json");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const SESSION_REFRESH_MS = SESSION_TTL_MS / 2; // 절반 이하로 남으면 롤링 연장
const MAX_SESSIONS = 50;
const USERNAME_MAX = 64;
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 256;

// 로그인 스로틀(인메모리, IP 키별): 실패가 쌓일수록 실패 응답을 지연하고
// 동시 진행 로그인 수를 제한한다. 잠금은 없다 — 성공은 항상 즉시 통과하므로
// 제3자가 부정 시도로 계정 주인의 접속을 막을 수 없다.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_INFLIGHT = 3;
const LOGIN_DELAY_STEP_MS = 2000;
const LOGIN_DELAY_MAX_MS = 30_000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

let store = null;
// key(보통 클라이언트 IP) → { fails: 실패 시각[], inflight: 진행 중 로그인 수 }
const attempts = new Map();

function load() {
    if (store) return store;
    let data = null;
    try {
        data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    } catch {}
    store = {
        account: data?.account && typeof data.account === "object" ? data.account : null,
        sessions: Array.isArray(data?.sessions) ? data.sessions.filter((s) => s && typeof s.id === "string") : [],
    };
    return store;
}

function persist() {
    if (!store) return;
    try {
        writeJsonAtomic(AUTH_FILE, store, { mode: 0o600 });
    } catch (err) {
        console.error("tabyBot: failed to write auth.json:", err?.message || err);
    }
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verifyPassword(password, encoded) {
    const parts = String(encoded || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (!salt.length || !expected.length) return false;
    let actual;
    try {
        actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    } catch {
        return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sessionId(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function hasAccount() {
    return Boolean(load().account);
}

export function accountInfo() {
    const s = load();
    const a = s.account;
    if (!a) return null;
    const now = Date.now();
    return {
        username: a.username,
        createdAt: a.createdAt || null,
        sessions: s.sessions.filter((x) => Date.parse(x.expiresAt || "") > now).length,
    };
}

// password === undefined면 비밀번호 규칙은 건너뛴다(이름만 바꿀 때).
function validate(username, password) {
    if (!username) return "username_required";
    if (username.length > USERNAME_MAX) return "username_too_long";
    if (password !== undefined) {
        const len = String(password).length;
        if (len < PASSWORD_MIN) return "password_too_short";
        if (len > PASSWORD_MAX) return "password_too_long";
    }
    return null;
}

export function createAccount({ username, password } = {}) {
    const s = load();
    if (s.account) return { error: "account_exists" };
    const uname = String(username ?? "").trim();
    const err = validate(uname, password);
    if (err) return { error: err };
    const now = iso(Date.now());
    s.account = { username: uname, password: hashPassword(password), createdAt: now, updatedAt: now };
    persist();
    return { account: accountInfo() };
}

// 현재 비밀번호 확인 후 이름/비밀번호를 갱신한다. 비밀번호를 바꾸면
// 현재 세션(keepToken)만 남기고 나머지를 전부 폐기한다.
export function updateAccount({ currentPassword, username, password, keepToken } = {}) {
    const s = load();
    if (!s.account) return { error: "no_account" };
    if (!verifyPassword(currentPassword, s.account.password)) return { error: "wrong_password" };
    const changing = typeof password === "string" && password.length > 0;
    const uname = username !== undefined ? String(username).trim() : s.account.username;
    const err = validate(uname, changing ? password : undefined);
    if (err) return { error: err };
    s.account.username = uname;
    if (changing) {
        s.account.password = hashPassword(password);
        const keep = keepToken ? sessionId(keepToken) : "";
        s.sessions = s.sessions.filter((x) => x.id === keep);
    }
    s.account.updatedAt = iso(Date.now());
    persist();
    return { account: accountInfo() };
}

function pruneSessions(now) {
    const s = load();
    const before = s.sessions.length;
    s.sessions = s.sessions.filter((x) => {
        const exp = Date.parse(x.expiresAt);
        return Number.isFinite(exp) && exp > now;
    });
    if (s.sessions.length !== before) persist();
}

export function createSession() {
    const now = Date.now();
    pruneSessions(now);
    const token = crypto.randomBytes(32).toString("base64url");
    load().sessions.push({ id: sessionId(token), createdAt: iso(now), expiresAt: iso(now + SESSION_TTL_MS) });
    const s = load().sessions;
    if (s.length > MAX_SESSIONS) s.splice(0, s.length - MAX_SESSIONS);
    persist();
    return { token, expiresAt: iso(now + SESSION_TTL_MS) };
}

export function resolveSession(token) {
    if (!token) return null;
    const id = sessionId(token);
    const sess = load().sessions.find((x) => x.id === id);
    if (!sess) return null;
    const now = Date.now();
    const exp = Date.parse(sess.expiresAt);
    if (!Number.isFinite(exp) || exp <= now) {
        pruneSessions(now);
        return null;
    }
    if (exp - now < SESSION_REFRESH_MS) {
        sess.expiresAt = iso(now + SESSION_TTL_MS);
        persist();
    }
    return sess;
}

export function revokeSession(token) {
    if (!token) return;
    const s = load();
    const id = sessionId(token);
    const before = s.sessions.length;
    s.sessions = s.sessions.filter((x) => x.id !== id);
    if (s.sessions.length !== before) persist();
}

const ATTEMPTS_MAX_KEYS = 10_000;

function attemptEntry(key) {
    let a = attempts.get(key);
    if (a) return a;
    // 많은 출발지가 한 번씩만 건드려도 Map이 영원히 커지지 않게
    // 새 키를 만들 때 상한을 넘으면 유휴 항목을 쓸어낸다.
    if (attempts.size >= ATTEMPTS_MAX_KEYS) {
        const cutoff = Date.now() - LOGIN_WINDOW_MS;
        for (const [k, v] of attempts) {
            if (!v.inflight && v.fails.every((t) => t <= cutoff)) attempts.delete(k);
        }
    }
    a = { fails: [], inflight: 0 };
    attempts.set(key, a);
    return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login({ key = "", username, password } = {}) {
    const k = key || "unknown";
    const a = attemptEntry(k);
    const now = Date.now();
    while (a.fails.length && a.fails[0] <= now - LOGIN_WINDOW_MS) a.fails.shift();
    // 같은 출발지가 슬롯을 독점하지 못하게 한다 — 지연 중에도 슬롯을 잡으므로
    // 이 상한이 브루트포스의 실질 처리량을 정한다.
    if (a.inflight >= LOGIN_MAX_INFLIGHT) return { error: "too_many_attempts", retryAfter: 10 };
    a.inflight++;
    try {
        const account = load().account;
        const uname = String(username ?? "").trim();
        const ok = account && uname === account.username && verifyPassword(password, account.password);
        if (!ok) {
            a.fails.push(Date.now());
            await sleep(Math.min(a.fails.length * LOGIN_DELAY_STEP_MS, LOGIN_DELAY_MAX_MS));
            return { error: "invalid_credentials" };
        }
        a.fails.length = 0;
        return { account: accountInfo(), session: createSession() };
    } finally {
        a.inflight--;
        if (!a.inflight && !a.fails.length) attempts.delete(k);
    }
}
