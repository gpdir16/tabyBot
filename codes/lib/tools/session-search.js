import fs from "node:fs";
import path from "node:path";
import { SESSION_DIR, USER_DIR } from "../paths.js";
import { findAgentByNameOrId, getAgent, getAgentByUuid, listAgents } from "../agents-store.js";
import { extractSessionTextLines } from "../agent/chat-history.js";
import { groupDir, groupsOfAgent, listGroups } from "../groups-store.js";

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
                "Search every archived session transcript (all bots, and group rooms) by keyword or regex. Returns matching user/assistant lines with session file paths. Follow up with file_read on a hit for full context. Only conversation text is searched, not tool outputs.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Case-insensitive keyword, or a regex if it compiles" },
                    agent: { type: "string", description: "Limit to one bot by id or name, including the group rooms it is in (default: all)" },
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

// 찾을 곳: 에이전트 스레드와 그룹 방의 화면 기록(방 안의 모든 발화가 이름과 함께 들어 있다).
// agentQuery를 주면 그 에이전트의 스레드와 그 에이전트가 든 방만 찾는다.
function searchSources(agentQuery) {
    let agents = listAgents();
    let groups = listGroups();
    if (agentQuery) {
        const found = getAgent(String(agentQuery).trim()) || findAgentByNameOrId(agentQuery);
        if (!found) return { error: `unknown agent: ${agentQuery}` };
        agents = [found];
        groups = groupsOfAgent(found.uuid);
    }
    return [
        ...agents.map((agent) => ({ agent: agent.name, agentId: agent.id, root: path.join(SESSION_DIR, agent.uuid) })),
        ...groups.map((group) => ({ agent: `group: ${group.name}`, agentId: null, groupId: group.id, root: groupDir(group.id) })),
    ];
}

export function executeSessionSearchTool(name, args) {
    if (name !== "session_search") return { error: `Unknown tool: ${name}` };

    const query = String(args?.query || "").trim();
    if (!query) return { error: "query is required" };
    const limit = Math.min(Math.max(1, Number(args?.limit) || DEFAULT_LIMIT), MAX_LIMIT);

    const sources = searchSources(args?.agent);
    if (sources.error) return sources;

    const matches = [];
    let scannedFiles = 0;
    let hitLimit = false;

    outer: for (const source of sources) {
        const sessionsDir = path.join(source.root, "sessions");
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
                    agent: source.agent,
                    ...(source.agentId ? { agentId: source.agentId } : { groupId: source.groupId }),
                    session: data?.sessionId || file.name.replace(/\.json$/, ""),
                    file: path.relative(USER_DIR, abs).split(path.sep).join("/"),
                    at: line.at,
                    role: line.role,
                    ...(line.speaker ? { speaker: getAgentByUuid(line.speaker)?.name || "" } : {}),
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
