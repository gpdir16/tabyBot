import { getMergedProvider, loadUserConfig } from "../config-loader.js";
import { chatCompletions, chatCompletionsPing, createOpenAIClient } from "./openai-compatible.js";
import { codexComplete, codexPing } from "./codex-client.js";
import { grokComplete, grokPing } from "./grok-client.js";
import { githubCopilotComplete } from "./github-copilot-client.js";
import { claudeAgentComplete, claudeAgentPing } from "./claude-agent-client.js";
import { withCacheKeepAlive } from "./cache-keepalive.js";
import { withUsageLog } from "./usage-log.js";
import { ensureModelMeta, rememberContextWindow } from "./model-meta.js";
import { getThinkingLevel, getCachedProviderThinkingMeta, normalizeThinkingLevel } from "../user-settings.js";

const OAUTH_PROVIDER_TYPES = new Set(["codex-oauth", "grok-oauth", "github-copilot-oauth"]);

// 봇별 모델 오버라이드. providerKey 비교에도 같은 변형을 적용해야
// 설정 핫리로드 감지가 매 라운드 클라이언트를 재생성하지 않는다.
export function applyAgentOverrides(provider, { model } = {}) {
    if (model) {
        provider.model = model;
        provider.autoMode = false;
    }
    return provider;
}

// 모든 요청의 토큰 사용량을 기록한다(설정 > 효율적인 운영의 사용 기록).
export async function createLlmClient(overrides = {}) {
    return withUsageLog(await buildLlmClient(overrides));
}

async function buildLlmClient(overrides) {
    const userConfig = loadUserConfig();
    const provider = applyAgentOverrides(getMergedProvider(userConfig), overrides);
    const thinkingLevel = overrides.thinkingLevel ? normalizeThinkingLevel(overrides.thinkingLevel, provider.id) : getThinkingLevel(userConfig);

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
    const client = createOpenAIClient({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        extraHeaders: provider.extraHeaders,
    });

    const thinkingParam = () => getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort";
    const pinnedProvider = provider.id === "openrouter" ? provider.openRouterPins?.[provider.model] || "" : "";
    const providerRouting = pinnedProvider ? { order: [pinnedProvider], allow_fallbacks: false } : null;
    return withCacheKeepAlive({
        provider,
        modelMeta,
        ping({ messages, tools, tool_choice, signal }) {
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
            });
        },
        complete({ messages, tools, tool_choice, stream, onTextDelta, signal }) {
            return chatCompletions({
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
            });
        },
    });
}
