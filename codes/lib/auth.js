import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "./paths.js";
import { loadAgentConfig } from "./config-loader.js";

const APPROVED_PATH = path.join(USER_DIR, "approved.json");

function emptyApprovedFile() {
    return { approved: { chatId: null }, pending: {} };
}

function readApprovedFile() {
    if (!fs.existsSync(APPROVED_PATH)) {
        return emptyApprovedFile();
    }
    try {
        return JSON.parse(fs.readFileSync(APPROVED_PATH, "utf8"));
    } catch (err) {
        console.error(`tabyAgent: invalid JSON in ${APPROVED_PATH}:`, err.message);
        return emptyApprovedFile();
    }
}

function writeApprovedFile(data) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(APPROVED_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function pruneExpired(data) {
    const now = Date.now();
    for (const [code, entry] of Object.entries(data.pending || {})) {
        if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) {
            delete data.pending[code];
        }
    }
    return data;
}

function loadApprovedState() {
    const data = readApprovedFile();
    const pendingBefore = Object.keys(data.pending || {}).length;
    const pruned = pruneExpired(data);
    if (Object.keys(pruned.pending || {}).length !== pendingBefore) {
        writeApprovedFile(pruned);
    }
    return pruned;
}

export function getOwnerChatId() {
    const chatId = loadApprovedState().approved?.chatId;
    return chatId ? String(chatId) : null;
}

export function hasOwner() {
    return getOwnerChatId() !== null;
}

export function isApproved(chatId) {
    const owner = getOwnerChatId();
    return owner !== null && owner === String(chatId);
}

export function claimOwnerIfNone(chatId) {
    const data = loadApprovedState();
    const id = String(chatId);
    const existing = data.approved?.chatId;

    if (existing) {
        if (String(existing) === id) {
            return { ok: true, chatId: id, alreadyOwner: true };
        }
        return { ok: false, reason: "owner_exists", ownerChatId: String(existing) };
    }

    data.approved = { chatId: id };
    writeApprovedFile(data);
    return { ok: true, chatId: id, alreadyOwner: false };
}

export function setOwner(chatId) {
    const data = loadApprovedState();
    const id = String(chatId);
    const previous = data.approved?.chatId;
    const previousOwner = previous && String(previous) !== id ? String(previous) : null;
    data.approved = { chatId: id };
    writeApprovedFile(data);
    return { ok: true, chatId: id, previousOwner };
}

export function issuePendingCode(chatId) {
    const data = loadApprovedState();
    const agent = loadAgentConfig();
    const ttlMin = agent.authCodeTtlMinutes ?? 15;

    for (const [code, entry] of Object.entries(data.pending || {})) {
        if (String(entry.chatId) === String(chatId)) {
            return { code, expiresAt: entry.expiresAt, minutes: ttlMin };
        }
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();
    data.pending = data.pending || {};
    data.pending[code] = { chatId: String(chatId), expiresAt };
    writeApprovedFile(data);
    return { code, expiresAt, minutes: ttlMin };
}

export function approveCode(code) {
    const normalized = String(code || "").trim();
    const data = loadApprovedState();
    const entry = data.pending?.[normalized];
    if (!entry) return { ok: false, reason: "invalid_or_expired" };
    if (new Date(entry.expiresAt).getTime() < Date.now()) {
        delete data.pending[normalized];
        writeApprovedFile(data);
        return { ok: false, reason: "invalid_or_expired" };
    }

    const chatId = String(entry.chatId);
    delete data.pending[normalized];
    writeApprovedFile(data);

    const { previousOwner } = setOwner(chatId);
    return { ok: true, chatId, previousOwner };
}
