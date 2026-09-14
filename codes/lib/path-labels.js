import path from "node:path";
import { CODES_DIR, SKILLS_SYSTEM_DIR, USER_DIR } from "./paths.js";
import { isDockerRuntime } from "./runtime.js";

export function memoryFilePath() {
    return path.join(USER_DIR, "memory.md");
}

export function mcpConfigPath() {
    return path.join(USER_DIR, "mcp.json");
}

export function skillsDirPath() {
    return path.join(USER_DIR, "skills");
}

export function todosConfigPath() {
    return path.join(USER_DIR, "todos.json");
}

export function terminalRunDescription() {
    const runtime = isDockerRuntime() ? "Run a shell command inside the Docker container." : "Run a shell command on the host machine.";
    return `${runtime} Default cwd is \`${USER_DIR}\`.`;
}

export function terminalCwdParamDescription() {
    return `Working directory (default \`${USER_DIR}\`)`;
}

export function fileReadDescription() {
    return `Read a text file. Absolute paths are allowed; relative paths resolve to \`${USER_DIR}\`. Optional line range; output capped below 50% of remaining context.`;
}

export function filePatchDescription() {
    return `Patch a text file (unified diff). Absolute paths are allowed; relative paths resolve to \`${USER_DIR}\`. Call file_read on the same path in this turn first; disk must still match that read.`;
}

export function filePathParamDescription() {
    return `Required. Absolute filesystem path, or a path relative to \`${USER_DIR}\``;
}

export function sendFileDescription() {
    return `Deliver a file to the user as a downloadable attachment in the web client. Default \`${USER_DIR}\`. Optional caption is shown with the attachment.`;
}

export function todosPathHint(agentId) {
    return path.join(USER_DIR, "agents", agentId || "<agent-id>", "todos.json");
}

export function mcpConfigEditHint(serverName) {
    return `MCP server not connected: ${serverName}. Edit \`${mcpConfigPath()}\`; it loads on the next message.`;
}

export function buildSkillContentVars() {
    return {
        USER_DIR,
        CODES_DIR,
        SKILLS_DIR: skillsDirPath(),
        SYSTEM_SKILLS_DIR: SKILLS_SYSTEM_DIR,
        MEMORY_PATH: memoryFilePath(),
        MCP_CONFIG_PATH: mcpConfigPath(),
        SCHEDULING_PATH: todosConfigPath(),
        CAMOFOX_DIR: path.join(CODES_DIR, "skills", "camofox"),
        CAMOFOX_DATA_DIR: path.join(USER_DIR, "camofox"),
    };
}

let cachedSkillContentVars = null;

function skillContentVars() {
    if (!cachedSkillContentVars) cachedSkillContentVars = buildSkillContentVars();
    return cachedSkillContentVars;
}

const LEGACY_SKILL_PATHS = [
    ["/app/user/memory.md", (v) => v.MEMORY_PATH],
    ["/app/user/mcp.json", (v) => v.MCP_CONFIG_PATH],
    ["/app/user/scheduling.json", (v) => todosConfigPath()],
    ["/app/user/skills", (v) => v.SKILLS_DIR],
    ["/app/codes/skills", (v) => path.join(v.CODES_DIR, "skills")],
    ["/app/user", (v) => v.USER_DIR],
    ["/app/codes", (v) => v.CODES_DIR],
];

export function renderSkillContent(text) {
    if (typeof text !== "string" || !text) return text;
    const vars = skillContentVars();
    let out = text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
        return String(vars[key]);
    });
    for (const [legacy, resolve] of LEGACY_SKILL_PATHS) {
        out = out.split(legacy).join(resolve(vars));
    }
    return out;
}
