import {
    buildInitialMessages,
    countMessagesTokens,
    countTokens,
    getCompressTriggerTokens,
    getContextLimit,
    getKeepRecentTokenBudget,
} from "./context.js";
import { loadChatHistory, replaceChatHistoryAfterCompression, turnToMessages } from "./chat-history.js";

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
    items.push({ kind: "user", text: userMessage });

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
    visionAttachment = null,
    { signal, runtimeInfo = {}, chatId = null } = {},
) {
    const recentBudget = getKeepRecentTokenBudget(modelMeta);
    const { oldItems, recentItems } = splitHistoryForCompression(fullHistory, userMessage, model, recentBudget);

    if (!oldItems.length) {
        return null;
    }

    const transcript = oldItemsToTranscript(oldItems);

    console.log(`tabyAgent: compressing context (${oldItems.length} older block(s), keeping ~${recentBudget} recent tokens verbatim)`);

    const summary = await compressTranscript(llm, transcript, { signal });
    const recentHistory = recentItemsToHistory(recentItems);
    const latestUser = recentUserMessage(recentItems, userMessage);

    if (chatId) {
        replaceChatHistoryAfterCompression(chatId, recentHistory, summary);
    }

    const rebuilt = buildWithHistory(latestUser, recentHistory, {
        modelMeta,
        visionAttachment,
        runtimeInfo,
    });
    return repairToolPairIntegrity(rebuilt);
}

export async function ensureWithinContextLimit(
    llm,
    userMessage,
    modelMeta,
    { chatId, onStatusPhase, visionAttachment = null, session = null, runtimeInfo = {}, history = null } = {},
) {
    const fullHistory = history ?? (chatId ? loadChatHistory(chatId) : []);
    const model = llm.provider.model;
    const trigger = getCompressTriggerTokens(modelMeta);
    const hardLimit = getContextLimit(modelMeta);

    const buildOpts = { visionAttachment, modelMeta, runtimeInfo };
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
        compressed = await applyIntelligentCompression(llm, userMessage, fullHistory, model, modelMeta, visionAttachment, {
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
        console.warn("tabyAgent: intelligent compression failed:", err.message || err);
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
