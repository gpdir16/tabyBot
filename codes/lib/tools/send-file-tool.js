import { sendTelegramFile } from "../telegram-send.js";
import { resolveAgentPath } from "../paths.js";
import { sendFileDescription } from "../path-labels.js";
import { telegramThreadOpts } from "../agent-route.js";

export const sendFileToolDefinitions = [
    {
        type: "function",
        function: {
            name: "telegram_send_file",
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

export async function executeSendFileTool(_name, args, ctx) {
    const raw = args?.path?.trim();
    if (!raw) return { error: "path is required" };
    if (!ctx?.bot || !ctx?.chatId) {
        return { error: "No active Telegram chat — file send only works during a user message turn" };
    }
    const filePath = resolveAgentPath(raw);
    if (!filePath) return { error: "path is required" };
    return sendTelegramFile(ctx.bot, ctx.chatId, filePath, {
        caption: args?.caption,
        ...telegramThreadOpts(ctx.threadId),
    });
}
