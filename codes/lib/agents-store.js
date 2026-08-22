import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "./paths.js";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_AGENT_NAME = "tabyAgent";

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
        console.error("tabyAgent: invalid agents.json:", err.message);
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeThreadId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 1 ? n : null;
}

export function loadAgentsStore() {
    const raw = readJson(AGENTS_PATH, { agents: [] });
    const agents = Array.isArray(raw?.agents) ? raw.agents.filter((a) => a && typeof a.id === "string" && a.id !== DEFAULT_AGENT_ID) : [];
    return { agents, mainThreadId: normalizeThreadId(raw?.mainThreadId) };
}

export function saveAgentsStore(store) {
    const payload = { agents: store.agents || [] };
    const mainThreadId = normalizeThreadId(store.mainThreadId);
    if (mainThreadId) payload.mainThreadId = mainThreadId;
    writeJson(AGENTS_PATH, payload);
}

export function getMainThreadId() {
    return loadAgentsStore().mainThreadId;
}

export function setMainThreadId(threadId) {
    const store = loadAgentsStore();
    store.mainThreadId = normalizeThreadId(threadId);
    saveAgentsStore(store);
    return store.mainThreadId;
}

export function listAgents() {
    return loadAgentsStore().agents;
}

export function getAgent(id) {
    if (!id || id === DEFAULT_AGENT_ID) return null;
    return listAgents().find((a) => a.id === id) || null;
}

export function findAgentByThread(threadId) {
    const n = Number(threadId);
    if (!Number.isFinite(n) || n <= 1) return null;
    if (getMainThreadId() === n) return null;
    return listAgents().find((a) => Number(a.threadId) === n) || null;
}

export function findAgentByNameOrId(query) {
    const q = String(query || "")
        .trim()
        .toLowerCase();
    if (!q) return null;
    if (q === DEFAULT_AGENT_ID || q === DEFAULT_AGENT_NAME.toLowerCase()) return null;
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
    if (base === DEFAULT_AGENT_ID) base = "agent";

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

export function topicIconColor(id) {
    let hash = 0;
    for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return TOPIC_COLORS[hash % TOPIC_COLORS.length];
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

export function addAgent({ name, persona, threadId }) {
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
        name: named.name,
        persona: person.persona,
        threadId: Number(threadId),
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
    if (patch.threadId !== undefined) current.threadId = Number(patch.threadId);
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
    const [removed] = store.agents.splice(idx, 1);
    saveAgentsStore(store);
    moveDirAside(agentHomeDir(id));
    return { agent: removed };
}

export function formatPeerAgentsForPrompt(currentId = DEFAULT_AGENT_ID) {
    const lines = [];
    if (currentId !== DEFAULT_AGENT_ID) {
        lines.push(`- **${DEFAULT_AGENT_NAME}** (\`${DEFAULT_AGENT_ID}\`) — default assistant`);
    }
    for (const a of listAgents().filter((agent) => agent.id !== currentId)) {
        const role = a.persona ? ` — ${a.persona}` : "";
        lines.push(`- **${a.name}** (\`${a.id}\`)${role}`);
    }
    return lines.join("\n");
}
