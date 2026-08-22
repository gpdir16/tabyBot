import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpConfig } from "../config-loader.js";
import { mcpConfigEditHint } from "../path-labels.js";

const servers = new Map();

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
    const client = new Client({ name: "tabyagent", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();
    servers.set(server.name, {
        client,
        tools: tools.map((t) => mcpToolToOpenAI(server.name, t)),
        configKey: JSON.stringify(server),
    });
}

export async function syncMcpServers() {
    const wanted = loadMcpConfig().servers || [];
    const wantedNames = new Set(wanted.map((s) => s.name));

    for (const name of [...servers.keys()]) {
        if (!wantedNames.has(name)) await closeEntry(name);
    }

    for (const server of wanted) {
        if (servers.get(server.name)?.configKey === JSON.stringify(server)) continue;
        await closeEntry(server.name);
        try {
            await connectServer(server);
        } catch (err) {
            console.error(`tabyAgent: MCP ${server.name} failed:`, err.message || err);
        }
    }
}

export function getDynamicMcpToolDefinitions() {
    const defs = [];
    for (const entry of servers.values()) {
        defs.push(...entry.tools);
    }
    return defs;
}

export async function invokeMcpTool(name, args) {
    const parsed = parseMcpToolName(name);
    if (!parsed) return { error: "Invalid MCP tool name" };
    const entry = servers.get(parsed.serverName);
    if (!entry) {
        return {
            error: mcpConfigEditHint(parsed.serverName),
        };
    }

    try {
        const result = await entry.client.callTool({
            name: parsed.toolName,
            arguments: args || {},
        });
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
