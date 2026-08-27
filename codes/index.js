import { ensureUserDir } from "./lib/bootstrap.js";
import { initTools, shutdownTools } from "./lib/agent/tool-registry.js";
import { startWebServer } from "./lib/web/server.js";
import { setCronJobHandler, startCronScheduler } from "./lib/cron/scheduler.js";
import { startUpdateScheduler } from "./lib/update/scheduler.js";

async function shutdown() {
    await shutdownTools();
    process.exit(0);
}

async function main() {
    ensureUserDir();
    await initTools();

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    startWebServer();
    setCronJobHandler();
    startCronScheduler();
    startUpdateScheduler();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
