import crypto from "node:crypto";
import { getMergedProvider, loadUserConfig } from "../config-loader.js";
import { chatCompletions, chatCompletionsPing, createOpenAIClient } from "./openai-compatible.js";
import { codexComplete, codexPing } from "./codex-client.js";
import { grokComplete, grokPing } from "./grok-client.js";
import { githubCopilotComplete } from "./github-copilot-client.js";
import { claudeAgentComplete, claudeAgentPing } from "./claude-agent-client.js";
import { withCacheKeepAlive } from "./cache-keepalive.js";
import { withUsageLog } from "./usage-log.js";
import { ensureModelMeta, rememberContextWindow } from "./model-meta.js";
import { getCachedProviderThinkingMeta, normalizeThinkingLevel } from "../user-settings.js";
import { isOpenRouterAlias, recordOpenRouterAlias } from "./openrouter-aliases.js";

const OAUTH_PROVIDER_TYPES = new Set(["codex-oauth", "grok-oauth", "github-copilot-oauth"]);

// 봇이 쓸 요청 설정. 봇이 고른 모델 프리셋(없으면 기본 프리셋)을 풀고,
// 프리셋을 고르지 않은 예전 봇은 예전 모델 오버라이드를 그 위에 얹는다.
// providerKey 비교에도 같은 함수를 써야 설정 핫리로드 감지가 매 라운드 클라이언트를 재생성하지 않는다.
export function agentProvider(userConfig, overrides = {}) {
    const provider = getMergedProvider(userConfig, overrides.preset || "");
    if (overrides.preset) return provider;
    return applyAgentOverrides(provider, overrides);
}

function applyAgentOverrides(provider, { model, thinkingLevel } = {}) {
    if (model) {
        provider.model = model;
        provider.modelOverride = true;
        provider.autoMode = false;
        provider.openRouterPins = {};
    }
    if (thinkingLevel) provider.thinkingLevel = thinkingLevel;
    return provider;
}

// 모든 요청의 토큰 사용량을 기록한다(설정 > 효율적인 운영의 사용 기록).
export async function createLlmClient(overrides = {}) {
    return withUsageLog(await buildLlmClient(overrides));
}

async function buildLlmClient(overrides) {
    const userConfig = loadUserConfig();
    const provider = agentProvider(userConfig, overrides);
    // 추론 깊이는 실제로 쓰는 프로바이더의 단계로 맞춘다.
    const thinkingLevel = normalizeThinkingLevel(provider.thinkingLevel, provider.id);

    if (!OAUTH_PROVIDER_TYPES.has(provider.type)) {
        if (!provider.apiKey && !provider.apiKeyOptional) throw new Error("provider.apiKey is not set in config.json");
    }
    if (!provider.model) throw new Error("provider.model is not set in config.json");

    if (provider.type === "codex-oauth") {
        const modelMeta = await ensureModelMeta(provider);
        const thinkingParam = () => getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort";
        return withCacheKeepAlive({
            provider,
            modelMeta,
            ping({ messages, tools, tool_choice, signal, cacheKey }) {
                return codexPing({
                    cacheKey,
                    model: provider.model,
                    messages,
                    tools,
                    tool_choice,
                    signal,
                    thinkingLevel,
                    thinkingParam: thinkingParam(),
                });
            },
            complete({ messages, tools, tool_choice, stream, onTextDelta, signal, cacheKey }) {
                return codexComplete({
                    cacheKey,
                    model: provider.model,
                    messages,
                    tools: tools?.length ? tools : undefined,
                    tool_choice,
                    stream,
                    onTextDelta,
                    signal,
                    thinkingLevel,
                    thinkingParam: thinkingParam(),
                });
            },
        });
    }

    if (provider.type === "grok-oauth") {
        const modelMeta = await ensureModelMeta(provider);
        const thinkingParam = () => getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning";
        return withCacheKeepAlive({
            provider,
            modelMeta,
            ping({ messages, tools, tool_choice, signal, cacheKey }) {
                return grokPing({
                    cacheKey,
                    model: provider.model,
                    messages,
                    tools,
                    tool_choice,
                    signal,
                    thinkingLevel,
                    thinkingParam: thinkingParam(),
                });
            },
            complete({ messages, tools, tool_choice, stream, onTextDelta, signal, cacheKey }) {
                return grokComplete({
                    cacheKey,
                    model: provider.model,
                    messages,
                    tools: tools?.length ? tools : undefined,
                    tool_choice,
                    stream,
                    onTextDelta,
                    signal,
                    thinkingLevel,
                    thinkingParam: thinkingParam(),
                });
            },
        });
    }

    if (provider.type === "github-copilot-oauth") {
        const modelMeta = await ensureModelMeta(provider);
        return {
            provider,
            modelMeta,
            complete({ messages, tools, tool_choice, stream, onTextDelta, signal }) {
                return githubCopilotComplete({
                    model: provider.autoMode ? "auto" : provider.model,
                    messages,
                    tools: tools?.length ? tools : undefined,
                    tool_choice,
                    stream,
                    onTextDelta,
                    signal,
                    thinkingLevel,
                    thinkingParam: getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort",
                    autoModelCandidates: provider.autoModelCandidates,
                });
            },
        };
    }

    if (provider.type === "claude-agent-sdk") {
        const modelMeta = await ensureModelMeta(provider);
        return withCacheKeepAlive({
            provider,
            modelMeta,
            ping({ messages, tools, signal, cacheKey }) {
                return claudeAgentPing({ cacheKey, model: provider.model, messages, tools, thinkingLevel, signal });
            },
            complete({ messages, tools, tool_choice, stream, onTextDelta, signal, cacheKey }) {
                return claudeAgentComplete({
                    cacheKey,
                    model: provider.model,
                    messages,
                    tools: tools?.length ? tools : undefined,
                    tool_choice,
                    stream,
                    onTextDelta,
                    signal,
                    thinkingLevel,
                    onContextWindow: (contextWindow) => rememberContextWindow(modelMeta, contextWindow),
                });
            },
        });
    }

    if (provider.type !== "openai-compatible") {
        throw new Error(`Unsupported provider type: ${provider.type}`);
    }

    const modelMeta = await ensureModelMeta(provider);
    const client = await createOpenAIClient({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        extraHeaders: provider.extraHeaders,
    });

    const thinkingParam = () => getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort";
    const pinnedProvider = provider.id === "openrouter" ? provider.openRouterPins?.[provider.model] || "" : "";
    const providerRouting = pinnedProvider ? { order: [pinnedProvider], allow_fallbacks: false } : null;
    // 세션 헤더가 필요한 곳은 대화(cacheKey)를 세션 id로 보낸다. 대화가 없는 요청(압축, 드리밍)은 요청마다 새 id.
    const sessionHeaders = (cacheKey) =>
        provider.sessionHeader ? { [provider.sessionHeader]: cacheKey ? String(cacheKey) : crypto.randomUUID() } : undefined;
    return withCacheKeepAlive({
        provider,
        modelMeta,
        ping({ messages, tools, tool_choice, signal, cacheKey }) {
            return chatCompletionsPing({
                client,
                model: provider.model,
                messages,
                tools,
                tool_choice,
                signal,
                thinkingLevel,
                thinkingParam: thinkingParam(),
                providerRouting,
                headers: sessionHeaders(cacheKey),
            });
        },
        complete({ messages, tools, tool_choice, stream, onTextDelta, signal, cacheKey }) {
            const done = chatCompletions({
                client,
                model: provider.model,
                messages,
                tools: tools?.length ? tools : undefined,
                tool_choice,
                stream,
                onTextDelta,
                signal,
                thinkingLevel,
                thinkingParam: thinkingParam(),
                providerRouting,
                headers: sessionHeaders(cacheKey),
            });
            // OpenRouter 별칭 모델(~)이면 이번에 실제로 답한 모델을 기억한다(프로바이더 고정 선택지에 쓴다).
            if (provider.id !== "openrouter" || !isOpenRouterAlias(provider.model)) return done;
            return done.then((result) => {
                recordOpenRouterAlias(provider.model, result?.model);
                return result;
            });
        },
    });
}
