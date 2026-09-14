import { ensureUserDir } from "./lib/bootstrap.js";
import { initTools, shutdownTools } from "./lib/agent/tool-registry.js";
import { startWebServer } from "./lib/web/server.js";
import { setTodoJobHandler } from "./lib/web/turns.js";
import { startTodoScheduler } from "./lib/todos/scheduler.js";
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
    setTodoJobHandler();
    startTodoScheduler();
    startUpdateScheduler();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
