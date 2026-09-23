import { listAgents } from "./agents-store.js";
import { scheduleWork } from "./agent-queue.js";
import { getProactiveConfig } from "./self-improvement.js";
import { defaultTimeZone, isValidTimeZone } from "./scheduling/time.js";
import { isUserIdle, DEFAULT_IDLE_REQUIRED_MS } from "./user-activity.js";

const TICK_MS = 60_000;

export const CHECKIN_PROMPT = `This is a proactive check-in — you are reaching out first, not answering a request.

Look for anything the user would actually want to know right now:
- Open user todos due soon or overdue. If one looks doable by you, is not assigned to anyone, and you have NOT already offered on it (its line shows "you already offered" when you have), offer it with todo_offer. Otherwise remind briefly.
- Your automations' recent runs — findings the user has not seen yet.
- Missed promises: anything in memory or recent sessions where you said you would tell the user something later ("I'll let you know at 9", "I'll check tomorrow") but no automation exists for it. These are dropped notifications — surface them now, and create the missing automation with todo_add so it cannot be lost again.
- Recent sessions: unanswered questions, open threads, follow-ups left hanging. Use session_search for older context.
- Missed routines: if your memory's "## Routines" section lists a time-anchored routine whose usual window has fully passed today AND today's activity shows no sign of it (this thread; session_search today's sessions across bots if unsure), you may gently ask once — a light question, never an alarm. Strict limits: only routines explicitly listed there (never infer new ones), at most one routine mention per check-in, never if you already asked about it today (check your recent messages), and when in doubt whether it happened today, stay silent.
- Something NEW and time-sensitive: a fresh release, a just-announced event, a deadline that only now became urgent. A static date or fact already sitting in memory is not a finding.

Rules:
- Speak only when you have something genuinely useful. Lead with the useful part, keep it short, match the user's language.
- **New to the user, not new to you.** The user is one person across all bots — a fact any bot already surfaced, or one already stored in memory, is not news. Never recite stored schedules, holdings, or dates the user already knows. Unsure whether it was already surfaced? session_search first; still unsure, stay silent.
- If you notice a recurring "tell me when X" need with no automation yet, create it yourself with todo_add and mention it in one line.
- Do not repeat yourself: if you or another bot already surfaced something and nothing changed, stay silent.
- No filler ("just checking in", "how can I help"). Every message must carry information or a concrete suggestion.
- If nothing qualifies, reply with ONLY __SILENT__ — no preamble, no "nothing new to report", no narrating what you checked. NOT OK: "Nothing new to surface. __SILENT__", "I'll just check todos and times, then move on." The entire reply is the marker or it is a real message — never both.`;

let timer = null;
let runCheckin = null;
const lastRunAt = new Map();
const inFlight = new Set();

export function setProactiveRunner(fn) {
    runCheckin = fn;
}

function localHour(now, timeZone) {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
    return Number.isFinite(h) ? h % 24 : now.getHours();
}

function proactiveConfig() {
    const cfg = getProactiveConfig();
    return {
        enabled: cfg.enabled !== false,
        intervalMs: Math.max(5, cfg.intervalMin || 360) * 60_000,
        startHour: Number.isInteger(cfg.activeStartHour) ? cfg.activeStartHour : 8,
        endHour: Number.isInteger(cfg.activeEndHour) ? cfg.activeEndHour : 23,
        idleMs: Number.isFinite(cfg.idleMin) ? cfg.idleMin * 60_000 : DEFAULT_IDLE_REQUIRED_MS,
        timeZone: isValidTimeZone(cfg.timezone) ? cfg.timezone : defaultTimeZone(),
    };
}

export function proactiveTick(now = new Date()) {
    if (!runCheckin) return { ran: 0, reason: "no_runner" };
    const cfg = proactiveConfig();
    if (!cfg.enabled) return { ran: 0, reason: "disabled" };
    const hour = localHour(now, cfg.timeZone);
    if (hour < cfg.startHour || hour >= cfg.endHour) return { ran: 0, reason: "outside_hours" };
    if (!isUserIdle(cfg.idleMs)) return { ran: 0, reason: "user_active" };
    const pending = [];
    for (const agent of listAgents()) {
        if (inFlight.has(agent.uuid)) continue;
        const last = lastRunAt.get(agent.uuid) || 0;
        if (now.getTime() - last < cfg.intervalMs) continue;
        inFlight.add(agent.uuid);
        lastRunAt.set(agent.uuid, now.getTime());
        pending.push(
            scheduleWork("proactive", () => runCheckin(agent), { sessionKey: agent.uuid, cancellable: true })
                .catch((err) => console.error(`tabyBot: proactive check-in failed (${agent.id}):`, err?.stack || err))
                .finally(() => inFlight.delete(agent.uuid)),
        );
    }
    return { ran: pending.length, done: Promise.allSettled(pending) };
}

export function startProactiveScheduler() {
    // 타이머는 비활성이어도 항상 둔다 — enabled 등 설정은 매 틱 다시 읽어
    // 설정 화면 변경이 재시작 없이 반영된다.
    if (!timer) {
        timer = setInterval(() => {
            try {
                proactiveTick();
            } catch (err) {
                console.error("tabyBot: proactive tick failed:", err?.stack || err);
            }
        }, TICK_MS);
        timer.unref?.();
    }
    console.log(`tabyBot: proactive check-in ${getProactiveConfig().enabled ? "scheduled" : "disabled"}`);
}

export function stopProactiveScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
