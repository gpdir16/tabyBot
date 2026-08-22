import { getMergedProvider, loadUserConfig } from "../config-loader.js";
import { chatCompletions, createOpenAIClient } from "./openai-compatible.js";
import { codexComplete } from "./codex-client.js";
import { grokComplete } from "./grok-client.js";
import { ensureModelMeta } from "./model-meta.js";
import { getThinkingLevel, getCachedProviderThinkingMeta } from "../user-settings.js";

const OAUTH_PROVIDER_TYPES = new Set(["codex-oauth", "grok-oauth"]);

export async function createLlmClient() {
    const userConfig = loadUserConfig();
    const provider = getMergedProvider(userConfig);

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
                    thinkingLevel: getThinkingLevel(userConfig),
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
                    thinkingLevel: getThinkingLevel(userConfig),
                    thinkingParam: getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning",
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
                thinkingLevel: getThinkingLevel(userConfig),
                thinkingParam: getCachedProviderThinkingMeta(provider.id, provider.model).param || "reasoning_effort",
            });
        },
    };
}
