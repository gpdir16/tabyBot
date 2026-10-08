// 화면 스트림·터미널 WebSocket 연결과 컴퓨터 화면 HTTP API.
import crypto from "node:crypto";
import { createWsServer } from "../ws.js";
import * as display from "../../computer/display.js";
import { attachTerminal, killAllSessions, terminalEnabled } from "../../computer/pty.js";
import { isDockerRuntime } from "../../runtime.js";
import { getAgent, getAgentByUuid } from "../../agents-store.js";
import { ensureBrowserWindow, openBrowser } from "./browser.js";
import { startTabSnapshotter } from "./camofox.js";

// ── 화면 스트림과 터미널 WebSocket 연결. ──

const FRAME_TARGET_MS = 90; // 캡처 시간 포함 목표 주기: 느려도 최소 간격으로 자연 감속

const FRAME_MIN_GAP_MS = 30;

const MAX_INPUT_MSG_BYTES = 64 * 1024;

let wsServer = null;

/* ── 화면 스트림 허브: 캡처는 하나만 돌리고 모든 접속자에게 같은 프레임을 보낸다 ── */
const screen = { clients: new Set(), timer: null, busy: false, lastHash: "", lastDims: null };

// 한 번 캡처해서 모든 접속자에게 보낸다. 바뀐 프레임만 해시로 걸러 보낸다.
async function screenTick() {
    if (!screen.clients.size) return;
    if (screen.busy) return;
    const sess = display.loadSession();
    if (!sess) {
        for (const conn of [...screen.clients]) conn.sendJson({ type: "inactive" });
        return;
    }
    screen.busy = true;
    const r = await display.screenshotJpegBuf(sess, 72);
    screen.busy = false;
    if (!r.ok || !r.jpeg?.length) return;
    const hash = crypto.createHash("md5").update(r.jpeg).digest("hex");
    if (hash === screen.lastHash) return;
    screen.lastHash = hash;
    for (const conn of [...screen.clients]) {
        try {
            conn.send(r.jpeg);
        } catch {
            // 연결이 이미 끊겼으면 보낼 곳이 없으므로 무시한다
        }
    }
}

// 캡처 완료 시점부터 다시 재는 자기재스케줄 루프: 고정 인터벌보다 응답이 빠르고
// 캡처가 느린 환경에서는 저절로 느려진다.
async function screenLoop() {
    while (screen.clients.size) {
        const t0 = Date.now();
        await screenTick();
        const wait = Math.max(FRAME_MIN_GAP_MS, FRAME_TARGET_MS - (Date.now() - t0));
        await new Promise((res) => setTimeout(res, wait));
    }
    screen.timer = null;
}

function ensureScreenLoop() {
    if (!screen.timer) {
        screen.timer = true; // 루프 진입 표시(종료 시 null)
        void screenLoop();
    }
}

async function handleScreenConn(conn, url) {
    if (!isDockerRuntime()) {
        conn.sendJson({ type: "error", error: "docker_only" });
        conn.close();
        return;
    }
    const r = await display.ensureSession();
    if (r.error) {
        conn.sendJson({ type: "error", error: r.error });
        conn.close();
        return;
    }
    const sess = r.sess;
    process.env.DISPLAY = `:${sess.display}`;
    const dims = display.geometryDims(sess.geometry);
    screen.lastDims = dims;
    conn.sendJson({ type: "ready", display: sess.display, width: dims.w, height: dims.h });
    screen.clients.add(conn);
    screen.lastHash = "";
    ensureScreenLoop();
    const agentParam = url?.searchParams?.get("agent");
    void ensureBrowserWindow(agentParam);

    // 입력은 접속별 큐로 순서대로 처리한다. move는 처리 중 사이에 쌓인 것을
    // 최신 것으로 합치고, 큐가 빌 때마다 즉시 프레임을 뽑아 반응성을 높인다.
    const inputQueue = [];
    let inputBusy = false;
    async function pumpInput() {
        if (inputBusy) return;
        inputBusy = true;
        try {
            while (inputQueue.length) {
                let msg = inputQueue.shift();
                if (msg.type === "move") while (inputQueue.length && inputQueue[0].type === "move") msg = inputQueue.shift();
                const cur = display.loadSession();
                if (!cur) {
                    inputQueue.length = 0;
                    return;
                }
                await display.sendInput(cur, msg);
                screen.lastHash = "";
            }
        } finally {
            inputBusy = false;
        }
        void screenTick();
    }
    conn.on("message", (data, isBinary) => {
        if (isBinary || !data || data.length > MAX_INPUT_MSG_BYTES) return;
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        inputQueue.push(msg);
        void pumpInput();
    });
    conn.on("close", () => {
        screen.clients.delete(conn);
    });
}

function handleTerminalConn(conn, url) {
    const id = url.searchParams.get("agent") || "";
    const agent = getAgent(id) || getAgentByUuid(id);
    if (!agent) {
        conn.sendJson({ type: "error", error: "unknown_agent" });
        conn.close(1008);
        return;
    }
    attachTerminal(agent.id, conn);
}

export function initComputerWs(auth) {
    wsServer = createWsServer({ auth });
    wsServer.add("/ws/computer/screen", (conn, _req, url) => void handleScreenConn(conn, url));
    wsServer.add("/ws/computer/terminal", (conn, _req, url) => handleTerminalConn(conn, url));
    return wsServer;
}

export function handleComputerUpgrade(req, socket, head) {
    wsServer.handleUpgrade(req, socket, head);
}

export function shutdownComputer() {
    killAllSessions();
}

// ── 컴퓨터 화면 HTTP API. ──

function statusPayload() {
    const sess = display.loadSession();
    const dims = display.geometryDims(sess?.geometry);
    return {
        docker: isDockerRuntime(),
        screen: sess ? { active: true, display: sess.display, width: dims.w, height: dims.h, apps: (sess.apps || []).length } : { active: false },
        terminal: terminalEnabled(),
    };
}

export function registerComputerRoutes(router) {
    startTabSnapshotter();
    router.add("GET", "/api/computer/status", (ctx) => {
        ctx.json200(statusPayload());
    });

    router.add("POST", "/api/computer/screen/start", async (ctx) => {
        if (!isDockerRuntime()) return ctx.json400("docker_only");
        const body = await ctx.json().catch(() => ({}));
        const r = await display.ensureSession(body?.geometry);
        if (r.error) return ctx.json400(r.error);
        process.env.DISPLAY = `:${r.sess.display}`;
        ctx.json200(statusPayload());
    });

    router.add("POST", "/api/computer/screen/stop", async (ctx) => {
        await display.closeSession();
        ctx.json200(statusPayload());
    });

    router.add("POST", "/api/computer/browser/open", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        const r = await openBrowser(body?.agentId, body?.url);
        if (r.error === "docker_only") return ctx.json400("docker_only");
        if (r.error === "camofox_missing") return ctx.json400("camofox_missing");
        if (r.error) return ctx.json400(typeof r.error === "string" ? r.error : "browser_open_failed");
        ctx.json200(r);
    });
}
