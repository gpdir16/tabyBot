import { CODES_DIR, USER_DIR } from "../paths.js";
import { memoryFilePath, mcpConfigPath, skillsDirPath } from "../path-labels.js";
import { isDockerRuntime } from "../runtime.js";

const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function renderSystemPrompt(template, vars) {
    return template.replace(PLACEHOLDER_RE, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(vars, key)) {
            console.warn(`tabyBot: unknown system prompt placeholder ${match}`);
            return match;
        }
        const value = vars[key];
        return value == null ? "" : String(value);
    });
}

function localeForLanguage(lang) {
    if (lang === "ko") return "ko-KR";
    if (lang === "ja") return "ja-JP";
    return "en-US";
}

export function buildEnvironmentPromptVars() {
    const docker = isDockerRuntime();
    const pathHint = `any absolute path, \`${USER_DIR}\`, or \`/tmp\``;

    return {
        MCP_CONFIG_PATH: mcpConfigPath(),
        MEMORY_PATH: memoryFilePath(),
        SKILLS_DIR: skillsDirPath(),
        WORKSPACE_PATHS_HINT: pathHint,
        AUTONOMY_LINE: docker
            ? "- **Full container autonomy:** you may `terminal_run` from other directories (`/app`, `/tmp`, `/root`, …), install packages when needed (`apk`, `npm`, `pip`, etc.), and inspect the system."
            : "- **Full host autonomy:** you may `terminal_run` from other directories on the host, install packages when needed (`brew`, `npm`, `pip`, etc.), and inspect the system.",
    };
}

export function buildFilesystemPromptBlock() {
    const docker = isDockerRuntime();
    const lines = [
        docker ? "### Filesystem map (container — read before file/shell work)" : "### Filesystem map (local install — read before file/shell work)",
        "",
        docker
            ? "You run **inside a Docker container**. Container paths are separate from the user's host machine."
            : "You run **directly on the user's machine** (not in Docker). Paths below are real host paths.",
        "",
        `| Path | Role |`,
        `|------|------|`,
        `| \`${USER_DIR}\` | **Main home (default).** Configuration, memory, skills, MCP, todos, sessions, and **most work**. Default \`terminal_run\` cwd. Relative \`file_*\` paths resolve here. |`,
        `| \`${CODES_DIR}\` | Shipped agent source and built-in skills (image; avoid editing). |`,
        `| \`/tmp\` | Ephemeral scratch. |`,
        "",
        "**Path handling:** `file_read` and `file_patch` accept any absolute path accessible to the process. Relative paths resolve to the main home above.",
    ];
    return lines.join("\n");
}

export function buildDateTimePromptVars(lang = "en") {
    const now = new Date();
    const timeZone = (typeof process.env.TZ === "string" && process.env.TZ.trim()) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const locale = localeForLanguage(lang);
    const localFormatted = new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
    }).format(now);
    const utcFormatted = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC",
    }).format(now);

    return {
        LOCAL_DATETIME: localFormatted,
        UTC_DATETIME: utcFormatted,
        ISO_UTC: now.toISOString(),
        TIMEZONE: timeZone,
    };
}

export function buildRuntimeInfoLine(info = {}) {
    const safe = info || {};
    const parts = [];
    if (safe.model) parts.push(`Model: ${safe.model}`);
    if (safe.sessionKey) parts.push(`Session: ${safe.sessionKey}`);
    if (safe.agentId) parts.push(`Agent: ${safe.agentId}`);
    if (safe.channel) parts.push(`Channel: ${safe.channel}`);
    if (!parts.length) return "";
    return `- ${parts.join(" · ")}`;
}
