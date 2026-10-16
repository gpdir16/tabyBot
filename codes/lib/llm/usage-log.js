// 토큰 사용 기록. 모든 LLM 요청의 usage를 날짜와 프로바이더·모델별로 모아 설정의 사용 기록 화면에 보여 준다.
// 캐시 유지 핑은 실제 요청과 따로 센다(핑은 거의 전부 캐시에서 읽으므로 섞으면 캐시 적중률이 부풀려진다).
// 본문은 저장하지 않고 토큰 수만 저장한다.
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { readJsonFile, writeJsonAtomic } from "../atomic-file.js";
import { loadUserConfig } from "../config-loader.js";
import { defaultTimeZone, isValidTimeZone } from "../scheduling/time.js";

const LOG_FILE = path.join(USER_DIR, "usage-log.json");
// 보관하는 날 수. 화면에서 고를 수 있는 가장 긴 기간과 같다.
export const USAGE_KEEP_DAYS = 90;
const FIELDS = ["calls", "input", "cached", "written", "output", "pings", "pingInput", "pingCached"];

let log = null;
let saveTimer = null;

function loadLog() {
    if (log) return log;
    const raw = readJsonFile(LOG_FILE, null, { label: "usage log" });
    log = { days: raw?.days && typeof raw.days === "object" ? raw.days : {} };
    return log;
}

function writeNow() {
    try {
        writeJsonAtomic(LOG_FILE, log);
    } catch (err) {
        console.warn(`tabyBot: usage log save failed: ${err?.message || err}`);
    }
}

function saveLog() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeNow();
    }, 5000);
    saveTimer.unref?.();
}

// 종료 직전에 아직 쓰지 않은 기록을 저장한다.
export function flushUsageLog() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeNow();
}

function timeZone() {
    const tz = loadUserConfig().timezone;
    return tz && isValidTimeZone(tz) ? tz : defaultTimeZone();
}

// 사용자 시간대의 날짜(YYYY-MM-DD).
function dayKey(date, tz) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

// Chat Completions와 Responses 모양의 usage를 같은 모양으로. 모르면 null.
function readUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    return {
        input: num(usage.prompt_tokens ?? usage.input_tokens),
        cached: num(details.cached_tokens),
        written: num(details.cache_write_tokens),
        output: num(usage.completion_tokens ?? usage.output_tokens),
    };
}

function pruneOld(days, today) {
    const keys = Object.keys(days).sort();
    const cutoff = new Date(`${today}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - USAGE_KEEP_DAYS);
    const oldest = cutoff.toISOString().slice(0, 10);
    for (const key of keys) {
        if (key > oldest) break;
        delete days[key];
    }
}

// 요청 하나의 사용량을 기록한다. kind는 "call"(실제 요청) 또는 "ping"(캐시 유지 핑).
export function recordUsage(provider, usage, kind = "call") {
    if (!provider?.id) return;
    try {
        const data = loadLog();
        const today = dayKey(new Date(), timeZone());
        if (!data.days[today]) {
            data.days[today] = {};
            pruneOld(data.days, today);
        }
        const id = `${provider.id}|${provider.model || ""}`;
        data.days[today][id] ??= {};
        const row = data.days[today][id];
        const u = readUsage(usage);
        if (kind === "ping") {
            row.pings = (row.pings || 0) + 1;
            if (u) {
                row.pingInput = (row.pingInput || 0) + u.input;
                row.pingCached = (row.pingCached || 0) + u.cached;
            }
        } else {
            row.calls = (row.calls || 0) + 1;
            if (u) {
                row.input = (row.input || 0) + u.input;
                row.cached = (row.cached || 0) + u.cached;
                row.written = (row.written || 0) + u.written;
                row.output = (row.output || 0) + u.output;
            }
        }
        saveLog();
    } catch (err) {
        console.warn(`tabyBot: usage log record failed: ${err?.message || err}`);
    }
}

// 최근 USAGE_KEEP_DAYS일. 오래된 날부터, 기록이 없는 날도 빈 날로 채운다.
// days: [{ date, models: { "<프로바이더>|<모델>": { calls, input, cached, written, output, pings, pingInput, pingCached } } }]
export function usageSummary() {
    const data = loadLog();
    const tz = timeZone();
    const today = dayKey(new Date(), tz);
    const start = new Date(`${today}T00:00:00Z`);
    const days = [];
    for (let i = USAGE_KEEP_DAYS - 1; i >= 0; i--) {
        const d = new Date(start);
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().slice(0, 10);
        const models = {};
        for (const [id, row] of Object.entries(data.days[date] || {})) {
            models[id] = Object.fromEntries(FIELDS.map((f) => [f, num(row?.[f])]));
        }
        days.push({ date, models });
    }
    return { days };
}

// LLM 클라이언트의 complete()를 감싸 응답마다 사용량을 기록한다.
export function withUsageLog(client) {
    const complete = client.complete;
    return {
        ...client,
        async complete(args) {
            const response = await complete(args);
            recordUsage(client.provider, response?.usage);
            return response;
        },
    };
}
