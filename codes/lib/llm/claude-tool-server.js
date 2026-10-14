// Claude Agent SDK에 tabyBot 도구를 알려 주는 stdio MCP 서버.
// CLI가 직접 띄우며, 첫 요청 전에 연결이 끝나 도구 정의가 빠지지 않음.
// 도구는 여기서 실행하지 않음. 호출을 소켓으로 tabyBot에 넘기고, tabyBot 루프가 실행한 결과를
// 받아 그대로 돌려줌.
import fs from "node:fs";
import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tools = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const socketPath = process.env.TABYBOT_TOOL_SOCKET;
const token = process.env.TABYBOT_TOOL_TOKEN;

const waiting = new Map();
let seq = 0;
let socket = null;
// 연결됐다가 끊겼으면 tabyBot이 이 프로세스를 닫는 중임.
let closing = false;

function connect() {
    return new Promise((resolve) => {
        if (!socketPath) return resolve();
        const conn = net.createConnection(socketPath);
        let buffer = "";
        conn.setEncoding("utf8");
        conn.on("connect", () => {
            socket = conn;
            resolve();
        });
        conn.on("data", (chunk) => {
            buffer += chunk;
            for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 1);
                const reply = JSON.parse(line);
                waiting.get(reply.id)?.(reply.result);
                waiting.delete(reply.id);
            }
        });
        conn.on("error", () => resolve());
        // 닫는 중에 기다리던 호출에 답하면 CLI가 그 답으로 모델을 한 번 더 부르므로 답하지 않음.
        // CLI가 끝나면 이 서버도 표준 입력이 닫히며 끝남.
        conn.on("close", () => {
            closing = socket !== null;
            socket = null;
        });
    });
}

await connect();

const server = new Server({ name: "tabybot-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (closing) {
        return new Promise(() => {
            // 답하지 않음(위 설명).
        });
    }
    if (!socket) return Promise.resolve({ isError: true, content: [{ type: "text", text: "tabyBot is not reachable." }] });
    const id = ++seq;
    const call = {
        id,
        token,
        toolUseId: request.params._meta?.["claudecode/toolUseId"] || null,
        name: request.params.name,
        arguments: request.params.arguments || {},
    };
    return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.write(`${JSON.stringify(call)}\n`);
    });
});
process.stdin.on("close", () => process.exit(0));
await server.connect(new StdioServerTransport());
