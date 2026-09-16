import fs from "node:fs";
import path from "node:path";
import { SESSION_DIR, USER_DIR } from "../paths.js";
import { agentMemoryPath, listAgents } from "../agents-store.js";
import { extractSessionTextLines } from "../agent/chat-history.js";
import { createLlmClient } from "../llm/client.js";
import { writeFileAtomic } from "../atomic-file.js";
import { loadAgentConfig } from "../config-loader.js";
import { appendDreamDiary, dreamBackupDir, loadDreamingState, saveDreamingState } from "./state.js";

const MEMORY_PATH = path.join(USER_DIR, "memory.md");

const PER_FILE_CHAR_CAP = 6000;
const TOTAL_CHAR_CAP = 24000;
const MEMORY_INPUT_CAP = 40000;
const AGENT_MEMORY_INPUT_CAP = 20000;
const MAX_SESSION_FILES = 200;

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

function readText(filePath, cap) {
    try {
        const text = fs.readFileSync(filePath, "utf8");
        return text.length > cap ? `${text.slice(0, cap)}\n\n...[truncated]...` : text;
    } catch {
        return "";
    }
}

// Light phase — state.ingested의 {mtime, lines, done} 포인터 이후 새 줄만 수집한다.
export function collectCandidates(state) {
    const candidates = [];
    let scannedFiles = 0;
    let totalChars = 0;

    for (const agent of listAgents()) {
        const root = path.join(SESSION_DIR, agent.uuid);
        const manifest = readJson(path.join(root, "manifest.json"));
        if (!manifest?.sessions?.length) continue;

        // 캡에 걸릴 때를 대비해 최신 세션부터 본다.
        const entries = [...manifest.sessions].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
        for (const entry of entries.slice(0, MAX_SESSION_FILES)) {
            const filePath = path.join(root, entry.file);
            let mtime;
            try {
                mtime = fs.statSync(filePath).mtimeMs;
            } catch {
                continue;
            }
            const key = `${agent.uuid}/${entry.file}`;
            const prev = state.ingested[key];
            if (prev && prev.mtime === mtime && prev.done) continue;

            const data = readJson(filePath);
            const lines = extractSessionTextLines(data?.turns);
            const base = prev?.lines || 0;
            const fresh = lines.slice(base);
            if (!fresh.length) {
                state.ingested[key] = { mtime, lines: lines.length, done: true };
                continue;
            }

            scannedFiles += 1;
            let consumed = 0;
            for (const line of fresh) {
                const len = line.text.length + 40;
                if (len > PER_FILE_CHAR_CAP) {
                    consumed += 1; // 초대형 붙여넣기 줄은 영구 스킵
                    continue;
                }
                if (totalChars + len > TOTAL_CHAR_CAP) break; // 캡 초과분은 다음 스윕으로 미룬다
                candidates.push({
                    agent: agent.id,
                    agentName: agent.name,
                    session: entry.id,
                    role: line.role,
                    at: line.at,
                    text: line.text,
                });
                totalChars += len;
                consumed += 1;
                if (totalChars >= TOTAL_CHAR_CAP) break;
            }
            state.ingested[key] = { mtime, lines: base + consumed, done: consumed >= fresh.length };
            if (totalChars >= TOTAL_CHAR_CAP) return { candidates, scannedFiles };
        }
    }
    return { candidates, scannedFiles };
}

const DEEP_SYSTEM = `You are the memory consolidation pass of a personal AI assistant — a "dream" sweep that runs on a schedule, outside any live conversation.

You receive:
1. CURRENT MEMORY — the durable memory files injected into every future session: one shared file for basic user facts, plus one private file per bot.
2. CANDIDATES — conversation lines produced since the last sweep (user and assistant messages only).

Decide which candidates deserve durable memory, then return a JSON object:
{"ops":[{"op":"add"|"replace"|"remove","target":"shared"|"<agentId>","section":"<heading without ##>","find":"<exact existing substring>","text":"declarative fact","reason":"why"}],"routines":[{"target":"<agentId>","key":"<slug>","text":"<activity> — usually around <HH:MM> local","day":"<YYYY-MM-DD of that candidate>"}],"summary":"<one line>"}

Rules:
- Promote only what still matters in a week: stable user facts, preferences, corrections, decisions, durable project context. Skip small talk, one-off task details, anything secret-shaped.
- Write declarative facts ("User prefers concise replies"), never self-instructions ("Always reply concisely").
- target "shared" is for basic user facts every bot needs (school, region, occupation, stable communication preferences). A bot's own id targets that bot's private memory (its domain, holdings, watchlists, decisions).
- Prefer replace/remove over add when a candidate refines or contradicts an existing entry. Merge near-duplicates instead of stacking them.
- Routines — recurring time-anchored user patterns ("studies Japanese around 21:00"). Two paths:
  - The user explicitly stated it as a routine → "add" under "## Routines" of the observing bot's memory (never "shared" — every bot would nudge it). Format: "- <activity> — usually around <HH:MM> local".
  - You only OBSERVED it in candidates → do NOT write memory. Emit it in the top-level "routines" array instead — sightings accumulate across sweeps and auto-promote after 3 separate days.
- Remove "## Routines" entries the user clearly dropped.
- "add" appends "- <text>" under the "## <section>" heading (created if missing). "replace" and "remove" require "find": a substring that occurs EXACTLY ONCE in the target file — copy it verbatim from CURRENT MEMORY.
- Never touch the "## Setup" section.
- At most {{MAX_OPS}} ops. Zero ops is a valid, common result — do not invent memories to justify the run.
- Respond with JSON only. No prose, no code fences.`;

function formatMemorySections() {
    const parts = [`### target "shared" — memory.md\n\n${readText(MEMORY_PATH, MEMORY_INPUT_CAP) || "(empty)"}`];
    for (const agent of listAgents()) {
        const body = readText(agentMemoryPath(agent.id), AGENT_MEMORY_INPUT_CAP) || "(empty)";
        parts.push(`### target "${agent.id}" — ${agent.name} private memory\n\n${body}`);
    }
    return parts.join("\n\n");
}

function formatCandidates(candidates) {
    return candidates.map((c, i) => `#${i + 1} [${c.agentName}/${c.session} ${c.at || ""}] ${c.role}: ${c.text}`).join("\n\n");
}

export function parseDecision(text) {
    const trimmed = String(text || "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object in consolidation reply");
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return {
        ops: Array.isArray(parsed?.ops) ? parsed.ops : [],
        routines: Array.isArray(parsed?.routines) ? parsed.routines : [],
        summary: typeof parsed?.summary === "string" ? parsed.summary : "",
    };
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count += 1;
        idx += needle.length;
    }
    return count;
}

function sectionBounds(content, section) {
    const re = /^##\s+(.+?)\s*$/gm;
    let match;
    while ((match = re.exec(content))) {
        const name = match[1].trim().toLowerCase();
        const bodyStart = match.index + match[0].length;
        const next = /^##\s/m.exec(content.slice(bodyStart));
        const end = next ? bodyStart + next.index : content.length;
        if (name === section.trim().toLowerCase()) return { start: match.index, bodyStart, end };
    }
    return null;
}

function normalizeSectionName(section) {
    return String(section || "")
        .trim()
        .replace(/^#+\s*/, "")
        .trim();
}

function normalizeFactText(text) {
    return String(text || "")
        .trim()
        .replace(/^[-*]\s+/, "");
}

function insideSetupSection(content, index) {
    const setup = sectionBounds(content, "Setup");
    return Boolean(setup && index >= setup.start && index < setup.end);
}

function applyAdd(content, section, text) {
    const name = normalizeSectionName(section);
    const fact = `- ${normalizeFactText(text)}`;
    const bounds = name ? sectionBounds(content, name) : null;
    if (!bounds) {
        const heading = `## ${name || "General"}`;
        return `${content.trimEnd()}\n\n${heading}\n${fact}\n`;
    }
    const body = content.slice(bounds.bodyStart, bounds.end).trimEnd();
    const newBody = `${body}\n${fact}\n`;
    const rest = content.slice(bounds.end);
    return content.slice(0, bounds.bodyStart) + newBody + (rest ? `\n${rest}` : "");
}

function applyReplace(content, find, text) {
    if (countOccurrences(content, find) !== 1) return null;
    return content.replace(find, () => String(text || "").trim());
}

function applyRemove(content, find) {
    if (find.includes("\n")) {
        if (countOccurrences(content, find) !== 1) return null;
        return content.replace(find, () => "").replace(/\n{3,}/g, "\n\n");
    }
    const lines = content.split("\n");
    const hits = lines.map((l, i) => (l.includes(find) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) return null;
    lines.splice(hits[0], 1);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function validateOp(op, agentsById) {
    if (!op || typeof op !== "object") return "not an object";
    const kind = String(op.op || "");
    if (!["add", "replace", "remove"].includes(kind)) return `unknown op: ${kind}`;
    const target = String(op.target || "shared");
    if (target !== "shared" && !agentsById.has(target)) return `unknown target: ${target}`;
    if (kind === "add") {
        if (!String(op.text || "").trim()) return "add needs text";
        if (normalizeSectionName(op.section).toLowerCase() === "setup") return "Setup section is off-limits";
    } else {
        if (!String(op.find || "").trim()) return `${kind} needs find`;
        if (kind === "replace" && !String(op.text || "").trim()) return "replace needs text";
    }
    return null;
}

function targetFileFor(target) {
    if (target === "shared") return { filePath: MEMORY_PATH, label: "memory.md" };
    return { filePath: agentMemoryPath(target), label: `${target}.memory.md` };
}

function backupOnce(backupDir, filePath, label, done) {
    if (done.has(filePath) || !fs.existsSync(filePath)) return;
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(backupDir, label));
    done.add(filePath);
}

export function applyOps(ops, { maxOps, backupDir, resolveTarget = targetFileFor } = {}) {
    const agentsById = new Map(listAgents().map((a) => [a.id, a]));
    const results = [];
    const contents = new Map();
    const backedUp = new Set();
    let applied = 0;

    const loadContent = (filePath) => {
        if (!contents.has(filePath)) contents.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "");
        return contents.get(filePath);
    };

    for (const op of ops) {
        if (applied >= maxOps) {
            results.push({ op, ok: false, detail: `over per-run cap (${maxOps})` });
            continue;
        }
        const invalid = validateOp(op, agentsById);
        if (invalid) {
            results.push({ op, ok: false, detail: invalid });
            continue;
        }
        const target = String(op.target || "shared");
        const { filePath, label } = resolveTarget(target);
        const content = loadContent(filePath);
        const findIdx = op.find ? content.indexOf(String(op.find)) : -1;
        if (op.find && findIdx !== -1 && insideSetupSection(content, findIdx)) {
            results.push({ op, ok: false, detail: "find lands inside ## Setup" });
            continue;
        }

        let next = null;
        if (op.op === "add") next = applyAdd(content, String(op.section || "General"), op.text);
        else if (op.op === "replace") next = applyReplace(content, String(op.find), op.text);
        else next = applyRemove(content, String(op.find));

        if (next === null || next === content) {
            results.push({ op, ok: false, detail: "find not unique or not found" });
            continue;
        }
        contents.set(filePath, next);
        backupOnce(backupDir, filePath, label, backedUp);
        writeFileAtomic(filePath, next);
        applied += 1;
        results.push({ op, ok: true, detail: label });
    }

    return results;
}

const ROUTINE_WATCH_STALE_MS = 14 * 24 * 3600 * 1000;
const ROUTINE_PROMOTE_DAYS = 3;
const ROUTINE_PROMOTE_CAP = 2;

// 관찰된 루틴 신호를 스윕 간에 누적한다. LLM은 신호만 보내고,
// 날짜 수 세기와 승격은 코드가 한다 — 뇌는 판단, 손은 적용.
export function accumulateRoutines(routines, state, { backupDir, diary = [] } = {}) {
    state.routineWatch = state.routineWatch || {};
    const now = Date.now();
    const agents = new Set(listAgents().map((a) => a.id));
    const promotions = [];

    for (const raw of Array.isArray(routines) ? routines : []) {
        const target = String(raw?.target || "");
        const key = String(raw?.key || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .slice(0, 60);
        const day = /^\d{4}-\d{2}-\d{2}/.exec(String(raw?.day || ""))?.[0] || "";
        const text = String(raw?.text || "")
            .trim()
            .slice(0, 200);
        if (!agents.has(target) || !key || !day || !text) continue;

        const watchKey = `${target}/${key}`;
        const entry = (state.routineWatch[watchKey] ||= { days: [], text, lastSeen: 0 });
        if (!Array.isArray(entry.days)) entry.days = [];
        entry.text = text;
        entry.lastSeen = now;
        if (!entry.days.includes(day)) entry.days.push(day);
        if (entry.days.length < ROUTINE_PROMOTE_DAYS) continue;

        const memText = readText(agentMemoryPath(target), AGENT_MEMORY_INPUT_CAP).toLowerCase();
        const activity = entry.text
            .split("—")[0]
            .replace(/^[-*]\s+/, "")
            .trim()
            .toLowerCase();
        if (activity && memText.includes(activity)) {
            delete state.routineWatch[watchKey]; // 이미 기억하고 있는 루틴
            continue;
        }
        promotions.push({
            op: "add",
            target,
            section: "Routines",
            text: entry.text,
            reason: `observed on ${entry.days.length} separate days`,
        });
        delete state.routineWatch[watchKey];
    }

    for (const [wk, entry] of Object.entries(state.routineWatch)) {
        if (now - (entry?.lastSeen || 0) > ROUTINE_WATCH_STALE_MS) delete state.routineWatch[wk];
    }
    const watchKeys = Object.keys(state.routineWatch);
    if (watchKeys.length > 100) {
        for (const wk of watchKeys
            .sort((a, b) => (state.routineWatch[a]?.lastSeen || 0) - (state.routineWatch[b]?.lastSeen || 0))
            .slice(0, watchKeys.length - 100)) {
            delete state.routineWatch[wk];
        }
    }

    for (const op of promotions.slice(0, ROUTINE_PROMOTE_CAP)) {
        const results = applyOps([op], { maxOps: 1, backupDir });
        const r = results[0];
        diary.push(
            `- ${r?.ok ? "promoted routine" : "routine rejected"} ${describeOp(r?.op || op)}${r?.ok ? "" : `: ${r?.detail || "apply failed"}`}`,
        );
    }
    return promotions.length;
}

function describeOp(op) {
    const target = String(op.target || "shared");
    const what = op.op === "add" ? `"${normalizeFactText(op.text).slice(0, 80)}"` : `"${String(op.find || "").slice(0, 60)}"`;
    return `${op.op} → ${target}${op.section ? `/${op.section}` : ""} ${what}`;
}

export async function runDreamSweep({ trigger = "cron" } = {}) {
    const cfg = loadAgentConfig().dreaming || {};
    const maxOps = Number.isFinite(cfg.maxOpsPerRun) ? cfg.maxOpsPerRun : 5;
    const now = new Date();
    const state = loadDreamingState();
    const { candidates, scannedFiles } = collectCandidates(state);

    const diary = [`## ${now.toISOString()} sweep (${trigger})`];
    diary.push(`- Scanned ${scannedFiles} session file(s) → ${candidates.length} candidate line(s)`);

    if (!candidates.length) {
        state.lastSweepAt = now.toISOString();
        saveDreamingState(state);
        diary.push("- No new material; nothing to consolidate.");
        appendDreamDiary(diary.join("\n"));
        return { ok: true, candidates: 0, applied: 0 };
    }

    let decision;
    try {
        const llm = await createLlmClient();
        const response = await llm.complete({
            messages: [
                { role: "system", content: DEEP_SYSTEM.replace("{{MAX_OPS}}", String(maxOps)) },
                {
                    role: "user",
                    content: `## CURRENT MEMORY\n\n${formatMemorySections()}\n\n## CANDIDATES\n\n${formatCandidates(candidates)}\n\nReturn JSON only.`,
                },
            ],
            tool_choice: "none",
        });
        decision = parseDecision(response.choices?.[0]?.message?.content);
    } catch (err) {
        // ingested 포인터를 저장하지 않는다 — 다음 스윕이 같은 후보를 다시 본다.
        diary.push(`- Consolidation call failed: ${err?.message || err}. Will retry next sweep.`);
        appendDreamDiary(diary.join("\n"));
        console.error("tabyBot: dream sweep consolidation failed:", err?.message || err);
        return { ok: false, error: err?.message || String(err) };
    }

    const backupDir = dreamBackupDir(now);
    const results = applyOps(decision.ops, { maxOps, backupDir });
    const applied = results.filter((r) => r.ok).length;

    for (const r of results) {
        diary.push(
            `- ${r.ok ? "applied" : "rejected"} ${describeOp(r.op)} — ${r.ok ? r.detail : `rejected: ${r.detail}`}${r.op?.reason ? ` (${r.op.reason})` : ""}`,
        );
    }
    accumulateRoutines(decision.routines, state, { backupDir, diary });
    if (!results.length) diary.push("- Model returned no ops; nothing durable surfaced.");
    if (decision.summary) diary.push(`- summary: ${decision.summary}`);

    state.lastSweepAt = now.toISOString();
    saveDreamingState(state);
    appendDreamDiary(diary.join("\n"));
    console.log(`tabyBot: dream sweep done — ${candidates.length} candidates, ${applied} op(s) applied`);
    return { ok: true, candidates: candidates.length, applied };
}
