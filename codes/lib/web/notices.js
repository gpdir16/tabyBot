// 시스템 알림 기록: 서버가 사용자에게 알린 일(업데이트, 세션 압축 확인, 할 일 기한,
// 예약 작업 결과 등)을 user/notices.json에 남긴다. 화면에 잠깐 떴다 사라지면 놓치기 쉬우므로
// 클라이언트는 읽지 않은 알림을 모달로 띄우고, 지난 알림은 설정의 알림 탭에서 다시 볼 수 있다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "../paths.js";
import { writeJsonAtomic } from "../atomic-file.js";

const NOTICES_PATH = path.join(USER_DIR, "notices.json");
const MAX_NOTICES = 200;
// 알림 종류별로 기록에 남길 필드. 이벤트의 나머지 필드(seq 등 전송용 값)는 버린다.
const KEEP_FIELDS = {
    notice: ["level", "text", "conversationId", "action"],
    todo_due: ["title", "kind", "cron", "every", "at", "timezone", "text", "url"],
};

let cache = null;

function load() {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(NOTICES_PATH, "utf8"));
        cache = Array.isArray(raw?.notices) ? raw.notices : [];
    } catch {
        cache = [];
    }
    return cache;
}

function save() {
    try {
        writeJsonAtomic(NOTICES_PATH, { notices: cache });
    } catch (err) {
        // 기록 실패가 알림 전달(SSE/푸시)을 막아서는 안 된다.
        console.warn("tabyBot: failed to save notices:", err?.message || err);
    }
}

export function isNoticeEvent(event) {
    return Boolean(event && Object.hasOwn(KEEP_FIELDS, event.type));
}

// 알림 이벤트를 기록하고 저장된 항목을 돌려준다.
export function recordNotice(event) {
    const list = load();
    const entry = { id: crypto.randomBytes(8).toString("hex"), type: event.type, createdAt: new Date().toISOString(), read: false };
    for (const key of KEEP_FIELDS[event.type]) {
        // todo_due의 at은 "할 일 시각"이다. 알림이 생긴 시각(createdAt)과 구분해 dueAt으로 둔다.
        if (event[key] !== undefined && event[key] !== null) entry[key === "at" ? "dueAt" : key] = event[key];
    }
    list.push(entry);
    if (list.length > MAX_NOTICES) list.splice(0, list.length - MAX_NOTICES);
    save();
    return entry;
}

// 최신 순.
export function listNotices() {
    const list = load();
    return { notices: [...list].reverse(), unread: list.filter((n) => !n.read).length };
}

// ids가 없으면 전부 읽음 처리. 바뀐 것이 있으면 true.
export function markNoticesRead(ids = null) {
    const only = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    let changed = false;
    for (const n of load()) {
        if (n.read || (only && !only.has(n.id))) continue;
        n.read = true;
        changed = true;
    }
    if (changed) save();
    return changed;
}

export function clearNotices() {
    if (!load().length) return false;
    cache = [];
    save();
    return true;
}
