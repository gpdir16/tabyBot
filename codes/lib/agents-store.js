import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSION_DIR, USER_DIR } from "./paths.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-file.js";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_AGENT_NAME = "tabyBot";

const AGENTS_PATH = path.join(USER_DIR, "agents.json");
const AGENTS_ROOT = path.join(USER_DIR, "agents");

const MAX_AGENTS = 20;
const MAX_FOLDERS = 20;
const MAX_NAME = 32;
const MAX_PERSONA = 500;
const MAX_MODEL = 128;
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
    writeJsonAtomic(filePath, data);
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

// 폴더 목록을 읽어 {id, name}만 남긴다. 순서 = 표시 순서.
function normalizeFolders(raw) {
    const seen = new Set();
    const out = [];
    for (const f of Array.isArray(raw) ? raw : []) {
        if (!f || typeof f.id !== "string" || seen.has(f.id)) continue;
        const name = String(f.name || "")
            .trim()
            .slice(0, MAX_NAME);
        if (!name) continue;
        seen.add(f.id);
        out.push({ id: f.id, name });
        if (out.length >= MAX_FOLDERS) break;
    }
    return out;
}

let agentsCache = null;

function statMtime() {
    try {
        return fs.statSync(AGENTS_PATH).mtimeMs;
    } catch {
        return -1;
    }
}

export function loadAgentsStore() {
    const mtime = statMtime();
    if (agentsCache && mtime !== -1 && agentsCache.mtime === mtime) return agentsCache.store;
    const raw = readJson(AGENTS_PATH, { agents: [], folders: [] });
    const { agents, mutated } = withSeed(Array.isArray(raw?.agents) ? raw.agents.filter((a) => a && typeof a.id === "string") : []);
    const folders = normalizeFolders(raw?.folders);
    const folderIds = new Set(folders.map((f) => f.id));
    // 지워진 폴더를 가리키는 에이전트는 미분류로 되돌린다.
    for (const a of agents) {
        if (a.folder && !folderIds.has(a.folder)) {
            a.folder = "";
        }
    }
    if (mutated) writeJson(AGENTS_PATH, { agents, folders });
    agentsCache = { mtime: mutated ? statMtime() : mtime, store: { agents, folders } };
    return agentsCache.store;
}

export function saveAgentsStore(store) {
    writeJson(AGENTS_PATH, { agents: store.agents || [], folders: store.folders || [] });
    agentsCache = { mtime: statMtime(), store };
}

export function listAgents() {
    return loadAgentsStore().agents;
}

export function listFolders() {
    return loadAgentsStore().folders || [];
}

function normalizeFolderName(name) {
    const trimmed = String(name || "")
        .trim()
        .replace(/\s+/g, " ");
    if (!trimmed) return { error: "folder_name_required" };
    if (trimmed.length > MAX_NAME) return { error: "name_too_long", max: MAX_NAME };
    return { name: trimmed };
}

export function addFolder({ name }) {
    const named = normalizeFolderName(name);
    if (named.error) return named;
    const store = loadAgentsStore();
    if (store.folders.length >= MAX_FOLDERS) return { error: "too_many_folders", max: MAX_FOLDERS };
    const folder = { id: `f-${crypto.randomBytes(6).toString("hex")}`, name: named.name };
    store.folders.push(folder);
    saveAgentsStore(store);
    return { folder };
}

export function updateFolder(id, { name }) {
    const named = normalizeFolderName(name);
    if (named.error) return named;
    const store = loadAgentsStore();
    const folder = store.folders.find((f) => f.id === id);
    if (!folder) return { error: "not_found" };
    folder.name = named.name;
    saveAgentsStore(store);
    return { folder };
}

// 폴더를 지우고 소속 에이전트는 미분류로 되돌린다.
export function removeFolder(id) {
    const store = loadAgentsStore();
    const idx = store.folders.findIndex((f) => f.id === id);
    if (idx < 0) return { error: "not_found" };
    store.folders.splice(idx, 1);
    for (const a of store.agents) {
        if (a.folder === id) a.folder = "";
    }
    saveAgentsStore(store);
    return { ok: true };
}

// ids 순서대로 폴더를 재배열한다. 누락된 폴더는 끝에 유지한다.
export function setFoldersOrder(ids) {
    if (!Array.isArray(ids)) return { error: "invalid_ids" };
    const store = loadAgentsStore();
    const byId = new Map(store.folders.map((f) => [f.id, f]));
    const ordered = [];
    const seen = new Set();
    for (const id of ids) {
        const f = byId.get(id);
        if (f && !seen.has(id)) {
            seen.add(id);
            ordered.push(f);
        }
    }
    for (const f of store.folders) {
        if (!seen.has(f.id)) ordered.push(f);
    }
    store.folders = ordered;
    saveAgentsStore(store);
    return { folders: ordered };
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

export function getAgentByUuid(uuid) {
    if (!uuid) return null;
    return listAgents().find((a) => a.uuid === uuid) || null;
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
    let trimmed = String(persona || "").trim();
    if (trimmed === "-" || trimmed === "—") trimmed = "";
    if (trimmed.length > MAX_PERSONA) return { error: "persona_too_long", max: MAX_PERSONA };
    return { persona: trimmed };
}

// 빈 문자열은 "전역 설정을 따른다"는 뜻. 선택형 오버라이드 공통 규칙.
export function normalizeAgentModel(model) {
    const trimmed = String(model || "").trim();
    if (trimmed.length > MAX_MODEL) return { error: "model_too_long", max: MAX_MODEL };
    return { model: trimmed };
}

export function normalizeAgentThinkingLevel(value) {
    const v = String(value || "")
        .trim()
        .toLowerCase();
    if (!v) return { thinkingLevel: "" };
    if (!/^[a-z]+$/.test(v)) return { error: "invalid_thinking_level" };
    return { thinkingLevel: v };
}

export function normalizeAgentColor(value) {
    const v = String(value || "")
        .trim()
        .toLowerCase();
    if (!v) return { color: "" };
    if (!/^#[0-9a-f]{6}$/.test(v)) return { error: "invalid_color" };
    return { color: v };
}

export const AVATAR_COLORS = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#32d74b", "#64d2ff"];
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
        writeFileAtomic(file, `# ${id} memory\n\n`);
    }
    return file;
}

export function canAddAgent() {
    return listAgents().length < MAX_AGENTS;
}

export function addAgent({ name, persona, model, thinkingLevel, color }) {
    const named = normalizeAgentName(name);
    if (named.error) return named;
    const person = normalizeAgentPersona(persona);
    if (person.error) return person;
    const mod = normalizeAgentModel(model);
    if (mod.error) return mod;
    const thinking = normalizeAgentThinkingLevel(thinkingLevel);
    if (thinking.error) return thinking;
    const col = normalizeAgentColor(color);
    if (col.error) return col;
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
        model: mod.model,
        thinkingLevel: thinking.thinkingLevel,
        color: col.color,
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
    if (patch.model !== undefined) {
        const mod = normalizeAgentModel(patch.model);
        if (mod.error) return mod;
        current.model = mod.model;
    }
    if (patch.thinkingLevel !== undefined) {
        const thinking = normalizeAgentThinkingLevel(patch.thinkingLevel);
        if (thinking.error) return thinking;
        current.thinkingLevel = thinking.thinkingLevel;
    }
    if (patch.color !== undefined) {
        const col = normalizeAgentColor(patch.color);
        if (col.error) return col;
        current.color = col.color;
    }
    if (patch.folder !== undefined) {
        const folderId = String(patch.folder || "");
        if (folderId && !store.folders.some((f) => f.id === folderId)) return { error: "folder_not_found" };
        current.folder = folderId;
    }
    store.agents[idx] = current;
    saveAgentsStore(store);
    return { agent: current };
}

function removeDir(src) {
    if (!src || !fs.existsSync(src)) return;
    fs.rmSync(src, { recursive: true, force: true });
}

export function removeAgent(id) {
    const store = loadAgentsStore();
    const idx = store.agents.findIndex((a) => a.id === id);
    if (idx < 0) return { error: "not_found" };
    if (store.agents.length <= 1) return { error: "last_agent" };
    const [removed] = store.agents.splice(idx, 1);
    saveAgentsStore(store);
    removeDir(agentHomeDir(id));
    if (removed.uuid) removeDir(path.join(SESSION_DIR, removed.uuid));
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
