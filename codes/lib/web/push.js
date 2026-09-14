// 웹 푸시: VAPID 키 관리, 구독 저장, SSE 수신자가 없을 때 백그라운드 알림.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { USER_DIR } from "../paths.js";
import { getConversationMeta } from "./conversations.js";
import { getAgent, getAgentByUuid } from "../agents-store.js";

const DIR = path.join(USER_DIR, "web-push");
const KEYS_FILE = path.join(DIR, "vapid.json");
const SUBS_DIR = path.join(DIR, "subs");

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function loadKeys() {
    try {
        const raw = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
        if (raw?.publicKey && raw?.privateKey) return raw;
    } catch {
        // 없거나 깨졌으면 새로 만든다
    }
    ensureDir(DIR);
    const generated = webpush.generateVAPIDKeys();
    const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    fs.writeFileSync(KEYS_FILE, `${JSON.stringify(keys, null, 2)}\n`);
    return keys;
}

function subPath(endpoint) {
    const hash = crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);
    return path.join(SUBS_DIR, `${hash}.json`);
}

function isValidSub(sub) {
    return Boolean(sub && typeof sub.endpoint === "string" && sub.keys?.p256dh && sub.keys?.auth);
}

export function getVapidPublicKey() {
    return loadKeys().publicKey;
}

export function saveSubscription(sub) {
    if (!isValidSub(sub)) return false;
    ensureDir(SUBS_DIR);
    fs.writeFileSync(subPath(sub.endpoint), `${JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }, null, 2)}\n`);
    return true;
}

export function removeSubscription(sub) {
    const endpoint = typeof sub === "string" ? sub : sub?.endpoint;
    if (!endpoint) return;
    try {
        fs.unlinkSync(subPath(endpoint));
    } catch {
        // 이미 없으면 무시
    }
}

function listSubs() {
    try {
        return fs
            .readdirSync(SUBS_DIR)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(SUBS_DIR, f), "utf8"));
                } catch {
                    return null;
                }
            })
            .filter(isValidSub);
    } catch {
        return [];
    }
}

function eventTitle(event) {
    const id = event.conversationId;
    if (!id) return "tabyBot";
    const meta = getConversationMeta(id);
    const agent = getAgent(meta?.agentId) || getAgentByUuid(id);
    return agent?.name || "tabyBot";
}

function payloadFor(event) {
    if (!event || typeof event !== "object") return null;
    if (event.type === "notice") {
        // 대화 턴이 있는 알림(크론 결과 등)은 turn_done이 담당한다.
        if (event.conversationId) return null;
        return { title: "tabyBot", body: String(event.text || "").slice(0, 180), tag: "notice", url: "/" };
    }
    if (event.type === "ask") {
        return { title: eventTitle(event), body: String(event.question || "").slice(0, 180), tag: `ask-${event.askId || ""}`, url: "/" };
    }
    if (event.type === "turn_done") {
        if (event.stopped || event.silent) return null;
        const body = String(event.text || event.error?.detail || "").trim();
        if (!body) return null;
        return { title: eventTitle(event), body: body.slice(0, 180), tag: `turn-${event.conversationId || ""}`, url: "/" };
    }
    if (event.type === "todo_due") {
        const body = [event.title || event.text || ""]
            .map((s) => String(s).trim())
            .filter(Boolean)
            .join(" — ")
            .slice(0, 180);
        return {
            title: eventTitle(event) || "tabyBot",
            body,
            tag: `todo-${event.url || event.agentId || event.title || ""}`,
            url: event.url || "/",
        };
    }
    return null;
}

export async function maybePush(event, { liveClients = 0 } = {}) {
    // 열린 탭이 있으면 SSE/페이지 알림이 담당한다.
    if (liveClients > 0) return;
    const payload = payloadFor(event);
    if (!payload) return;

    const keys = loadKeys();
    const body = JSON.stringify(payload);
    const opts = {
        vapidDetails: {
            subject: "mailto:tabybot@localhost",
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
        },
        TTL: 60 * 30,
    };

    await Promise.all(
        listSubs().map(async (sub) => {
            try {
                await webpush.sendNotification(sub, body, opts);
            } catch (err) {
                const status = err?.statusCode;
                if (status === 404 || status === 410) removeSubscription(sub);
            }
        }),
    );
}
