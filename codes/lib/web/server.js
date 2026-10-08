// tabyBot 웹 서버: 정적 클라이언트 + JSON API + SSE 이벤트 스트림.
import http from "node:http";
import path from "node:path";
import { CODES_DIR } from "../paths.js";
import { isDockerRuntime } from "../runtime.js";
import { isConfigReady } from "../onboarding.js";
import { recoverInterruptedTurns } from "./turns.js";
import { subscribe, currentSeq } from "./bus.js";
import * as accountAuth from "./auth.js";
import { createRouter } from "./http.js";
import { registerComputerRoutes, initComputerWs, handleComputerUpgrade } from "./computer.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerTodosRoutes } from "./routes/todos.js";

const PUBLIC_DIR = path.join(CODES_DIR, "public");
// 계정이 만들어져 있으면 세션 인증이 켜진다. 계정이 없으면 열려 있다(첫 방문에 생성 유도).
const AUTH = {
    enabled: () => accountAuth.hasAccount(),
    verify: (token) => Boolean(accountAuth.resolveSession(token)),
    publicPaths: ["/api/account/state", "/api/account/login", "/api/account/setup"],
};
// 도커 안에서는 항상 8999로 듣는다. 호스트 포트는 compose 매핑이 담당한다
// (TABYBOT_PORT를 컨테이너에 주입하면 커스텀 포트에서 매핑이 깨진다).
const PORT = isDockerRuntime() ? 8999 : Number(process.env.TABYBOT_PORT || 8999);
// 기본은 모든 인터페이스에 연다. 이 머신만 쓰려면 TABYBOT_HOST=127.0.0.1로 명시한다.
const HOST = process.env.TABYBOT_HOST?.trim() || "0.0.0.0";

export function startWebServer() {
    const router = createRouter({ publicDir: PUBLIC_DIR, auth: AUTH });
    router.setSseSubscribe(subscribe);
    router.setSeqNow(currentSeq);

    registerAccountRoutes(router);
    registerChatRoutes(router);
    registerLibraryRoutes(router);
    registerSettingsRoutes(router);
    registerAgentsRoutes(router);
    registerTodosRoutes(router);
    registerComputerRoutes(router);

    const server = http.createServer((req, res) => router.handle(req, res));
    initComputerWs(AUTH);
    server.on("upgrade", (req, socket, head) => {
        try {
            handleComputerUpgrade(req, socket, head);
        } catch {
            socket.destroy();
        }
    });
    server.listen(PORT, HOST, () => {
        console.log(`tabyBot: web UI ready at http://${HOST}:${PORT}${accountAuth.hasAccount() ? " (account required)" : ""}`);
        if (isConfigReady()) recoverInterruptedTurns();
    });
    return server;
}
