import fs from "node:fs";
import path from "node:path";
import { SKILLS_SYSTEM_DIR, USER_DIR, AGENTS_SKILLS_LINK } from "./paths.js";
import { renderSkillContent } from "./path-labels.js";

function listSkillDirs(root) {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
}

export function readSkillSummary(skillPath) {
    const skillFile = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(skillFile)) return null;
    const text = fs.readFileSync(skillFile, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
        const desc = fm[1].match(/^description:\s*(.+)$/m);
        if (desc) {
            const summary = renderSkillContent(desc[1].trim().replace(/^["']|["']$/g, ""));
            return { name: path.basename(skillPath), summary };
        }
    }
    const firstLine =
        text.split("\n").find((l) => {
            const t = l.trim();
            return t && !t.startsWith("---");
        }) || skillPath;
    return { name: path.basename(skillPath), summary: renderSkillContent(firstLine.replace(/^#\s*/, "").trim()) };
}

export function collectAvailableSkills() {
    const skills = [];
    const seen = new Set();
    for (const root of [SKILLS_SYSTEM_DIR, path.join(USER_DIR, "skills"), AGENTS_SKILLS_LINK]) {
        for (const dirName of listSkillDirs(root)) {
            if (seen.has(dirName)) continue;
            const summary = readSkillSummary(path.join(root, dirName));
            if (summary) {
                seen.add(dirName);
                skills.push({
                    name: summary.name,
                    summary: summary.summary,
                    source: root === SKILLS_SYSTEM_DIR ? "system" : "user",
                });
            }
        }
    }
    return skills;
}

export function formatSkillsListForPrompt() {
    const skills = collectAvailableSkills();
    if (!skills.length) return "- (no skills installed)";

    const builtIn = skills.filter((s) => s.source === "system").sort((a, b) => a.name.localeCompare(b.name));
    const user = skills.filter((s) => s.source === "user").sort((a, b) => a.name.localeCompare(b.name));
    const lines = [];
    if (builtIn.length) {
        lines.push("### Built-in");
        for (const s of builtIn) lines.push(`- **${s.name}** — ${s.summary}`);
    }
    if (user.length) {
        if (lines.length) lines.push("");
        lines.push("### User-installed");
        for (const s of user) lines.push(`- **${s.name}** — ${s.summary}`);
    }
    return lines.join("\n");
}

export function resolveSkillPath(name, source) {
    const roots = [];
    if (source === "system" || !source) roots.push({ root: SKILLS_SYSTEM_DIR, label: "system" });
    if (source === "user" || !source) {
        roots.push({ root: path.join(USER_DIR, "skills"), label: "user" });
        if (fs.existsSync(AGENTS_SKILLS_LINK)) {
            roots.push({ root: AGENTS_SKILLS_LINK, label: "user" });
        }
    }

    for (const { root, label } of roots) {
        const skillPath = path.join(root, name);
        const skillFile = path.join(skillPath, "SKILL.md");
        if (fs.existsSync(skillFile)) return { skillFile, source: label };
    }
    return null;
}
