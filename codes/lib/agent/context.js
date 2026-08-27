import fs from "node:fs";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { sanitizeTextForLlm } from "../llm/sanitize-messages.js";
import { CODES_DIR } from "../paths.js";
import {
    readMemoryFile,
    formatMemoryFilesListForPrompt,
    readAgentMemoryFile,
    formatAgentMemoryFilesListForPrompt,
    agentMemoryFilePath,
} from "../memory-file.js";
import { firstAgent, formatPeerAgentsForPrompt, getAgent } from "../agents-store.js";
import { loadAgentConfig, loadUserConfig } from "../config-loader.js";
import {
    getNsfwLevel,
    buildNsfwPolicyText,
    nsfwPolicyLabel,
    getApprovalLevel,
    buildApprovalPolicyText,
    approvalPolicyLabel,
} from "../user-settings.js";
import { estimateContentTokens } from "../llm/vision.js";
import { collectFilesFromHistory, formatAttachedFilesPrompt, hydrateUserContent } from "../web/attachments.js";
import { formatSkillsListForPrompt } from "../skills-catalog.js";
import {
    buildDateTimePromptVars,
    buildEnvironmentPromptVars,
    buildFilesystemPromptBlock,
    buildRuntimeInfoLine,
    renderSystemPrompt,
} from "./system-prompt.js";
import { formatPastSessionsForPrompt, turnToMessages, cloneStoredMessage } from "./chat-history.js";
const SYSTEM_PATH = path.join(CODES_DIR, "lib", "prompts", "system.txt");

let encoding;
function getTokenizer(model) {
    try {
        if (!encoding) encoding = getEncoding("o200k_base");
        return encoding;
    } catch {
        return null;
    }
}

export function countTokens(text, model = "gpt-4o-mini") {
    const enc = getTokenizer(model);
    const safe = sanitizeTextForLlm(typeof text === "string" ? text : (JSON.stringify(text) ?? ""));
    if (enc) {
        try {
            return enc.encode(safe, undefined, []).length;
        } catch {
            return Math.ceil(safe.length / 4);
        }
    }
    return Math.ceil(safe.length / 4);
}

export function countMessagesTokens(messages, model) {
    let total = 0;
    for (const m of messages) {
        if (Array.isArray(m.content)) {
            total += estimateContentTokens(m.content);
        } else {
            total += countTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content), model);
        }
        if (m.tool_calls) total += countTokens(JSON.stringify(m.tool_calls), model);
    }
    return total;
}

function loadSystemPromptTemplate() {
    return fs.readFileSync(SYSTEM_PATH, "utf8");
}

function loadMemoryForPrompt({ truncateMemory = false, maxMemoryChars = 120000 } = {}) {
    let memory = readMemoryFile();
    if (truncateMemory && memory.length > maxMemoryChars) {
        memory = `${memory.slice(0, maxMemoryChars)}\n\n...[memory truncated]...`;
    }
    return memory;
}

function loadScopedMemory(raw, { truncateMemory = false, maxMemoryChars = 120000 } = {}) {
    let memory = raw || "";
    if (truncateMemory && memory.length > maxMemoryChars) {
        memory = `${memory.slice(0, maxMemoryChars)}\n\n...[memory truncated]...`;
    }
    return memory;
}

function agentIdentityText(agentId) {
    const agent = getAgent(agentId) || firstAgent();
    if (!agent) return "You are tabyBot. Handle general work.";
    const job = agent.persona?.trim() || "Do the work the user assigned to this agent.";
    return `You are **${agent.name}** (id: \`${agent.id}\`).\nYour job this turn: ${job}\nStay in this role. Shared tabyBot rules still apply. Private memory: \`${agentMemoryFilePath(agent.id)}\``;
}

function agentMemoryText(agentId, opts) {
    const id = agentId || firstAgent()?.id;
    if (!id) return "- (none — use shared memory.md)";
    const body = loadScopedMemory(readAgentMemoryFile(id), opts).trim() || "(empty)";
    return `${body}\n\n### Agent memory files\n${formatAgentMemoryFilesListForPrompt(id)}`;
}

function peerAgentsText(agentId) {
    return formatPeerAgentsForPrompt(agentId || firstAgent()?.id) || "- (none)";
}

export function buildSystemMessageContent(lang, { truncateMemory = false, maxMemoryChars = 120000, runtimeInfo = {} } = {}) {
    const template = loadSystemPromptTemplate();
    const rt = runtimeInfo || {};
    const pastSessions = formatPastSessionsForPrompt(rt.sessionKey);
    const vars = {
        ...buildDateTimePromptVars(lang),
        ...buildEnvironmentPromptVars(),
        FILESYSTEM_BLOCK: buildFilesystemPromptBlock(),
        SKILLS_LIST: formatSkillsListForPrompt(),
        MEMORY_FILES_LIST: formatMemoryFilesListForPrompt(),
        RUNTIME_INFO: buildRuntimeInfoLine(rt),
        MEMORY: loadMemoryForPrompt({ truncateMemory, maxMemoryChars }),
        AGENT_IDENTITY: agentIdentityText(rt.agentId),
        AGENT_MEMORY: agentMemoryText(rt.agentId, { truncateMemory, maxMemoryChars }),
        PEER_AGENTS: peerAgentsText(rt.agentId),
        PAST_SESSIONS_LIST: pastSessions,
        ATTACHED_FILES: formatAttachedFilesPrompt(rt.attachedFiles),
        NSFW_LEVEL_LABEL: nsfwPolicyLabel(getNsfwLevel(loadUserConfig())),
        NSFW_POLICY: buildNsfwPolicyText(getNsfwLevel(loadUserConfig())),
        APPROVAL_LEVEL_LABEL: approvalPolicyLabel(getApprovalLevel(loadUserConfig())),
        APPROVAL_POLICY: buildApprovalPolicyText(getApprovalLevel(loadUserConfig())),
    };
    return renderSystemPrompt(template, vars).trim();
}

function dropPendingCurrent(history, userMessage) {
    if (!history?.length) return history || [];
    const last = history[history.length - 1];
    const msgs = last?.messages || [];
    if (msgs.length !== 1 || msgs[0]?.role !== "user") return history;
    const lastText = typeof msgs[0].content === "string" ? msgs[0].content.trim() : "";
    const incoming = String(userMessage || "").trim();
    if (lastText === incoming) return history.slice(0, -1);
    return history;
}

function toLlmMessage(message, { visionEnabled = false } = {}) {
    const cloned = cloneStoredMessage(message);
    delete cloned.imageUrl;
    if (cloned.role === "user") {
        const text = typeof cloned.content === "string" ? cloned.content : "";
        cloned.content = hydrateUserContent(text, cloned.attachments, { visionEnabled });
    }
    delete cloned.attachments;
    return cloned;
}

export function buildInitialMessages(
    userMessage,
    { truncateMemory = false, maxMemoryChars = 120000, history = [], attachments = [], modelMeta = null, runtimeInfo = {} } = {},
) {
    const visionEnabled = modelMeta?.supportsVision === true;
    const currentFiles = Array.isArray(attachments) ? attachments : [];
    const historyForPrompt = dropPendingCurrent(history, userMessage);
    const attachedFiles = collectFilesFromHistory(historyForPrompt, currentFiles);
    const lang = loadUserConfig().language || "en";
    const systemContent = buildSystemMessageContent(lang, {
        truncateMemory,
        maxMemoryChars,
        runtimeInfo: { ...runtimeInfo, attachedFiles },
    });

    const messages = [{ role: "system", content: systemContent }];

    for (const turn of historyForPrompt) {
        for (const message of turnToMessages(turn)) {
            messages.push(toLlmMessage(message, { visionEnabled }));
        }
    }
    messages.push({
        role: "user",
        content: hydrateUserContent(userMessage, currentFiles, { visionEnabled }),
    });
    return messages;
}

export function getContextWindow(modelMeta) {
    return modelMeta?.contextWindow || 128000;
}

export function getCompressTriggerTokens(modelMeta) {
    const agent = loadAgentConfig();
    const pct = agent.contextCompressTriggerPercent ?? 75;
    return Math.floor((getContextWindow(modelMeta) * pct) / 100);
}

export function getKeepRecentTokenBudget(modelMeta) {
    const agent = loadAgentConfig();
    const pct = agent.contextKeepRecentPercent ?? 20;
    return Math.floor((getContextWindow(modelMeta) * pct) / 100);
}

export function getContextLimit(modelMeta) {
    const agent = loadAgentConfig();
    const pct = agent.contextThresholdPercent ?? 90;
    return Math.floor((getContextWindow(modelMeta) * pct) / 100);
}
