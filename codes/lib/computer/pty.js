// 봇별 상주 PTY 셸 세션.
// 웹 터미널 탭은 WebSocket으로 여기에 붙고, 세션은 접속이 끊겨도 살아 있어
// 재접속 시 같은 셸과 출력 백로그를 이어 본다. python3 브리지(리사이즈 지원)를
// 우선 쓰고, 없으면 script(1)로 폴백한다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { USER_DIR, CODES_DIR } from "../paths.js";
import { isDockerRuntime } from "../runtime.js";
import { loadAgentConfig } from "../config-loader.js";
import { camofoxUser, camofoxEnv } from "./camofox-user.js";

const BRIDGE = path.join(CODES_DIR, "lib", "computer", "pty-bridge.py");
const BACKLOG_CAP = 256 * 1024;
const sessions = new Map(); // agentId → session

function pickShell() {
    if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
    for (const sh of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
        if (fs.existsSync(sh)) return sh;
    }
    return "/bin/sh";
}

function buildEnv(agentId) {
    return camofoxEnv({
        ...process.env,
        HOME: isDockerRuntime() ? USER_DIR : process.env.HOME || USER_DIR,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        // 이 셸의 camofox 호출이 해당 봇의 브라우저 프로필을 쓰게 한다.
        CAMOFOX_CLI_USER: camofoxUser(agentId),
    });
}

function appendBacklog(sess, chunk) {
    sess.backlog.push(chunk);
    sess.backlogSize += chunk.length;
    while (sess.backlogSize > BACKLOG_CAP && sess.backlog.length) sess.backlogSize -= sess.backlog.shift().length;
}

function broadcast(sess, data) {
    for (const conn of [...sess.clients]) {
        try {
            conn.send(data);
        } catch {}
    }
}

function broadcastJson(sess, obj) {
    for (const conn of [...sess.clients]) {
        try {
            conn.sendJson(obj);
        } catch {}
    }
}

function spawnSession(sess) {
    const env = buildEnv(sess.agentId);
    const cwd = sess.cwd;
    fs.mkdirSync(cwd, { recursive: true });

    let proc = null;
    if (fs.existsSync(BRIDGE)) {
        proc = spawn("python3", [BRIDGE, sess.shell, cwd, String(sess.cols), String(sess.rows)], {
            stdio: ["pipe", "pipe", "pipe", "pipe"],
            env,
        });
        sess.ctrl = proc.stdio[3];
        sess.mode = "pty";
    }
    if (!proc) {
        // 폴백: util-linux script(리눅스) / BSD script(macOS)
        const args = process.platform === "darwin" ? ["-q", "/dev/null", sess.shell] : ["-qefc", sess.shell, "/dev/null"];
        proc = spawn("script", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
        sess.ctrl = null;
        sess.mode = "script";
    }
    sess.proc = proc;
    sess.dead = false;
    sess.exitCode = null;

    proc.stdout.on("data", (chunk) => {
        if (sess.proc !== proc) return;
        appendBacklog(sess, chunk);
        broadcast(sess, chunk);
    });
    proc.stderr.on("data", (chunk) => {
        // 브리지 자체 에러만 표준 에러로 온다. 출력 경로를 오염시키지 않는다.
        const msg = chunk.toString().trim();
        if (msg) console.error(`tabyBot pty(${sess.agentId}): ${msg.slice(0, 300)}`);
    });
    proc.on("error", (err) => {
        if (sess.proc !== proc) return;
        if (sess.mode === "pty" && err?.code === "ENOENT" && !sess.everHadData) {
            // python3가 없는 환경: script 폴백으로 재시도
            sess.mode = null;
            sess.proc = null;
            spawnSessionFallback(sess, env);
            return;
        }
        sess.dead = true;
        broadcastJson(sess, { type: "exit", detail: String(err?.message || err) });
    });
    proc.on("close", (code) => {
        if (sess.proc !== proc) return;
        sess.dead = true;
        sess.exitCode = code;
        broadcastJson(sess, { type: "exit", code });
    });
}

function spawnSessionFallback(sess, env) {
    const args = process.platform === "darwin" ? ["-q", "/dev/null", sess.shell] : ["-qefc", sess.shell, "/dev/null"];
    const proc = spawn("script", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: sess.cwd });
    sess.proc = proc;
    sess.ctrl = null;
    sess.mode = "script";
    sess.dead = false;
    proc.stdout.on("data", (chunk) => {
        if (sess.proc !== proc) return;
        appendBacklog(sess, chunk);
        broadcast(sess, chunk);
    });
    proc.on("close", (code) => {
        if (sess.proc !== proc) return;
        sess.dead = true;
        sess.exitCode = code;
        broadcastJson(sess, { type: "exit", code });
    });
    proc.on("error", (err) => {
        if (sess.proc !== proc) return;
        sess.dead = true;
        broadcastJson(sess, { type: "exit", detail: String(err?.message || err) });
    });
}

function getSession(agentId) {
    const key = String(agentId || "main");
    let sess = sessions.get(key);
    if (!sess) {
        sess = {
            agentId: key,
            shell: pickShell(),
            // 봇의 terminal_run 도구와 같은 기본 작업 디렉터리(USER_DIR)를 쓴다.
            cwd: USER_DIR,
            cols: 80,
            rows: 24,
            clients: new Set(),
            backlog: [],
            backlogSize: 0,
            proc: null,
            ctrl: null,
            dead: true,
            exitCode: null,
            mode: null,
            everHadData: false,
        };
        sessions.set(key, sess);
    }
    return sess;
}

function writeRaw(sess, data) {
    const proc = sess.proc;
    if (!proc || sess.dead || !proc.stdin?.writable) return;
    try {
        proc.stdin.write(data);
        sess.everHadData = true;
    } catch {}
}

function writeCtrl(sess, obj) {
    if (sess.ctrl && sess.ctrl.writable) {
        try {
            sess.ctrl.write(JSON.stringify(obj) + "\n");
            return true;
        } catch {}
    }
    return false;
}

function resize(sess, cols, rows) {
    cols = Math.max(2, Math.min(500, Math.round(cols)));
    rows = Math.max(1, Math.min(500, Math.round(rows)));
    sess.cols = cols;
    sess.rows = rows;
    if (sess.dead) return;
    if (!writeCtrl(sess, { type: "resize", cols, rows })) {
        // script 폴백: 셸 안에서 stty로 크기를 맞춘다(에코는 감수한다).
        writeRaw(sess, `stty rows ${rows} cols ${cols}\n`);
    }
}

// 에이전트 설정에서 터미널이 꺼져 있으면 웹 터미널도 열지 않는다(terminal_run과 같은 정책).
export function terminalEnabled() {
    return loadAgentConfig().terminalEnabled !== false;
}

// WS 연결을 봇의 PTY 세션에 붙인다. 반환값은 detach 함수.
export function attachTerminal(agentId, conn) {
    if (!terminalEnabled()) {
        conn.sendJson({ type: "error", error: "terminal_disabled" });
        conn.close(1008);
        return;
    }
    const sess = getSession(agentId);
    sess.clients.add(conn);

    if (sess.dead) spawnSession(sess);

    conn.sendJson({ type: "ready", cols: sess.cols, rows: sess.rows, shell: sess.shell, mode: sess.mode });
    for (const chunk of sess.backlog) {
        try {
            conn.send(chunk);
        } catch {}
    }
    if (sess.dead && sess.exitCode != null) conn.sendJson({ type: "exit", code: sess.exitCode });

    conn.on("message", (data, isBinary) => {
        if (isBinary) {
            writeRaw(sess, data);
            return;
        }
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        if (msg?.type === "resize" && Number.isFinite(Number(msg.cols)) && Number.isFinite(Number(msg.rows))) {
            resize(sess, Number(msg.cols), Number(msg.rows));
        } else if (msg?.type === "input" && typeof msg.data === "string") {
            writeRaw(sess, msg.data);
        } else if (msg?.type === "restart") {
            killSession(sess.agentId);
            const fresh = getSession(sess.agentId);
            fresh.backlog = [];
            fresh.backlogSize = 0;
            fresh.clients.add(conn);
            spawnSession(fresh);
            conn.sendJson({ type: "ready", cols: fresh.cols, rows: fresh.rows, shell: fresh.shell, mode: fresh.mode });
        }
    });
    conn.on("close", () => {
        sess.clients.delete(conn);
    });
}

export function killSession(agentId) {
    const sess = sessions.get(String(agentId));
    if (!sess) return;
    sess.dead = true;
    for (const conn of [...sess.clients]) {
        try {
            conn.sendJson({ type: "exit" });
        } catch {}
    }
    try {
        sess.proc?.kill("SIGHUP");
    } catch {}
    // 재시작 경합: spawnSession이 sess.proc를 새 셸로 교체한 뒤 타임아웃이 발동하면
    // 새 셸이 죽는다. 반드시 "지금의" proc만 잡아 둔다.
    const oldProc = sess.proc;
    setTimeout(() => {
        try {
            oldProc?.kill("SIGKILL");
        } catch {}
    }, 1500);
}

export function killAllSessions() {
    for (const key of [...sessions.keys()]) killSession(key);
    sessions.clear();
}
