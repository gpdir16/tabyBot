// 할 일의 일정(1회/크론/주기) 해석과 다음 실행 시각 계산.
import { computeNextRun, defaultTimeZone, describeSchedule, isValidTimeZone, parseAt, parseCron, parseEvery } from "../../scheduling/time.js";

function scheduleShape(item) {
    return {
        kind: item.kind || "none",
        cron: item.cron || "",
        every: item.every || "",
        at: item.at || "",
        timezone: item.timezone || defaultTimeZone(),
    };
}

export function describeTodoWhen(item) {
    if (!item || item.kind === "none" || !item.kind) return "";
    const tz = item.timezone || defaultTimeZone();
    if (item.kind === "cron") {
        const m = /^(\d+) (\d+) \* \* \*$/.exec(String(item.cron || ""));
        if (m && Number(m[1]) <= 59 && Number(m[2]) <= 23) {
            const hh = String(m[2]).padStart(2, "0");
            const mm = String(m[1]).padStart(2, "0");
            return `every day ${hh}:${mm} (${tz})`;
        }
    }
    return describeSchedule(scheduleShape(item));
}

export function isPeriodDone(item) {
    if (item?.status !== "open") return item?.status === "done";
    if (item.kind === "none" || !item.kind) return false;
    if (!item.lastDoneAt) return false;
    const done = Date.parse(item.lastDoneAt);
    const next = Date.parse(item.nextRunAt || "");
    const notified = Math.max(Date.parse(item.lastNotifiedAt || "") || 0, Date.parse(item.lastRunAt || "") || 0);
    if (!Number.isFinite(done)) return false;
    if (Number.isFinite(next) && next <= Date.now()) return false;
    if (Number.isFinite(notified) && done < notified) return false;
    return Number.isFinite(next) ? done < next : false;
}

const NO_SCHEDULE_ERROR = "Provide exactly one of cron, every, or at.";

// 입력과 기존 값에서 크론/주기/일회 값을 읽는다. 일정을 명시하지 않았으면 기존 종류의 값을 이어받는다.
function readScheduleValues(input, fallback) {
    const clear = input.kind === "none" || input.clearWhen === true;
    const explicit = input.cron != null || input.every != null || input.at != null || clear;
    const pick = (key, kind) => {
        if (input[key] != null) return String(input[key]).trim();
        return !explicit && fallback.kind === kind ? fallback[key] || "" : "";
    };
    return { clear, cron: pick("cron", "cron"), every: pick("every", "every"), at: pick("at", "at") };
}

// 일정 값이 하나도 없을 때: 일정 해제로 보거나, 잘못된 입력이면 오류.
function resolveWithoutSchedule(input, { clear, timezone, mode }) {
    if (input.kind && input.kind !== "none" && !clear) return { error: `kind "${input.kind}" needs a matching schedule value` };
    const blankOnly = ["cron", "every", "at"].some((k) => input[k] != null && !String(input[k]).trim());
    if (blankOnly && !clear && mode !== "create") return { error: NO_SCHEDULE_ERROR };
    return { kind: "none", cron: "", every: "", at: "", timezone, nextRunAt: null };
}

function resolveCronWhen(cron, timezone) {
    if (!parseCron(cron)) return { error: `invalid cron expression: ${cron}` };
    const next = computeNextRun({ kind: "cron", cron, timezone }, new Date());
    if (!next) return { error: `cron never fires: ${cron}` };
    return { kind: "cron", cron, every: "", at: "", timezone, nextRunAt: next.toISOString() };
}

function resolveEveryWhen(every, timezone, fallback, mode) {
    const parsed = parseEvery(every);
    if (parsed.error) return { error: parsed.error };
    // 주기가 그대로면 이미 잡힌 다음 실행 시각을 유지한다(수정할 때마다 시계가 다시 시작되지 않게).
    const unchanged = (mode === "update" || mode === "reopen" || mode === "apply") && fallback.kind === "every" && fallback.every === parsed.label;
    if (unchanged && fallback.nextRunAt) {
        return { kind: "every", cron: "", every: parsed.label, at: "", timezone, nextRunAt: fallback.nextRunAt };
    }
    const next = computeNextRun({ kind: "every", every: parsed.label, timezone }, new Date());
    if (next && !Number.isFinite(next.getTime())) return { error: "interval too large" };
    return { kind: "every", cron: "", every: parsed.label, at: "", timezone, nextRunAt: next?.toISOString() || null };
}

// 이미 지난 시각의 일회 일정에 다음 실행 시각을 정한다. 호출 맥락(mode)마다 처리가 다르다.
function nextRunForPastAt({ at, parsed, input, fallback, mode, sameTz }) {
    const newTime = input.at != null && at !== String(fallback.at || "");
    if (newTime) {
        if (mode === "update") return { error: "at must be in the future" };
        return { next: mode === "reopen" ? null : new Date(Date.now() + 1000) };
    }
    const fired = !!(fallback.lastNotifiedAt || fallback.lastRunAt || fallback.consumedSlot || fallback.running);
    if (fired) return { next: null };
    if (mode === "apply") return { next: new Date(Date.now() + 1000) };
    if (mode === "update") {
        const kept = sameTz ? fallback.nextRunAt : null;
        return { next: kept ? new Date(kept) : parsed.date || null };
    }
    return { next: null };
}

function resolveAtWhen(at, timezone, input, fallback, mode) {
    const parsed = parseAt(at, timezone);
    if (parsed.error) return { error: parsed.error };
    const sameTz = timezone === (fallback.timezone || defaultTimeZone());
    if (mode === "update" && input.at != null && fallback.kind === "at" && at === String(fallback.at || "") && sameTz) {
        return { kind: "at", cron: "", every: "", at, timezone, nextRunAt: fallback.nextRunAt || null };
    }
    let next = computeNextRun({ kind: "at", at, timezone }, new Date());
    if (!next) {
        const past = nextRunForPastAt({ at, parsed, input, fallback, mode, sameTz });
        if (past.error) return { error: past.error };
        next = past.next;
    }
    return { kind: "at", cron: "", every: "", at, timezone, nextRunAt: next?.toISOString() || null };
}

// 입력(input)과 기존 값(fallback)을 합쳐 확정된 일정({kind, cron, every, at, timezone, nextRunAt})을 만든다.
// mode: create | update | reopen | apply. 오류면 { error }.
export function resolveWhen(input = {}, fallback = {}, mode = "create") {
    const timezone = String(input.timezone || fallback.timezone || defaultTimeZone()).trim() || defaultTimeZone();
    if (!isValidTimeZone(timezone)) return { error: `invalid timezone: ${timezone}` };

    const { clear, cron, every, at } = readScheduleValues(input, fallback);
    const present = [cron && "cron", every && "every", at && "at"].filter(Boolean);

    if (!present.length) return resolveWithoutSchedule(input, { clear, timezone, mode });
    if (present.length !== 1) return { error: NO_SCHEDULE_ERROR };

    const kind = present[0];
    if (input.kind && input.kind !== kind) return { error: `kind "${input.kind}" does not match the provided schedule` };
    if (kind === "cron") return resolveCronWhen(cron, timezone);
    if (kind === "every") return resolveEveryWhen(every, timezone, fallback, mode);
    return resolveAtWhen(at, timezone, input, fallback, mode);
}

export function applyWhen(item, when) {
    const slotChanged = item.nextRunAt !== when.nextRunAt;
    item.kind = when.kind;
    item.cron = when.cron;
    item.every = when.every;
    item.at = when.at;
    item.timezone = when.timezone;
    item.nextRunAt = when.nextRunAt;
    if (slotChanged) item.consumedSlot = null;
}

export function bumpNextRun(item, from = new Date()) {
    if (item.kind === "at" || item.kind === "none" || !item.kind) {
        item.nextRunAt = null;
        return;
    }
    const slot = Date.parse(item.nextRunAt || "");
    if (Number.isFinite(slot)) item.consumedSlot = item.nextRunAt;
    if (item.kind === "every") {
        const parsed = parseEvery(item.every);
        if (parsed.error) {
            item.nextRunAt = null;
            return;
        }
        const base = Number.isFinite(slot) ? slot : from.getTime();
        const steps = Math.max(1, Math.floor((from.getTime() - base) / parsed.ms) + 1);
        item.nextRunAt = new Date(base + steps * parsed.ms).toISOString();
        return;
    }
    const base = Number.isFinite(slot) && slot > from.getTime() ? new Date(slot) : from;
    item.nextRunAt = computeNextRun(scheduleShape(item), base)?.toISOString() || null;
}

export function pendingSlotDelivered(item) {
    const slot = Date.parse(item.consumedSlot || "");
    if (!Number.isFinite(slot)) return false;
    const delivered = Math.max(Date.parse(item.lastNotifiedAt || "") || 0, Date.parse(item.lastRunAt || "") || 0);
    return delivered >= slot;
}
