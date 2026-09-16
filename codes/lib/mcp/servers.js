import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpConfig } from "../config-loader.js";
import { mcpConfigEditHint } from "../path-labels.js";

const servers = new Map();
// 연결 실패한 서버는 매 턴 재접속하지 않고 잠시 뒤로 미룬다.
const failures = new Map();
let syncing = null;

const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_BACKOFF_MS = 60_000;
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function mcpToolName(serverName, toolName) {
    return `mcp__${serverName}__${toolName}`;
}

function parseMcpToolName(name) {
    if (!name.startsWith("mcp__")) return null;
    const rest = name.slice(5);
    const sep = rest.indexOf("__");
    if (sep < 0) return null;
    return { serverName: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

function mcpToolToOpenAI(serverName, tool) {
    const schema = tool.inputSchema || { type: "object", properties: {} };
    return {
        type: "function",
        function: {
            name: mcpToolName(serverName, tool.name),
            description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
            parameters: schema,
        },
    };
}

// mcp.json이 깨져 있어도 부팅이 멈추지 않게 항목별로 검증해 걸러낸다.
// name은 도구 이름 mcp__<name>__<tool>에 들어가므로 __ 포함을 금지한다.
function validServerEntry(entry) {
    return (
        entry &&
        typeof entry === "object" &&
        typeof entry.name === "string" &&
        SERVER_NAME_RE.test(entry.name) &&
        typeof entry.command === "string" &&
        Boolean(entry.command.trim()) &&
        (entry.args === undefined || Array.isArray(entry.args)) &&
        (entry.env === undefined || (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)))
    );
}

function loadWantedServers() {
    const raw = loadMcpConfig()?.servers;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry) => {
        if (validServerEntry(entry)) return true;
        console.error(`tabyBot: skipping invalid MCP server entry: ${JSON.stringify(entry)?.slice(0, 200)}`);
        return false;
    });
}

async function closeEntry(name) {
    const entry = servers.get(name);
    if (!entry) return;
    try {
        await entry.client.close();
    } catch {
        // ignore
    }
    servers.delete(name);
}

async function connectServer(server) {
    const transport = new StdioClientTransport({
        command: server.command,
        args: server.args || [],
        env: { ...process.env, ...(server.env || {}) },
    });
    const client = new Client({ name: "tabybot", version: "0.1.0" }, { capabilities: {} });
    // 연결이 붙지 않으면 타임아웃으로 transport를 닫아 자식 프로세스를 회수한다.
    const timer = setTimeout(() => {
        transport.close().catch(() => {});
    }, CONNECT_TIMEOUT_MS);
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        servers.set(server.name, {
            client,
            tools: tools.map((t) => mcpToolToOpenAI(server.name, t)),
            configKey: JSON.stringify(server),
        });
    } catch (err) {
        // 실패한 연결의 자식 프로세스가 남지 않게 닫는다.
        try {
            await client.close();
        } catch {
            // ignore
        }
        try {
            await transport.close();
        } catch {
            // ignore
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function syncMcpServersInner() {
    const wanted = loadWantedServers();
    const wantedNames = new Set(wanted.map((s) => s.name));

    for (const name of [...servers.keys()]) {
        if (!wantedNames.has(name)) await closeEntry(name);
    }
    for (const name of [...failures.keys()]) {
        if (!wantedNames.has(name)) failures.delete(name);
    }

    const now = Date.now();
    await Promise.allSettled(
        wanted.map(async (server) => {
            const configKey = JSON.stringify(server);
            if (servers.get(server.name)?.configKey === configKey) return;
            const failed = failures.get(server.name);
            if (failed?.configKey === configKey && failed.retryAt > now) return;
            await closeEntry(server.name);
            try {
                await connectServer(server);
                failures.delete(server.name);
            } catch (err) {
                failures.set(server.name, { configKey, retryAt: Date.now() + RETRY_BACKOFF_MS });
                console.error(`tabyBot: MCP ${server.name} failed:`, err.message || err);
            }
        }),
    );
}

// 동시 호출(부팅 + 턴 시작)이 같은 서버를 두 번 띄우지 않게 진행 중 sync를 공유한다.
export function syncMcpServers() {
    if (!syncing) {
        syncing = syncMcpServersInner().finally(() => {
            syncing = null;
        });
    }
    return syncing;
}

export function getDynamicMcpToolDefinitions() {
    const defs = [];
    for (const entry of servers.values()) {
        defs.push(...entry.tools);
    }
    return defs;
}

export async function invokeMcpTool(name, args, ctx = {}) {
    const parsed = parseMcpToolName(name);
    if (!parsed) return { error: "Invalid MCP tool name" };
    const entry = servers.get(parsed.serverName);
    if (!entry) {
        return {
            error: mcpConfigEditHint(parsed.serverName),
        };
    }

    try {
        const result = await entry.client.callTool(
            {
                name: parsed.toolName,
                arguments: args || {},
            },
            undefined,
            { signal: ctx.signal },
        );
        const text = (result.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        return { content: text || JSON.stringify(result) };
    } catch (err) {
        return { error: err.message || String(err) };
    }
}

export async function disconnectMcpServers() {
    for (const entry of servers.values()) {
        try {
            await entry.client.close();
        } catch {
            // ignore
        }
    }
    servers.clear();
}
