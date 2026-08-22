import { ensureUserDir } from "./lib/bootstrap.js";
import { initTools, shutdownTools } from "./lib/agent/tool-registry.js";
import { startTelegramBot } from "./lib/telegram.js";
import { bootstrapBotTokenFromEnv, hasBotToken } from "./lib/readiness.js";

const RETRY_MS = 10000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown() {
    await shutdownTools();
    process.exit(0);
}

async function main() {
    ensureUserDir();
    bootstrapBotTokenFromEnv();
    await initTools();

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    while (!hasBotToken()) {
        console.error("");
        console.error("tabyAgent: set TELEGRAM_BOT_TOKEN in .env (or config), then restart.");
        console.error("  All other setup is done in Telegram after the bot is running.");
        console.error("");
        await sleep(10000);
    }

    while (true) {
        try {
            await startTelegramBot();
            return;
        } catch (err) {
            console.error("tabyAgent: bot error:", err.message || err);
            console.error(`Retrying in ${RETRY_MS / 1000}s…`);
            await sleep(RETRY_MS);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
