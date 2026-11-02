// 웹 푸시: VAPID 키 관리, 구독 저장, 앱을 보고 있지 않은 기기로 백그라운드 알림.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { writeJsonAtomic } from "../atomic-file.js";
import { getConversationMeta } from "./conversations.js";
import { getAgent, getAgentByUuid } from "../agents-store.js";
import { getGroup } from "../groups-store.js";

const DIR = path.join(USER_DIR, "web-push");
const KEYS_FILE = path.join(DIR, "vapid.json");
const SUBS_DIR = path.join(DIR, "subs");

// 앱을 화면에 띄워 둔 기기(구독 endpoint)에는 푸시를 보내지 않는다. 그 기기는 SSE와 화면 토스트로 받는다.
// 거르는 일은 여기(서버)서 해야 한다. 서비스 워커가 푸시를 받고 알림을 띄우지 않으면
// iOS/Safari는 userVisibleOnly 약속 위반으로 보고 세 번 만에 구독을 끊는다.
// 클라이언트는 화면에 있는 동안 주기적으로 알린다. 숨김 알림이 유실돼도 FOREGROUND_TTL_MS 뒤에는 다시 푸시를 보낸다.
const FOREGROUND_TTL_MS = 45_000;
// endpoint -> (탭 id -> 만료 시각). 같은 기기에서 탭 여러 개가 같은 구독을 쓴다.
const foreground = new Map();

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

// web-push generateVAPIDKeys와 같은 형식(P-256 공개 키 65바이트, 개인 키 32바이트, base64url)으로 만든다.
// 키를 만들 때까지 web-push를 불러오지 않으려고 직접 만든다.
function generateVapidKeys() {
    const curve = crypto.createECDH("prime256v1");
    curve.generateKeys();
    const pad = (buf, size) => (buf.length < size ? Buffer.concat([Buffer.alloc(size - buf.length), buf]) : buf);
    return { publicKey: pad(curve.getPublicKey(), 65).toString("base64url"), privateKey: pad(curve.getPrivateKey(), 32).toString("base64url") };
}

// web-push는 의존성이 많아 불러오는 데 시간이 걸린다. 실제로 보낼 때 불러온다.
let webpush;

function loadKeys() {
    try {
        const raw = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
        if (raw?.publicKey && raw?.privateKey) return raw;
    } catch {
        // 없거나 깨졌으면 새로 만든다
    }
    ensureDir(DIR);
    const keys = generateVapidKeys();
    writeJsonAtomic(KEYS_FILE, keys, { mode: 0o600 });
    return keys;
}

function subPath(endpoint) {
    const hash = crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);
    return path.join(SUBS_DIR, `${hash}.json`);
}

// 로그에는 endpoint 원문(비밀) 대신 파일 이름과 같은 해시 앞부분만 쓴다.
function subLabel(endpoint) {
    return crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 8);
}

function subFiles() {
    try {
        return fs.readdirSync(SUBS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
        return []; // 구독이 하나도 없음
    }
}

function isValidSub(sub) {
    return Boolean(sub && typeof sub.endpoint === "string" && sub.keys?.p256dh && sub.keys?.auth);
}

export function getVapidPublicKey() {
    return loadKeys().publicKey;
}

// 기기 하나에는 구독 하나만 남긴다. 다시 구독하면 예전 구독은 죽은 채로 쌓이기만 한다
// (iOS는 알림을 못 띄운 푸시가 쌓이면 구독을 끊고, 다시 구독할 때마다 새 endpoint가 생긴다).
export function saveSubscription(sub) {
    if (!isValidSub(sub)) return false;
    ensureDir(SUBS_DIR);
    const deviceId = typeof sub.deviceId === "string" ? sub.deviceId.slice(0, 64) : "";
    const file = subPath(sub.endpoint);
    writeJsonAtomic(file, { endpoint: sub.endpoint, keys: sub.keys, ...(deviceId ? { deviceId } : {}) });
    console.log(`[push] subscribe ${subLabel(sub.endpoint)}${deviceId ? ` device=${deviceId.slice(0, 8)}` : ""}`);
    if (deviceId) dropOtherSubs(deviceId, file);
    return true;
}

// 같은 기기의 예전 구독 파일을 지운다.
function dropOtherSubs(deviceId, keepFile) {
    for (const name of subFiles()) {
        const file = path.join(SUBS_DIR, name);
        if (file === keepFile) continue;
        try {
            if (JSON.parse(fs.readFileSync(file, "utf8"))?.deviceId !== deviceId) continue;
        } catch {
            continue; // 깨진 파일은 건드리지 않는다
        }
        try {
            fs.unlinkSync(file);
            console.log(`[push] dropped stale ${name.slice(0, 8)} device=${deviceId.slice(0, 8)}`);
        } catch {
            // 이미 없으면 무시
        }
    }
}

// 모든 기기의 알림 구독을 지운다. 다시 로그인한 기기는 알림이 켜져 있으면 다시 구독한다.
export function removeAllSubscriptions() {
    for (const name of subFiles()) {
        try {
            fs.unlinkSync(path.join(SUBS_DIR, name));
        } catch {
            // 이미 없으면 무시
        }
    }
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

export function setForeground(endpoint, clientId, visible) {
    if (typeof endpoint !== "string" || !endpoint || typeof clientId !== "string" || !clientId) return false;
    let tabs = foreground.get(endpoint);
    const was = Boolean(tabs?.size);
    if (visible) {
        if (!tabs) {
            tabs = new Map();
            foreground.set(endpoint, tabs);
        }
        tabs.set(clientId, Date.now() + FOREGROUND_TTL_MS);
    } else if (tabs) {
        tabs.delete(clientId);
        if (!tabs.size) foreground.delete(endpoint);
    }
    const is = Boolean(foreground.get(endpoint)?.size);
    if (was !== is) console.log(`[push] ${subLabel(endpoint)} ${is ? "foreground on" : "foreground off"}`);
    return true;
}

function isForeground(endpoint) {
    const tabs = foreground.get(endpoint);
    if (!tabs) return false;
    const now = Date.now();
    for (const [id, until] of tabs) if (until <= now) tabs.delete(id);
    if (!tabs.size) foreground.delete(endpoint);
    return tabs.size > 0;
}

// 오래된 구독 파일을 정리한다. 앱을 다시 열면 스스로 다시 구독하므로 지워도 복구된다.
// 기기 id가 없는 옛 구독은 다시 구독한 기기가 남긴 것일 가능성이 커서 더 짧게 본다.
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_STALE_MS = 24 * 60 * 60 * 1000;

export function pruneStaleSubs() {
    const now = Date.now();
    for (const name of subFiles()) {
        const file = path.join(SUBS_DIR, name);
        let legacy;
        let age;
        try {
            legacy = !JSON.parse(fs.readFileSync(file, "utf8"))?.deviceId;
            age = now - fs.statSync(file).mtimeMs;
        } catch {
            continue; // 읽을 수 없는 파일은 건드리지 않는다
        }
        if (age < (legacy ? LEGACY_STALE_MS : STALE_MS)) continue;
        try {
            fs.unlinkSync(file);
            console.log(`[push] pruned ${name.slice(0, 8)} age=${Math.round(age / 3600000)}h${legacy ? " legacy" : ""}`);
        } catch {
            // 이미 없으면 무시
        }
    }
}

function listSubs() {
    return subFiles()
        .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(SUBS_DIR, f), "utf8"));
            } catch {
                return null;
            }
        })
        .filter(isValidSub);
}

function eventTitle(event) {
    const id = event.conversationId;
    if (!id) return "tabyBot";
    // 그룹 방: 말한 에이전트와 방 이름을 함께 쓴다.
    const group = getGroup(id);
    if (group) {
        const speaker = getAgentByUuid(event.speaker)?.name;
        return speaker ? `${speaker} (${group.name})` : group.name;
    }
    const meta = getConversationMeta(id);
    const agent = getAgent(meta?.agentId) || getAgentByUuid(id);
    return agent?.name || "tabyBot";
}

function convUrl(id) {
    return id ? `/a/${id}` : "/";
}

function payloadFor(event) {
    if (!event || typeof event !== "object") return null;
    if (event.type === "notice") {
        // 대화 턴이 있는 알림(크론 결과 등)은 turn_done이 담당한다.
        if (event.conversationId) return null;
        return { title: "tabyBot", body: String(event.text || "").slice(0, 180), tag: "notice", url: "/" };
    }
    if (event.type === "ask") {
        return {
            title: eventTitle(event),
            body: String(event.question || "").slice(0, 180),
            tag: `ask-${event.askId || ""}`,
            url: convUrl(event.conversationId),
        };
    }
    if (event.type === "say") {
        // 작업 중 명시 발화(user_say): 최종 답변과 같은 태그로 묶어 알림을 합친다.
        const body = String(event.text || "").trim();
        if (!body || !event.conversationId) return null;
        return { title: eventTitle(event), body: body.slice(0, 180), tag: `turn-${event.conversationId}`, url: convUrl(event.conversationId) };
    }
    if (event.type === "turn_done") {
        if (event.stopped || event.silent) return null;
        const body = String(event.text || event.error?.detail || "").trim();
        if (!body) return null;
        return {
            title: eventTitle(event),
            body: body.slice(0, 180),
            tag: `turn-${event.conversationId || ""}`,
            url: convUrl(event.conversationId),
        };
    }
    if (event.type === "todo_due") {
        const body = [event.title || event.text || ""]
            .map((s) => String(s).trim())
            .filter(Boolean)
            .join(", ")
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

// 설정 화면의 "테스트 알림". 이 기기 구독 하나로만 보내고 태그를 돌려준다.
// 알림이 실제로 떴는지는 화면이 그 태그를 알림 목록에서 확인한다(서비스 워커 버전과 무관하게 확인된다).
export async function sendTest(endpoint) {
    const sub = listSubs().find((s) => s.endpoint === endpoint);
    if (!sub) {
        console.log(`[push] test missing ${subLabel(endpoint)}`);
        return { sent: false, status: 0, tag: "", reason: "no_subscription" };
    }
    const tag = `push-test-${crypto.randomBytes(4).toString("hex")}`;
    const keys = loadKeys();
    webpush ??= (await import("web-push")).default;
    try {
        const res = await webpush.sendNotification(sub, JSON.stringify({ title: "tabyBot", body: "테스트 알림", tag, url: "/" }), {
            vapidDetails: { subject: "https://github.com/gpdir16/tabyBot", publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: 60,
        });
        const status = res?.statusCode || 0;
        console.log(`[push] test ${subLabel(sub.endpoint)} status=${status}`);
        return { sent: true, status, tag, reason: "" };
    } catch (err) {
        const status = err?.statusCode || 0;
        if (status === 404 || status === 410 || status === 401 || status === 403) removeSubscription(sub);
        console.log(`[push] test failed ${subLabel(sub.endpoint)} status=${status || "?"} ${err?.message || err}`);
        return { sent: false, status, tag: "", reason: String(err?.message || err).slice(0, 120) };
    }
}

export async function maybePush(event) {
    const payload = payloadFor(event);
    if (!payload) return;

    const all = listSubs();
    const subs = all.filter((sub) => !isForeground(sub.endpoint));
    if (!subs.length) return;
    const keys = loadKeys();
    webpush ??= (await import("web-push")).default;
    const body = JSON.stringify(payload);
    const opts = {
        vapidDetails: {
            subject: "https://github.com/gpdir16/tabyBot",
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
        },
        TTL: 60 * 30,
    };

    const results = await Promise.all(
        subs.map(async (sub) => {
            try {
                await webpush.sendNotification(sub, body, opts);
                return true;
            } catch (err) {
                const status = err?.statusCode;
                if (status === 404 || status === 410 || status === 401 || status === 403) {
                    removeSubscription(sub);
                    console.log(`[push] dropped ${subLabel(sub.endpoint)} status=${status}`);
                } else {
                    console.warn("[push] send failed:", status || "", err?.message || err);
                }
                return false;
            }
        }),
    );
    const sent = results.filter(Boolean).length;
    const skipped = all.length - subs.length;
    console.log(`[push] ${payload.tag}: sent ${sent}/${subs.length}${skipped ? ` (foreground ${skipped})` : ""}`);
}
