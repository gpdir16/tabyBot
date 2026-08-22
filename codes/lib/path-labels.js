import path from "node:path";
import { CODES_DIR, DOWNLOAD_DIR, SKILLS_SYSTEM_DIR, USER_DIR, WORKSPACE_DIR, isWorkspaceEnabled } from "./paths.js";
import { isDockerRuntime } from "./runtime.js";

export function memoryFilePath() {
    return path.join(USER_DIR, "memory.md");
}

export function memoryDirPath() {
    return path.join(USER_DIR, "memory");
}

export function mcpConfigPath() {
    return path.join(USER_DIR, "mcp.json");
}

export function skillsDirPath() {
    return path.join(USER_DIR, "skills");
}

export function downloadDirPath() {
    return DOWNLOAD_DIR;
}

export function cronConfigPath() {
    return path.join(USER_DIR, "cron.json");
}

function workspaceSuffix() {
    if (!isWorkspaceEnabled()) return "";
    if (isDockerRuntime()) {
        return ` Use \`${WORKSPACE_DIR}\` or \`workspace/...\` only for the host-mounted PC folder.`;
    }
    return ` Use \`${WORKSPACE_DIR}\` or \`workspace/...\` only for the optional project folder.`;
}

export function terminalRunDescription() {
    const runtime = isDockerRuntime() ? "Run a shell command inside the Docker container." : "Run a shell command on the host machine.";
    return `${runtime} Default cwd is \`${USER_DIR}\`.${workspaceSuffix()}`;
}

export function terminalCwdParamDescription() {
    const ws = isWorkspaceEnabled()
        ? isDockerRuntime()
            ? `; use \`${WORKSPACE_DIR}\` only for host-mounted project work`
            : `; use \`${WORKSPACE_DIR}\` only for optional project folder work`
        : "";
    return `Working directory (default \`${USER_DIR}\`${ws})`;
}

export function fileReadDescription() {
    return `Read a text file. Default: paths relative to \`${USER_DIR}\`.${workspaceSuffix()} Optional line range; output capped below 50% of remaining context.`;
}

export function filePatchDescription() {
    return `Patch a text file (unified diff). Default \`${USER_DIR}\`.${workspaceSuffix()} Call file_read on the same path in this turn first; disk must still match that read.`;
}

export function filePathParamDescription() {
    const ws = isWorkspaceEnabled() ? ", or workspace/... when a project folder is configured" : "";
    return `Absolute path, path relative to \`${USER_DIR}\`${ws}`;
}

export function sendFileDescription() {
    return `Send a file to Telegram. Default \`${USER_DIR}\`.${workspaceSuffix()}`;
}

export function cronListDescription() {
    return `List scheduled cron jobs from \`${cronConfigPath()}\`.`;
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
        MEMORY_DIR: memoryDirPath(),
        MCP_CONFIG_PATH: mcpConfigPath(),
        CRON_PATH: cronConfigPath(),
        DOWNLOAD_DIR: downloadDirPath(),
        BROWSER_USE_DIR: path.join(CODES_DIR, "skills", "browser-use"),
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
    ["/app/user/cron.json", (v) => v.CRON_PATH],
    ["/app/user/skills", (v) => v.SKILLS_DIR],
    ["/app/user/download", (v) => v.DOWNLOAD_DIR],
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
