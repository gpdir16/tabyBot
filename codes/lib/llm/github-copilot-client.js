import { randomUUID } from "node:crypto";
import { createOpenAIClient, chatCompletions } from "./openai-compatible.js";
import { ensureFreshGithubCopilotToken } from "./github-copilot-tokens.js";

const COPILOT_HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
    "X-GitHub-Api-Version": "2026-06-01",
};
const VSCODE_HEADERS = {
    "VScode-SessionId": `${randomUUID()}${Date.now()}`,
    "VScode-MachineId": randomUUID().replace(/-/g, ""),
    "Editor-Device-Id": randomUUID(),
};
// ponytail: 무한 재시도를 막기 위해 세션 라우팅을 5회로 제한한다.
const AUTO_ROUTE_MAX_ATTEMPTS = 5;

function apiBaseURL(baseURL) {
    return String(baseURL || "")
        .replace(/\/$/, "")
        .replace(/\/v1$/, "");
}

function copilotHeaders(accessToken, sessionToken) {
    return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...COPILOT_HEADERS,
        ...VSCODE_HEADERS,
        ...(sessionToken ? { "Copilot-Session-Token": sessionToken } : {}),
    };
}

async function fetchAutoSession(auth, signal) {
    const res = await fetch(`${apiBaseURL(auth.baseURL)}/models/session`, {
        method: "POST",
        headers: copilotHeaders(auth.accessToken),
        body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
        signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.session_token !== "string") {
        const detail = data.error?.message || data.message || res.statusText || "Auto mode is unavailable";
        throw new Error(`GitHub Copilot Auto session failed: ${res.status} ${detail}`.trim());
    }
    const availableModels = Array.isArray(data.available_models) ? data.available_models.filter((id) => typeof id === "string") : [];
    const selectedModel = typeof data.selected_model === "string" ? data.selected_model : availableModels[0];
    if (!selectedModel) throw new Error("GitHub Copilot Auto session returned no model");
    return { sessionToken: data.session_token, availableModels, selectedModel };
}

function textContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part) => part?.type === "text")
        .map((part) => part.text || "")
        .join("\n");
}

function latestUserPrompt(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "user") return textContent(messages[i].content);
    }
    return "";
}

async function routeAutoModel(auth, session, messages, signal, allowedModels) {
    const allowed = new Set(allowedModels);
    const prompt = latestUserPrompt(messages);
    if (!allowed.size) return session.selectedModel;
    if (!prompt || !session.availableModels.length) return allowed.has(session.selectedModel) ? session.selectedModel : null;

    const res = await fetch(`${apiBaseURL(auth.baseURL)}/models/session/intent`, {
        method: "POST",
        headers: copilotHeaders(auth.accessToken, session.sessionToken),
        body: JSON.stringify({ prompt, available_models: session.availableModels }),
        signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return allowed.has(session.selectedModel) ? session.selectedModel : null;
    const candidates = Array.isArray(data.candidate_models) ? data.candidate_models : [];
    return candidates.find((id) => session.availableModels.includes(id) && allowed.has(id)) || null;
}

export async function githubCopilotComplete({ model, messages, tools, tool_choice, stream = false, onTextDelta, signal, autoModelCandidates = [] }) {
    const auth = await ensureFreshGithubCopilotToken();
    let requestModel = model;
    let sessionToken = null;
    if (model === "auto") {
        let session = null;
        for (let attempt = 0; attempt < AUTO_ROUTE_MAX_ATTEMPTS; attempt += 1) {
            session = await fetchAutoSession(auth, signal);
            requestModel = await routeAutoModel(auth, session, messages, signal, autoModelCandidates);
            if (requestModel) {
                sessionToken = session.sessionToken;
                break;
            }
        }
        if (!requestModel) {
            throw new Error("GitHub Copilot Auto could not route to one of the selected models.");
        }
    }

    const client = createOpenAIClient({
        baseURL: auth.baseURL,
        apiKey: auth.accessToken,
        extraHeaders: { ...COPILOT_HEADERS, ...VSCODE_HEADERS, ...(sessionToken ? { "Copilot-Session-Token": sessionToken } : {}) },
    });
    return chatCompletions({
        client,
        model: requestModel,
        messages,
        tools,
        tool_choice,
        stream,
        onTextDelta,
        signal,
        // Copilot OpenAI 호환 엔드포인트는 reasoning_effort를 받지 않는다. Auto 라우터가 판단한다.
        thinkingLevel: "off",
    });
}

export async function fetchGithubCopilotRoutingModels() {
    const auth = await ensureFreshGithubCopilotToken();
    const session = await fetchAutoSession(auth);
    return session.availableModels.map((id) => ({ id, label: id }));
}

export async function fetchGithubCopilotModels() {
    const auth = await ensureFreshGithubCopilotToken();
    const res = await fetch(`${auth.baseURL}/models`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${auth.accessToken}`,
            ...COPILOT_HEADERS,
        },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
            const message = payload.error?.message || payload.message || res.statusText || "Failed to fetch GitHub Copilot models";
            throw new Error(message);
        }
        try {
            const session = await fetchAutoSession(auth);
            return session.availableModels.map((id) => ({ id, label: id, contextWindow: null, supportsVision: true }));
        } catch {
            return [];
        }
    }

    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(payload?.data) ? payload.data : []) {
        const id = String(raw?.id || "").trim();
        if (!id || id === "auto" || seen.has(id) || raw?.capabilities?.supports?.tool_calls === false || raw?.policy?.state === "disabled") continue;
        seen.add(id);
        const modalities = raw?.capabilities?.supports?.input_modalities || raw?.input_modalities;
        out.push({
            id,
            label: String(raw?.name || raw?.display_name || id).trim(),
            contextWindow: Number(raw?.capabilities?.limits?.max_context_window) || Number(raw?.context_window) || null,
            supportsVision: Array.isArray(modalities) ? modalities.includes("image") : /gpt-4o|gpt-4\.1|claude-3|gemini/i.test(id),
        });
    }
    out.sort((a, b) => a.label.localeCompare(b.label, "en"));
    return out;
}
