import { getMergedProvider, loadAgentConfig, loadUserConfig } from "../config-loader.js";
import { createLlmClient, applyAgentOverrides } from "../llm/client.js";
import { assistantMessageToPlain } from "../llm/messages.js";
import { executeTool, getAllToolDefinitions, toolResultContent } from "./tool-registry.js";
import { buildToolResultContent } from "../llm/vision.js";
import { extractTurnMessages } from "./chat-history.js";
import { ensureWithinContextLimit } from "./summarize.js";
import { clearFileReadCache } from "../tools/file.js";
import { countMessagesTokens } from "./context.js";
import { firstAgentId, firstAgent, getAgent } from "../agents-store.js";
import { PENDING_USER_PREFIX } from "./history/messages.js";
import { EMPTY_REPLY_HINT, QUIET_EMPTY_HINT } from "./session.js";

const SILENT_REPLY_TOKEN = "__SILENT__";
const TOOL_BUDGET_ERROR = { error: "Tool call budget exceeded for this turn." };
const EMPTY_STATS = { toolCallCount: 0, modelCallCount: 0, tokensUsed: 0, contextWindow: 128000 };

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

// 모델이 마커 앞뒤에 잡담을 붙여도 침묵 의사로 인정한다. 마커가 있으면 전달하지 않는다.
function isSilentReply(content) {
    if (typeof content !== "string") return false;
    const t = content.trim();
    return t.startsWith(SILENT_REPLY_TOKEN) || t.endsWith(SILENT_REPLY_TOKEN);
}

function isStoppedError(err, session) {
    return Boolean(session?.isAborted?.() || err?.name === "AbortError");
}

function buildToolImageObservation(result, { visionEnabled = false } = {}) {
    if (!visionEnabled || !result || typeof result !== "object" || !result.__image) return null;
    const { __image, ...stripped } = result;
    return {
        role: "user",
        content: buildToolResultContent(JSON.stringify(stripped) ?? "", __image, { visionEnabled }),
    };
}

// 한 턴의 진행 상태. 메시지 목록·호출 횟수·중단 여부 같은 값을 묶어 두고,
// 결과 만들기·체크포인트·빈 답변 복구를 메서드로 처리한다.
class AgentTurn {
    constructor({ llm, messages, contextBaseLength, session, setStatus, onTextDelta, onCheckpoint, quietEmpty, maxEmptyReplyRetries }) {
        this.llm = llm;
        this.messages = messages;
        this.contextBaseLength = contextBaseLength;
        this.session = session;
        this.setStatus = setStatus;
        this.onTextDelta = onTextDelta;
        this.onCheckpoint = onCheckpoint;
        this.quietEmpty = quietEmpty;
        this.maxEmptyReplyRetries = maxEmptyReplyRetries;
        this.toolCallCount = 0;
        this.modelCallCount = 0;
        this.partialText = null; // 스트리밍 중 지금까지 받은 본문. 중단되면 이것을 돌려준다.
    }

    get stopRequested() {
        return Boolean(this.session?.isAborted?.());
    }

    stats() {
        const contextWindow = this.llm.modelMeta?.contextWindow ?? 128000;
        const loadedContext = countMessagesTokens(this.messages.slice(0, this.contextBaseLength));
        const peakContext = countMessagesTokens(this.messages);
        return {
            toolCallCount: this.toolCallCount,
            modelCallCount: this.modelCallCount,
            tokensUsed: Math.max(loadedContext, peakContext),
            contextWindow,
        };
    }

    result(extra = {}) {
        const turnMessages = extractTurnMessages(this.messages, this.contextBaseLength);
        return {
            ...extra,
            stats: this.stats(),
            turnMessages,
            deliveredAttachments: deliveredAttachmentsFromMessages(turnMessages),
        };
    }

    stopped(partialText = this.partialText) {
        return this.result({ text: partialText?.trim() || null, error: "stopped_by_user" });
    }

    // 모델 답변을 모은 결과(usage 포함)를 최종 결과로 바꾼다.
    replyResult(reply) {
        return this.result({ text: reply.silent ? null : reply.text, usage: reply.usage, silent: reply.silent || false });
    }

    checkpoint() {
        this.onCheckpoint?.(extractTurnMessages(this.messages, this.contextBaseLength));
    }

    // 작업 중에 사용자가 보낸 메시지를 대화에 합친다. 합쳤으면 true.
    injectPendingUserMessages() {
        if (!this.session) return false;
        const pending = this.session.drainPendingMessages();
        if (!pending.length) return false;
        this.messages.push({
            role: "user",
            content: `${PENDING_USER_PREFIX}\n\n${pending.join("\n\n")}`,
        });
        return true;
    }

    pushToolResult(toolCallId, result) {
        this.messages.push({ role: "tool", tool_call_id: toolCallId, content: toolResultContent(result) });
    }

    pushSkippedToolResults(toolCalls, startIndex = 0, result = { ok: false, aborted: true, error: "Stopped by user." }) {
        for (let i = startIndex; i < toolCalls.length; i += 1) this.pushToolResult(toolCalls[i].id, result);
    }

    // 스트리밍 콜백: 받은 본문을 기억하고 상태를 "streaming"으로 알린다.
    streamDelta() {
        if (!this.onTextDelta) return undefined;
        return (delta, full) => {
            this.partialText = full;
            this.setStatus("streaming");
            this.onTextDelta(delta, full);
        };
    }

    // 도구 없이 텍스트 답변만 받는다. 빈 답변이면 힌트를 붙여 maxEmptyReplyRetries번까지 다시 묻는다.
    // 중단되거나 끝내 비어 있으면 null.
    async completeTextReply() {
        for (let attempt = 0; attempt < this.maxEmptyReplyRetries; attempt++) {
            if (this.stopRequested) return null;

            if (attempt > 0) {
                this.messages.push({ role: "user", content: this.quietEmpty ? QUIET_EMPTY_HINT : EMPTY_REPLY_HINT });
            }

            this.setStatus("thinking");
            this.modelCallCount += 1;
            let response;
            try {
                response = await this.llm.complete({
                    messages: this.messages,
                    tool_choice: "none",
                    stream: Boolean(this.onTextDelta),
                    onTextDelta: this.streamDelta(),
                    signal: this.session?.signal,
                });
            } catch (err) {
                if (isStoppedError(err, this.session)) {
                    if (err.partialText) this.partialText = err.partialText;
                    return null;
                }
                throw err;
            }

            if (this.stopRequested) return null;

            const raw = response.choices?.[0]?.message;
            if (!raw) continue;

            const msg = assistantMessageToPlain(raw);
            if (msg.content?.trim()) {
                this.messages.push(msg);
                this.checkpoint();
                if (isSilentReply(msg.content)) return { text: null, usage: response.usage, silent: true };
                return { text: msg.content, usage: response.usage };
            }
        }

        return null;
    }

    // 도구를 쓰지 않은 답변을 처리한다. 다음 라운드로 이어져야 하면 undefined, 끝이면 결과.
    async finishTextOnlyReply(choice, response) {
        if (choice.content?.trim()) {
            this.messages.push(choice);
            this.checkpoint();
            if (this.injectPendingUserMessages()) return undefined;
            if (isSilentReply(choice.content)) return this.result({ text: null, usage: response.usage, silent: true });
            return this.result({ text: choice.content, usage: response.usage });
        }

        if (this.stopRequested) return this.stopped();

        const recovered = await this.completeTextReply();
        if (this.stopRequested) return this.stopped(this.partialText || recovered?.text);
        if (recovered) {
            if (this.injectPendingUserMessages()) return undefined;
            return this.replyResult(recovered);
        }

        if (this.quietEmpty) return this.result({ text: null, silent: true });
        return this.result({ text: null, error: "empty_reply_exhausted" });
    }

    // 도구 호출을 차례로 실행한다. 중단되면 결과를 돌려주고, 아니면 undefined.
    async runToolCalls(toolCalls, ctx) {
        const { maxToolCalls, toolContext, visionSupport } = ctx;
        const imageObservations = [];

        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
            const tc = toolCalls[toolIndex];
            if (this.toolCallCount >= maxToolCalls) {
                this.pushSkippedToolResults(toolCalls, toolIndex, TOOL_BUDGET_ERROR);
                this.checkpoint();
                break;
            }

            if (this.stopRequested) {
                this.pushSkippedToolResults(toolCalls, toolIndex);
                return this.stopped();
            }

            this.setStatus("tools", tc.function.name);

            const parsed = parseToolArgs(tc.function.arguments);
            if (!parsed.ok) {
                this.pushToolResult(tc.id, {
                    ok: false,
                    error: `Tool arguments were not valid JSON for ${tc.function.name}; the call was not executed.`,
                });
                this.checkpoint();
                continue;
            }
            this.toolCallCount += 1;

            const result = await executeTool(tc.function.name, parsed.args, {
                ...toolContext,
                messages: this.messages,
                model: this.llm.provider.model,
                modelMeta: this.llm.modelMeta,
                signal: this.session?.signal,
                onStatusPhase: this.setStatus,
            });

            this.pushToolResult(tc.id, result);
            if (this.stopRequested) {
                this.pushSkippedToolResults(toolCalls, toolIndex + 1);
                this.checkpoint();
                return this.stopped();
            }
            this.checkpoint();
            const imageObservation = buildToolImageObservation(result, { visionEnabled: visionSupport });
            if (imageObservation) imageObservations.push(imageObservation);
        }

        if (imageObservations.length) {
            this.messages.push(...imageObservations);
            this.checkpoint();
        }
        return undefined;
    }

    // 한 라운드의 모델 호출. 중단으로 끝내야 하면 { stopped }를, 아니면 { response }를 돌려준다.
    async callModel({ tools, toolsEnabled }) {
        this.setStatus("thinking");
        this.modelCallCount += 1;
        try {
            const response = await this.llm.complete({
                messages: this.messages,
                tools: toolsEnabled ? tools : undefined,
                tool_choice: toolsEnabled ? "auto" : "none",
                stream: Boolean(this.onTextDelta),
                onTextDelta: this.streamDelta(),
                signal: this.session?.signal,
            });
            return { response };
        } catch (err) {
            if (isStoppedError(err, this.session)) {
                if (err.partialText) this.partialText = err.partialText;
                return { stopped: this.stopped() };
            }
            throw err;
        }
    }

    // 라운드를 다 쓴 뒤: 도구 없이 마지막 답변을 받고, 그사이 들어온 사용자 메시지에도 답한다.
    async finishAfterRounds(maxRounds) {
        if (this.stopRequested) return this.stopped();

        const recovered = await this.completeTextReply();
        if (this.stopRequested) return this.stopped(this.partialText || recovered?.text);
        if (recovered) {
            let latest = recovered;
            for (let extraRound = 0; extraRound < maxRounds; extraRound += 1) {
                if (!this.injectPendingUserMessages()) break;

                if (this.stopRequested) return this.stopped(this.partialText || latest.text);

                const extra = await this.completeTextReply();
                if (this.stopRequested) return this.stopped(this.partialText || extra?.text);
                if (!extra) break;
                latest = extra;
            }
            return this.replyResult(latest);
        }

        if (this.quietEmpty) return this.result({ text: null, silent: true });
        return this.result({ text: null, error: "tool_rounds_exceeded" });
    }
}

export async function runAgent(userMessage, options = {}) {
    try {
        return await runAgentTurn(userMessage, options);
    } catch (err) {
        if (isStoppedError(err, options.session)) {
            return {
                text: err.partialText?.trim() || null,
                error: "stopped_by_user",
                stats: EMPTY_STATS,
                turnMessages: [],
            };
        }
        console.error("Agent loop error:", err?.stack || err);
        return {
            text: null,
            error: "agent_error",
            errorDetail: err?.message || String(err),
            stats: EMPTY_STATS,
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
    const resolvedSessionKey = sessionKey || chatId;
    const resolvedAgentId = agentId || firstAgentId();
    // 봇별 오버라이드. 모델과 사고 수준은 client 생성 시 적용한다.
    const agent = getAgent(resolvedAgentId) || firstAgent();
    const agentOverrides = {
        model: agent?.model?.trim() || "",
        thinkingLevel: agent?.thinkingLevel || "",
    };
    const llm = await createLlmClient(agentOverrides);
    const agentConfig = loadAgentConfig();
    const setStatus = (phase, detail = null) => onStatusPhase?.(phase, detail);
    const maxRounds = agentConfig.maxToolRoundsPerTurn ?? agentConfig.maxToolRounds ?? 16;
    const maxToolCalls = agentConfig.maxToolCallsPerTurn ?? 20;
    const maxEmptyReplyRetries = agentConfig.maxEmptyReplyRetries ?? 8;

    setStatus("generating");
    const contextResult = await ensureWithinContextLimit(llm, userMessage, llm.modelMeta, {
        chatId: persistHistory === false ? null : resolvedSessionKey,
        onStatusPhase: setStatus,
        attachments,
        session,
        runtimeInfo: {
            model: llm.provider.model,
            sessionKey: resolvedSessionKey,
            channel: "web",
            agentId: resolvedAgentId,
        },
        history: persistHistory === false ? (history ?? []) : history,
    });
    const messages = contextResult.messages;
    // 사용자 메시지는 messages의 마지막이다. -1로 두면 extractTurnMessages가 그것을 이번 턴에 포함한다.
    const contextBaseLength = messages.length - 1;

    const turn = new AgentTurn({ llm, messages, contextBaseLength, session, setStatus, onTextDelta, onCheckpoint, quietEmpty, maxEmptyReplyRetries });

    if (turn.stopRequested) return turn.stopped(null);

    const tools = await getAllToolDefinitions();
    const toolContext = {
        chatId,
        sessionKey: resolvedSessionKey,
        agentId: resolvedAgentId,
        consultDepth,
        todoId,
        fileSnapshots: new Map(),
    };
    let activeProviderKey = providerKey(turn.llm.provider);
    let visionSupport = Boolean(turn.llm.modelMeta?.supportsVision);

    for (let round = 0; round < maxRounds; round++) {
        // 설정에서 모델이나 프로바이더가 바뀌었으면 다음 라운드부터 새 클라이언트를 쓴다.
        const configuredProvider = applyAgentOverrides(getMergedProvider(loadUserConfig()), agentOverrides);
        if (providerKey(configuredProvider) !== activeProviderKey) {
            turn.llm = await createLlmClient(agentOverrides);
            activeProviderKey = providerKey(turn.llm.provider);
            visionSupport = Boolean(turn.llm.modelMeta?.supportsVision);
        }
        turn.injectPendingUserMessages();
        if (turn.stopRequested) return turn.stopped();

        const toolsEnabled = turn.toolCallCount < maxToolCalls;

        const { response, stopped: stoppedResult } = await turn.callModel({ tools, toolsEnabled });
        if (stoppedResult) return stoppedResult;

        if (turn.stopRequested) return turn.stopped();

        const raw = response.choices?.[0]?.message;
        if (!raw) throw new Error("Empty LLM response");

        const choice = assistantMessageToPlain(raw);
        const toolCalls = choice.tool_calls;
        if (!toolCalls?.length) {
            const finished = await turn.finishTextOnlyReply(choice, response);
            if (finished) return finished;
            continue;
        }

        messages.push(choice);
        turn.checkpoint();

        if (turn.toolCallCount >= maxToolCalls) {
            turn.pushSkippedToolResults(toolCalls, 0, TOOL_BUDGET_ERROR);
            turn.checkpoint();
            continue;
        }

        const stopped = await turn.runToolCalls(toolCalls, { maxToolCalls, toolContext, visionSupport });
        if (stopped) return stopped;
    }

    return turn.finishAfterRounds(maxRounds);
}
