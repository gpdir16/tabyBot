// 공유 X 디스플레이(Xvfb) 세션 관리.
// xvfb_gui 도구와 웹 "컴퓨터" 화면이 같은 세션 파일(/tmp/tabybot-xvfb/session.json)을
// 공유하므로 한 대의 가상 화면 위에서 브라우저·GUI 앱·xterm이 모두 보인다.
import { exec, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../atomic-file.js";

const SESSIONS_DIR = "/tmp/tabybot-xvfb";
const SHOTS_DIR = "/tmp/tabybot-xvfb/screenshots";
export const DEFAULT_GEOMETRY = "1280x800x24";
export const DISPLAY = 99;

export function run(cmd, opts = {}) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: opts.timeout ?? 30_000, ...opts }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                exitCode: err ? (err.code ?? -1) : 0,
                stdout: (stdout || "").toString(),
                stderr: (stderr || "").toString(),
            });
        });
    });
}

export function ensureDirs() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

function sessionPath() {
    return path.join(SESSIONS_DIR, "session.json");
}

function isPidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        // kill(0)은 좀비에도 성공하므로 Linux에서는 /proc 상태로 좀비를 걸러낸다.
        const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
        if (state === "Z" || state === "X") return false;
    } catch {
        // /proc을 읽을 수 없는 환경이면 좀비 판별을 건너뛰고 kill(0) 결과만 본다
    }
    try {
        process.kill(n, 0);
        return true;
    } catch {
        return false;
    }
}

function unlinkQuietly(file) {
    try {
        fs.unlinkSync(file);
    } catch {
        // 이미 닫혔거나 정리된 대상이면 무시한다
    }
}

function displayLockPath(display) {
    return `/tmp/.X${display}-lock`;
}

function displaySocketPath(display) {
    return `/tmp/.X11-unix/X${display}`;
}

function cleanupStaleDisplay(display) {
    const lockFile = displayLockPath(display);
    if (!fs.existsSync(lockFile)) return;
    let lockPid = null;
    try {
        lockPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    } catch {
        // 락 파일을 읽지 못하면 pid 없이 오래된 락으로 취급한다
    }
    if (lockPid && isPidAlive(lockPid)) return;
    unlinkQuietly(lockFile);
    unlinkQuietly(displaySocketPath(display));
}

export function loadSession() {
    const p = sessionPath();
    if (!fs.existsSync(p)) return null;
    try {
        const sess = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!isPidAlive(sess.xvfb_pid)) {
            unlinkQuietly(p);
            cleanupStaleDisplay(sess.display ?? DISPLAY);
            return null;
        }
        const alive = (sess.apps || []).filter((app) => isPidAlive(app.pid));
        // 앱이 죽어 목록이 바뀐 경우에만 다시 쓴다. 입력/캡처 경로에서 매번 쓰면 낭비.
        if (alive.length !== (sess.apps || []).length) {
            sess.apps = alive;
            saveSession(sess);
        }
        sess.apps = alive;
        return sess;
    } catch {
        unlinkQuietly(p);
        return null;
    }
}

function saveSession(sess) {
    writeJsonAtomic(sessionPath(), sess);
}

function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function coord(value) {
    const n = finiteNumber(value);
    return n == null ? null : Math.round(n);
}

function boundedInt(value, fallback, { min = 0, max = 10000 } = {}) {
    const n = finiteNumber(value);
    if (n == null) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function settleMs(value, fallback) {
    return boundedInt(value, fallback, { min: 0, max: 10000 });
}

function validKey(key) {
    return typeof key === "string" && /^[A-Za-z0-9_+@=.,:/-]+$/.test(key);
}

function validGeometry(geometry) {
    return typeof geometry === "string" && /^\d{2,5}x\d{2,5}x\d{1,2}$/.test(geometry);
}

export function geometryDims(geometry) {
    const m = String(geometry || DEFAULT_GEOMETRY).match(/^(\d+)x(\d+)/);
    return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1280, h: 800 };
}

// Xvfb는 셸+nohup 대신 직접 spawn한다. 직계 자식이면 죽을 때 libuv가 회수해
// 좀비가 남지 않고, pid 추적도 정확하다. 로그는 /tmp/tabybot-xvfb/xvfb.log로.
async function startXvfb(display, geometry) {
    cleanupStaleDisplay(display);
    ensureDirs();
    let proc;
    try {
        const logFd = fs.openSync(path.join(SESSIONS_DIR, "xvfb.log"), "a");
        proc = spawn("Xvfb", [`:${display}`, "-screen", "0", geometry, "-ac", "+extension", "RANDR", "+extension", "GLX", "+render", "-noreset"], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
        });
        proc.unref();
        proc.on("error", () => {
            /* 자식 프로세스 오류는 로그 파일로 남으므로 여기서는 무시한다 */
        });
        proc.on("exit", () => {
            /* 자식 프로세스 오류는 로그 파일로 남으므로 여기서는 무시한다 */
        });
        fs.closeSync(logFd);
    } catch {
        return null;
    }
    const pid = proc.pid;
    if (!pid) return null;
    const lockFile = `/tmp/.X${display}-lock`;
    for (let i = 0; i < 20; i++) {
        await sleep(250);
        if (fs.existsSync(lockFile)) break;
    }
    await sleep(300);
    if (!isPidAlive(pid) || !fs.existsSync(lockFile)) return null;
    return pid;
}

function killPid(pid) {
    if (!pid) return;
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // 이미 닫혔거나 정리된 대상이면 무시한다
    }
    setTimeout(() => {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // 이미 닫혔거나 정리된 대상이면 무시한다
        }
    }, 2000);
}

// :99부터 순서대로 빈 디스플레이를 찾는다. 외부 X 서버(예: camofox 자체 Xvfb)가
// 락을 쥐고 있으면 다음 번호로 넘어간다.
async function newSession(geometry) {
    for (let display = DISPLAY; display < DISPLAY + 5; display++) {
        const lockFile = displayLockPath(display);
        if (fs.existsSync(lockFile)) {
            let lockPid = null;
            try {
                lockPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
            } catch {
                // 락 파일을 읽지 못하면 pid 없이 오래된 락으로 취급한다
            }
            if (lockPid && isPidAlive(lockPid)) continue;
            unlinkQuietly(lockFile);
            unlinkQuietly(displaySocketPath(display));
        }
        const xvfbPid = await startXvfb(display, geometry);
        if (!xvfbPid) continue;
        const sess = { display, geometry, xvfb_pid: xvfbPid, apps: [], created_at: new Date().toISOString() };
        saveSession(sess);
        return { sess };
    }
    return { error: `Failed to start Xvfb on :${DISPLAY}..:${DISPLAY + 4}. Check /tmp/tabybot-xvfb/xvfb.log` };
}

// 이미 떠 있으면 재사용, 없으면 새로 만든다. 도구와 웹이 같은 진입점을 쓴다.
// 동시 호출 시 Xvfb가 중복으로 뜨지 않게 진행 중인 시작을 공유한다.
let starting = null;
export async function ensureSession(geometry) {
    const existing = loadSession();
    if (existing) return { sess: existing };
    if (starting) return starting;
    ensureDirs();
    const geo = validGeometry(geometry) ? geometry : DEFAULT_GEOMETRY;
    starting = newSession(geo).finally(() => {
        starting = null;
    });
    return starting;
}

export async function screenshot(sess) {
    const file = path.join(SHOTS_DIR, `${Date.now()}.png`);
    const r = await run(`DISPLAY=:${sess.display} import -window root -silent "${file}"`, { timeout: 15_000 });
    if (!r.ok) return { error: `Screenshot failed: ${r.stderr || r.stdout}` };
    const stat = fs.statSync(file);
    const { w, h } = geometryDims(sess.geometry);
    return { ok: true, action: "screenshot", shotPath: file, __image: file, imageBytes: stat.size, viewport: { width: w, height: h } };
}

// 스트림 경로용: 프레임을 stdout으로 직접 받아 임시 파일 I/O를 없앤다.
function runFileBuffer(file, args, display, timeoutMs = 15_000) {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            { env: { ...process.env, DISPLAY: `:${display}` }, encoding: "buffer", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
                resolve({ ok: !err && stdout?.length > 0, buf: stdout, stderr: (stderr || "").toString() });
            },
        );
    });
}

export async function screenshotJpegBuf(sess, quality = 75) {
    const q = boundedInt(quality, 75, { min: 10, max: 95 });
    const r = await runFileBuffer("import", ["-window", "root", "-silent", "-quality", String(q), "jpg:-"], sess.display);
    if (!r.ok) return { error: `frame capture failed: ${r.stderr}` };
    return { ok: true, jpeg: r.buf };
}

// 셸을 거치지 않고 직접 실행: 입력 이벤트는 초당 수십 건이라 spawn 비용을 줄인다.
function xdotoolArgs(display, args) {
    return new Promise((resolve) => {
        execFile("xdotool", args, { env: { ...process.env, DISPLAY: `:${display}` }, timeout: 15_000 }, (err, _stdout, stderr) => {
            resolve({ ok: !err, stderr: (stderr || "").toString() });
        });
    });
}

export async function xdotool(display, subcmd) {
    return await run(`DISPLAY=:${display} xdotool ${subcmd}`, { timeout: 15_000 });
}

export function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

// GUI 앱도 직계 자식으로 띄운다(dash sh -c는 단일 명령을 exec하므로 pid=앱).
export function launchApp(sess, appCmd) {
    if (!appCmd) return { error: "app is required for launch" };
    if (/[\r\n]/.test(appCmd)) return { error: "app command must be a single line" };
    if (/[;&|`$<>]/.test(appCmd)) return { error: "app command must not contain shell control characters" };
    ensureDirs();
    const logFd = fs.openSync(path.join(SESSIONS_DIR, "app.log"), "a");
    let proc;
    try {
        proc = spawn("sh", ["-c", `exec ${appCmd}`], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: { ...process.env, DISPLAY: `:${sess.display}` },
        });
    } finally {
        fs.closeSync(logFd);
    }
    const pid = proc?.pid;
    if (!pid) return { ok: false, action: "launch", app: appCmd, error: "Failed to launch app" };
    proc.unref();
    proc.on("error", () => {
        /* 자식 프로세스 오류는 로그 파일로 남으므로 여기서는 무시한다 */
    });
    proc.on("exit", () => {
        /* 자식 프로세스 오류는 로그 파일로 남으므로 여기서는 무시한다 */
    });
    sess.apps = sess.apps || [];
    sess.apps.push({ pid, cmd: appCmd });
    saveSession(sess);
    return { ok: true, action: "launch", app: appCmd, pid, session: sess.display };
}

export async function doAction(sess, args) {
    const { display } = sess;
    switch (args.action) {
        case "screenshot":
            return screenshot(sess);
        case "click": {
            const x = coord(args.x);
            const y = coord(args.y);
            if (x == null || y == null) return { error: "numeric x and y required for click" };
            const btn = [1, 2, 3].includes(Number(args.button)) ? Number(args.button) : 1;
            const r = args.double
                ? await xdotool(display, `mousemove ${x} ${y} click --repeat 2 ${btn}`)
                : await xdotool(display, `mousemove ${x} ${y} click ${btn}`);
            return { ok: r.ok, action: "click", x, y, button: btn, double: !!args.double, stderr: r.stderr || "" };
        }
        case "drag": {
            const x1 = coord(args.x1);
            const y1 = coord(args.y1);
            const x2 = coord(args.x2);
            const y2 = coord(args.y2);
            if (x1 == null || y1 == null || x2 == null || y2 == null) return { error: "numeric x1,y1,x2,y2 required for drag" };
            const steps = 20;
            const dx = (x2 - x1) / steps;
            const dy = (y2 - y1) / steps;
            const r0 = await xdotool(display, `mousemove ${x1} ${y1} mousedown 1`);
            for (let i = 1; i <= steps; i++) {
                await xdotool(display, `mousemove ${Math.round(x1 + dx * i)} ${Math.round(y1 + dy * i)}`);
                await sleep(15);
            }
            const r1 = await xdotool(display, `mouseup 1`);
            return {
                ok: r0.ok && r1.ok,
                action: "drag",
                from: { x: x1, y: y1 },
                to: { x: x2, y: y2 },
                stderr: (r0.stderr || "") + (r1.stderr || ""),
            };
        }
        case "type": {
            if (!args.text) return { error: "text required for type" };
            const escaped = args.text.replace(/'/g, `'\\''`);
            const r = await xdotool(display, `type --delay 30 '${escaped}'`);
            return { ok: r.ok, action: "type", length: args.text.length, stderr: r.stderr || "" };
        }
        case "key": {
            if (!validKey(args.key)) return { error: "key is required and must use xdotool key syntax without spaces" };
            const r = await xdotool(display, `key ${args.key}`);
            return { ok: r.ok, action: "key", key: args.key, stderr: r.stderr || "" };
        }
        case "scroll": {
            const x = coord(args.x);
            const y = coord(args.y);
            if (x == null || y == null) return { error: "numeric x and y required for scroll" };
            const amt = boundedInt(args.amount, 3, { min: 1, max: 20 });
            const button = args.direction === "up" ? 4 : 5;
            const cmds = [];
            for (let i = 0; i < amt; i++) cmds.push(`mousemove ${x} ${y} click ${button}`);
            const r = await xdotool(display, cmds.join(" "));
            return { ok: r.ok, action: "scroll", x, y, amount: amt, direction: args.direction || "down", stderr: r.stderr || "" };
        }
        case "kill_app": {
            const pid = boundedInt(args.pid, null, { min: 1, max: 9999999 });
            if (!pid) return { error: "numeric pid required for kill_app" };
            // 이 세션에서 launch로 띄운 앱만 죽일 수 있다. 임의 PID(예: 1)는 거부.
            if (!(sess.apps || []).some((a) => a.pid === pid)) {
                return { error: `pid ${pid} is not an app launched in this session. Use a pid from a launch result.` };
            }
            killPid(pid);
            sess.apps = (sess.apps || []).filter((a) => a.pid !== pid);
            saveSession(sess);
            return { ok: true, action: "kill_app", pid };
        }
        default:
            return { error: `Unknown action: ${args.action}` };
    }
}

// 포인터 이동·클릭 입력(click, move, mousedown, mouseup)을 xdotool 인자로 바꿔 보낸다.
async function sendPointerInput({ display }, input) {
    const type = input.type;
    const x = coord(input.x);
    const y = coord(input.y);
    if (x == null || y == null) return { error: "bad coords" };
    const btn = [1, 2, 3].includes(Number(input.button)) ? Number(input.button) : 1;
    const at = [String(x), String(y)];
    let args;
    if (type === "click") args = ["mousemove", ...at, "click", ...(input.double ? ["--repeat", "2"] : []), String(btn)];
    else if (type === "move") args = ["mousemove", ...at];
    else args = ["mousemove", ...at, type, String(btn)];
    const r = await xdotoolArgs(display, args);
    return { ok: r.ok, stderr: r.stderr || "" };
}

const SCROLL_BUTTONS = { up: "4", left: "6", right: "7" }; // 그 밖에는 아래(5)

async function sendScrollInput({ display }, input) {
    const x = coord(input.x);
    const y = coord(input.y);
    if (x == null || y == null) return { error: "bad coords" };
    const amount = boundedInt(input.amount, 3, { min: 1, max: 20 });
    const button = SCROLL_BUTTONS[input.direction] || "5";
    const args = [];
    for (let i = 0; i < amount; i++) args.push("mousemove", String(x), String(y), "click", button);
    const r = await xdotoolArgs(display, args);
    return { ok: r.ok };
}

async function sendKeyInput({ display }, input) {
    const mods = [];
    if (input.ctrl) mods.push("ctrl");
    if (input.alt) mods.push("alt");
    if (input.shift) mods.push("shift");
    if (input.meta) mods.push("super");
    const key = String(input.key || "");
    if (!validKey(key)) return { error: "bad key" };
    const r = await xdotoolArgs(display, ["key", [...mods, key].join("+")]);
    return { ok: r.ok };
}

// keydown/keyup: 누르고 있기·떼기만 따로 보낸다(수정자 키를 누른 채 다른 입력을 할 때).
async function sendKeyEdgeInput({ display }, input) {
    const key = String(input.key || "");
    if (!validKey(key)) return { error: "bad key" };
    const r = await xdotoolArgs(display, [input.type === "keydown" ? "keydown" : "keyup", key]);
    return { ok: r.ok };
}

async function sendTextInput({ display }, input) {
    const text = String(input.text || "");
    if (!text) return { error: "empty text" };
    if (text.length > 4096) return { error: "text too long" };
    const r = await xdotoolArgs(display, ["type", "--delay", "12", "--", text]);
    return { ok: r.ok };
}

const INPUT_HANDLERS = new Map([
    ["click", sendPointerInput],
    ["move", sendPointerInput],
    ["mousedown", sendPointerInput],
    ["mouseup", sendPointerInput],
    ["scroll", sendScrollInput],
    ["key", sendKeyInput],
    ["keydown", sendKeyEdgeInput],
    ["keyup", sendKeyEdgeInput],
    ["type", sendTextInput],
    ["drag", (sess, input) => doAction(sess, { action: "drag", x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2 })],
]);

// 웹 포인터/키보드 입력을 xdotool로 보낸다. doAction과 달리 자동 스크린샷은 하지 않는다.
// 셸을 거치지 않는 execFile 경로라 따옴표 이스케이프 걱정 없이 인자를 넘긴다.
export function sendInput(sess, input) {
    const handler = INPUT_HANDLERS.get(input?.type);
    return handler ? handler(sess, input) : { error: "unknown input type" };
}

export async function closeSession() {
    const sess = loadSession();
    if (sess) {
        for (const app of sess.apps || []) killPid(app.pid);
        killPid(sess.xvfb_pid);
        unlinkQuietly(sessionPath());
        await sleep(500);
        cleanupStaleDisplay(sess.display ?? DISPLAY);
    }
    return { ok: true };
}

export { settleMs, validKey, validGeometry };
