// 프롬프트 캐시 유지. 대화가 쉬는 동안 캐시가 만료되기 직전에 같은 앞부분으로 출력이 거의 없는 요청(핑)을
// 보내 캐시를 살려 둔다. 핑도 앞부분 전체를 캐시에서 다시 읽으므로 그 값(입력 단가의 약 10~25%)이 든다.
// 그래서 핑을 계속 보내는 비용보다 그동안 사용자가 돌아와 아끼는 값이 클 때만 보낸다.
//
// - 만료 시간은 프로바이더별 알려진 값에서 시작하고, 실제 응답의 캐시 적중 여부로 고쳐 나간다.
// - 캐시 적중이 한 번이라도 확인된 모델에만 보낸다. 캐시를 안 쓰는 곳에 보내면 매번 입력 전체 값이 든다.
// - 사용자가 돌아오기까지 걸린 시간을 저장된 대화 기록의 시각(본문은 읽지 않음)과 이후 실제 요청으로 모으고,
//   "지금까지 쉰 시간"에서 앞으로 얼마나 더 유지하면 이득인지를 셈한다. 정해진 상한은 없다.
// - 기록이 적을 때는 함께 배포하는 기본 사용 패턴을 섞고, 내 기록이 쌓일수록 기본 패턴의 비중을 줄인다.
// - 사용자 지정 모드에서는 만료 시간과 유지 시간을 사용자가 정하고, 예측 없이 그만큼만 유지한다.
// - 도구 실행을 기다리는 중이면 곧 다음 요청이 오므로 따지지 않고 유지한다.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, SESSION_DIR, USER_DIR } from "../paths.js";
import { readJsonFile, writeJsonAtomic } from "../atomic-file.js";
import { getMergedProvider, loadUserConfig } from "../config-loader.js";
import { recordUsage } from "./usage-log.js";

const STATS_FILE = path.join(USER_DIR, "cache-keepalive.json");
const PATTERN_FILE = path.join(CONFIG_DIR, "cache-keepalive-pattern.json");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MIN_TTL_MS = 3 * MINUTE;
const MAX_TTL_MS = 24 * HOUR;
// 이보다 짧은 프롬프트는 캐시되지 않거나(최소 길이 미만) 다시 읽어도 싸다.
const MIN_PROMPT_TOKENS = 2048;
const MAX_TOOL_WAIT_MS = 2 * HOUR;
// 이득을 따져 보는 가장 먼 시점. 그보다 오래 쉬었다 돌아오는 경우까지 위해 핑을 보내지는 않는다.
const HORIZON_MS = 7 * 24 * HOUR;
const PING_TIMEOUT_MS = 2 * MINUTE;
const MAX_ENTRIES = 30;
const MAX_GAPS = 3000;
const MAX_OPEN = 500;
const OPEN_EXPIRE_MS = 30 * 24 * HOUR;
// 남은 표본이 적을 때 섞는 기본 가정의 무게(표본 몇 개만큼으로 칠지).
const PRIOR_WEIGHT = 10;
// 기본 패턴 표본 하나의 무게는 BASE_HALF / (BASE_HALF + 내 기록 수). 내 기록이 쌓일수록 기본 패턴이 물러난다.
const BASE_HALF = 100;
const CUSTOM_DEFAULT = { ttlMinutes: 60, keepHours: 3 };
const SMOOTH_FROM_MS = MINUTE;
const SMOOTH_RATIO = 1.25;
// 응답 끝에 붙여 보내는 사용자 메시지. 모델은 답을 시작하기 전에 끊기므로 내용은 쓰이지 않는다.
const PING_TEXT = ".";

// 프로바이더별 기본값. ttlMs는 처음 가정하는 만료 시간, read/miss는 입력 단가 대비 캐시 읽기 단가와
// 캐시가 없을 때(다시 처리하고 캐시에 쓰는) 단가. null이면 핑이 이득이 없는 프로바이더.
function profileOf(provider) {
    if (!provider) return null;
    switch (provider.type) {
        case "claude-agent-sdk":
            // 구독은 1시간 캐시(쓰기 2배)를 쓰고, 추가 사용량을 쓰는 중이면 5분(쓰기 1.25배). 응답에서 알아냄.
            return { ttlMs: HOUR, read: 0.1, miss: 2, missShort: 1.25 };
        case "codex-oauth":
            return { ttlMs: 5 * MINUTE, read: 0.1, miss: 1 };
        case "grok-oauth":
            return { ttlMs: 5 * MINUTE, read: 0.25, miss: 1 };
        case "github-copilot-oauth":
            // 요청 수로 과금되고 캐시 할인이 없으므로 핑은 요청 하나를 그대로 더 쓸 뿐이다.
            return null;
        default:
            break;
    }
    // 로컬 Ollama는 요금이 없고 캐시 사용량도 알려 주지 않는다.
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(provider.baseURL || "")) return null;
    // OpenAI API는 기본 보존 기간(24h 보존: 쉬는 시간 약 30분)을 가정하고, 짧으면 응답에서 고친다.
    if (/^https:\/\/api\.openai\.com\//.test(provider.baseURL || "")) return { ttlMs: 30 * MINUTE, read: 0.1, miss: 1 };
    return { ttlMs: 5 * MINUTE, read: 0.25, miss: 1 };
}

const clampNumber = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// 모델 프리셋별 설정: { mode: "auto" } | { mode: "off" } | { mode: "custom", ttlMinutes, keepHours }.
// 저장하지 않은 프리셋은 자동이다(예전의 false는 끔). 예전에는 프로바이더 종류(id)로 저장했으므로 그 값도 읽는다.
function cacheKeepAliveSettings(provider, config = loadUserConfig()) {
    const all = config.cacheKeepAlive || {};
    const raw = (provider.presetUid && all[provider.presetUid]) ?? all[provider.id || "default"];
    if (raw === false || raw?.mode === "off") return { mode: "off" };
    if (raw?.mode === "custom") {
        return {
            mode: "custom",
            ttlMinutes: clampNumber(raw.ttlMinutes, 1, 24 * 60, CUSTOM_DEFAULT.ttlMinutes),
            keepHours: clampNumber(raw.keepHours, 0.25, 7 * 24, CUSTOM_DEFAULT.keepHours),
        };
    }
    return { mode: "auto" };
}

// 설정 화면에서 받은 값을 저장할 모양으로 바꾼다. 자동이면 null(저장하지 않음).
export function normalizeCacheKeepAlive(value) {
    const mode = typeof value === "boolean" ? (value ? "auto" : "off") : value?.mode;
    if (mode === "off") return { mode: "off" };
    if (mode !== "custom") return null;
    return {
        mode: "custom",
        ttlMinutes: clampNumber(value.ttlMinutes, 1, 24 * 60, CUSTOM_DEFAULT.ttlMinutes),
        keepHours: clampNumber(value.keepHours, 0.25, 7 * 24, CUSTOM_DEFAULT.keepHours),
    };
}

function providerKey(provider) {
    return `${provider.profileUid || ""}|${provider.id}|${provider.type}|${provider.baseURL}|${provider.model}|${provider.openRouterPins?.[provider.model] || ""}`;
}

// ── 학습한 값(재시작해도 이어 씀) ──

let stats = null;
let saveTimer = null;

function loadStats() {
    if (stats) return stats;
    const raw = readJsonFile(STATS_FILE, null, { label: "cache keep-alive stats" });
    stats = {
        models: raw?.models && typeof raw.models === "object" ? raw.models : {},
        gaps: Array.isArray(raw?.gaps) ? raw.gaps.filter((g) => Number.isFinite(g) && g >= 0) : [],
        open: raw?.open && typeof raw.open === "object" ? raw.open : {},
        seeded: raw?.seeded === true,
    };
    if (!stats.seeded) seedFromHistory(stats);
    return stats;
}

const timeOf = (value) => {
    const ms = Date.parse(value || "");
    return Number.isFinite(ms) ? ms : null;
};

// 처음 한 번, 저장된 대화 기록에서 턴의 시작과 끝 시각만 읽어 사용자가 돌아온 간격을 채운다.
// 턴의 시작은 첫 메시지 시각, 끝은 그 턴에 적힌 가장 늦은 시각으로 본다(답이 끝난 시각은 따로 적히지 않아
// 도구 결과 시각까지만 안다). 마지막 턴 뒤로 아직 돌아오지 않은 대화는 "그만큼은 안 돌아왔다"로 넣는다.
function seedFromHistory(s) {
    const events = [];
    let agents = [];
    try {
        agents = fs.readdirSync(SESSION_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
        // 기록이 아직 없다
    }
    for (const agent of agents) {
        const dir = path.join(SESSION_DIR, agent.name, "sessions");
        let files = [];
        try {
            files = fs
                .readdirSync(dir)
                .filter((name) => /^s\d+\.json$/.test(name))
                .sort();
        } catch {
            continue; // 세션 파일이 없는 봇
        }
        let lastEnd = null;
        for (const name of files) {
            const turns = readJsonFile(path.join(dir, name), null)?.turns;
            if (!Array.isArray(turns)) continue;
            for (const turn of turns) {
                const times = [timeOf(turn?.at), ...(Array.isArray(turn?.messages) ? turn.messages.map((m) => timeOf(m?.at)) : [])].filter(
                    (t) => t !== null,
                );
                if (!times.length) continue;
                const start = Math.min(...times);
                if (lastEnd !== null && start > lastEnd) events.push([start, start - lastEnd]);
                lastEnd = Math.max(lastEnd ?? 0, ...times);
            }
        }
        if (lastEnd !== null && !s.open[agent.name]) s.open[agent.name] = lastEnd;
    }
    events.sort((a, b) => a[0] - b[0]);
    s.gaps = [...events.slice(-MAX_GAPS).map(([, gap]) => gap), ...s.gaps].slice(-MAX_GAPS);
    s.seeded = true;
    saveStats();
}

function saveStats() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            writeJsonAtomic(STATS_FILE, stats);
        } catch (err) {
            console.warn(`tabyBot: cache keep-alive stats save failed: ${err?.message || err}`);
        }
    }, 5000);
    saveTimer.unref?.();
}

// 학습한 만료 시간은 프로바이더 프로필과 모델(OpenRouter는 고정한 업스트림까지)마다 따로 둔다.
// 업스트림마다 캐시가 따로라 같은 모델이라도 만료 시간이 다르다. 예전 키(프로바이더 종류|모델)의 값은 이어 쓴다.
function modelStat(provider, profile) {
    const s = loadStats();
    const pin = provider.openRouterPins?.[provider.model] || "";
    const id = `${provider.profileUid || provider.id}|${provider.model}${pin ? `|${pin}` : ""}`;
    s.models[id] ??= { ...(s.models[`${provider.id}|${provider.model}`] || { ttlMs: profile.ttlMs, cached: false, hitGapMs: 0 }) };
    return s.models[id];
}

const clampTtl = (ms) => Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ms)));

// 응답의 캐시 사용량으로 만료 시간을 고친다. gap은 같은 대화의 앞 요청(핑 포함)부터 지난 시간.
function learn(stat, { gap, usage }) {
    if (!usage) return;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) || 0;
    const hinted = Number(usage.cache_ttl_ms) || 0;
    if (hinted) stat.ttlMs = clampTtl(hinted);
    if (prompt < MIN_PROMPT_TOKENS) return;
    if (cached > 0) {
        stat.cached = true;
        if (gap > stat.hitGapMs) {
            stat.hitGapMs = gap;
            // 그만큼 쉬고도 적중했으면 만료 시간은 적어도 그만큼이다.
            if (!hinted && gap > stat.ttlMs) stat.ttlMs = clampTtl(gap);
        }
    } else if (stat.cached && gap != null && gap < stat.ttlMs) {
        // 시스템 프롬프트까지 통째로 빗나감: 앞부분이 바뀐 게 아니라 만료된 것이다. 더 일찍 보낸다.
        stat.ttlMs = clampTtl(gap * 0.8);
    }
    saveStats();
}

// 사용자가 돌아오기까지 걸린 시간을 기록한다.
function recordGap(key, gapMs) {
    const s = loadStats();
    delete s.open[key];
    s.gaps.push(Math.round(gapMs));
    if (s.gaps.length > MAX_GAPS) s.gaps.splice(0, s.gaps.length - MAX_GAPS);
    saveStats();
}

function markOpen(key, at) {
    const s = loadStats();
    delete s.open[key];
    s.open[key] = at;
    const keys = Object.keys(s.open);
    for (const k of keys) if (at - s.open[k] > OPEN_EXPIRE_MS) delete s.open[k];
    const left = Object.keys(s.open);
    for (const k of left.slice(0, Math.max(0, left.length - MAX_OPEN))) delete s.open[k];
    saveStats();
}

// 함께 배포하는 기본 사용 패턴(돌아오기까지 걸린 분, 아직 안 돌아온 대화가 쉰 분).
let basePattern = null;

function loadBasePattern() {
    if (basePattern) return basePattern;
    const raw = readJsonFile(PATTERN_FILE, null, { label: "cache keep-alive pattern" });
    const minutes = (list) => (Array.isArray(list) ? list.filter((n) => Number.isFinite(n) && n >= 0).map((n) => n * MINUTE) : []);
    basePattern = { gaps: minutes(raw?.gapsMinutes), open: minutes(raw?.openMinutes) };
    return basePattern;
}

// 사용 패턴에서 내 기록과 기본 패턴이 차지하는 비중.
function patternMix() {
    const own = loadStats().gaps.length;
    const base = loadBasePattern().gaps.length;
    const weight = BASE_HALF / (BASE_HALF + own);
    return { own, base, weight, ownShare: own + base * weight > 0 ? own / (own + base * weight) : 0 };
}

// 사용자가 쉰 시간의 분포. 돌아온 간격(사건)과 아직 안 돌아온 대화(그 시간까지는 안 돌아왔다는 것만 앎)로
// 무게를 준 카플란-마이어 추정을 한다. survivalAfter(idle)는 이미 idle만큼 쉰 사용자가 x까지도 돌아오지 않을
// 확률 S(x | idle)를 준다. idle 뒤에 남은 표본이 적을수록 "처음엔 자주, 오래 쉴수록 드물게 돌아온다"는
// 가정을 많이 섞어, 드문 기록 몇 개에 판단이 휘둘리지 않게 한다.
function usageCurve(key, now) {
    const s = loadStats();
    const base = loadBasePattern();
    const { weight } = patternMix();
    const obs = [
        ...s.gaps.map((gap) => [gap, true, 1]),
        ...base.gaps.map((gap) => [gap, true, weight]),
        ...base.open.map((idle) => [idle, false, weight]),
    ];
    for (const [k, since] of Object.entries(s.open)) if (k !== key && now > since) obs.push([now - since, false, 1]);
    obs.sort((a, b) => a[0] - b[0]);
    const times = [];
    const values = [];
    // after[i]: times[i]보다 오래 쉰 표본의 무게 합(그 시점 뒤에 남은 표본 수)
    const marks = [];
    const after = [];
    let atRisk = obs.reduce((sum, o) => sum + o[2], 0);
    let surv = 1;
    for (let i = 0; i < obs.length; ) {
        const t = obs[i][0];
        let returned = 0;
        let left = 0;
        for (; i < obs.length && obs[i][0] === t; i += 1) {
            if (obs[i][1]) returned += obs[i][2];
            else left += obs[i][2];
        }
        if (returned && atRisk > 0) {
            surv *= Math.max(0, 1 - returned / atRisk);
            times.push(t);
            values.push(surv);
        }
        atRisk -= returned + left;
        marks.push(t);
        after.push(Math.max(0, atRisk));
    }
    const lastAtOrBefore = (list, x) => {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid] <= x) lo = mid + 1;
            else hi = mid;
        }
        return lo - 1;
    };
    const step = (x) => {
        const i = lastAtOrBefore(times, x);
        return i >= 0 ? values[i] : 1;
    };
    // 계단 모양 그대로 쓰면 우연히 어떤 시각 바로 뒤에 돌아온 기록 하나가 판단을 뒤집는다. 시간을 25%씩 늘어나는
    // 구간으로 나눠 그 사이를 (로그 시간 위에서) 곧게 이어 부드럽게 한다.
    const km = (x) => {
        if (x <= SMOOTH_FROM_MS) return step(x);
        const j = Math.floor(Math.log(x / SMOOTH_FROM_MS) / Math.log(SMOOTH_RATIO));
        const a = SMOOTH_FROM_MS * SMOOTH_RATIO ** j;
        const b = a * SMOOTH_RATIO;
        const sa = step(a);
        const sb = step(b);
        if (sa <= 0 || sb <= 0) return step(x);
        const w = Math.log(x / a) / Math.log(SMOOTH_RATIO);
        return Math.exp((1 - w) * Math.log(sa) + w * Math.log(sb));
    };
    // 돌아오는 비율이 처음 30분에 한 번꼴에서 한 시간마다 e배씩 줄어든다고 본 S(x).
    const prior = (x) => Math.exp(-2 * (1 - Math.exp(-x / HOUR)));
    const total = obs.reduce((sum, o) => sum + o[2], 0);
    return {
        survivalAfter(idle) {
            const i = lastAtOrBefore(marks, idle);
            const remaining = i >= 0 ? after[i] : total;
            const kmBase = km(idle);
            const priorBase = prior(idle);
            return (x) => {
                const fromData = kmBase > 0 ? km(x) / kmBase : 1;
                return (remaining * fromData + PRIOR_WEIGHT * (prior(x) / priorBase)) / (remaining + PRIOR_WEIGHT);
            };
        },
    };
}

// 지금(쉰 지 idle) 핑을 보내고 이어서 k번까지 보낼 때, 그동안 돌아와 아끼는 값이 핑 값보다 큰 k가 있는가.
// 핑 j는 그 전에 사용자가 돌아오지 않았을 때만 나가고, 돌아오면 캐시를 다시 만드는 값(miss)에서 읽는 값(read)을 아낀다.
function worthKeeping({ curve, idle, ttl, read, miss }) {
    const surv = curve.survivalAfter(idle);
    let pings = 0;
    for (let k = 1; idle + (k - 1) * ttl < HORIZON_MS; k += 1) {
        pings += surv(idle + (k - 1) * ttl);
        if ((miss - read) * (1 - surv(idle + k * ttl)) > read * pings) return true;
    }
    return false;
}

const missCost = (profile, ttl) => (ttl < HOUR && profile.missShort ? profile.missShort : profile.miss);

// 돌아오기까지 걸린 시간의 분포(내 기록과 기본 패턴을 섞은 무게로). 설정 화면에 보여 준다.
const RETURN_BUCKETS_MINUTES = [5, 30, 60, 6 * 60, 12 * 60, 24 * 60, Number.POSITIVE_INFINITY];

function returnBuckets(weight) {
    const counts = RETURN_BUCKETS_MINUTES.map(() => 0);
    const add = (gap, w) => {
        const i = RETURN_BUCKETS_MINUTES.findIndex((limit) => gap < limit * MINUTE);
        counts[i] += w;
    };
    for (const gap of loadStats().gaps) add(gap, 1);
    for (const gap of loadBasePattern().gaps) add(gap, weight);
    const total = counts.reduce((sum, n) => sum + n, 0);
    return RETURN_BUCKETS_MINUTES.map((limit, i) => ({
        underMinutes: Number.isFinite(limit) ? limit : null,
        percent: total ? Math.round((counts[i] / total) * 100) : 0,
    }));
}

// 설정 화면에 보여 줄 요약: 쓰는 만료 시간, 대화가 끝난 뒤 얼마나 유지할지, 사용 패턴의 구성.
export function cacheKeepAliveSummary(provider, config = loadUserConfig()) {
    const profile = profileOf(provider);
    if (!profile) return null;
    const settings = cacheKeepAliveSettings(provider, config);
    const stat = modelStat(provider, profile);
    const mix = patternMix();
    const pattern = { own: mix.own, base: mix.base, ownShare: Math.round(mix.ownShare * 100), returns: returnBuckets(mix.weight) };
    if (settings.mode === "custom") {
        return { ...settings, ttlMs: settings.ttlMinutes * MINUTE, keepMs: settings.keepHours * HOUR, pattern };
    }
    const ttl = stat.ttlMs;
    const curve = usageCurve(null, Date.now());
    let idle = ttl * 0.9;
    let pings = 0;
    while (idle < HORIZON_MS && worthKeeping({ curve, idle, ttl, read: profile.read, miss: missCost(profile, ttl) })) {
        pings += 1;
        idle += ttl;
    }
    return { mode: settings.mode, ttlMs: ttl, keepMs: pings ? idle - ttl * 0.1 : 0, cachedSeen: stat.cached, pattern };
}

// ── 대화별 상태 ──

const entries = new Map();
let queue = Promise.resolve();

// 핑은 한 번에 하나씩 보낸다(Claude는 핑마다 CLI 프로세스를 띄운다).
function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {
        // 실패는 호출한 쪽에서 처리했다
    });
    return run;
}

function drop(entry) {
    clearTimeout(entry.timer);
    entry.abort?.abort();
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
}

// 지금 쓸 만료 시간. 사용자 지정이면 그 값, 아니면 학습한 값.
function ttlFor(entry, settings = cacheKeepAliveSettings(entry.provider)) {
    return settings.mode === "custom" ? settings.ttlMinutes * MINUTE : modelStat(entry.provider, entry.profile).ttlMs;
}

function schedule(entry) {
    clearTimeout(entry.timer);
    const ttl = ttlFor(entry);
    const at = entry.touchedAt + ttl - Math.max(20_000, ttl * 0.1);
    entry.timer = setTimeout(() => void fire(entry), Math.max(1000, at - Date.now()));
    entry.timer.unref?.();
}

function worthPinging(entry) {
    let current = null;
    try {
        // 이 대화가 쓰는 프리셋의 지금 설정. 프리셋 대신 예전 모델 오버라이드를 쓰는 봇은 모델을 그 봇의 것으로 맞춘다.
        const fresh = getMergedProvider(loadUserConfig(), entry.provider.presetUid);
        current = entry.provider.modelOverride ? { ...fresh, model: entry.provider.model, openRouterPins: {} } : fresh;
    } catch {
        return false; // 설정을 읽을 수 없으면 보내지 않는다
    }
    // 프로바이더나 모델이 바뀌었으면 다음 요청은 이 캐시를 쓰지 않는다.
    if (providerKey(current) !== providerKey(entry.provider)) return false;
    const settings = cacheKeepAliveSettings(current);
    if (settings.mode === "off" || entry.promptTokens < MIN_PROMPT_TOKENS) return false;
    const now = Date.now();
    const idle = now - entry.endedAt;
    // 사용자 지정: 정한 시간까지만 그대로 유지한다.
    if (settings.mode === "custom") return idle < Math.max(settings.keepHours * HOUR, entry.waiting === "tools" ? MAX_TOOL_WAIT_MS : 0);
    if (!modelStat(entry.provider, entry.profile).cached) return false;
    if (entry.waiting === "tools") return idle < MAX_TOOL_WAIT_MS;
    const ttl = ttlFor(entry, settings);
    const curve = usageCurve(entry.key, now);
    return worthKeeping({ curve, idle, ttl, read: entry.profile.read, miss: missCost(entry.profile, ttl) });
}

// 다음 요청과 앞부분이 같은 메시지. 답이 끝났으면 그 답까지 넣고 짧은 사용자 메시지를 붙여 답까지 캐시에
// 남기고, 도구를 기다리는 중이면 마지막 요청을 그대로 보낸다.
function pingMessages(entry) {
    const tail = entry.messages.slice(entry.length);
    const reply = tail[0];
    if (entry.waiting === "user" && tail.length === 1 && reply?.role === "assistant" && !reply.tool_calls?.length && reply.content) {
        return [...entry.messages, { role: "user", content: PING_TEXT }];
    }
    return entry.messages.slice(0, entry.length);
}

async function fire(entry) {
    if (entries.get(entry.key) !== entry) return;
    if (!worthPinging(entry)) {
        drop(entry);
        return;
    }
    const abort = new AbortController();
    entry.abort = abort;
    const timer = setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
    try {
        const result = await enqueue(async () => {
            if (abort.signal.aborted) return { skipped: true };
            const sentAt = Date.now();
            const usage = await entry.ping({
                cacheKey: entry.key,
                messages: pingMessages(entry),
                tools: entry.tools,
                tool_choice: "auto",
                signal: abort.signal,
            });
            return { sentAt, usage };
        });
        if (entries.get(entry.key) !== entry || result.skipped) return;
        // 보낼 수 없는 상태(Claude 프로세스가 일하는 중 등)면 이번 쉬는 동안은 그만둔다.
        if (result.usage === null && entry.provider.type === "claude-agent-sdk") {
            drop(entry);
            return;
        }
        const gap = result.sentAt - entry.touchedAt;
        entry.touchedAt = result.sentAt;
        entry.pings += 1;
        recordUsage(entry.provider, result.usage, "ping");
        learn(modelStat(entry.provider, entry.profile), { gap, usage: result.usage });
        const cached = Number(result.usage?.prompt_tokens_details?.cached_tokens ?? result.usage?.input_tokens_details?.cached_tokens);
        const prompt = Number(result.usage?.prompt_tokens ?? result.usage?.input_tokens);
        console.log(`tabyBot: cache keep-alive ${entry.key} #${entry.pings} cached=${Number.isFinite(cached) ? `${cached}/${prompt}` : "?"}`);
        schedule(entry);
    } catch (err) {
        if (entries.get(entry.key) !== entry) return;
        console.warn(`tabyBot: cache keep-alive ${entry.key} failed: ${String(err?.message || err).slice(0, 200)}`);
        drop(entry);
    } finally {
        clearTimeout(timer);
        if (entry.abort === abort) entry.abort = null;
    }
}

// 같은 대화의 요청이 새로 시작됨: 예약한 핑을 거두고, 사용자를 기다리던 중이었으면 돌아온 시간을 기록한다.
function beginCall(key, now) {
    const prev = entries.get(key) || null;
    if (prev) {
        clearTimeout(prev.timer);
        prev.abort?.abort();
        entries.delete(key);
        if (prev.waiting === "user") recordGap(key, now - prev.endedAt);
    } else {
        const since = loadStats().open[key];
        if (since) recordGap(key, now - since);
    }
    return prev;
}

function finishCall({ key, client, profile, args, response, startedAt, prev }) {
    const usage = response?.usage || null;
    const stat = modelStat(client.provider, profile);
    learn(stat, { gap: prev ? startedAt - prev.touchedAt : null, usage });
    const message = response?.choices?.[0]?.message;
    const waiting = message?.tool_calls?.length ? "tools" : "user";
    const endedAt = Date.now();
    const entry = {
        key,
        provider: client.provider,
        profile,
        ping: client.ping,
        messages: args.messages,
        length: args.messages.length,
        // 도구 없이 부른 라운드(마지막 정리 답변)가 끝이어도 다음 요청은 도구를 싣고 온다.
        tools: args.tools?.length ? args.tools : prev?.tools,
        promptTokens: Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0,
        waiting,
        touchedAt: startedAt,
        endedAt,
        pings: 0,
        timer: null,
        abort: null,
    };
    entries.set(key, entry);
    if (entries.size > MAX_ENTRIES) drop(entries.values().next().value);
    if (waiting === "user") markOpen(key, endedAt);
    schedule(entry);
}

// LLM 클라이언트의 complete()를 감싸 대화(cacheKey)가 있는 요청마다 캐시 유지를 예약한다.
// client.ping({ cacheKey, messages, tools, tool_choice, signal })은 같은 앞부분의 짧은 요청을 보내고 usage(모르면 undefined,
// 보낼 수 없으면 null)를 돌려준다.
export function withCacheKeepAlive(client) {
    const profile = profileOf(client.provider);
    if (!profile || typeof client.ping !== "function") return client;
    const complete = client.complete;
    return {
        ...client,
        async complete(args) {
            if (!args?.cacheKey || !Array.isArray(args.messages)) return complete(args);
            const key = String(args.cacheKey);
            const startedAt = Date.now();
            const prev = beginCall(key, startedAt);
            const response = await complete(args);
            finishCall({ key, client, profile, args, response, startedAt, prev });
            return response;
        },
    };
}
