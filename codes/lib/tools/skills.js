import fs from "node:fs";
import { resolveSkillPath } from "../skills-catalog.js";
import { renderSkillContent } from "../path-labels.js";

export const skillsToolDefinitions = [
    {
        type: "function",
        function: {
            name: "skills_read",
            description:
                "Read SKILL.md by skill name. Built-in (codes) wins over user copy with the same name. The skill catalog is already in the system prompt — use this when you need the full playbook.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Skill directory name" },
                },
                required: ["name"],
            },
        },
    },
];

export async function executeSkillsTool(name, args) {
    if (name === "skills_read") {
        const skillName = args?.name?.trim();
        if (!skillName) return { error: "name is required" };
        const system = resolveSkillPath(skillName, "system");
        const resolved = system || resolveSkillPath(skillName, "user");
        if (!resolved) return { error: `Skill not found: ${skillName}` };
        const content = renderSkillContent(fs.readFileSync(resolved.skillFile, "utf8"));
        return { name: skillName, source: resolved.source, content };
    }

    return { error: `Unknown skills tool: ${name}` };
}
