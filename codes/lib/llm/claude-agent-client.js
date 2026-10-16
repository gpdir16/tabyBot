import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeMessagesForApi, sanitizeTextForLlm } from "./sanitize-messages.js";
import { buildStreamResult } from "./responses-request.js";
import { stoppedError, throwIfAborted } from "./transport.js";

// Claude 구독은 Claude Agent SDK(번들된 claude 실행 파일)로만 호출함. 로그인은 CLI의
// `claude auth login`이 하고, tabyBot은 토큰을 읽지도 저장하지도 않음.
//
// SDK는 원래 자체 에이전트 루프를 도는 하네스지만 여기서는 추론만 맡김:
// - 내장 도구는 모두 끄고(tools: []) tabyBot 도구만 MCP로 알려 줌. 모델이 도구를 부르면 그 호출을
//   붙잡아 둔 채 complete()를 끝내고, tabyBot 루프가 실행한 결과를 다음 complete()에서 돌려줌.
// - CLI는 띄우는 데 몇 초가 걸리므로 대화(cacheKey)마다 프로세스 하나를 살려 두고 이어 씀.
//   들어온 메시지가 "그 프로세스가 아는 대화 + 새 메시지 하나"일 때만 이어 쓰고, 아니면(기록 압축,
//   시스템 프롬프트 변경, 중단, 재시작 등) 프로세스를 새로 띄워 tabyBot 메시지로 세션 기록을 만들어 넘김.
// - 새로 띄울 때 앞부분이 그대로면 CLI가 남긴 기록 항목을 그대로 다시 넣어 요청 앞부분이 같게 함(프롬프트 캐시).

// MCP 서버 이름. 모델에는 mcp__t__<도구 이름>으로 보임.
const TOOL_SERVER = "t";
const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;
// 새로 띄운 프로세스의 마지막 메시지가 도구 결과면 기록에 넣은 채 CLI의 "끊긴 턴 이어 하기"로 답하게
// 함(프롬프트로 보내면 CLI가 "중단된 도구 호출"로 고쳐 씀). 그때 CLI가 뒤에 붙이는 문구.
const RESUME_MARKER = "(tool results above)";
const EMPTY_TEXT = "(no content)";
const INTERRUPTED_RESULT = "[tool call interrupted: no result recorded]";
const CLI_VERSION = "0.0.0";
const TOOLS_READY_TIMEOUT_MS = 15_000;
const AUTH_REFRESH_TIMEOUT_MS = 15_000;
// CLI는 MCP 도구 출력이 5만 자를 넘으면(한 메시지 합계로는 20만 자) 파일로 빼고 미리보기만 모델에 줌.
// 끌 방법이 없으므로 그보다 긴 결과는 살아 있는 프로세스로 돌려주지 않고, 새로 띄워 기록에 넣어 보냄.
const LIVE_RESULT_CHARS = 40_000;
const LIVE_RESULTS_TOTAL_CHARS = 150_000;
const MAX_CONVERSATIONS = 30;
// 살려 두는 프로세스 수. 하나가 수백 MB를 씀.
const MAX_LIVE = 3;
const IDLE_CLOSE_MS = 10 * 60_000;
const TOOLS_CLOSE_MS = 60 * 60_000;
const INFO_TTL_MS = 30 * 60_000;
const CLOSE_CLEANUP_MS = 5000;
// CLI는 작업 폴더의 경로와 git 상태를 프롬프트에 실음. 저장소 밖의 빈 폴더에서 띄워
// 대화와 상관없는 내용이 섞이지 않게 함.
const WORK_DIR = path.join(os.tmpdir(), "tabybot-claude-agent");
const TOOL_SERVER_SCRIPT = fileURLToPath(new URL("./claude-tool-server.js", import.meta.url));

// 자식 프로세스에 넘길 환경 변수. API 키, 기본 URL, 클라우드 백엔드 전환 변수는 넘기지 않음.
// 넘기면 구독 대신 API 과금으로 조용히 바뀔 수 있음.
const ENV_ALLOW = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TZ",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SystemRoot",
];

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required"]);

function sha(...parts) {
    const hash = crypto.createHash("sha256");
    for (const part of parts) hash.update(typeof part === "string" ? part : JSON.stringify(part)).update("\0");
    return hash.digest("hex");
}

export function buildClaudeEnv(envOverride) {
    const env = {};
    for (const name of ENV_ALLOW) if (process.env[name] !== undefined) env[name] = process.env[name];
    return {
        ...env,
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_AGENT_SDK_CLIENT_APP: "tabybot",
        // 도구 서버 연결이 끝난 뒤에 첫 요청을 보내게 함. 기본값(비동기)이면 도구 정의가 빠질 수 있음.
        MCP_CONNECTION_NONBLOCKING: "0",
        // 인증, 한도 오류에서 CLI가 오래 재시도하지 않게 함. 턴 복구는 tabyBot이 맡음.
        CLAUDE_CODE_MAX_RETRIES: "2",
        // 기록 압축과 도구 출력 자르기는 tabyBot이 함. CLI가 따로 하면 두 쪽의 대화가 어긋남.
        DISABLE_AUTO_COMPACT: "1",
        MAX_MCP_OUTPUT_TOKENS: "100000000",
        // 도구 실행(사용자 승인 대기 포함)은 오래 걸릴 수 있음.
        MCP_TOOL_TIMEOUT: String(24 * 60 * 60_000),
        ...envOverride,
    };
}

// ── tabyBot(OpenAI 형식) 메시지 → Anthropic 형식 ──

function imageBlock(url) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ""));
    if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
    return { type: "image", source: { type: "url", url: String(url || "") } };
}

function userBlocks(content) {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
    if (!Array.isArray(content)) return [];
    const blocks = [];
    for (const part of content) {
        if (part?.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
        else if (part?.type === "image_url") blocks.push(imageBlock(part.image_url?.url));
    }
    return blocks;
}

function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => (part?.type === "text" ? part.text || "" : "")).join("");
}

function parseArguments(raw) {
    if (raw && typeof raw === "object") return raw;
    try {
        const parsed = JSON.parse(raw || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        // 잘린 인자 JSON은 빈 입력으로 재생함. 결과 메시지에 당시 오류가 남아 있음.
        return {};
    }
}

function assistantSig(text, toolIds) {
    return sha("assistant", String(text || "").trim(), toolIds);
}

// 도구가 만든 이미지는 루프가 도구 결과 바로 뒤에 user 메시지로 따로 붙임(buildToolImageObservation).
// 사용자가 쓴 메시지(id 있음)나 작업 중에 들어온 메시지(queued 있음)와 구분해 표시해 둠.
function markToolObservations(messages) {
    let afterTool = false;
    return messages.map((m) => {
        const observation =
            afterTool && m?.role === "user" && !m.id && !m.queued && Array.isArray(m.content) && m.content.some((part) => part?.type === "image_url");
        afterTool = m?.role === "tool" || observation;
        return observation ? { ...m, toolObservation: true } : m;
    });
}

// 같은 역할이 이어지면 한 메시지로 합침. 도구 결과는 사용자 메시지 맨 앞에 와야 함.
function toAnthropicMessages(messages) {
    let system = "";
    const out = [];
    const pendingTools = new Set();

    const pushUser = (blocks, toolResults = []) => {
        let last = out[out.length - 1];
        if (last?.role !== "user") {
            last = { role: "user", results: [], blocks: [] };
            out.push(last);
        }
        last.results.push(...toolResults);
        last.blocks.push(...blocks);
    };
    // 결과 없이 끝난 도구 호출(중단된 턴)은 API가 거절하므로 빈 결과를 채움.
    const closePendingTools = () => {
        if (!pendingTools.size) return;
        pushUser(
            [],
            [...pendingTools].map((id) => ({ type: "tool_result", tool_use_id: id, content: INTERRUPTED_RESULT })),
        );
        pendingTools.clear();
    };
    // 도구가 만든 이미지는 마지막 도구 결과 안에 넣음. 그래야 결과와 함께 한 번에 돌려줄 수 있음.
    const foldObservation = (blocks) => {
        const last = out[out.length - 1];
        const result = last?.role === "user" && !last.blocks.length ? last.results[last.results.length - 1] : null;
        if (!result) return false;
        if (typeof result.content === "string") result.content = [{ type: "text", text: result.content }];
        result.content.push(...blocks);
        return true;
    };

    messages.forEach((m, index) => {
        if (m.role === "system" && index === 0) {
            system = textOf(m.content);
            return;
        }
        if (m.role === "tool") {
            if (!pendingTools.delete(m.tool_call_id)) return;
            pushUser([], [{ type: "tool_result", tool_use_id: m.tool_call_id, content: textOf(m.content) || EMPTY_TEXT }]);
            return;
        }
        if (m.toolObservation && !pendingTools.size && foldObservation(userBlocks(m.content))) return;
        closePendingTools();
        if (m.role === "assistant") {
            const text = textOf(m.content);
            const calls = (m.tool_calls || []).filter((tc) => tc?.id && tc.function?.name);
            const blocks = [];
            if (text) blocks.push({ type: "text", text });
            for (const tc of calls) {
                blocks.push({ type: "tool_use", id: tc.id, name: TOOL_PREFIX + tc.function.name, input: parseArguments(tc.function.arguments) });
                pendingTools.add(tc.id);
            }
            if (!blocks.length) blocks.push({ type: "text", text: EMPTY_TEXT });
            if (!out.length) pushUser([{ type: "text", text: EMPTY_TEXT }]);
            out.push({
                role: "assistant",
                blocks,
                sig: assistantSig(
                    text,
                    calls.map((tc) => tc.id),
                ),
            });
            return;
        }
        // user, 그리고 맨 앞이 아닌 system(압축 요약 등)
        pushUser(userBlocks(m.content));
    });
    closePendingTools();
    if (out[out.length - 1]?.role !== "user") pushUser([{ type: "text", text: "Continue." }]);

    return {
        system,
        messages: out.map((m) => {
            if (m.role === "assistant") return { role: "assistant", content: m.blocks, sig: m.sig };
            const blocks = m.results.length || m.blocks.length ? m.blocks : [{ type: "text", text: EMPTY_TEXT }];
            const body = [...m.results, ...blocks];
            return { role: "user", results: m.results, blocks, body, sig: sha("user", body) };
        }),
    };
}

// ── 대화별 상태 ──

// cacheKey(대화)별로 CLI가 남긴 기록 항목과, 그 기록이 담고 있는 메시지들의 서명을 둠.
// proc은 살아 있는 프로세스(없으면 null).
const conversations = new Map();
const lives = new Set();
// 닫았지만 아직 뒷정리(소켓, 로컬 기록)가 남은 프로세스.
const closing = new Set();

function newConversation() {
    return { key: null, sigs: [], entries: [], tools: null, proc: null, busy: false };
}

function conversation(cacheKey) {
    if (!cacheKey) return newConversation();
    const id = String(cacheKey);
    let conv = conversations.get(id);
    // 같은 대화의 호출이 겹치면 뒤에 온 쪽은 일회용 프로세스로 처리함.
    if (conv?.busy) return newConversation();
    if (conv) conversations.delete(id);
    else conv = newConversation();
    conversations.set(id, conv);
    if (conversations.size > MAX_CONVERSATIONS) {
        const [oldestId, oldest] = conversations.entries().next().value;
        if (!oldest.busy) {
            oldest.proc?.close();
            conversations.delete(oldestId);
        }
    }
    return conv;
}

process.once("exit", () => {
    for (const live of [...lives]) live.close();
    for (const live of [...closing]) live.cleanup();
});

// ── CLI 세션 기록 ──

const CHAIN_TYPES = new Set(["user", "assistant", "attachment"]);

function isSnapshot(entry) {
    return entry?.type === "attachment" && entry.attachment?.type === "prompt_snapshot";
}

function entryRole(entry) {
    if (entry.type === "assistant") return "assistant";
    return entry.type === "user" && !entry.isMeta ? "user" : null;
}

// 기록 항목을 메시지 단위로 묶음. 첨부, 딸림 항목은 바로 앞 메시지에 붙음.
function splitUnits(entries) {
    const units = [];
    const head = [];
    for (const entry of entries) {
        const role = entryRole(entry);
        let unit = units[units.length - 1];
        if (role && unit?.role !== role) {
            unit = { role, entries: units.length ? [] : [...head] };
            units.push(unit);
        }
        if (unit) unit.entries.push(entry);
        else head.push(entry);
    }
    return units;
}

function blockIds(blocks, type, field) {
    return blocks
        .filter((block) => block?.type === type)
        .map((block) => block[field])
        .sort()
        .join(",");
}

// 기록의 한 단위가 들어온 메시지와 같은 것인지 봄. 본문은 서명으로 이미 비교했고, 여기서는
// 프로세스가 죽으면서 기록이 덜 남은 경우를 걸러 냄.
function unitMatches(unit, message) {
    if (!unit || unit.role !== message.role) return false;
    const blocks = unit.entries
        .filter((entry) => entryRole(entry))
        .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : [{ type: "text", text: entry.message?.content }]));
    if (message.role === "assistant") return blockIds(blocks, "tool_use", "id") === blockIds(message.content, "tool_use", "id");
    return blocks.length > 0 && blockIds(blocks, "tool_result", "tool_use_id") === blockIds(message.results, "tool_result", "tool_use_id");
}

// 새 프로세스에 넘길 세션 기록을 만듦. 앞부분이 그대로인 메시지는 CLI가 남긴 항목을 그대로 쓰고
// (생각 블록, 첨부 포함), 나머지는 tabyBot 메시지로 만듦. 마지막 사용자 메시지는 보통 프롬프트로
// 보내므로 기록에서 빼고, 도구 결과면(resume) 기록에 두어 "끊긴 턴 이어 하기"로 답하게 함.
function buildTranscript({ conv, model, system, messages, sessionId, cwd, resume }) {
    const entries = [];
    let parentUuid = null;
    const push = (entry) => {
        entries.push({ ...entry, parentUuid, sessionId });
        parentUuid = entry.uuid;
    };
    const last = messages.length - 1;
    const units = splitUnits(conv.entries);
    let kept = 0;
    while (kept < last && conv.sigs[kept] === messages[kept].sig && unitMatches(units[kept], messages[kept])) kept += 1;

    let clock = Date.now() - (messages.length + 1) * 1000;
    const base = { isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, version: CLI_VERSION, gitBranch: "HEAD" };
    const make = (entry) => {
        clock += 1;
        push({ ...base, ...entry, uuid: crypto.randomUUID(), timestamp: new Date(clock).toISOString() });
    };
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    // 이어 하는 턴은 호출 옵션이 아니라 기록에 적힌 시스템 프롬프트를 씀. 지금 것을 맨 앞에 적어 줌.
    if (resume) {
        make({
            type: "attachment",
            attachment: {
                type: "prompt_snapshot",
                systemPrompt: [system],
                reminderFold: false,
                echoWireToolInputs: false,
                contextRendering: "announced",
            },
        });
    }
    for (const unit of units.slice(0, kept)) {
        for (const entry of unit.entries) {
            push(entry);
            clock = Math.max(clock, Date.parse(entry.timestamp) || 0);
        }
    }
    messages.forEach((m, i) => {
        if (i < kept || (i === last && !resume)) return;
        if (m.role === "user") {
            make({ type: "user", message: { role: "user", content: m.body } });
            // CLI는 첫 메시지 뒤에 날짜를 알리는 첨부를 붙임. 없으면 그 자리에 빈 시스템 블록을 보내므로
            // 첫 메시지의 시각 표기에서 읽은 날짜로 채워 둠(호출마다 같음).
            const date =
                i === 0 && i !== last ? /^\[(\d{4}-\d{2}-\d{2}) /.exec(m.blocks.find((block) => block.type === "text")?.text || "")?.[1] : null;
            if (date) {
                make({
                    type: "attachment",
                    attachment: { type: "date", date },
                    rendered: [{ content: `<system-reminder>\nToday's date is ${date}.\n</system-reminder>` }],
                    renderedRole: "system",
                });
            }
            return;
        }
        const stop_reason = m.content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
        for (const block of m.content) {
            make({
                type: "assistant",
                message: {
                    id: `msg_taby_${i}`,
                    type: "message",
                    role: "assistant",
                    model,
                    content: [block],
                    stop_reason,
                    stop_sequence: null,
                    usage,
                },
                requestedModel: model,
            });
        }
    });
    return { entries, covered: resume ? messages.length : last };
}

// ── 도구 ──

function toolList(tools) {
    return (tools || [])
        .filter((tool) => tool?.function?.name)
        .map((tool) => ({
            name: tool.function.name,
            description: tool.function.description || "",
            inputSchema: tool.function.parameters || { type: "object", properties: {} },
            // 도구 검색 뒤로 미루지 않고 항상 프롬프트에 실음.
            _meta: { "anthropic/alwaysLoad": true },
        }));
}

// 도구 목록은 내용 해시 이름의 파일로 넘김. 목록이 같으면 같은 파일을 다시 씀.
function toolsFile(list) {
    const body = JSON.stringify(list);
    const file = path.join(WORK_DIR, `tools-${sha(body).slice(0, 16)}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, body);
    return file;
}

function socketPath() {
    const name = crypto.randomBytes(6).toString("hex");
    return process.platform === "win32" ? `\\\\.\\pipe\\tabybot-claude-${name}` : path.join(WORK_DIR, `${name}.sock`);
}

// tabyBot 도구 결과(Anthropic tool_result 본문) → MCP 도구 결과
function toMcpResult(content) {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return {
        content: blocks.map((block) => {
            if (block.type !== "image") return { type: "text", text: block.text || "" };
            if (block.source?.type === "base64") return { type: "image", data: block.source.data, mimeType: block.source.media_type };
            return { type: "text", text: `[image: ${block.source?.url || ""}]` };
        }),
    };
}

// 도구 서버 연결보다 턴이 먼저 시작되면 그 요청에는 도구 정의가 빠짐. 연결을 확인한 뒤에 보냄.
async function waitForTools(run) {
    const deadline = Date.now() + TOOLS_READY_TIMEOUT_MS;
    for (;;) {
        const servers = await run.mcpServerStatus();
        const status = servers?.find((server) => server.name === TOOL_SERVER)?.status;
        if (status === "connected") return;
        if (status === "failed" || Date.now() > deadline) throw new Error(`tool server not ready (${status || "missing"})`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

// ── 응답 ──

function configDir(env) {
    return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
}

// CLI는 sessionStore와 별개로 로컬에도 기록(과 도구가 준 이미지)을 남김. 프로세스마다 새 세션이라
// 그대로 두면 계속 쌓임.
function removeLocalTranscript(env, cwd, sessionId) {
    const base = path.join(configDir(env), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), sessionId);
    for (const target of [`${base}.jsonl`, base]) {
        try {
            fs.rmSync(target, { force: true, recursive: true });
        } catch {
            // 정리 실패는 응답에 영향이 없음.
        }
    }
}

function toUsage(usage) {
    if (!usage) return undefined;
    const cached = usage.cache_read_input_tokens || 0;
    const prompt = (usage.input_tokens || 0) + cached + (usage.cache_creation_input_tokens || 0);
    const completion = usage.output_tokens || 0;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: cached },
    };
}

function failure(kind, text, stderr) {
    if (AUTH_ERRORS.has(kind) || /not logged in|please run \/login|invalid api key/i.test(text || "")) {
        invalidateClaudeInfo();
        const err = new Error(`Claude is not signed in. Sign in from the provider settings, then try again. (${text || kind})`);
        err.code = "CLAUDE_AUTH_REQUIRED";
        return err;
    }
    const detail = text || stderr.trim().split("\n").slice(-5).join("\n") || kind || "unknown error";
    return new Error(`Claude Agent SDK error: ${detail}`);
}

function blockText(blocks) {
    return blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function blockToolCalls(blocks) {
    return blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
            id: block.id,
            type: "function",
            function: {
                name: block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name,
                arguments: JSON.stringify(block.input ?? {}),
            },
        }));
}

// 실제로 요청을 보낸 모델의 컨텍스트 크기. CLI가 턴이 끝날 때 알려 줌.
function reportedContextWindow(result) {
    let best = null;
    for (const usage of Object.values(result?.modelUsage || {})) {
        const used = (usage.inputTokens || 0) + (usage.cacheReadInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
        if (usage.contextWindow > 0 && (!best || used > best.used)) best = { used, contextWindow: usage.contextWindow };
    }
    return best?.contextWindow || null;
}

// ── 살려 두는 프로세스 ──

// 프롬프트 입력. 프로세스가 사는 동안 열어 두고 사용자 메시지를 하나씩 밀어 넣음.
function createInbox() {
    const queue = [];
    let wake = null;
    let ended = false;
    const next = () => {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
        if (ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
            wake = () => resolve(next());
        });
    };
    const notify = () => {
        const fn = wake;
        wake = null;
        fn?.();
    };
    return {
        push(content) {
            queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
            notify();
        },
        end() {
            ended = true;
            notify();
        },
        [Symbol.asyncIterator]: () => ({ next }),
    };
}

class LiveProcess {
    constructor(conv, { env, cwd, sessionId, hasTools }) {
        this.conv = conv;
        this.env = env;
        this.cwd = cwd;
        this.sessionId = sessionId;
        this.inbox = createInbox();
        this.abortController = new AbortController();
        this.token = crypto.randomBytes(16).toString("hex");
        this.sockets = new Set();
        this.server = null;
        this.socketFile = null;
        this.run = null;
        this.closed = false;
        this.stderr = "";
        // idle: 다음 사용자 메시지를 기다림. tools: 모델이 부른 도구의 결과를 기다림.
        this.state = "idle";
        this.turnOpen = false;
        this.turnWaiters = [];
        this.toolsReady = !hasTools;
        this.expected = [];
        this.calls = new Map();
        this.held = new Map();
        this.current = null;
        this.apiError = null;
        this.onContextWindow = null;
        this.timer = null;
        this.usedAt = Date.now();
        lives.add(this);
    }

    // 도구 서버(CLI가 띄운 자식)가 호출을 넘겨 올 소켓.
    listen() {
        this.socketFile = socketPath();
        this.server = net.createServer((socket) => {
            this.sockets.add(socket);
            let buffer = "";
            socket.setEncoding("utf8");
            socket.on("data", (chunk) => {
                buffer += chunk;
                for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
                    const call = JSON.parse(buffer.slice(0, at));
                    buffer = buffer.slice(at + 1);
                    if (call.token !== this.token) {
                        socket.destroy();
                        return;
                    }
                    this.onToolCall(call, (result) => socket.write(`${JSON.stringify({ id: call.id, result })}\n`));
                }
            });
            socket.on("error", () => {
                // 프로세스를 닫을 때 끊기는 것은 정상임.
            });
            socket.on("close", () => this.sockets.delete(socket));
        });
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.socketFile, resolve);
        });
    }

    start(options, loaded) {
        const seen = new Set(loaded.map((entry) => entry.uuid));
        this.run = query({
            prompt: this.inbox,
            options: {
                ...options,
                cwd: this.cwd,
                env: this.env,
                abortController: this.abortController,
                includePartialMessages: true,
                sessionStore: {
                    append: (key, entries) => {
                        if (!key?.subpath && !this.closed) {
                            for (const entry of entries) {
                                if (!CHAIN_TYPES.has(entry?.type) || isSnapshot(entry) || seen.has(entry.uuid)) continue;
                                seen.add(entry.uuid);
                                this.conv.entries.push(entry);
                            }
                        }
                        return Promise.resolve();
                    },
                    load: (key) => Promise.resolve(key?.subpath ? null : loaded),
                },
                sessionStoreFlush: "eager",
                ...(loaded.length ? { resume: this.sessionId } : { sessionId: this.sessionId }),
                stderr: (chunk) => {
                    this.stderr = (this.stderr + chunk).slice(-4000);
                },
            },
        });
        this.pump();
    }

    async pump() {
        try {
            for await (const message of this.run) this.handle(message);
            this.fail("Claude process ended.");
        } catch (err) {
            this.fail(String(err?.message || err));
        }
    }

    handle(message) {
        if (this.closed || message.parent_tool_use_id) return;
        if (message.type === "stream_event") this.onEvent(message.event);
        else if (message.type === "result") this.onResult(message);
        else if (message.type === "assistant" && message.error) this.apiError = { kind: message.error, text: textOf(message.message?.content) };
        else if (message.type === "assistant") this.current?.blocks.push(...(message.message?.content || []));
    }

    onEvent(event) {
        const cur = this.current;
        if (event?.type === "message_start") {
            // 기다리는 호출이 없는데 모델이 답하기 시작함: CLI가 혼자 다음 단계로 넘어간 것.
            // 그 답은 tabyBot 대화에 없으므로 프로세스를 버림.
            if (!cur?.started) {
                this.close();
                return;
            }
            cur.blocks = [];
            cur.text = "";
            cur.usage = { ...event.message?.usage };
            return;
        }
        if (!cur?.started) return;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            cur.text += event.delta.text;
            cur.onTextDelta?.(event.delta.text, cur.text);
        } else if (event?.type === "message_delta") {
            cur.usage = { ...cur.usage };
            for (const [name, value] of Object.entries(event.usage || {})) if (value != null) cur.usage[name] = value;
        } else if (event?.type === "message_stop") {
            this.finish();
        }
    }

    // 모델의 답 하나가 끝남. 도구 호출이 있으면 붙잡아 둔 채로 호출자에게 돌려줌.
    finish() {
        const cur = this.current;
        if (!cur?.blocks.length) return;
        this.current = null;
        const text = blockText(cur.blocks);
        const calls = blockToolCalls(cur.blocks);
        const usable = cur.allowTools ? calls : [];
        this.conv.sigs.push(
            assistantSig(
                sanitizeTextForLlm(text),
                usable.map((call) => call.id),
            ),
        );
        this.state = usable.length ? "tools" : "idle";
        this.expected = usable.map((call) => ({ id: call.id, name: call.function.name }));
        cur.done(null, buildStreamResult(text, usable, toUsage(cur.usage)));
        // 도구를 쓰지 않기로 한 호출에서 모델이 도구를 부름. 그 호출은 버려지므로 이어 쓸 수 없음.
        if (calls.length && !usable.length) this.close();
        else this.arm();
    }

    onResult(message) {
        this.turnOpen = false;
        for (const wake of this.turnWaiters.splice(0)) wake();
        const contextWindow = reportedContextWindow(message);
        if (contextWindow) this.onContextWindow?.(contextWindow);

        const cur = this.current;
        const apiError = this.apiError;
        this.apiError = null;
        if (cur?.started) {
            if (!apiError && cur.blocks.length) {
                this.finish();
            } else {
                this.current = null;
                cur.done(failure(apiError?.kind || message.subtype, apiError?.text || (message.errors || []).join("\n"), this.stderr));
            }
        }
        // 오류로 끝났거나 도구 결과를 기다리던 턴이 닫혔으면 CLI 쪽 대화를 믿을 수 없음.
        if (apiError || this.state === "tools") this.close();
    }

    onToolCall(call, respond) {
        const id = call.toolUseId || this.expected.find((item) => item.name === call.name && !this.calls.has(item.id))?.id;
        if (!id) {
            respond({ isError: true, content: [{ type: "text", text: "Unknown tool call." }] });
        } else if (this.held.has(id)) {
            respond(this.held.get(id));
            this.held.delete(id);
        } else {
            this.calls.set(id, respond);
        }
    }

    // CLI는 도구를 하나씩 차례로 부름. 아직 불리지 않은 호출의 결과는 들고 있다가 불리면 줌.
    deliver(results) {
        for (const result of results) {
            const payload = toMcpResult(result.content);
            const respond = this.calls.get(result.tool_use_id);
            if (respond) {
                this.calls.delete(result.tool_use_id);
                respond(payload);
            } else {
                this.held.set(result.tool_use_id, payload);
            }
        }
    }

    turnClosed() {
        if (!this.turnOpen) return Promise.resolve();
        return new Promise((resolve) => this.turnWaiters.push(resolve));
    }

    // 들어온 메시지를 이 프로세스로 이어 받을 수 있으면 방식("prompt" | "tools")을, 아니면 null을 줌.
    accepts(messages) {
        const last = messages.length - 1;
        const sigs = this.conv.sigs;
        if (this.closed || this.current || sigs.length !== last) return null;
        for (let i = 0; i < last; i += 1) if (sigs[i] !== messages[i].sig) return null;
        const tail = messages[last];
        if (this.state === "idle") return tail.results.length ? null : "prompt";
        const expected = this.expected
            .map((item) => item.id)
            .sort()
            .join(",");
        // 도구 결과 뒤에 다른 내용(작업 중에 들어온 사용자 메시지 등)이 붙어 있으면 결과만 따로 줄 수 없음.
        if (blockIds(tail.results, "tool_result", "tool_use_id") !== expected || tail.blocks.length) return null;
        const sizes = tail.results.map((result) => textOf(result.content).length);
        const total = sizes.reduce((sum, size) => sum + size, 0);
        return sizes.every((size) => size <= LIVE_RESULT_CHARS) && total <= LIVE_RESULTS_TOTAL_CHARS ? "tools" : null;
    }

    request({ mode, tail, allowTools, onTextDelta, signal, onContextWindow }) {
        this.usedAt = Date.now();
        clearTimeout(this.timer);
        this.onContextWindow = onContextWindow;
        this.apiError = null;
        return new Promise((resolve, reject) => {
            const cur = { blocks: [], text: "", usage: null, started: false, allowTools, onTextDelta };
            const drop = (err) => {
                if (this.current !== cur) return;
                this.current = null;
                this.close();
                cur.done(err);
            };
            const onAbort = () => drop(stoppedError(cur.text));
            cur.done = (err, value) => {
                signal?.removeEventListener("abort", onAbort);
                if (err) reject(err);
                else resolve(value);
            };
            this.current = cur;
            signal?.addEventListener("abort", onAbort, { once: true });
            this.feed(cur, mode, tail).catch((err) => drop(failure(null, String(err?.message || err), this.stderr)));
        });
    }

    async feed(cur, mode, tail) {
        if (mode === "tools") {
            this.conv.sigs.push(tail.sig);
            cur.started = true;
            this.deliver(tail.results);
            return;
        }
        if (mode === "resume") {
            // 기록의 마지막 메시지에 CLI가 스스로 답함.
            cur.started = true;
            this.turnOpen = true;
            return;
        }
        await this.turnClosed();
        if (!this.toolsReady) {
            await waitForTools(this.run);
            this.toolsReady = true;
        }
        if (this.current !== cur) return;
        this.conv.sigs.push(tail.sig);
        cur.started = true;
        this.turnOpen = true;
        this.inbox.push(tail.body);
    }

    // 오래 쓰지 않으면 닫음.
    arm() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.close(), this.state === "tools" ? TOOLS_CLOSE_MS : IDLE_CLOSE_MS);
        this.timer.unref?.();
    }

    fail(text) {
        if (this.closed) return;
        const cur = this.current;
        this.current = null;
        this.close();
        cur?.done(failure(null, text, this.stderr));
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        lives.delete(this);
        if (this.conv.proc === this) this.conv.proc = null;
        clearTimeout(this.timer);
        for (const wake of this.turnWaiters.splice(0)) wake();
        this.inbox.end();
        this.abortController.abort();
        // 소켓은 CLI가 죽은 뒤에 닫음. 먼저 닫으면 기다리던 도구 호출이 오류로 끝나고, CLI가 그 결과로
        // 모델에 요청을 한 번 더 보냄.
        closing.add(this);
        setTimeout(() => this.cleanup(), CLOSE_CLEANUP_MS).unref?.();
        const cur = this.current;
        this.current = null;
        cur?.done(failure(null, "Claude process closed.", this.stderr));
    }

    // 닫힌 프로세스가 남긴 소켓과 로컬 기록을 치움.
    cleanup() {
        if (!closing.delete(this)) return;
        for (const socket of this.sockets) socket.destroy();
        this.server?.close();
        if (this.socketFile && process.platform !== "win32") {
            try {
                fs.rmSync(this.socketFile, { force: true });
            } catch {
                // 정리 실패는 응답에 영향이 없음.
            }
        }
        removeLocalTranscript(this.env, this.cwd, this.sessionId);
    }
}

// 프로세스가 너무 많으면 쉬고 있는 것 중 가장 오래 안 쓴 것부터 닫음.
function makeRoom() {
    const idle = [...lives].filter((live) => !live.current).sort((a, b) => a.usedAt - b.usedAt);
    while (lives.size >= MAX_LIVE && idle.length) idle.shift().close();
}

async function startLive(conv, { model, system, messages, list, level, resume, envOverride }) {
    makeRoom();
    const cwd = WORK_DIR;
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const sessionId = crypto.randomUUID();
    const transcript = buildTranscript({ conv, model, system, messages, sessionId, cwd, resume });
    conv.entries = transcript.entries.filter((entry) => !isSnapshot(entry));
    conv.sigs = messages.slice(0, transcript.covered).map((m) => m.sig);

    const env = buildClaudeEnv({
        ...(resume ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1", CLAUDE_CODE_RESUME_PROMPT: RESUME_MARKER } : {}),
        ...envOverride,
    });
    const live = new LiveProcess(conv, { env, cwd, sessionId, hasTools: list.length > 0 });
    conv.proc = live;
    try {
        let mcpServers = {};
        if (list.length) {
            await live.listen();
            mcpServers = {
                [TOOL_SERVER]: {
                    type: "stdio",
                    command: process.execPath,
                    args: [TOOL_SERVER_SCRIPT, toolsFile(list)],
                    env: { TABYBOT_TOOL_SOCKET: live.socketFile, TABYBOT_TOOL_TOKEN: live.token },
                },
            };
        }
        live.start(
            {
                model,
                systemPrompt: system,
                tools: [],
                settingSources: [],
                strictMcpConfig: true,
                mcpServers,
                permissionMode: "dontAsk",
                allowedTools: list.length ? [`mcp__${TOOL_SERVER}`] : [],
                ...(EFFORT_LEVELS.includes(level) ? { effort: level } : {}),
            },
            transcript.entries,
        );
    } catch (err) {
        live.close();
        throw failure(null, String(err?.message || err), live.stderr);
    }
    return live;
}

// 대화를 처리하는 CLI는 만료된 토큰을 갱신하지 않고 그대로 보내 인증 오류로 끝날 때가 있음.
// 계정 정보를 읽는 CLI는 시작할 때 토큰을 갱신하므로, 그걸 한 번 띄운 뒤 새 프로세스로 한 번만 다시 시도함.
// (오류가 나면 쓰던 프로세스는 닫히고 계정 정보 캐시도 비워진 상태임.)
export async function claudeAgentComplete(args) {
    try {
        return await completeOnce(args);
    } catch (err) {
        if (err?.code !== "CLAUDE_AUTH_REQUIRED" || args.signal?.aborted) throw err;
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, AUTH_REFRESH_TIMEOUT_MS);
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            args.signal?.addEventListener("abort", done, { once: true });
            claudeInfo(args.envOverride).account.then(done, done);
        });
        throwIfAborted(args.signal);
        return completeOnce(args);
    }
}

async function completeOnce({
    model,
    messages,
    tools,
    tool_choice,
    stream = false,
    onTextDelta,
    signal,
    thinkingLevel,
    cacheKey,
    envOverride,
    onContextWindow,
}) {
    throwIfAborted(signal);

    const conv = conversation(cacheKey);
    conv.busy = true;
    try {
        // 도구 없이 부르는 라운드(마지막 정리 답변 등)에도 정의는 그대로 둬야 캐시가 유지됨.
        if (tools?.length) conv.tools = tools;
        const list = toolList(tools?.length ? tools : conv.tools);
        const allowTools = Boolean(tools?.length) && tool_choice !== "none";
        const level = String(thinkingLevel || "").toLowerCase();

        const converted = toAnthropicMessages(sanitizeMessagesForApi(markToolObservations(messages)));
        const tail = converted.messages[converted.messages.length - 1];
        const key = sha(model, converted.system, list, level, envOverride || null);

        let live = conv.proc;
        let mode = live && conv.key === key ? live.accepts(converted.messages) : null;
        if (!mode) {
            live?.close();
            // 모델, 시스템 프롬프트, 도구가 바뀌면 앞부분이 달라짐. 생각 블록은 만들어진 대화 밖에서는
            // 유효하지 않으므로 CLI가 남긴 기록은 버리고 tabyBot 메시지로 다시 만듦.
            if (conv.key !== key) {
                conv.key = key;
                conv.entries = [];
                conv.sigs = [];
            }
            mode = tail.results.length ? "resume" : "prompt";
            live = await startLive(conv, {
                model,
                system: converted.system,
                messages: converted.messages,
                list,
                level,
                resume: mode === "resume",
                envOverride,
            });
            throwIfAborted(signal);
        }
        return await live.request({ mode, tail, allowTools, onTextDelta: stream ? onTextDelta : undefined, signal, onContextWindow });
    } catch (err) {
        if (signal?.aborted) conv.proc?.close();
        throw err;
    } finally {
        conv.busy = false;
        if (!cacheKey) conv.proc?.close();
    }
}

// ── 모델 목록과 로그인 상태. 추론 없이 CLI 초기화 정보만 읽음. ──

// 프로세스를 띄워야 알 수 있는 값이라 한 번 읽어 메모리에 둠. 로그인 상태가 바뀌면 버림.
let info = null;

export function invalidateClaudeInfo() {
    info = null;
}

// 아무것도 보내지 않는 프롬프트. until이 끝나면 닫힘.
function emptyPrompt(until) {
    return { [Symbol.asyncIterator]: () => ({ next: () => until.then(() => ({ done: true, value: undefined })) }) };
}

async function readModels(run) {
    const models = [];
    for (const m of (await run.supportedModels()) || []) {
        if (!m?.value) continue;
        let contextWindow;
        try {
            // 컨텍스트 크기는 계정, 모델에 따라 다름. CLI가 그 모델로 계산한 값을 그대로 씀.
            await run.setModel(m.value);
            contextWindow = (await run.getContextUsage())?.maxTokens || undefined;
        } catch {
            // 값을 못 얻으면 비워 둠. 첫 응답 때 CLI가 알려 주는 값으로 채워짐.
        }
        models.push({ id: m.value, label: m.displayName || m.value, contextWindow, supportsVision: true });
    }
    return models;
}

function loadInfo(envOverride) {
    fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
    const abortController = new AbortController();
    let release;
    const idle = new Promise((resolve) => {
        release = resolve;
    });
    const run = query({
        prompt: emptyPrompt(idle),
        options: {
            tools: [],
            settingSources: [],
            strictMcpConfig: true,
            permissionMode: "dontAsk",
            persistSession: false,
            cwd: WORK_DIR,
            env: buildClaudeEnv(envOverride),
            abortController,
            stderr: () => {
                // 초기화 정보만 읽으므로 로그는 쓰지 않음.
            },
        },
    });
    const account = run.accountInfo();
    // 모델을 바꿔 가며 읽으므로 계정 정보를 받은 뒤에 시작함.
    const models = account.then(
        () => readModels(run),
        () => readModels(run),
    );
    const record = { at: Date.now(), account, models };
    Promise.allSettled([account, models]).then((results) => {
        release();
        abortController.abort();
        // 실패한 조회는 다음에 다시 읽음.
        if (info === record && results.some((result) => result.status === "rejected")) info = null;
    });
    return record;
}

function claudeInfo(envOverride) {
    if (envOverride) return loadInfo(envOverride);
    if (!info || Date.now() - info.at > INFO_TTL_MS) info = loadInfo();
    return info;
}

export function fetchClaudeModels({ envOverride } = {}) {
    return claudeInfo(envOverride).models;
}

// 로그인 여부만 알려 줌. 토큰이나 자격 증명 파일은 건드리지 않음.
export async function getClaudeAuthStatus({ envOverride } = {}) {
    try {
        const account = await claudeInfo(envOverride).account;
        // 로그인하지 않았으면 tokenSource가 "none"으로 옴.
        const loggedIn = Boolean(account?.email || account?.subscriptionType || (account?.tokenSource && account.tokenSource !== "none"));
        return { loggedIn, email: account?.email || null, plan: account?.subscriptionType || null };
    } catch (err) {
        return { loggedIn: false, email: null, plan: null, error: String(err?.message || err) };
    }
}
