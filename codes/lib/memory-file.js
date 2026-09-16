import fs from "node:fs";
import path from "node:path";
import { TEMPLATES_USER_DIR, USER_DIR } from "./paths.js";
import { writeFileAtomic } from "./atomic-file.js";
import { agentMemoryDir, agentMemoryPath, ensureAgentMemory } from "./agents-store.js";

const MEMORY_PATH = path.join(USER_DIR, "memory.md");
const MEMORY_TEMPLATE_PATH = path.join(TEMPLATES_USER_DIR, "memory.md");

function defaultMemoryContent() {
    if (fs.existsSync(MEMORY_TEMPLATE_PATH)) {
        return fs.readFileSync(MEMORY_TEMPLATE_PATH, "utf8");
    }
    return "# Memory\n\n";
}

function ensureMemoryFile() {
    if (!fs.existsSync(MEMORY_PATH)) {
        writeFileAtomic(MEMORY_PATH, defaultMemoryContent());
    }
}

export function readMemoryFile() {
    ensureMemoryFile();
    return fs.readFileSync(MEMORY_PATH, "utf8");
}

function readMemoryFileSummary(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    const firstLine = text.split("\n").find((l) => l.trim()) || "";
    return firstLine.replace(/^#+\s*/, "").trim();
}

export function readAgentMemoryFile(agentId) {
    if (!agentId) return "";
    const file = ensureAgentMemory(agentId);
    return fs.readFileSync(file, "utf8");
}

export function formatAgentMemoryFilesListForPrompt(agentId) {
    if (!agentId) return "";
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
    if (!agentId) return "";
    return agentMemoryPath(agentId);
}

export function agentMemoryDirPath(agentId) {
    if (!agentId) return "";
    return agentMemoryDir(agentId);
}
