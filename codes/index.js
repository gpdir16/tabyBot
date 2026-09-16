import { ensureUserDir } from "./lib/bootstrap.js";
import { initTools, shutdownTools } from "./lib/agent/tool-registry.js";
import { startWebServer } from "./lib/web/server.js";
import { setTodoJobHandler, setProactiveHandler } from "./lib/web/turns.js";
import { startTodoScheduler } from "./lib/todos/scheduler.js";
import { startUpdateScheduler } from "./lib/update/scheduler.js";
import { startDreamingScheduler } from "./lib/dreaming/scheduler.js";
import { startProactiveScheduler } from "./lib/proactive.js";
import { isDockerRuntime } from "./lib/runtime.js";
import { ensureSession, DISPLAY } from "./lib/computer/display.js";
import { shutdownComputer } from "./lib/web/computer.js";

async function shutdown() {
    shutdownComputer();
    await shutdownTools();
    process.exit(0);
}

// Docker에서는 공유 Xvfb 화면을 부팅 시 미리 띄운다.
// camofox(CAMOFOX_HEADLESS=false)가 DISPLAY로 이 화면에 렌더링되고,
// xvfb_gui 앱도 같은 화면 위에 뜬다 — 웹 "컴퓨터" 뷰가 바로 그 화면을 비춘다.
function startSharedDisplay() {
    if (!isDockerRuntime()) return;
    if (!process.env.DISPLAY) process.env.DISPLAY = `:${DISPLAY}`;
    ensureSession()
        .then((r) => {
            if (r?.sess) process.env.DISPLAY = `:${r.sess.display}`;
            else if (r?.error) console.warn(`tabyBot: shared display unavailable: ${r.error}`);
        })
        .catch(() => {});
}

async function main() {
    ensureUserDir();
    await initTools();

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    startWebServer();
    startSharedDisplay();
    setTodoJobHandler();
    setProactiveHandler();
    startTodoScheduler();
    startUpdateScheduler();
    startDreamingScheduler();
    startProactiveScheduler();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
