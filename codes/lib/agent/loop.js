import { getMergedProvider, loadAgentConfig, loadUserConfig } from "../config-loader.js";
import { createLlmClient } from "../llm/client.js";
import { assistantMessageToPlain } from "../llm/messages.js";
import { executeTool, getAllToolDefinitions, toolResultContent } from "./tool-registry.js";
import { buildToolResultContent } from "../llm/vision.js";
import { extractTurnMessages } from "./chat-history.js";
import { ensureWithinContextLimit } from "./summarize.js";
import { clearFileReadCache } from "../tools/file.js";
import { countMessagesTokens } from "./context.js";
import { firstAgentId } from "../agents-store.js";
import { EMPTY_REPLY_HINT, QUIET_EMPTY_HINT } from "./session.js";
function parseToolArgs(raw) {
    try {
        return { ok: true, args: JSON.parse(raw || "{}") };
    } catch {
        return { ok: false };
    }
}

function providerKey(provider) {
    return [provider.id, provider.type, provider.baseURL, provider.model, provider.autoMode, ...(provider.autoModelCandidates || [])].join("\u0000");
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

function deliveredAttachmentsFromMessages(messages) {
    const seen = new Set();
    const attachments = [];
    for (const message of messages || []) {
        if (message?.role !== "tool" || typeof message.content !== "string") continue;
        try {
            const attachment = JSON.parse(message.content)?.attachment;
            if (!attachment?.id || seen.has(attachment.id)) continue;
            seen.add(attachment.id);
            attachments.push(attachment);
        } catch {
            // 도구 결과가 JSON이 아니면 첨부 메타데이터가 없는 결과로 처리한다.
        }
    }
    return attachments;
}

function buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCount, extra = {}) {
    const turnMessages = extractTurnMessages(messages, contextBaseLength);
    return {
        ...extra,
        stats: buildStats(llm, messages, contextBaseLength, toolCallCount, modelCallCount),
        turnMessages,
        deliveredAttachments: deliveredAttachmentsFromMessages(turnMessages),
    };
}

const SILENT_REPLY_TOKEN = "__SILENT__";

function isSilentReply(content) {
    return typeof content === "string" && content.trim() === SILENT_REPLY_TOKEN;
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

function pushSkippedToolResults(messages, toolCalls, startIndex = 0, result = { ok: false, aborted: true, error: "Stopped by user." }) {
    for (let i = startIndex; i < toolCalls.length; i += 1) {
        pushToolResult(messages, toolCalls[i].id, result);
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

function checkpointMessages(messages, contextBaseLength, onCheckpoint) {
    onCheckpoint?.(extractTurnMessages(messages, contextBaseLength));
}

async function completeTextReply(
    llm,
    messages,
    { onTextDelta, onCheckpoint, contextBaseLength, setStatus, maxRetries, modelCallCount, session, partialTextRef, quietEmpty = false },
) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (shouldStop(session)) return null;

        if (attempt > 0) {
            messages.push({ role: "user", content: quietEmpty ? QUIET_EMPTY_HINT : EMPTY_REPLY_HINT });
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
            checkpointMessages(messages, contextBaseLength, onCheckpoint);
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
        agentId = null,
        onTextDelta,
        onStatusPhase,
        attachments = [],
        session = null,
        history = null,
        persistHistory = true,
        consultDepth = 0,
        onCheckpoint,
        quietEmpty = false,
        todoId = null,
    } = {},
) {
    clearFileReadCache();
    let llm = await createLlmClient();
    let activeProviderKey = providerKey(llm.provider);
    const agentConfig = loadAgentConfig();
    const setStatus = (phase, detail = null) => onStatusPhase?.(phase, detail);
    const maxRounds = agentConfig.maxToolRoundsPerTurn ?? agentConfig.maxToolRounds ?? 16;
    const maxToolCalls = agentConfig.maxToolCallsPerTurn ?? 20;
    const maxEmptyReplyRetries = agentConfig.maxEmptyReplyRetries ?? 8;
    const modelCallCountRef = { value: 0 };
    const resolvedSessionKey = sessionKey || chatId;
    const resolvedAgentId = agentId || firstAgentId();

    const runtimeInfo = {
        model: llm.provider.model,
        sessionKey: resolvedSessionKey,
        channel: "web",
        agentId: resolvedAgentId,
    };

    setStatus("generating");
    const contextResult = await ensureWithinContextLimit(llm, userMessage, llm.modelMeta, {
        chatId: persistHistory === false ? null : resolvedSessionKey,
        onStatusPhase: setStatus,
        attachments,
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
    const fileSnapshots = new Map();
    let visionSupport = Boolean(llm.modelMeta?.supportsVision);

    const partialTextRef = { value: null };

    for (let round = 0; round < maxRounds; round++) {
        const configuredProvider = getMergedProvider(loadUserConfig());
        const configuredProviderKey = providerKey(configuredProvider);
        if (configuredProviderKey !== activeProviderKey) {
            llm = await createLlmClient();
            activeProviderKey = providerKey(llm.provider);
            visionSupport = Boolean(llm.modelMeta?.supportsVision);
        }
        injectPendingUserMessages(messages, session);
        if (shouldStop(session)) {
            return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                partialText: partialTextRef.value,
            });
        }

        const toolsEnabled = toolCallCount < maxToolCalls;
        const useStream = Boolean(onTextDelta);

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

        const raw = response.choices?.[0]?.message;
        if (!raw) throw new Error("Empty LLM response");

        const choice = assistantMessageToPlain(raw);
        const toolCalls = choice.tool_calls;
        if (!toolCalls?.length) {
            if (choice.content?.trim()) {
                messages.push(choice);
                checkpointMessages(messages, contextBaseLength, onCheckpoint);
                if (injectPendingUserMessages(messages, session)) {
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
                onCheckpoint,
                contextBaseLength,
                setStatus,
                maxRetries: maxEmptyReplyRetries,
                modelCallCount: modelCallCountRef,
                session,
                partialTextRef,
                quietEmpty,
            });
            if (shouldStop(session)) {
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value || recovered?.text,
                });
            }
            if (recovered) {
                if (injectPendingUserMessages(messages, session)) {
                    continue;
                }
                return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                    text: recovered.silent ? null : recovered.text,
                    usage: recovered.usage,
                    silent: recovered.silent || false,
                });
            }

            if (quietEmpty) {
                return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                    text: null,
                    silent: true,
                });
            }

            return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
                text: null,
                error: "empty_reply_exhausted",
            });
        }

        messages.push(choice);
        checkpointMessages(messages, contextBaseLength, onCheckpoint);

        if (toolCallCount >= maxToolCalls) {
            pushSkippedToolResults(messages, toolCalls, 0, {
                error: "Tool call budget exceeded for this turn.",
            });
            checkpointMessages(messages, contextBaseLength, onCheckpoint);
            continue;
        }

        const toolImageObservations = [];

        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
            const tc = toolCalls[toolIndex];
            if (toolCallCount >= maxToolCalls) {
                pushSkippedToolResults(messages, toolCalls, toolIndex, {
                    error: "Tool call budget exceeded for this turn.",
                });
                checkpointMessages(messages, contextBaseLength, onCheckpoint);
                break;
            }

            if (shouldStop(session)) {
                pushSkippedToolResults(messages, toolCalls, toolIndex);
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value,
                });
            }

            setStatus("tools", tc.function.name);

            const parsed = parseToolArgs(tc.function.arguments);
            if (!parsed.ok) {
                pushToolResult(messages, tc.id, {
                    ok: false,
                    error: `Tool arguments were not valid JSON for ${tc.function.name}; the call was not executed.`,
                });
                checkpointMessages(messages, contextBaseLength, onCheckpoint);
                continue;
            }
            toolCallCount += 1;

            const result = await executeTool(tc.function.name, parsed.args, {
                chatId,
                sessionKey: resolvedSessionKey,
                agentId: resolvedAgentId,
                consultDepth,
                todoId,
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
                checkpointMessages(messages, contextBaseLength, onCheckpoint);
                return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
                    partialText: partialTextRef.value,
                });
            }
            pushToolResult(messages, tc.id, result);
            checkpointMessages(messages, contextBaseLength, onCheckpoint);
            const imageObservation = buildToolImageObservation(result, { visionEnabled: visionSupport });
            if (imageObservation) toolImageObservations.push(imageObservation);
        }

        if (toolImageObservations.length) {
            messages.push(...toolImageObservations);
            checkpointMessages(messages, contextBaseLength, onCheckpoint);
        }
    }

    if (shouldStop(session)) {
        return finishStoppedTurn(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef, {
            partialText: partialTextRef.value,
        });
    }

    const recovered = await completeTextReply(llm, messages, {
        onTextDelta,
        onCheckpoint,
        contextBaseLength,
        setStatus,
        maxRetries: maxEmptyReplyRetries,
        modelCallCount: modelCallCountRef,
        session,
        partialTextRef,
        quietEmpty,
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
                onCheckpoint,
                contextBaseLength,
                setStatus,
                maxRetries: maxEmptyReplyRetries,
                modelCallCount: modelCallCountRef,
                session,
                partialTextRef,
                quietEmpty,
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

    if (quietEmpty) {
        return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
            text: null,
            silent: true,
        });
    }

    return buildResult(llm, messages, contextBaseLength, toolCallCount, modelCallCountRef.value, {
        text: null,
        error: "tool_rounds_exceeded",
    });
}
