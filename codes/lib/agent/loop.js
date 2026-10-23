import { loadAgentConfig, loadUserConfig } from "../config-loader.js";
import { createLlmClient, agentProvider } from "../llm/client.js";
import { assistantMessageToPlain, stripReasoning } from "../llm/messages.js";
import { executeTool, getAllToolDefinitions, toolResultContent } from "./tool-registry.js";
import { buildToolResultContent } from "../llm/vision.js";
import { extractTurnMessages } from "./chat-history.js";
import { ensureWithinContextLimit } from "./summarize.js";
import { clearFileReadCache } from "../tools/file.js";
import { countMessagesTokens, countRequestTokens, countTokens } from "./context.js";
import { learnTokenScale } from "../llm/token-estimate.js";
import { firstAgentId, firstAgent, getAgent } from "../agents-store.js";
import { buildPendingUserMessages } from "./history/messages.js";
import { EMPTY_REPLY_HINT, QUIET_EMPTY_HINT, SILENT_TO_USER_HINT } from "./session.js";
import { purgeOnceSecrets } from "./user-ask.js";

const SILENT_REPLY_TOKEN = "__SILENT__";
const TOOL_BUDGET_ERROR = { error: "Tool call budget exceeded for this turn." };
const USER_STEERED_RESULT = {
    ok: false,
    error: "Not run: the user sent a new message. Read it first, then run this again only if it is still needed.",
};
const EMPTY_STATS = { toolCallCount: 0, modelCallCount: 0, tokensUsed: 0, contextWindow: 128000 };

function parseToolArgs(raw) {
    try {
        return { ok: true, args: JSON.parse(raw || "{}") };
    } catch {
        return { ok: false };
    }
}

function providerKey(provider) {
    return [
        provider.presetUid || "",
        provider.profileUid || "",
        provider.id,
        provider.type,
        provider.baseURL,
        provider.model,
        provider.autoMode,
        provider.thinkingLevel || "",
        provider.openRouterPins?.[provider.model] || "",
        ...(provider.autoModelCandidates || []),
    ].join("\u0000");
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
        // 시각 표기가 첫 요청부터 붙도록 만들 때 at을 정한다(체크포인트가 나중에 붙이면 본문이 달라진다).
        at: new Date().toISOString(),
    };
}

// 한 턴의 진행 상태. 메시지 목록·호출 횟수·중단 여부 같은 값을 묶어 두고,
// 결과 만들기·체크포인트·빈 답변 복구를 메서드로 처리한다.
class AgentTurn {
    constructor({
        llm,
        messages,
        contextBaseLength,
        session,
        setStatus,
        onTextDelta,
        onCheckpoint,
        quietEmpty,
        maxEmptyReplyRetries,
        cacheKey,
        toolTokens,
    }) {
        this.llm = llm;
        this.cacheKey = cacheKey || null;
        this.inputTokens = 0;
        this.cachedTokens = 0;
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
        this.toolTokens = toolTokens || 0; // 도구 정의의 어림 토큰 수. 도구를 켠 호출의 입력에 들어간다.
        this.usageAnchor = null; // 마지막 호출에서 API가 센 입력 토큰 수와 그때 보낸 메시지 수
        this.silenceRejected = false;
    }

    get stopRequested() {
        return Boolean(this.session?.isAborted?.());
    }

    stats() {
        const contextWindow = this.llm.modelMeta?.contextWindow ?? 128000;
        return {
            toolCallCount: this.toolCallCount,
            modelCallCount: this.modelCallCount,
            tokensUsed: this.contextTokens(),
            contextWindow,
        };
    }

    // 지금 대화가 차지한 컨텍스트. 마지막 호출에서 API가 센 입력 토큰을 기준으로 그 뒤에 붙은 메시지만 어림해 더한다.
    // 아직 호출 전이거나 그사이 모델이 바뀌었으면 전체를 어림한다.
    contextTokens() {
        const model = this.llm.modelMeta?.model || "";
        const anchor = this.usageAnchor;
        if (!anchor || anchor.model !== model) return countRequestTokens(this.messages, { model, toolTokens: this.toolTokens });
        return anchor.tokens + countRequestTokens(this.messages.slice(anchor.length), { model });
    }

    // 호출의 실제 입력 토큰 수로 기준점을 옮기고, 같은 요청의 어림값과 견줘 모델별 배율을 배운다.
    learnUsage(usage, sentLength, toolTokens) {
        const actual = Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0;
        if (!actual) return;
        const model = this.llm.modelMeta?.model || "";
        learnTokenScale(model, countMessagesTokens(this.messages.slice(0, sentLength)) + toolTokens, actual);
        this.usageAnchor = { model, length: sentLength, tokens: actual };
    }

    // 사람이 보낸 턴의 침묵은 한 번 되돌려 답을 받는다. 침묵은 자동 턴(quietEmpty)만 쓸 수 있다.
    // 앞 턴의 예약 작업 흐름에 끌려가 사용자 질문에 __SILENT__로 끝내는 일이 있었다. 되돌렸으면 true.
    rejectSilence() {
        if (this.quietEmpty || this.silenceRejected) return false;
        this.silenceRejected = true;
        this.messages.push({ role: "user", content: SILENT_TO_USER_HINT });
        return true;
    }

    // 응답의 usage에서 입력 토큰과 그중 캐시에서 읽은 토큰을 모은다(Chat Completions와 Responses 모양 모두).
    recordUsage(usage) {
        if (!usage) return;
        this.inputTokens += Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
        this.cachedTokens += Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) || 0;
    }

    logCacheUsage() {
        if (!this.inputTokens) return;
        const pct = Math.round((this.cachedTokens / this.inputTokens) * 100);
        console.log(
            `tabyBot: prompt cache ${this.cacheKey || "-"} calls=${this.modelCallCount} input=${this.inputTokens} cached=${this.cachedTokens} (${pct}%)`,
        );
    }

    result(extra = {}) {
        this.logCacheUsage();
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

    // 작업 중에 사용자가 보낸 메시지를 각각의 user 메시지로 대화에 합친다. 합쳤으면 true.
    injectPendingUserMessages() {
        if (!this.session) return false;
        const pending = this.session.drainPendingMessages();
        if (!pending.length) return false;
        const messages = buildPendingUserMessages(pending);
        if (!messages.length) return false;
        this.messages.push(...messages);
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

            // 침묵을 되돌린 직후에는 그 안내가 이미 마지막에 있다.
            if (attempt > 0 && this.messages.at(-1)?.role !== "user") {
                this.messages.push({ role: "user", content: this.quietEmpty ? QUIET_EMPTY_HINT : EMPTY_REPLY_HINT });
            }

            this.setStatus("thinking");
            this.modelCallCount += 1;
            const sentLength = this.messages.length;
            let response;
            try {
                response = await this.llm.complete({
                    messages: this.messages,
                    tool_choice: "none",
                    stream: Boolean(this.onTextDelta),
                    onTextDelta: this.streamDelta(),
                    signal: this.session?.signal,
                    cacheKey: this.cacheKey,
                });
            } catch (err) {
                if (isStoppedError(err, this.session)) {
                    if (err.partialText) this.partialText = err.partialText;
                    return null;
                }
                throw err;
            }
            this.recordUsage(response.usage);
            this.learnUsage(response.usage, sentLength, 0);

            if (this.stopRequested) return null;

            const raw = response.choices?.[0]?.message;
            if (!raw) continue;

            const msg = assistantMessageToPlain(raw);
            if (msg.content?.trim()) {
                this.messages.push(msg);
                this.checkpoint();
                if (isSilentReply(msg.content)) {
                    if (this.rejectSilence()) continue;
                    return { text: null, usage: response.usage, silent: true };
                }
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
            if (isSilentReply(choice.content)) {
                if (this.rejectSilence()) return undefined;
                return this.result({ text: null, usage: response.usage, silent: true });
            }
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

            // 작업 중에 사용자가 메시지를 보냈으면 남은 도구는 건너뛰고 다음 라운드에서 바로 읽힌다.
            if (this.session?.hasPendingMessages?.()) {
                this.pushSkippedToolResults(toolCalls, toolIndex, USER_STEERED_RESULT);
                this.checkpoint();
                break;
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

            if (this.session) this.session.toolRunning = true;
            const result = await executeTool(tc.function.name, parsed.args, {
                ...toolContext,
                messages: this.messages,
                contextTokens: () => this.contextTokens(),
                toolCall: tc,
                // user_ask·secret_request가 질문을 만들면(답을 기다리기 전에) 체크포인트를 남긴다.
                // 그래야 질문 카드가 저장된 메시지 순서의 제자리에서 바로 그려지고 새로고침에도 살아남는다.
                onAskCreated: () => this.checkpoint(),
                model: this.llm.provider.model,
                modelMeta: this.llm.modelMeta,
                signal: this.session?.signal,
                onStatusPhase: this.setStatus,
            }).finally(() => {
                if (this.session) this.session.toolRunning = false;
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
        const sentLength = this.messages.length;
        try {
            const response = await this.llm.complete({
                messages: this.messages,
                tools: toolsEnabled ? tools : undefined,
                tool_choice: toolsEnabled ? "auto" : "none",
                stream: Boolean(this.onTextDelta),
                onTextDelta: this.streamDelta(),
                signal: this.session?.signal,
                cacheKey: this.cacheKey,
            });
            this.recordUsage(response.usage);
            this.learnUsage(response.usage, sentLength, toolsEnabled ? this.toolTokens : 0);
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
    } finally {
        // 이 턴에서 받은 일회용 시크릿(인증 코드 등)은 턴이 끝나면 쓸 일이 없으니 금고에서 지운다.
        const sessionKey = options.sessionKey || options.chatId;
        if (sessionKey) {
            try {
                purgeOnceSecrets(sessionKey);
            } catch (err) {
                console.warn(`tabyBot: one-time secret cleanup failed: ${err?.message || err}`);
            }
        }
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
        userMessageMeta = null,
    } = {},
) {
    clearFileReadCache();
    const resolvedSessionKey = sessionKey || chatId;
    const resolvedAgentId = agentId || firstAgentId();
    // 봇이 고른 모델 프리셋(없으면 기본 프리셋). 프리셋을 고르지 않은 예전 봇은 예전 모델 오버라이드를 쓴다.
    const agent = getAgent(resolvedAgentId) || firstAgent();
    const agentOverrides = {
        preset: agent?.modelPreset || "",
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
    // 이번 실행이 직접 다루는 메시지(지금 메시지와, 시작 전에 대기열에 쌓인 메시지)는
    // 기록에 대기 턴으로도 남아 있다. 프롬프트에 두 번 들어가지 않게 그 id를 넘긴다.
    const ownedMessageIds = [userMessageMeta?.id, ...(session?.pendingMessageIds?.() || [])].filter(Boolean);
    // 도구 정의도 요청마다 입력에 들어가므로 압축할지 정할 때 함께 센다.
    const tools = await getAllToolDefinitions();
    const toolTokens = countTokens(tools);
    const contextResult = await ensureWithinContextLimit(llm, userMessage, llm.modelMeta, {
        toolTokens,
        chatId: persistHistory === false ? null : resolvedSessionKey,
        onStatusPhase: setStatus,
        attachments,
        session,
        excludeMessageIds: ownedMessageIds,
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
    // 기록·화면이 대기 턴과 이 메시지를 같은 것으로 알아보게 id와 보낸 시각을 싣는다.
    const current = messages[contextBaseLength];
    if (userMessageMeta?.id) current.id = userMessageMeta.id;
    // 모델이 보는 현재 시각은 이 at에서 나온다. 저장된 뒤에도 같은 값이라 다음 턴의 프롬프트 캐시가 유지된다.
    current.at = (userMessageMeta?.id && userMessageMeta.at) || new Date().toISOString();

    const turn = new AgentTurn({
        llm,
        messages,
        contextBaseLength,
        session,
        setStatus,
        onTextDelta,
        onCheckpoint,
        quietEmpty,
        maxEmptyReplyRetries,
        cacheKey: resolvedSessionKey,
        toolTokens,
    });

    if (turn.stopRequested) return turn.stopped(null);

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
        const configuredProvider = agentProvider(loadUserConfig(), agentOverrides);
        if (providerKey(configuredProvider) !== activeProviderKey) {
            turn.llm = await createLlmClient(agentOverrides);
            activeProviderKey = providerKey(turn.llm.provider);
            // 앞 모델의 추론 내용은 새 업체가 모르는 필드일 수 있다
            for (const message of turn.messages) stripReasoning(message);
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
