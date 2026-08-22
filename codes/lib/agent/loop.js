import { loadAgentConfig } from "../config-loader.js";
import { createLlmClient } from "../llm/client.js";
import { assistantMessageToPlain } from "../llm/messages.js";
import { executeTool, getAllToolDefinitions, toolResultContent } from "./tool-registry.js";
import { buildToolResultContent } from "../llm/vision.js";
import { extractTurnMessages } from "./chat-history.js";
import { ensureWithinContextLimit } from "./summarize.js";
import { clearFileReadCache } from "../tools/file.js";
import { countMessagesTokens } from "./context.js";
function parseToolArgs(raw) {
    try {
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
}

function buildStats(llm, messages, contextBaseLength, toolCallCount, modelCallCount) {
    const model = llm.provider.model;
    const contextWindow = llm.modelMeta?.contextWindow ?? 128000;
    const loadedContext = countMessagesTokens(messages.slice(0, contextBaseLength), model);
    const peakContext = countMessagesTokens(messages, model);
    return {
        toolCallCount,
        modelCallCount,
        tokensUsed: Math.max(loadedContext, peakContext),
        contextWindow,
    };
}

function buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCount, extra = {}) {
    return {
        ...extra,
        stats: buildStats(llm, messages, contextBaseLength, toolCallCount, modelCallCount),
        turnMessages: extractTurnMessages(messages, contextBaseLength),
    };
}

function toolSignature(name, args) {
    return `${name}:${JSON.stringify(args)}`;
}

const FORCE_REPLY_HINT = "You have enough tool output. Stop calling tools. Reply to the user in plain text now using results you already have.";
const EMPTY_REPLY_HINT =
    "Your previous assistant reply was empty. Reply to the user in plain text now. Summarize what you accomplished and answer their request.";

const SILENT_REPLY_TOKEN = "__SILENT__";

function isSilentReply(content) {
    return typeof content === "string" && content.trim() === SILENT_REPLY_TOKEN;
}

function stripSilentReply(content) {
    if (!content) return null;
    if (isSilentReply(content)) return null;
    return content;
}
function injectPendingUserMessages(messages, session) {
    if (!session) return false;
    const pending = session.drainPendingMessages();
    if (!pending.length) return false;
    messages.push({
        role: "user",
        content: `The user sent additional message(s) while you were working:\n\n${pending.join("\n\n")}`,
    });
    return true;
}
function pushToolResult(messages, toolCallId, result) {
    messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: toolResultContent(result),
    });
}

function buildToolImageObservation(result, { visionEnabled = false } = {}) {
    if (!visionEnabled || !result || typeof result !== "object" || !result.__image) return null;
    const { __image, ...stripped } = result;
    return {
        role: "user",
        content: buildToolResultContent(JSON.stringify(stripped) ?? "", __image, { visionEnabled }),
    };
}

function pushSkippedToolResults(messages, toolCalls, startIndex = 0) {
    for (let i = startIndex; i < toolCalls.length; i += 1) {
        pushToolResult(messages, toolCalls[i].id, { ok: false, aborted: true, error: "Stopped by user." });
    }
}

function finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, { partialText = null } = {}) {
    return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
        text: partialText?.trim() || null,
        error: "stopped_by_user",
    });
}

function isStoppedError(err, session) {
    return Boolean(session?.isAborted?.() || err?.name === "AbortError");
}

function shouldStop(session) {
    return Boolean(session?.isAborted?.());
}

async function completeTextReply(llm, messages, { onTextDelta, setStatus, maxRetries, modelCallCount, session, partialTextRef }) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (shouldStop(session)) return null;

        if (attempt > 0) {
            messages.push({ role: "user", content: EMPTY_REPLY_HINT });
        }

        setStatus("thinking");
        const streamDelta = onTextDelta
            ? (_delta, full) => {
                  if (partialTextRef) partialTextRef.value = full;
                  setStatus("streaming");
                  onTextDelta(_delta, full);
              }
            : undefined;

        modelCallCount.value += 1;
        let response;
        try {
            response = await llm.complete({
                messages,
                tool_choice: "none",
                stream: Boolean(onTextDelta),
                onTextDelta: streamDelta,
                signal: session?.signal,
            });
        } catch (err) {
            if (isStoppedError(err, session)) {
                if (partialTextRef && err.partialText) partialTextRef.value = err.partialText;
                return null;
            }
            throw err;
        }

        if (shouldStop(session)) return null;

        const raw = response.choices?.[0]?.message;
        if (!raw) continue;

        const msg = assistantMessageToPlain(raw);
        if (msg.content?.trim()) {
            messages.push(msg);
            if (isSilentReply(msg.content)) {
                return { text: null, usage: response.usage, silent: true };
            }
            return { text: msg.content, usage: response.usage };
        }
    }

    return null;
}

export async function runAgent(userMessage, options = {}) {
    try {
        return await runAgentTurn(userMessage, options);
    } catch (err) {
        if (isStoppedError(err, options.session)) {
            return {
                text: err.partialText?.trim() || null,
                error: "stopped_by_user",
                stats: { toolCallCount: 0, modelCallCount: 0, tokensUsed: 0, contextWindow: 128000 },
                turnMessages: [],
            };
        }
        console.error("Agent loop error:", err?.stack || err);
        return {
            text: null,
            error: "agent_error",
            errorDetail: err?.message || String(err),
            stats: { toolCallCount: 0, modelCallCount: 0, tokensUsed: 0, contextWindow: 128000 },
            turnMessages: [],
        };
    }
}

async function runAgentTurn(
    userMessage,
    {
        chatId,
        sessionKey = null,
        threadId = null,
        agentId = null,
        bot,
        onTextDelta,
        onStatusPhase,
        visionAttachment = null,
        session = null,
        history = null,
        persistHistory = true,
        consultDepth = 0,
    } = {},
) {
    clearFileReadCache();
    const llm = await createLlmClient();
    const agentConfig = loadAgentConfig();
    const setStatus = (phase, detail = null) => onStatusPhase?.(phase, detail);
    const maxRounds = agentConfig.maxToolRoundsPerTurn ?? agentConfig.maxToolRounds ?? 16;
    const maxToolCalls = agentConfig.maxToolCallsPerTurn ?? 20;
    const maxSameToolRepeat = agentConfig.maxSameToolRepeat ?? 2;
    const maxEmptyReplyRetries = agentConfig.maxEmptyReplyRetries ?? 8;
    const modelCallCountRef = { value: 0 };
    const resolvedSessionKey = sessionKey || chatId;
    const resolvedAgentId = agentId || "main";

    const runtimeInfo = {
        model: llm.provider.model,
        sessionKey: resolvedSessionKey,
        channel: "telegram",
        agentId: resolvedAgentId,
    };

    setStatus("generating");
    const contextResult = await ensureWithinContextLimit(llm, userMessage, llm.modelMeta, {
        chatId: persistHistory === false ? null : resolvedSessionKey,
        onStatusPhase: setStatus,
        visionAttachment,
        session,
        runtimeInfo,
        history: persistHistory === false ? (history ?? []) : history,
    });
    let messages = contextResult.messages;

    if (shouldStop(session)) {
        return finishStoppedTurn(llm, messages, messages.length - 1, 0, modelCallCountRef, { partialText: null });
    }
    const tools = await getAllToolDefinitions();
    const contextBaseLength = messages.length - 1; // user message is last in messages; -1 keeps it in extractTurnMessages

    let toolCallCount = 0;
    const toolSigCounts = new Map();
    const fileSnapshots = new Map();
    let forceReplyNext = false;
    const visionSupport = Boolean(llm.modelMeta?.supportsVision);

    const partialTextRef = { value: null };

    for (let round = 0; round < maxRounds; round++) {
        injectPendingUserMessages(messages, session);
        if (shouldStop(session)) {
            return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                partialText: partialTextRef.value,
            });
        }

        const toolsEnabled = !forceReplyNext;
        const useStream = Boolean(onTextDelta) && !toolsEnabled;

        setStatus("thinking");

        const streamDelta =
            useStream && onTextDelta
                ? (_delta, full) => {
                      partialTextRef.value = full;
                      setStatus("streaming");
                      onTextDelta(_delta, full);
                  }
                : undefined;

        modelCallCountRef.value += 1;
        let response;
        try {
            response = await llm.complete({
                messages,
                tools: toolsEnabled ? tools : undefined,
                tool_choice: toolsEnabled ? "auto" : "none",
                stream: useStream,
                onTextDelta: streamDelta,
                signal: session?.signal,
            });
        } catch (err) {
            if (isStoppedError(err, session)) {
                if (err.partialText) partialTextRef.value = err.partialText;
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value,
                });
            }
            throw err;
        }

        if (shouldStop(session)) {
            return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                partialText: partialTextRef.value,
            });
        }

        forceReplyNext = false;

        const raw = response.choices?.[0]?.message;
        if (!raw) throw new Error("Empty LLM response");

        const choice = assistantMessageToPlain(raw);
        const toolCalls = choice.tool_calls;
        if (!toolCalls?.length) {
            if (choice.content?.trim()) {
                messages.push(choice);
                if (injectPendingUserMessages(messages, session)) {
                    forceReplyNext = false;
                    continue;
                }
                if (isSilentReply(choice.content)) {
                    return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                        text: null,
                        usage: response.usage,
                        silent: true,
                    });
                }
                return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                    text: choice.content,
                    usage: response.usage,
                });
            }

            if (shouldStop(session)) {
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value,
                });
            }

            const recovered = await completeTextReply(llm, messages, {
                onTextDelta,
                setStatus,
                maxRetries: maxEmptyReplyRetries,
                modelCallCount: modelCallCountRef,
                session,
                partialTextRef,
            });
            if (shouldStop(session)) {
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value || recovered?.text,
                });
            }
            if (recovered) {
                if (injectPendingUserMessages(messages, session)) {
                    forceReplyNext = false;
                    continue;
                }
                return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                    text: recovered.silent ? null : recovered.text,
                    usage: recovered.usage,
                    silent: recovered.silent || false,
                });
            }

            return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                text: null,
                error: "empty_reply_exhausted",
            });
        }

        messages.push(choice);

        if (toolCallCount >= maxToolCalls) {
            pushSkippedToolResults(messages, toolCalls, 0);
            messages.push({ role: "user", content: FORCE_REPLY_HINT });
            forceReplyNext = true;
            continue;
        }

        const toolImageObservations = [];

        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
            const tc = toolCalls[toolIndex];
            if (toolCallCount >= maxToolCalls) {
                pushSkippedToolResults(messages, toolCalls, toolIndex);
                break;
            }

            injectPendingUserMessages(messages, session);
            if (shouldStop(session)) {
                pushSkippedToolResults(messages, toolCalls, toolIndex);
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value,
                });
            }

            setStatus("tools", tc.function.name);

            const args = parseToolArgs(tc.function.arguments);
            const sig = toolSignature(tc.function.name, args);
            const seen = (toolSigCounts.get(sig) || 0) + 1;
            toolSigCounts.set(sig, seen);
            toolCallCount += 1;

            if (seen > maxSameToolRepeat) {
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: toolResultContent({
                        error: "Duplicate tool call skipped. Use the previous result and answer the user without calling this again.",
                    }),
                });
                forceReplyNext = true;
                continue;
            }

            const result = await executeTool(tc.function.name, args, {
                chatId,
                sessionKey: resolvedSessionKey,
                threadId,
                agentId: resolvedAgentId,
                consultDepth,
                bot,
                messages,
                model: llm.provider.model,
                modelMeta: llm.modelMeta,
                fileSnapshots,
                signal: session?.signal,
                onStatusPhase: setStatus,
            });

            if (shouldStop(session)) {
                pushToolResult(messages, tc.id, result);
                pushSkippedToolResults(messages, toolCalls, toolIndex + 1);
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value,
                });
            }
            pushToolResult(messages, tc.id, result);
            const imageObservation = buildToolImageObservation(result, { visionEnabled: visionSupport });
            if (imageObservation) toolImageObservations.push(imageObservation);
        }

        if (toolImageObservations.length) {
            messages.push(...toolImageObservations);
        }

        if (forceReplyNext || toolCallCount >= maxToolCalls) {
            messages.push({ role: "user", content: FORCE_REPLY_HINT });
            forceReplyNext = true;
        }
    }

    messages.push({ role: "user", content: FORCE_REPLY_HINT });

    if (shouldStop(session)) {
        return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
            partialText: partialTextRef.value,
        });
    }

    const recovered = await completeTextReply(llm, messages, {
        onTextDelta,
        setStatus,
        maxRetries: maxEmptyReplyRetries,
        modelCallCount: modelCallCountRef,
        session,
        partialTextRef,
    });
    if (shouldStop(session)) {
        return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
            partialText: partialTextRef.value || recovered?.text,
        });
    }
    if (recovered) {
        let latest = recovered;
        for (let extraRound = 0; extraRound < maxRounds; extraRound += 1) {
            if (!injectPendingUserMessages(messages, session)) break;

            if (shouldStop(session)) {
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value || latest.text,
                });
            }

            const extra = await completeTextReply(llm, messages, {
                onTextDelta,
                setStatus,
                maxRetries: maxEmptyReplyRetries,
                modelCallCount: modelCallCountRef,
                session,
                partialTextRef,
            });
            if (shouldStop(session)) {
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value || extra?.text,
                });
            }
            if (!extra) break;
            latest = extra;
        }
        return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
            text: latest.silent ? null : latest.text,
            usage: latest.usage,
            silent: latest.silent || false,
        });
    }

    return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
        text: null,
        error: "tool_rounds_exceeded",
    });
}
