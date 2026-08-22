#!/usr/bin/env node
import { Bot } from "grammy";
import { ensureUserDir } from "./lib/bootstrap.js";
import { getApproveCliHint } from "./lib/runtime.js";
import { approveCode } from "./lib/auth.js";
import { notifyOwnerTransfer } from "./lib/auth-access.js";
import { loadUserConfig } from "./lib/config-loader.js";
import { bootstrapBotTokenFromEnv } from "./lib/readiness.js";

ensureUserDir();
bootstrapBotTokenFromEnv();

const [, , command, ...rest] = process.argv;
const arg = rest.join(" ").trim();

if (command === "approve" && arg) {
    const result = approveCode(arg);
    if (!result.ok) {
        console.error("Approval failed");
        process.exit(1);
    }
    console.log(`Approved: ${result.chatId}`);
    const token = loadUserConfig().telegram?.botToken?.trim();
    if (token) {
        const bot = new Bot(token);
        await notifyOwnerTransfer(bot, {
            previousOwner: result.previousOwner,
            newChatId: result.chatId,
            approvedByChatId: null,
        });
    }
    process.exit(0);
}

console.error(`Setup and config are done in Telegram. Optional: ${getApproveCliHint("<code>")}`);
process.exit(command ? 1 : 0);
