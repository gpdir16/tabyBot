import fs from "node:fs";
import { registerProducedFile, publicAttachment } from "../web/files.js";
import { resolveAgentPath } from "../paths.js";
import { sendFileDescription } from "../path-labels.js";

export const sendFileToolDefinitions = [
    {
        type: "function",
        function: {
            name: "send_file",
            description: sendFileDescription(),
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Absolute or relative path to the file" },
                    caption: { type: "string", description: "Optional short caption (max 1024 chars)" },
                },
                required: ["path"],
            },
        },
    },
];

export async function executeSendFileTool(_name, args, _ctx) {
    const raw = args?.path?.trim();
    if (!raw) return { error: "path is required" };
    const filePath = resolveAgentPath(raw);
    if (!filePath) return { error: "path is required" };
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { error: `file not found: ${filePath}` };
    }
    try {
        const entry = await registerProducedFile(filePath, args?.caption);
        return {
            ok: true,
            name: entry.name,
            size: entry.size,
            url: `/api/files/${entry.id}`,
            attachment: publicAttachment(entry),
            note: "File is delivered to the web client as a downloadable attachment. Do not paste the URL as text — the client renders it automatically.",
        };
    } catch (err) {
        return { error: err?.message || String(err) };
    }
}
