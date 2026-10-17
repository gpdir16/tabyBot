import fs from "node:fs";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import { sanitizeTextForLlm } from "../llm/sanitize-messages.js";
import { CODES_DIR } from "../paths.js";
import { readMemoryFile, readAgentMemoryFile, formatAgentMemoryFilesListForPrompt, agentMemoryFilePath, agentMemoryDirPath } from "../memory-file.js";
import { firstAgent, formatPeerAgentsForPrompt, getAgent } from "../agents-store.js";
import { loadAgentConfig, loadUserConfig } from "../config-loader.js";
import {
    getNsfwLevel,
    buildNsfwPolicyText,
    nsfwPolicyLabel,
    getApprovalLevel,
    buildApprovalPolicyText,
    approvalPolicyLabel,
    normalizeContextTriggerPercent,
} from "../user-settings.js";
import { formatTodosForPrompt } from "../todos/store.js";
import { estimateContentTokens } from "../llm/vision.js";
import { hydrateUserContent } from "../web/attachments.js";
import { formatSkillsListForPrompt } from "../skills-catalog.js";
import { formatSecretsForPrompt } from "../secrets/vault.js";
import { buildEnvironmentPromptVars, buildFilesystemPromptBlock, buildRuntimeInfoLine, renderSystemPrompt } from "./system-prompt.js";
import { formatPastSessionsForPrompt, turnToMessages, cloneStoredMessage } from "./chat-history.js";
import { isStandalonePendingTurn } from "./history/messages.js";
const SYSTEM_PATH = path.join(CODES_DIR, "lib", "prompts", "system.txt");

let encoding;
function getTokenizer() {
    try {
        if (!encoding) encoding = getEncoding("o200k_base");
        return encoding;
    } catch {
        return null;
    }
}

export function countTokens(text) {
    const enc = getTokenizer();
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

export function countMessagesTokens(messages) {
    let total = 0;
    for (const m of messages) {
        if (Array.isArray(m.content)) {
            total += estimateContentTokens(m.content);
        } else {
            total += countTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
        }
        if (m.tool_calls) total += countTokens(JSON.stringify(m.tool_calls));
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
    if (!id) return "- (none. Use shared memory.md)";
    return loadScopedMemory(readAgentMemoryFile(id), opts).trim() || "(empty)";
}

function peerAgentsText(agentId) {
    return formatPeerAgentsForPrompt(agentId || firstAgent()?.id) || "- (none)";
}

function buildSystemMessageContent({ truncateMemory = false, maxMemoryChars = 120000, runtimeInfo = {} } = {}) {
    const template = loadSystemPromptTemplate();
    const rt = runtimeInfo || {};
    const pastSessions = formatPastSessionsForPrompt(rt.sessionKey);
    const todoBlocks = formatTodosForPrompt(rt.agentId);
    const vars = {
        ...buildEnvironmentPromptVars(),
        FILESYSTEM_BLOCK: buildFilesystemPromptBlock(),
        SKILLS_LIST: formatSkillsListForPrompt(),
        SECRETS_LIST: formatSecretsForPrompt(),
        RUNTIME_INFO: buildRuntimeInfoLine(rt),
        MEMORY: loadMemoryForPrompt({ truncateMemory, maxMemoryChars }),
        AGENT_MEMORY_PATH: agentMemoryFilePath(rt.agentId || firstAgent()?.id),
        AGENT_MEMORY_DIR: agentMemoryDirPath(rt.agentId || firstAgent()?.id),
        AGENT_MEMORY_FILES_LIST: formatAgentMemoryFilesListForPrompt(rt.agentId || firstAgent()?.id),
        AGENT_IDENTITY: agentIdentityText(rt.agentId),
        AGENT_MEMORY: agentMemoryText(rt.agentId, { truncateMemory, maxMemoryChars }),
        PEER_AGENTS: peerAgentsText(rt.agentId),
        PAST_SESSIONS_LIST: pastSessions,
        NSFW_LEVEL_LABEL: nsfwPolicyLabel(getNsfwLevel(loadUserConfig())),
        NSFW_POLICY: buildNsfwPolicyText(getNsfwLevel(loadUserConfig())),
        APPROVAL_LEVEL_LABEL: approvalPolicyLabel(getApprovalLevel(loadUserConfig())),
        APPROVAL_POLICY: buildApprovalPolicyText(getApprovalLevel(loadUserConfig())),
        TODO_LIST: todoBlocks.list,
        TODO_SUGGEST_LIST: todoBlocks.suggestions,
        SCHEDULE_JOBS: todoBlocks.jobs,
    };
    return renderSystemPrompt(template, vars).trim();
}

// 이번 실행이 직접 다루는 메시지의 대기 턴은 프롬프트에서 뺀다. 지금 메시지는 맨 끝에 다시 붙고,
// 대기열에 쌓인 메시지는 실행 중에 합쳐 넣으므로 그대로 두면 모델이 같은 말을 두 번 읽는다.
function dropOwnedPendingTurns(history, excludeMessageIds) {
    const owned = new Set(excludeMessageIds || []);
    if (!owned.size) return history || [];
    return (history || []).filter((turn) => !(isStandalonePendingTurn(turn) && owned.has(turn.messages[0].id)));
}

// id가 없는 예전 기록용: 마지막 대기 턴이 지금 메시지와 같은 본문이면 뺀다.
function dropPendingCurrent(history, userMessage) {
    if (!history?.length) return history || [];
    const last = history[history.length - 1];
    const msgs = last?.messages || [];
    if (msgs.length !== 1 || msgs[0]?.role !== "user" || msgs[0].id) return history;
    const lastText = typeof msgs[0].content === "string" ? msgs[0].content.trim() : "";
    const incoming = String(userMessage || "").trim();
    if (lastText === incoming) return history.slice(0, -1);
    return history;
}

function toLlmMessage(message) {
    const cloned = cloneStoredMessage(message);
    delete cloned.imageUrl;
    if (cloned.role === "user") {
        const text = typeof cloned.content === "string" ? cloned.content : "";
        // 히스토리 메시지의 첨부 이미지를 매 턴 base64로 다시 싣지 않는다. 인라인 이미지는 현재 사용자
        // 메시지에서만 붙인다. attachments는 남겨 두면 API로 보낼 때 그 메시지의 첨부 안내 블록이 된다.
        cloned.content = hydrateUserContent(text, cloned.attachments, { visionEnabled: false });
        return cloned;
    }
    delete cloned.attachments;
    return cloned;
}

export function buildInitialMessages(
    userMessage,
    {
        truncateMemory = false,
        maxMemoryChars = 120000,
        history = [],
        attachments = [],
        modelMeta = null,
        runtimeInfo = {},
        excludeMessageIds = [],
    } = {},
) {
    const visionEnabled = modelMeta?.supportsVision === true;
    const currentFiles = Array.isArray(attachments) ? attachments : [];
    const historyForPrompt = dropPendingCurrent(dropOwnedPendingTurns(history, excludeMessageIds), userMessage);
    const systemContent = buildSystemMessageContent({ truncateMemory, maxMemoryChars, runtimeInfo });

    const messages = [{ role: "system", content: systemContent }];

    for (const turn of historyForPrompt) {
        for (const message of turnToMessages(turn)) {
            messages.push(toLlmMessage(message));
        }
    }
    messages.push({
        role: "user",
        content: hydrateUserContent(userMessage, currentFiles, { visionEnabled }),
        ...(currentFiles.length ? { attachments: currentFiles } : {}),
    });
    return messages;
}

export function getContextWindow(modelMeta) {
    return modelMeta?.contextWindow || 128000;
}

export function getCompressTriggerTokens(modelMeta) {
    const agent = loadAgentConfig();
    // 사용자 설정(설정의 모델 탭 고급 항목)이 우선, 없으면 agent.json 기본값을 쓴다.
    const pct = normalizeContextTriggerPercent(loadUserConfig().contextTriggerPercent, agent.contextCompressTriggerPercent ?? 75);
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
