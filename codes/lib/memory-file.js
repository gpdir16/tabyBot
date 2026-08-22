import fs from "node:fs";
import path from "node:path";
import { TEMPLATES_USER_DIR, USER_DIR } from "./paths.js";
import { DEFAULT_AGENT_ID, agentMemoryDir, agentMemoryPath, ensureAgentMemory } from "./agents-store.js";

const MEMORY_PATH = path.join(USER_DIR, "memory.md");
const MEMORY_DIR = path.join(USER_DIR, "memory");
const MEMORY_TEMPLATE_PATH = path.join(TEMPLATES_USER_DIR, "memory.md");

function defaultMemoryContent() {
    if (fs.existsSync(MEMORY_TEMPLATE_PATH)) {
        return fs.readFileSync(MEMORY_TEMPLATE_PATH, "utf8");
    }
    return "# Memory\n\n";
}

function ensureMemoryFile() {
    if (!fs.existsSync(MEMORY_PATH)) {
        fs.mkdirSync(USER_DIR, { recursive: true });
        fs.writeFileSync(MEMORY_PATH, defaultMemoryContent(), "utf8");
    }
}

export function readMemoryFile() {
    ensureMemoryFile();
    return fs.readFileSync(MEMORY_PATH, "utf8");
}

function listMemoryFiles() {
    if (!fs.existsSync(MEMORY_DIR)) return [];
    return fs
        .readdirSync(MEMORY_DIR)
        .filter((f) => f.endsWith(".md"))
        .sort();
}

function readMemoryFileSummary(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    const firstLine = text.split("\n").find((l) => l.trim()) || "";
    return firstLine.replace(/^#+\s*/, "").trim();
}

// 시스템 프롬프트에 주입되는 주제별 메모 파일 목록 (파일명 + 첫 줄 요약만).
export function formatMemoryFilesListForPrompt() {
    const items = listMemoryFiles().map((name) => {
        const summary = readMemoryFileSummary(path.join(MEMORY_DIR, name));
        const short = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
        return `- **${name.replace(/\.md$/, "")}** — ${short}`;
    });
    if (!items.length) return "- (none yet — create `memory/<topic>.md` when a topic needs durable notes)";
    return items.join("\n");
}

export function readAgentMemoryFile(agentId) {
    if (!agentId || agentId === DEFAULT_AGENT_ID) return "";
    const file = ensureAgentMemory(agentId);
    return fs.readFileSync(file, "utf8");
}

export function formatAgentMemoryFilesListForPrompt(agentId) {
    if (!agentId || agentId === DEFAULT_AGENT_ID) return "";
    const dir = agentMemoryDir(agentId);
    if (!fs.existsSync(dir)) return "- (none yet — create files under this agent's memory/ folder)";
    const items = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((name) => {
            const summary = readMemoryFileSummary(path.join(dir, name));
            const short = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
            return `- **${name.replace(/\.md$/, "")}** — ${short}`;
        });
    if (!items.length) return "- (none yet — create files under this agent's memory/ folder)";
    return items.join("\n");
}

export function agentMemoryFilePath(agentId) {
    if (!agentId || agentId === DEFAULT_AGENT_ID) return "";
    return agentMemoryPath(agentId);
}
