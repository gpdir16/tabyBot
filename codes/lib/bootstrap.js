import fs from "node:fs";
import path from "node:path";
import { USER_DIR, DOWNLOAD_DIR, TEMPLATES_USER_DIR, AGENTS_SKILLS_LINK, WORKSPACE_DIR, isWorkspaceEnabled } from "./paths.js";
import { isDockerRuntime, shouldLinkAgentsSkillsDir } from "./runtime.js";
function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function seedUserFromTemplates() {
    if (!fs.existsSync(TEMPLATES_USER_DIR)) return;

    for (const entry of fs.readdirSync(TEMPLATES_USER_DIR, { withFileTypes: true })) {
        const srcPath = path.join(TEMPLATES_USER_DIR, entry.name);
        const destPath = path.join(USER_DIR, entry.name);
        if (fs.existsSync(destPath)) continue;

        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function linkAgentsSkillsDir(userSkills) {
    if (!shouldLinkAgentsSkillsDir()) return;

    const agentsDir = path.dirname(AGENTS_SKILLS_LINK);
    fs.mkdirSync(agentsDir, { recursive: true });

    try {
        const stat = fs.lstatSync(AGENTS_SKILLS_LINK);
        if (stat.isSymbolicLink()) {
            const target = fs.readlinkSync(AGENTS_SKILLS_LINK);
            if (path.resolve(path.dirname(AGENTS_SKILLS_LINK), target) !== path.resolve(userSkills)) {
                fs.unlinkSync(AGENTS_SKILLS_LINK);
                fs.symlinkSync(userSkills, AGENTS_SKILLS_LINK);
            }
            return;
        }
        console.warn(`tabyAgent: ~/.agents/skills exists and is not a symlink; leaving it unchanged. Use ${userSkills}.`);
    } catch (err) {
        if (err.code === "ENOENT") {
            fs.symlinkSync(userSkills, AGENTS_SKILLS_LINK);
        } else {
            throw err;
        }
    }
}

export function ensureUserDir() {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.mkdirSync(path.join(USER_DIR, "skills"), { recursive: true });
    fs.mkdirSync(path.join(USER_DIR, "temp"), { recursive: true });
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    seedUserFromTemplates();

    const mcpPath = path.join(USER_DIR, "mcp.json");
    if (!fs.existsSync(mcpPath)) {
        fs.writeFileSync(mcpPath, '{\n  "servers": []\n}\n', "utf8");
    }

    linkAgentsSkillsDir(path.join(USER_DIR, "skills"));

    if (isWorkspaceEnabled()) {
        if (isDockerRuntime()) {
            console.log(`tabyAgent: host workspace mounted at ${WORKSPACE_DIR}`);
        } else {
            console.log(`tabyAgent: project workspace enabled at ${WORKSPACE_DIR}`);
        }
    }
}
