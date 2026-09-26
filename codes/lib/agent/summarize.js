import {
    buildInitialMessages,
    countMessagesTokens,
    countTokens,
    getCompressTriggerTokens,
    getContextLimit,
    getKeepRecentTokenBudget,
} from "./context.js";
import {
    compressedSummaryTurn,
    hasRecoverableChatTurn,
    loadChatHistory,
    replaceChatHistoryAfterCompression,
    turnToMessages,
} from "./chat-history.js";
import { listAgents, getAgentByUuid } from "../agents-store.js";
import { isAgentSessionRunning } from "./session.js";
import { createLlmClient } from "../llm/client.js";

const COMPRESS_SYSTEM = `You compress chat transcripts for long-term context storage.

Output a single markdown block with EXACTLY these sections (omit a section only if empty):
## Goal
The user's goal in this conversation.

## Constraints & Preferences
User preferences, coding style, constraints, and important decisions.

## Progress
### Done
### In Progress
### Blocked

## Key Decisions
Important technical decisions and rationale.

## Relevant Files
Files read, modified, or created (with paths).

## Critical Context
Critical values, error messages, configurations, command outputs that must survive compression.

Rules:
- Preserve facts, numbers, command outputs, decisions, errors, filenames, and what the user wanted.
- Same language as the source (Korean stays Korean, etc.).
- Dense markdown bullets or short paragraphs. No filler, no "summary:" prefix, no preamble.
- Do NOT invent information that is not in the transcript. If you are unsure, omit it.
- Earlier compressed summary (if provided above a --- separator) is already trusted context — preserve its facts and refine/extend, never drop them.`;

const TOOL_OUTPUT_TRIM_THRESHOLD = 600;
const TOOL_OUTPUT_KEEP_HEAD = 200;
const TOOL_OUTPUT_KEEP_TAIL = 200;

function buildWithHistory(userMessage, history, opts = {}) {
    return buildInitialMessages(userMessage, { history, ...opts });
}

function tokenCount(messages, model) {
    return countMessagesTokens(messages, model);
}

function contentToText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (part?.type === "text") return part.text || "";
                if (part?.type === "image_url") return "[image]";
                return `[${part?.type || "part"}]`;
            })
            .join(" ");
    }
    return content == null ? "" : String(content);
}

function trimToolOutput(text) {
    if (typeof text !== "string" || text.length <= TOOL_OUTPUT_TRIM_THRESHOLD) return text;
    const head = text.slice(0, TOOL_OUTPUT_KEEP_HEAD);
    const tail = text.slice(-TOOL_OUTPUT_KEEP_TAIL);
    const omitted = text.length - head.length - tail.length;
    return `${head}\n…[trimmed ${omitted} chars]…\n${tail}`;
}

function messageToTranscriptLine(message) {
    if (message.role === "system") return `System: ${contentToText(message.content)}`;
    if (message.role === "user") return `User: ${contentToText(message.content)}`;
    if (message.role === "assistant") {
        const parts = [`Assistant: ${contentToText(message.content)}`];
        if (message.tool_calls?.length) {
            parts.push(`Tool calls: ${JSON.stringify(message.tool_calls)}`);
        }
        return parts.join("\n");
    }
    if (message.role === "tool") {
        return `Tool (${message.tool_call_id}): ${trimToolOutput(contentToText(message.content))}`;
    }
    return "";
}

function turnToTranscript(turn) {
    return turnToMessages(turn).map(messageToTranscriptLine).filter(Boolean).join("\n\n");
}

function turnTokens(turn, model) {
    return countMessagesTokens(turnToMessages(turn), model);
}

function itemTokens(item, model) {
    if (item.kind === "user") return countTokens(item.text, model);
    return turnTokens(item.turn, model);
}

function splitHistoryForCompression(turns, userMessage, model, recentBudget) {
    const items = turns.map((turn) => ({ kind: "turn", turn }));
    // 수동 압축은 진행 중인 유저 메시지가 없으므로 null을 허용한다.
    if (userMessage != null) items.push({ kind: "user", text: userMessage });

    const recentItems = [];
    let used = 0;
    let splitAt = 0;

    for (let i = items.length - 1; i >= 0; i--) {
        const tok = itemTokens(items[i], model);
        if (used + tok > recentBudget && recentItems.length > 0) {
            splitAt = i + 1;
            break;
        }
        used += tok;
        recentItems.unshift(items[i]);
        if (i === 0) splitAt = 0;
    }

    return {
        oldItems: items.slice(0, splitAt),
        recentItems,
    };
}

function oldItemsToTranscript(oldItems) {
    const lines = [];
    let summaryPrefix = "";
    for (const item of oldItems) {
        if (item.kind === "user") {
            lines.push(`User: ${item.text}`);
        } else {
            // Extract system-message summary turns so they appear above the --- separator
            // in the transcript, telling the compression model to preserve their facts.
            const msgs = turnToMessages(item.turn);
            const summaryMsg = msgs.find((m) => m?.role === "system" && typeof m?.content === "string" && m.content.includes("compressed summary"));
            if (summaryMsg) {
                summaryPrefix = summaryPrefix ? `${summaryPrefix}\n\n${summaryMsg.content}` : summaryMsg.content;
                const remaining = msgs.filter((m) => m !== summaryMsg);
                if (remaining.length) lines.push(remaining.map(messageToTranscriptLine).filter(Boolean).join("\n\n"));
            } else {
                lines.push(turnToTranscript(item.turn));
            }
        }
    }
    const transcript = lines.join("\n\n");
    if (!summaryPrefix) return transcript;
    return `## Earlier conversation (compressed summary)\n\n${summaryPrefix}\n\n---\n\n${transcript}`;
}

function recentItemsToHistory(recentItems) {
    const history = [];
    for (const item of recentItems) {
        if (item.kind === "turn") {
            history.push(item.turn);
        }
    }
    return history;
}

function recentUserMessage(recentItems, fallback) {
    const last = recentItems[recentItems.length - 1];
    if (last?.kind === "user") return last.text;
    return fallback;
}

async function compressTranscript(llm, transcript, { signal } = {}) {
    const response = await llm.complete({
        messages: [
            { role: "system", content: COMPRESS_SYSTEM },
            {
                role: "user",
                content: `Compress this transcript into the structured summary. If a prior compressed summary appears above a "---" separator, treat it as trusted context and refine/extend it rather than dropping its facts:\n\n${transcript}`,
            },
        ],
        tool_choice: "none",
        signal,
    });
    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Compression model returned empty summary");
    return text;
}

function repairToolPairIntegrity(messages) {
    const survivingCallIds = new Set();
    for (const m of messages) {
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc?.id) survivingCallIds.add(tc.id);
            }
        }
    }

    const resultIds = new Set();
    for (const m of messages) {
        if (m.role === "tool" && m.tool_call_id) resultIds.add(m.tool_call_id);
    }

    // Drop orphan tool results (no surviving assistant tool_call for them).
    let repaired = messages.filter((m) => !(m.role === "tool" && m.tool_call_id && !survivingCallIds.has(m.tool_call_id)));

    // Insert stub tool results for orphan tool_calls (assistant asked, no answer).
    const patched = [];
    for (const m of repaired) {
        patched.push(m);
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc?.id && !resultIds.has(tc.id)) {
                    patched.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: "[Result from earlier conversation — see context summary above]",
                    });
                    resultIds.add(tc.id);
                }
            }
        }
    }

    return patched;
}

async function applyIntelligentCompression(
    llm,
    userMessage,
    fullHistory,
    model,
    modelMeta,
    attachments = [],
    { signal, runtimeInfo = {}, chatId = null, archiveReason = "context_compression" } = {},
) {
    const recentBudget = getKeepRecentTokenBudget(modelMeta);
    const { oldItems, recentItems } = splitHistoryForCompression(fullHistory, userMessage, model, recentBudget);

    if (!oldItems.length) {
        return null;
    }

    const transcript = oldItemsToTranscript(oldItems);

    console.log(`tabyBot: compressing context (${oldItems.length} older block(s), keeping ~${recentBudget} recent tokens verbatim)`);

    const summary = await compressTranscript(llm, transcript, { signal });
    const recentHistory = recentItemsToHistory(recentItems);
    const latestUser = recentUserMessage(recentItems, userMessage);

    if (chatId) {
        replaceChatHistoryAfterCompression(chatId, recentHistory, summary, { reason: archiveReason });
    }

    // 디스크에 저장된 요약을 진행 중인 요청에도 그대로 실어야
    // 압축 직후 첫 응답이 요약 전 컨텍스트를 잃지 않는다.
    const historyWithSummary = summary?.trim() ? [compressedSummaryTurn(summary), ...recentHistory] : recentHistory;
    const rebuilt = buildWithHistory(latestUser, historyWithSummary, {
        modelMeta,
        attachments,
        runtimeInfo,
    });
    return repairToolPairIntegrity(rebuilt);
}

export async function ensureWithinContextLimit(
    llm,
    userMessage,
    modelMeta,
    { chatId, onStatusPhase, attachments = [], session = null, runtimeInfo = {}, history = null } = {},
) {
    const fullHistory = history ?? (chatId ? loadChatHistory(chatId) : []);
    const model = llm.provider.model;
    const trigger = getCompressTriggerTokens(modelMeta);
    const hardLimit = getContextLimit(modelMeta);

    const buildOpts = { attachments, modelMeta, runtimeInfo };
    let messages = buildWithHistory(userMessage, fullHistory, buildOpts);
    let tokens = tokenCount(messages, model);

    if (tokens <= trigger) {
        return { messages, didCompress: false };
    }

    messages = buildWithHistory(userMessage, fullHistory, {
        truncateMemory: true,
        maxMemoryChars: 60000,
        ...buildOpts,
    });
    tokens = tokenCount(messages, model);

    if (tokens <= trigger) {
        return { messages, didCompress: false };
    }

    let compressed = null;
    try {
        if (session?.isAborted?.()) {
            return { messages, didCompress: false };
        }
        onStatusPhase?.("compressing");
        compressed = await applyIntelligentCompression(llm, userMessage, fullHistory, model, modelMeta, attachments, {
            signal: session?.signal,
            runtimeInfo,
            chatId,
        });
        if (compressed) {
            messages = compressed;
            tokens = tokenCount(messages, model);
        }
    } catch (err) {
        if (session?.isAborted?.() || err?.name === "AbortError") {
            throw err;
        }
        console.warn("tabyBot: intelligent compression failed:", err.message || err);
    }

    if (tokens <= hardLimit) {
        return { messages, didCompress: Boolean(compressed) };
    }

    return {
        messages: buildWithHistory(userMessage, [], {
            truncateMemory: true,
            maxMemoryChars: 40000,
            ...buildOpts,
        }),
        didCompress: false,
    };
}

/* ── 수동 세션 압축(설정 → 모델 → 고급) ─────────────────────
   자동 압축(applyIntelligentCompression)과 같은 함수를 그대로 호출하되
   트리거만 수동이다 — 진행 중인 유저 메시지가 없으므로 null을 넘기고,
   반환된 재구성 메시지는 진행 중 요청이 없어 버린다. */
// 세션에 압축할 실제 대화가 있는지 — 실행 중/복구 대기/빈 세션은 false.
function sessionNeedsCompression(chatId) {
    if (isAgentSessionRunning(chatId) || hasRecoverableChatTurn(chatId)) return false;
    const turns = loadChatHistory(chatId);
    return turns.some((t) => (t?.messages || []).some((m) => m?.role !== "system"));
}

async function compressSessionHistory(llm, chatId) {
    // 실행 중이거나 복구 대기(pending/interrupted) 턴이 있는 세션은 건드리지 않는다.
    if (!sessionNeedsCompression(chatId)) return false;
    const compressed = await applyIntelligentCompression(llm, null, loadChatHistory(chatId), llm.provider.model, llm.modelMeta, [], {
        chatId,
        archiveReason: "manual_compression",
    });
    return compressed !== null;
}

// chatIds를 생략하면 모든 봇의 활성 세션을 압축한다.
// 반환: { compressed, skipped, failed } — 실행 중/빈 세션은 skipped로 센다.
export async function compressBotSessions(chatIds = null) {
    const ids =
        Array.isArray(chatIds) && chatIds.length
            ? chatIds
            : listAgents()
                  .map((a) => a.uuid)
                  .filter(Boolean);
    const result = { compressed: 0, skipped: 0, failed: 0 };
    // 압축할 게 하나도 없으면 모델 클라이언트 자체를 만들지 않는다.
    const candidates = ids.filter(sessionNeedsCompression);
    result.skipped = ids.length - candidates.length;
    if (!candidates.length) return result;
    // 자동 압축처럼 각 봇의 모델/사고 수준 오버라이드를 반영한 클라이언트로
    // 요약한다 — 같은 오버라이드 조합은 클라이언트를 재사용한다.
    const clients = new Map();
    const clientFor = async (chatId) => {
        const agent = getAgentByUuid(chatId);
        const model = agent?.model?.trim() || "";
        const thinkingLevel = agent?.thinkingLevel || "";
        const key = `${model}|${thinkingLevel}`;
        if (!clients.has(key)) clients.set(key, await createLlmClient({ model, thinkingLevel }));
        return clients.get(key);
    };
    for (const chatId of candidates) {
        try {
            const llm = await clientFor(chatId);
            if (await compressSessionHistory(llm, chatId)) result.compressed += 1;
            else result.skipped += 1;
        } catch (err) {
            console.warn(`tabyBot: manual session compression failed for ${chatId}:`, err?.message || err);
            result.failed += 1;
        }
    }
    return result;
}
