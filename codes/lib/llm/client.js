import { getMergedProvider, loadUserConfig } from "../config-loader.js";
import { chatCompletions, createOpenAIClient } from "./openai-compatible.js";
import { codexComplete } from "./codex-client.js";
import { grokComplete } from "./grok-client.js";
import { githubCopilotComplete } from "./github-copilot-client.js";
import { ensureModelMeta } from "./model-meta.js";
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

export async function createLlmClient(overrides = {}) {
    const userConfig = loadUserConfig();
    const provider = applyAgentOverrides(getMergedProvider(userConfig), overrides);
    const thinkingLevel = overrides.thinkingLevel ? normalizeThinkingLevel(overrides.thinkingLevel, provider.id) : getThinkingLevel(userConfig);

    if (!OAUTH_PROVIDER_TYPES.has(provider.type)) {
        if (!provider.apiKey && !provider.apiKeyOptional) throw new Error("provider.apiKey is not set in config.json");
    }
    if (!provider.model) throw new Error("provider.model is not set in config.json");

    if (provider.type === "codex-oauth") {
        const modelMeta = await ensureModelMeta(provider);
        return {
            provider,
            modelMeta,
            async complete({ messages, tools, tool_choice, stream, onTextDelta, signal }) {
                return codexComplete({
                    model: provider.model,
                    messages,
                    tools: tools?.length ? tools : undefined,
                    tool_choice,
                    stream,
                    onTextDelta,
                    signal,
                    thinkingLevel,
                    thinkingParam: getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort",
                });
            },
        };
    }

    if (provider.type === "grok-oauth") {
        const modelMeta = await ensureModelMeta(provider);
        return {
            provider,
            modelMeta,
            async complete({ messages, tools, tool_choice, stream, onTextDelta, signal }) {
                return grokComplete({
                    model: provider.model,
                    messages,
                    tools: tools?.length ? tools : undefined,
                    tool_choice,
                    stream,
                    onTextDelta,
                    signal,
                    thinkingLevel,
                    thinkingParam: getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning",
                });
            },
        };
    }

    if (provider.type === "github-copilot-oauth") {
        const modelMeta = await ensureModelMeta(provider);
        return {
            provider,
            modelMeta,
            async complete({ messages, tools, tool_choice, stream, onTextDelta, signal }) {
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

    if (provider.type !== "openai-compatible") {
        throw new Error(`Unsupported provider type: ${provider.type}`);
    }

    const modelMeta = await ensureModelMeta(provider);
    const client = createOpenAIClient({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        extraHeaders: provider.extraHeaders,
    });

    return {
        provider,
        modelMeta,
        async complete({ messages, tools, tool_choice, stream, onTextDelta, signal }) {
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
                thinkingParam: getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort",
            });
        },
    };
}
