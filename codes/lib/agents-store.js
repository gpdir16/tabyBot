import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { USER_DIR } from "./paths.js";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_AGENT_NAME = "tabyBot";

const AGENTS_PATH = path.join(USER_DIR, "agents.json");
const AGENTS_ROOT = path.join(USER_DIR, "agents");
const DELETED_ROOT = path.join(USER_DIR, "temp", "deleted-agents");

const MAX_AGENTS = 20;
const MAX_NAME = 32;
const MAX_PERSONA = 500;
const MAX_ID = 24;

const TOPIC_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        console.error("tabyBot: invalid agents.json:", err.message);
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function newUuid() {
    return crypto.randomUUID();
}

function withSeed(agents) {
    // 봇이 하나도 없을 때만 첫 봇을 만든다. 특정 id를 특권 봇으로 취급하지 않는다.
    if (!agents.length) {
        agents = [{ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_NAME, persona: "", createdAt: new Date().toISOString() }];
    }
    let mutated = false;
    for (const a of agents) {
        if (!a.uuid) {
            a.uuid = newUuid();
            mutated = true;
        }
    }
    return { agents, mutated };
}

export function loadAgentsStore() {
    const raw = readJson(AGENTS_PATH, { agents: [] });
    const { agents, mutated } = withSeed(Array.isArray(raw?.agents) ? raw.agents.filter((a) => a && typeof a.id === "string") : []);
    if (mutated) writeJson(AGENTS_PATH, { agents });
    return { agents };
}

export function saveAgentsStore(store) {
    writeJson(AGENTS_PATH, { agents: store.agents || [] });
}

export function listAgents() {
    return loadAgentsStore().agents;
}

export function firstAgent() {
    return listAgents()[0] || null;
}

export function firstAgentId() {
    return firstAgent()?.id || DEFAULT_AGENT_ID;
}

export function getAgent(id) {
    if (!id) return null;
    return listAgents().find((a) => a.id === id) || null;
}

export function agentThreadId(id) {
    return `web-agent-${id}`;
}

export function findAgentByNameOrId(query) {
    const q = String(query || "")
        .trim()
        .toLowerCase();
    if (!q) return null;
    return listAgents().find((a) => a.id.toLowerCase() === q || String(a.name || "").toLowerCase() === q) || null;
}

export function slugifyAgentId(name, existingIds = []) {
    const ascii = String(name || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_ID);

    let base = ascii || "agent";

    const used = new Set(existingIds);
    if (!used.has(base)) return base;
    for (let i = 2; i < 100; i += 1) {
        const next = `${base.slice(0, MAX_ID - 3)}-${i}`.slice(0, MAX_ID);
        if (!used.has(next)) return next;
    }
    return `${base.slice(0, 16)}-${Date.now().toString(36).slice(-6)}`;
}

export function normalizeAgentName(name) {
    const trimmed = String(name || "")
        .trim()
        .replace(/\s+/g, " ");
    if (!trimmed) return { error: "name_required" };
    if (trimmed.length > MAX_NAME) return { error: "name_too_long", max: MAX_NAME };
    return { name: trimmed };
}

export function normalizeAgentPersona(persona) {
    const trimmed = String(persona || "").trim();
    if (!trimmed || trimmed === "-" || trimmed === "—") return { error: "persona_required" };
    if (trimmed.length > MAX_PERSONA) return { error: "persona_too_long", max: MAX_PERSONA };
    return { persona: trimmed };
}

const AVATAR_COLORS = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#32d74b", "#64d2ff"];
export function agentColor(id) {
    let hash = 0;
    for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function agentHomeDir(id) {
    return path.join(AGENTS_ROOT, id);
}

export function agentMemoryPath(id) {
    return path.join(agentHomeDir(id), "memory.md");
}

export function agentMemoryDir(id) {
    return path.join(agentHomeDir(id), "memory");
}

export function ensureAgentMemory(id) {
    const file = agentMemoryPath(id);
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# ${id} memory\n\n`, "utf8");
    }
    return file;
}

export function canAddAgent() {
    return listAgents().length < MAX_AGENTS;
}

export function addAgent({ name, persona }) {
    const named = normalizeAgentName(name);
    if (named.error) return named;
    const person = normalizeAgentPersona(persona);
    if (person.error) return person;
    if (!canAddAgent()) return { error: "too_many", max: MAX_AGENTS };

    const store = loadAgentsStore();
    const id = slugifyAgentId(
        named.name,
        store.agents.map((a) => a.id),
    );
    const agent = {
        id,
        uuid: newUuid(),
        name: named.name,
        persona: person.persona,
        createdAt: new Date().toISOString(),
    };
    store.agents.push(agent);
    saveAgentsStore(store);
    ensureAgentMemory(id);
    return { agent };
}

export function updateAgent(id, patch) {
    const store = loadAgentsStore();
    const idx = store.agents.findIndex((a) => a.id === id);
    if (idx < 0) return { error: "not_found" };
    const current = store.agents[idx];
    if (patch.name !== undefined) {
        const named = normalizeAgentName(patch.name);
        if (named.error) return named;
        current.name = named.name;
    }
    if (patch.persona !== undefined) {
        const person = normalizeAgentPersona(patch.persona);
        if (person.error) return person;
        current.persona = person.persona;
    }
    if (patch.threadId !== undefined) delete patch.threadId;
    store.agents[idx] = current;
    saveAgentsStore(store);
    return { agent: current };
}

function moveDirAside(src) {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(DELETED_ROOT, { recursive: true });
    const dest = path.join(DELETED_ROOT, `${path.basename(src)}-${Date.now()}`);
    fs.renameSync(src, dest);
    return true;
}

export function removeAgent(id) {
    const store = loadAgentsStore();
    const idx = store.agents.findIndex((a) => a.id === id);
    if (idx < 0) return { error: "not_found" };
    if (store.agents.length <= 1) return { error: "last_agent" };
    const [removed] = store.agents.splice(idx, 1);
    saveAgentsStore(store);
    moveDirAside(agentHomeDir(id));
    return { agent: removed };
}

export function formatPeerAgentsForPrompt(currentId) {
    const lines = [];
    for (const a of listAgents().filter((agent) => agent.id !== currentId)) {
        const role = a.persona ? ` — ${a.persona}` : "";
        lines.push(`- **${a.name}** (\`${a.id}\`)${role}`);
    }
    return lines.join("\n");
}
