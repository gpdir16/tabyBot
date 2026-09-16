import fs from "node:fs";
import path from "node:path";
import { SESSION_DIR, USER_DIR } from "../paths.js";
import { findAgentByNameOrId, getAgent, listAgents } from "../agents-store.js";
import { extractSessionTextLines } from "../agent/chat-history.js";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const MAX_FILES = 200;
const SNIPPET_HALF = 80;

export const sessionSearchToolDefinitions = [
    {
        type: "function",
        function: {
            name: "session_search",
            description:
                "Search every archived session transcript (all bots) by keyword or regex. Returns matching user/assistant lines with session file paths — follow up with file_read on a hit for full context. Only conversation text is searched, not tool outputs.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Case-insensitive keyword, or a regex if it compiles" },
                    agent: { type: "string", description: "Limit to one bot by id or name (default: all)" },
                    limit: { type: "number", description: `Max matches (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
                },
                required: ["query"],
            },
        },
    },
];

function buildMatcher(query) {
    try {
        const re = new RegExp(query, "i");
        return (text) => re.exec(text)?.index ?? -1;
    } catch {
        const needle = query.toLowerCase();
        return (text) => text.toLowerCase().indexOf(needle);
    }
}

function snippetAround(text, idx, queryLen) {
    const start = Math.max(0, idx - SNIPPET_HALF);
    const end = Math.min(text.length, idx + Math.max(queryLen, 1) + SNIPPET_HALF);
    return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

export async function executeSessionSearchTool(name, args) {
    if (name !== "session_search") return { error: `Unknown tool: ${name}` };

    const query = String(args?.query || "").trim();
    if (!query) return { error: "query is required" };
    const limit = Math.min(Math.max(1, Number(args?.limit) || DEFAULT_LIMIT), MAX_LIMIT);

    let agents = listAgents();
    if (args?.agent) {
        const found = getAgent(String(args.agent).trim()) || findAgentByNameOrId(args.agent);
        if (!found) return { error: `unknown agent: ${args.agent}` };
        agents = [found];
    }

    const matches = [];
    let scannedFiles = 0;
    let hitLimit = false;

    outer: for (const agent of agents) {
        const root = path.join(SESSION_DIR, agent.uuid);
        const sessionsDir = path.join(root, "sessions");
        let files;
        try {
            files = fs
                .readdirSync(sessionsDir)
                .filter((f) => f.endsWith(".json"))
                .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
        } catch {
            continue;
        }

        const matcher = buildMatcher(query);
        for (const file of files) {
            if (scannedFiles >= MAX_FILES) break outer;
            scannedFiles += 1;
            const abs = path.join(sessionsDir, file.name);
            let data;
            try {
                data = JSON.parse(fs.readFileSync(abs, "utf8"));
            } catch {
                continue;
            }
            for (const line of extractSessionTextLines(data?.turns)) {
                const idx = matcher(line.text);
                if (idx === -1) continue;
                matches.push({
                    agent: agent.name,
                    agentId: agent.id,
                    session: data?.sessionId || file.name.replace(/\.json$/, ""),
                    file: path.relative(USER_DIR, abs).split(path.sep).join("/"),
                    at: line.at,
                    role: line.role,
                    snippet: snippetAround(line.text, idx, query.length),
                });
                if (matches.length >= limit) {
                    hitLimit = true;
                    break outer;
                }
            }
        }
    }

    return { matches, scannedFiles, truncated: hitLimit };
}
