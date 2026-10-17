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
import { shutdownComputer, upgradeAllProfilesCompat } from "./lib/web/computer.js";
import { deleteOnceSecrets } from "./lib/secrets/store.js";
import { flushUsageLog } from "./lib/llm/usage-log.js";

async function shutdown() {
    shutdownComputer();
    flushUsageLog();
    await shutdownTools();
    process.exit(0);
}

// Docker에서는 공유 Xvfb 화면을 부팅 시 미리 띄운다.
// camofox(CAMOFOX_HEADLESS=false)가 DISPLAY로 이 화면에 렌더링되고,
// xvfb_gui 앱도 같은 화면 위에 뜬다. 웹 "컴퓨터" 뷰가 바로 그 화면을 비춘다.
function startSharedDisplay() {
    if (!isDockerRuntime()) return;
    if (!process.env.DISPLAY) process.env.DISPLAY = `:${DISPLAY}`;
    ensureSession()
        .then((r) => {
            if (r?.sess) process.env.DISPLAY = `:${r.sess.display}`;
            else if (r?.error) console.warn(`tabyBot: shared display unavailable: ${r.error}`);
        })
        .catch((err) => console.warn(`tabyBot: shared display setup failed: ${err?.message || err}`));
}

async function main() {
    ensureUserDir();
    // Camoufox가 업데이트된 뒤 첫 부팅이면 기존 브라우저 프로필을 새 버전으로 열 수 있게 맞춘다.
    upgradeAllProfilesCompat();
    // 지난 실행이 턴 도중에 끝나 남은 일회용 시크릿(인증 코드 등)을 지운다.
    deleteOnceSecrets();
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
