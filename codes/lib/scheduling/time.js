const MIN_EVERY_MS = 60_000;
const MAX_EVERY_MS = 36_525 * 86_400_000;

const MONTH_ALIAS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};

const DOW_ALIAS = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
};

const DOW_FROM_SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const EVERY_RE = /^(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days)$/i;

export function defaultTimeZone() {
    const env = typeof process.env.TZ === "string" ? process.env.TZ.trim() : "";
    if (env) return env;
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(timeZone) {
    try {
        Intl.DateTimeFormat("en-US", { timeZone: String(timeZone || "") });
        return true;
    } catch {
        return false;
    }
}

function aliasNumber(raw, aliases) {
    const key = String(raw || "")
        .trim()
        .toLowerCase();
    if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
    const n = Number(key);
    return Number.isInteger(n) ? n : null;
}

function parseCronField(raw, min, max, aliases = {}) {
    const field = String(raw || "")
        .trim()
        .toLowerCase();
    if (!field) return null;
    const values = new Set();
    for (const part of field.split(",")) {
        const segs = part.split("/");
        if (segs.length > 2) return null;
        const [rangeRaw, stepRaw] = segs;
        const step = stepRaw == null || stepRaw === "" ? 1 : Number(stepRaw);
        if (!Number.isInteger(step) || step < 1) return null;
        let start;
        let end;
        if (rangeRaw === "*") {
            start = min;
            end = max;
        } else if (rangeRaw.includes("-")) {
            const [a, b] = rangeRaw.split("-");
            start = aliasNumber(a, aliases);
            end = aliasNumber(b, aliases);
        } else {
            start = aliasNumber(rangeRaw, aliases);
            end = stepRaw != null && stepRaw !== "" ? max : start;
        }
        if (start == null || end == null || start > end || start < min || end > max) return null;
        for (let value = start; value <= end; value += step) values.add(value);
    }
    return values.size ? values : null;
}

export function parseCron(expr) {
    const parts = String(expr || "")
        .trim()
        .split(/\s+/);
    if (parts.length !== 5) return null;
    const minute = parseCronField(parts[0], 0, 59);
    const hour = parseCronField(parts[1], 0, 23);
    const dom = parseCronField(parts[2], 1, 31);
    const month = parseCronField(parts[3], 1, 12, MONTH_ALIAS);
    const dow = parseCronField(parts[4], 0, 7, DOW_ALIAS);
    if (!minute || !hour || !dom || !month || !dow) return null;
    // 7도 일요일
    if (dow.has(7)) {
        dow.add(0);
        dow.delete(7);
    }
    return {
        minute,
        hour,
        dom,
        month,
        dow,
        domStar: parts[2] === "*",
        dowStar: parts[4] === "*",
    };
}

export function parseEvery(raw) {
    const text = String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/^@every\s+/, "");
    const match = text.match(EVERY_RE);
    if (!match) return { error: 'interval must look like "5m", "2h", "1d", or "60s"' };
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) return { error: "interval count must be a positive integer" };
    const unit = match[2][0];
    const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    if (ms < MIN_EVERY_MS) return { error: "interval must be at least 60s" };
    if (ms > MAX_EVERY_MS) return { error: "interval too large" };
    return { ms, label: `${n}${unit}` };
}

function zonedParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    });
    const map = {};
    for (const part of dtf.formatToParts(date)) {
        if (part.type !== "literal") map[part.type] = part.value;
    }
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour) % 24,
        minute: Number(map.minute),
        dow: DOW_FROM_SHORT[map.weekday],
    };
}

export function nextCronDate(expr, timeZone, from = new Date()) {
    const parsed = typeof expr === "string" ? parseCron(expr) : expr;
    if (!parsed || !isValidTimeZone(timeZone)) return null;
    const minutes = [...parsed.minute].sort((a, b) => a - b);
    const hours = [...parsed.hour].sort((a, b) => a - b);
    const fromMs = from.getTime();
    const start = zonedParts(from, timeZone);
    for (let day = 0; day <= 3000; day++) {
        const wall = new Date(Date.UTC(start.year, start.month - 1, start.day + day));
        const wy = wall.getUTCFullYear();
        const wm = wall.getUTCMonth() + 1;
        const wday = wall.getUTCDate();
        if (!parsed.month.has(wm)) continue;
        const noonMs = wallClockUtcMs(wy, wm, wday, 12, 0, timeZone);
        const dow = zonedParts(new Date(noonMs), timeZone).dow;
        const domHit = parsed.dom.has(wday);
        const dowHit = parsed.dow.has(dow);
        const ok = parsed.domStar && parsed.dowStar ? true : parsed.domStar ? dowHit : parsed.dowStar ? domHit : domHit || dowHit;
        if (!ok) continue;
        let bestMs = null;
        let bestNaive = null;
        for (const h of hours) {
            for (const mi of minutes) {
                const naive = Date.UTC(wy, wm - 1, wday, h, mi);
                if (bestMs != null && naive > bestNaive + 3_600_000) break;
                const base = wallClockUtcMs(wy, wm, wday, h, mi, timeZone);
                for (const ms of [base - 3_600_000, base, base + 3_600_000]) {
                    const back = zonedParts(new Date(ms), timeZone);
                    if (back.year !== wy || back.month !== wm || back.day !== wday || back.hour !== h || back.minute !== mi) continue;
                    if (ms > fromMs && (bestMs == null || ms < bestMs)) {
                        bestMs = ms;
                        bestNaive = naive;
                    }
                }
            }
            if (bestMs != null && Date.UTC(wy, wm - 1, wday, h, 59) > bestNaive + 3_600_000) break;
        }
        if (bestMs != null) return new Date(bestMs);
    }
    return null;
}

function wallClockUtcMs(year, month, day, hour, minute, timeZone) {
    const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = naive;
    for (let i = 0; i < 4; i++) {
        const asInTz = zonedParts(new Date(guess), timeZone);
        const wall = Date.UTC(asInTz.year, asInTz.month - 1, asInTz.day, asInTz.hour, asInTz.minute);
        const next = guess + (naive - wall);
        if (next === guess) break;
        guess = next;
    }
    return guess;
}

export function parseAt(raw, timeZone) {
    const text = String(raw || "").trim();
    if (!text) return { error: "at requires an ISO datetime" };
    if (!isValidTimeZone(timeZone)) return { error: `invalid timezone: ${timeZone}` };
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) return { error: "invalid datetime" };
        return { date };
    }
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return { error: 'at must be ISO-8601, e.g. "2026-09-11T08:00"' };
    const [y, mo, d, h, mi, s] = [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        match[6] != null ? Number(match[6]) : 0,
    ];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return { error: "invalid datetime" };
    let ms = wallClockUtcMs(y, mo, d, h, mi, timeZone);
    const probe = zonedParts(new Date(ms), timeZone);
    if (probe.year === y && probe.month === mo && probe.day === d && (probe.hour !== h || probe.minute !== mi)) {
        for (let i = 1; i <= 180; i++) {
            const p = zonedParts(new Date(ms + i * 60_000), timeZone);
            if (p.year === y && p.month === mo && p.day === d && p.hour * 60 + p.minute >= h * 60 + mi) {
                ms = ms + i * 60_000;
                break;
            }
        }
    }
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return { error: "invalid datetime" };
    const back = zonedParts(date, timeZone);
    if (back.year !== y || back.month !== mo || back.day !== d) return { error: "invalid datetime" };
    return { date };
}

export function sameWallClock(a, b, timeZone) {
    const da = Date.parse(a instanceof Date ? a.toISOString() : a);
    const db = Date.parse(b instanceof Date ? b.toISOString() : b);
    if (!Number.isFinite(da) || !Number.isFinite(db)) return false;
    const pa = zonedParts(new Date(da), timeZone);
    const pb = zonedParts(new Date(db), timeZone);
    return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day && pa.hour === pb.hour && pa.minute === pb.minute;
}

export function computeNextRun(job, from = new Date()) {
    const timeZone = job.timezone || defaultTimeZone();
    if (job.kind === "every") {
        const parsed = parseEvery(job.every);
        if (parsed.error) return null;
        return new Date(from.getTime() + parsed.ms);
    }
    if (job.kind === "at") {
        const parsed = parseAt(job.at, timeZone);
        if (parsed.error) return null;
        return parsed.date.getTime() > from.getTime() ? parsed.date : null;
    }
    if (job.kind === "cron") {
        return nextCronDate(job.cron, timeZone, from);
    }
    return null;
}

export function describeSchedule(job) {
    const timeZone = job.timezone || defaultTimeZone();
    if (job.kind === "every") return `every ${job.every} (${timeZone})`;
    if (job.kind === "at") return `at ${job.at} (${timeZone})`;
    if (job.kind === "cron") return `cron ${job.cron} (${timeZone})`;
    return "unknown";
}
