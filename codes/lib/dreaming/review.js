import fs from "node:fs";
import path from "node:path";
import { SESSION_DIR } from "../paths.js";
import { skillsDirPath } from "../path-labels.js";
import { getAgentByUuid } from "../agents-store.js";
import { loadChatHistory } from "../agent/chat-history.js";
import { scheduleWork } from "../agent-queue.js";
import { getReviewConfig } from "../self-improvement.js";
import { loadDreamingState, saveDreamingState, appendDreamDiary } from "./state.js";

const queued = new Set();

function activeSessionFilePath(sessionKey) {
    const agent = getAgentByUuid(sessionKey);
    if (!agent?.uuid) return null;
    const root = path.join(SESSION_DIR, agent.uuid);
    const manifestPath = path.join(root, "manifest.json");
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const entry = manifest?.sessions?.find((s) => s.id === manifest.activeSessionId);
        return entry?.file ? path.join(root, entry.file) : null;
    } catch {
        return null;
    }
}

function buildReviewPrompt({ sessionFile, agentName }) {
    return `You are running a background self-improvement review — the user did not send this message and will never see your reply.

A session by agent "${agentName}" just finished non-trivial work. Its full transcript is at:
\`${sessionFile}\`
(JSON: {turns: [{at, status, messages}]}) — focus on the most recent completed turn(s).

Decide whether the session produced something reusable for future sessions:
- a non-trivial technique or workflow that will recur
- a fix, workaround, or recovery from an error
- an explicit user correction or preference worth codifying

If yes: create or update a skill under \`${skillsDirPath()}/<slug>/SKILL.md\` — YAML frontmatter (name, description) plus concise markdown a future run can follow. Check the Available skills list in your system prompt first, and prefer patching an existing related skill over creating a near-duplicate. Create the directory first (mkdir -p via terminal_run), then write the file.

If the session surfaced a durable user fact or correction not yet in memory, you may also patch the memory files.

If nothing durable surfaced, change nothing. Either way, reply with ONLY __SILENT__.`;
}

async function runSessionReview({ sessionKey, agentId }) {
    const agent = getAgentByUuid(sessionKey);
    const sessionFile = activeSessionFilePath(sessionKey);
    if (!agent || !sessionFile || !fs.existsSync(sessionFile)) return;

    const { runAgent } = await import("../agent/loop.js");
    const result = await runAgent(buildReviewPrompt({ sessionFile, agentName: agent.name || agentId }), {
        chatId: sessionKey,
        sessionKey: `dream:review:${sessionKey}`,
        agentId,
        persistHistory: false,
        history: [],
        quietEmpty: true,
    });

    const stamp = new Date().toISOString();
    if (result?.error) {
        appendDreamDiary(`## ${stamp} review (${agentId})\n- failed: ${result.errorDetail || result.error}`);
    } else {
        appendDreamDiary(
            `## ${stamp} review (${agentId})\n- reviewed ${path.basename(sessionFile)} — ${result?.silent ? "no changes reported" : "completed"}`,
        );
    }
}

export function maybeScheduleSessionReview({ sessionKey, agentId, result, automated = false }) {
    // 백그라운드(자동) 턴은 리뷰/학습 대상에서 제외 — 체크인·잡이 리뷰를 연쇄 발동시키지 않게 한다.
    if (automated) return;
    if (getReviewConfig().enabled === false) return;
    if (!result || result.error === "stopped_by_user") return;
    if (String(sessionKey || "").startsWith("dream:")) return;

    const minToolCalls = Number.isFinite(getReviewConfig().minToolCalls) ? getReviewConfig().minToolCalls : 5;
    if ((result.stats?.toolCallCount || 0) < minToolCalls) return;

    const turns = loadChatHistory(sessionKey);
    const turnAt = turns.at(-1)?.at;
    if (!turnAt) return;

    const state = loadDreamingState();
    if (state.reviews[sessionKey] === turnAt) return;
    if (queued.has(sessionKey)) return;

    // 실행 전에 기록해 크래시 루프에서 같은 턴을 반복 리뷰하지 않게 한다.
    state.reviews[sessionKey] = turnAt;
    saveDreamingState(state);
    queued.add(sessionKey);

    scheduleWork("dream", () => runSessionReview({ sessionKey, agentId }), {
        sessionKey: `dream:review:${sessionKey}`,
    })
        .catch((err) => console.error("tabyBot: session review failed:", err?.stack || err))
        .finally(() => queued.delete(sessionKey));
}
