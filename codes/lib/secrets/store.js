// 시크릿 금고: 비밀번호·API 키·토큰을 모델에 보여 주지 않고 도구 실행 때만 쓰게 한다.
// 값은 AES-256-GCM으로 암호화해 USER_DIR/secrets.json에 두고, 키는 .secret-key(0600)에 따로 둔다.
// 시크릿은 UUID로 식별하고, 사용자가 붙인 이름은 표시용이다. 이름과 id만 모델에 노출되고 값은 API로도 내려주지 않는다(쓰기 전용).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "../atomic-file.js";

export const SECRETS_FILE = path.join(USER_DIR, "secrets.json");
export const SECRET_KEY_FILE = path.join(USER_DIR, ".secret-key");

export const SECRET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SECRET_LENGTH = 8192;
const MAX_NAME_LENGTH = 60;

export class SecretError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

let keyCache = null;

function loadKey() {
    if (keyCache) return keyCache;
    try {
        const hex = fs.readFileSync(SECRET_KEY_FILE, "utf8").trim();
        if (/^[0-9a-f]{64}$/.test(hex)) {
            keyCache = Buffer.from(hex, "hex");
            return keyCache;
        }
    } catch {
        // 키 파일이 아직 없으면 아래에서 새로 만든다
    }
    const key = crypto.randomBytes(32);
    writeFileAtomic(SECRET_KEY_FILE, `${key.toString("hex")}\n`, { mode: 0o600 });
    keyCache = key;
    return key;
}

function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(entry) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
}

function readStore() {
    const raw = readJsonFile(SECRETS_FILE, null, { label: "secrets.json" });
    const secrets = raw && typeof raw.secrets === "object" && raw.secrets && !Array.isArray(raw.secrets) ? raw.secrets : {};
    return { version: 2, secrets };
}

function writeStore(store) {
    writeJsonAtomic(SECRETS_FILE, store, { mode: 0o600 });
    valuesCache = null;
}

function normalizeName(value) {
    const name = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (!name || name.length > MAX_NAME_LENGTH) throw new SecretError("invalid_name");
    return name;
}

function validateValue(value) {
    if (typeof value !== "string" || value.includes("\0")) throw new SecretError("invalid_value");
    if (value.length === 0) throw new SecretError("invalid_value");
    if (value.length > MAX_SECRET_LENGTH) throw new SecretError("value_too_long");
}

// 이름은 모델이 구분하는 단서이므로 대소문자 무시로 겹치지 않게 한다.
function assertNameFree(store, name, exceptId) {
    const key = name.toLowerCase();
    for (const [id, e] of Object.entries(store.secrets)) {
        if (id !== exceptId && String(e?.name || "").toLowerCase() === key) throw new SecretError("name_exists");
    }
}

// id와 이름만 돌려준다. 값은 절대 포함하지 않는다.
export function listSecrets() {
    return Object.entries(readStore().secrets)
        .map(([id, e]) => ({ id, name: e?.name || "", updatedAt: e?.updatedAt || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function findSecretIdByName(name) {
    const key = String(name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    return listSecrets().find((s) => s.name.toLowerCase() === key)?.id || null;
}

// 새 시크릿을 만든다(id 생성). 만든 id를 돌려준다.
export function createSecret({ name, value }) {
    const store = readStore();
    const cleanName = normalizeName(name);
    validateValue(value);
    assertNameFree(store, cleanName, null);
    const id = crypto.randomUUID();
    store.secrets[id] = { name: cleanName, ...encrypt(value), updatedAt: new Date().toISOString() };
    writeStore(store);
    return id;
}

// name/value 중 넘긴 것만 바꾼다. 값을 안 넘기면 기존 값을 유지한다.
export function updateSecret(id, { name, value }) {
    const store = readStore();
    const prev = store.secrets[id];
    if (!prev) throw new SecretError("not_found");
    const next = { ...prev, updatedAt: new Date().toISOString() };
    if (name !== undefined) {
        next.name = normalizeName(name);
        assertNameFree(store, next.name, id);
    }
    if (value !== undefined) {
        validateValue(value);
        Object.assign(next, encrypt(value));
    }
    store.secrets[id] = next;
    writeStore(store);
}

export function deleteSecret(id) {
    const store = readStore();
    if (!Object.hasOwn(store.secrets, id)) return false;
    delete store.secrets[id];
    writeStore(store);
    return true;
}

let valuesCache = null;

// 복호화된 [{id, name, value}]. 도구 실행·마스킹에서만 쓰며 프로세스 밖으로 내보내지 않는다.
export function getSecretValues() {
    if (valuesCache) return valuesCache;
    const out = [];
    for (const [id, e] of Object.entries(readStore().secrets)) {
        try {
            const value = decrypt(e);
            if (value) out.push({ id, name: e.name || "", value });
        } catch (err) {
            console.error(`tabyBot: cannot decrypt secret ${id}:`, err?.message || err);
        }
    }
    valuesCache = out;
    return out;
}

// 모델이 금고 파일을 직접 읽거나 고치지 못하게 막을 때 쓰는 경로 판별.
export function isSecretStorePath(resolvedPath) {
    if (!resolvedPath) return false;
    const p = path.resolve(resolvedPath);
    return p === SECRETS_FILE || p === SECRET_KEY_FILE || p.startsWith(`${SECRETS_FILE}.tmp-`) || p.startsWith(`${SECRET_KEY_FILE}.tmp-`);
}

// 셸 명령 문자열이 금고 파일을 언급하는지 본다(우회가 쉬운 보조 방어선이다).
export function commandTouchesSecretStore(command) {
    const text = String(command || "");
    return text.includes(SECRETS_FILE) || text.includes(SECRET_KEY_FILE) || /secrets\.json|\.secret-key/.test(text);
}
