// 자기 개선(백그라운드 자동화) 설정.
// 해석 순서: 하드코딩 기본값 ← agent.json ← 사용자 config.selfImprovement.
import cron from "node-cron";
import { loadAgentConfig, loadUserConfig } from "./config-loader.js";
import { isValidTimeZone } from "./scheduling/time.js";

function numOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function boolOr(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}

function strOr(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function getDreamingConfig() {
    const userCfg = loadUserConfig();
    const agent = loadAgentConfig().dreaming || {};
    const user = userCfg.selfImprovement?.dreaming || {};
    return {
        enabled: boolOr(user.enabled, boolOr(agent.enabled, true)),
        cron: strOr(user.cron, strOr(agent.cron, "0 4 * * *")),
        idleMin: numOr(user.idleMin, numOr(agent.idleMin, 30)),
        maxOpsPerRun: numOr(user.maxOpsPerRun, numOr(agent.maxOpsPerRun, 5)),
        // 섹션별 오버라이드 → 사용자 전역 timezone(브라우저가 보고) → 시스템 기본값
        timezone: strOr(user.timezone, strOr(agent.timezone, strOr(userCfg.timezone, ""))),
    };
}

export function getReviewConfig() {
    const agent = loadAgentConfig().dreaming || {};
    const user = loadUserConfig().selfImprovement?.review || {};
    return {
        enabled: boolOr(user.enabled, boolOr(agent.reviewEnabled, true)),
        minToolCalls: numOr(user.minToolCalls, numOr(agent.reviewMinToolCalls, 5)),
    };
}

export function getProactiveConfig() {
    const userCfg = loadUserConfig();
    const agent = loadAgentConfig().proactive || {};
    const user = userCfg.selfImprovement?.proactive || {};
    return {
        enabled: boolOr(user.enabled, boolOr(agent.enabled, true)),
        intervalMin: numOr(user.intervalMin, numOr(agent.intervalMin, 360)),
        activeStartHour: numOr(user.activeStartHour, numOr(agent.activeStartHour, 8)),
        activeEndHour: numOr(user.activeEndHour, numOr(agent.activeEndHour, 23)),
        idleMin: numOr(user.idleMin, numOr(agent.idleMin, 30)),
        timezone: strOr(user.timezone, strOr(agent.timezone, strOr(userCfg.timezone, ""))),
    };
}

// PUT /api/settings 의 selfImprovement 패치 스키마.
// bool = 불리언 / cron = 크론식 / tz = IANA 타임존 / ["num"|"int", min, max] = 범위 클램프.
const SI_FIELDS = {
    dreaming: {
        enabled: "bool",
        cron: "cron",
        idleMin: ["num", 0, 1440],
        maxOpsPerRun: ["int", 1, 50],
        timezone: "tz",
    },
    review: {
        enabled: "bool",
        minToolCalls: ["int", 1, 100],
    },
    proactive: {
        enabled: "bool",
        intervalMin: ["num", 5, 1440],
        activeStartHour: ["int", 0, 23],
        activeEndHour: ["int", 0, 24],
        idleMin: ["num", 0, 1440],
        timezone: "tz",
    },
};

// target(config.selfImprovement)에 패치를 검증·적용한다. 실패 시 에러 코드 문자열.
export function applySelfImprovementPatch(target, patch) {
    if (typeof patch !== "object" || patch === null) return "invalid_self_improvement";
    for (const [section, fields] of Object.entries(SI_FIELDS)) {
        const src = patch[section];
        if (src === undefined) continue;
        if (typeof src !== "object" || src === null) return "invalid_self_improvement";
        const out = (target[section] = target[section] || {});
        for (const [key, spec] of Object.entries(fields)) {
            const value = src[key];
            if (value === undefined) continue;
            if (spec === "bool") {
                out[key] = Boolean(value);
            } else if (spec === "cron") {
                const v = String(value ?? "").trim();
                if (v && !cron.validate(v)) return "invalid_cron";
                out[key] = v;
            } else if (spec === "tz") {
                const v = String(value ?? "").trim();
                if (v && !isValidTimeZone(v)) return "invalid_timezone";
                out[key] = v;
            } else {
                const [kind, lo, hi] = spec;
                const n = Number(value);
                if (!Number.isFinite(n)) return "invalid_self_improvement";
                const rounded = kind === "int" ? Math.round(n) : n;
                out[key] = Math.min(hi, Math.max(lo, rounded));
            }
        }
    }
    return null;
}
