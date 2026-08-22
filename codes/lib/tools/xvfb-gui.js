import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadAgentConfig } from "../config-loader.js";
import { isDockerRuntime } from "../runtime.js";

const SESSIONS_DIR = "/tmp/tabyagent-xvfb";
const SHOTS_DIR = "/tmp/tabyagent-xvfb/screenshots";
const DEFAULT_GEOMETRY = "1280x800x24";
const DISPLAY = 99;

const XVFB_GUI_DESCRIPTION = `Linux GUI app automation on a virtual X display (Xvfb). Use this for non-browser Linux GUI programs in Docker. For web browsing, use browser-use.

Actions: launch, kill_app, screenshot, click (button 1/2/3, optional double), drag, type, key, scroll, close.

Drive GUI apps through screenshot, key, type, click, drag, and scroll. Coordinates are pixels from the top-left of the X display root window.`;

export const xvfbGuiToolDefinitions = [
    {
        type: "function",
        function: {
            name: "xvfb_gui",
            description: XVFB_GUI_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["launch", "kill_app", "screenshot", "click", "drag", "type", "key", "scroll", "close"],
                        description:
                            "launch: start a Linux GUI app on the display (auto-creates the session if none). kill_app: kill a launched app by pid. screenshot: capture the display. click: click at x,y (button 1=left default, 2=middle, 3=right; double=true for double-click). drag: mouse down at x1,y1, move to x2,y2, release. type: type text at cursor. key: press key (xdotool syntax: Return, Tab, ctrl+w, alt+F4). scroll: up/down at x,y. close: tear down the Xvfb session.",
                    },
                    app: { type: "string", description: "App command for launch, e.g. 'xterm' or 'xclock'." },
                    geometry: {
                        type: "string",
                        description: "Xvfb screen geometry for a new session, e.g. '1280x800x24'. Ignored when a session already exists.",
                    },
                    pid: { type: "number", description: "PID for kill_app." },
                    x: { type: "number", description: "X coordinate (pixels)." },
                    y: { type: "number", description: "Y coordinate (pixels)." },
                    x1: { type: "number", description: "Start X for drag." },
                    y1: { type: "number", description: "Start Y for drag." },
                    x2: { type: "number", description: "End X for drag." },
                    y2: { type: "number", description: "End Y for drag." },
                    text: { type: "string", description: "Text to type (type action)." },
                    key: {
                        type: "string",
                        description: "Key name (key action). xdotool syntax without spaces: Return, Tab, Escape, ctrl+w, alt+F4.",
                    },
                    button: { type: "number", enum: [1, 2, 3], description: "Mouse button for click: 1=left (default), 2=middle, 3=right." },
                    double: { type: "boolean", description: "If true, perform a double-click (click action only)." },
                    settle_ms: {
                        type: "number",
                        description: "Wait this many ms after the action before the auto-screenshot. Default 700; max 10000.",
                    },
                    amount: { type: "number", description: "Scroll amount in clicks (default 3)." },
                    direction: { type: "string", enum: ["up", "down"], description: "Scroll direction (default down)." },
                },
                required: ["action"],
            },
        },
    },
];

function run(cmd, opts = {}) {
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

function ensureDirs() {
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
        process.kill(n, 0);
        return true;
    } catch {
        return false;
    }
}

function unlinkQuietly(file) {
    try {
        fs.unlinkSync(file);
    } catch {}
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
    } catch {}
    if (lockPid && isPidAlive(lockPid)) return;
    unlinkQuietly(lockFile);
    unlinkQuietly(displaySocketPath(display));
}

function loadSession() {
    const p = sessionPath();
    if (!fs.existsSync(p)) return null;
    try {
        const sess = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!isPidAlive(sess.xvfb_pid)) {
            unlinkQuietly(p);
            cleanupStaleDisplay(sess.display ?? DISPLAY);
            return null;
        }
        sess.apps = (sess.apps || []).filter((app) => isPidAlive(app.pid));
        saveSession(sess);
        return sess;
    } catch {
        unlinkQuietly(p);
        return null;
    }
}
function saveSession(sess) {
    fs.writeFileSync(sessionPath(), JSON.stringify(sess, null, 2), "utf8");
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

function geometryDims(geometry) {
    const m = String(geometry || DEFAULT_GEOMETRY).match(/^(\d+)x(\d+)/);
    return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1280, h: 800 };
}

async function startXvfb(display, geometry) {
    cleanupStaleDisplay(display);
    const r = await run(
        `nohup Xvfb :${display} -screen 0 ${geometry} -ac +extension RANDR +extension GLX +render -noreset >/tmp/tabyagent-xvfb/xvfb.log 2>&1 & echo $!`,
    );
    if (!r.ok) return null;
    const pid = parseInt((r.stdout || "").trim(), 10);
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
    } catch {}
    setTimeout(() => {
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    }, 2000);
}

async function newSession(geometry) {
    const display = DISPLAY;
    const xvfbPid = await startXvfb(display, geometry);
    if (!xvfbPid) return { error: `Failed to start Xvfb on :${display}. Check /tmp/tabyagent-xvfb/xvfb.log` };
    const sess = { display, geometry, xvfb_pid: xvfbPid, apps: [], created_at: new Date().toISOString() };
    saveSession(sess);
    return { sess };
}

async function screenshot(sess) {
    const file = path.join(SHOTS_DIR, `${Date.now()}.png`);
    const r = await run(`DISPLAY=:${sess.display} import -window root -silent "${file}"`, { timeout: 15_000 });
    if (!r.ok) return { error: `Screenshot failed: ${r.stderr || r.stdout}` };
    const stat = fs.statSync(file);
    const { w, h } = geometryDims(sess.geometry);
    return { ok: true, action: "screenshot", shotPath: file, __image: file, imageBytes: stat.size, viewport: { width: w, height: h } };
}

async function xdotool(display, subcmd) {
    return await run(`DISPLAY=:${display} xdotool ${subcmd}`, { timeout: 15_000 });
}

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

async function launchApp(sess, appCmd) {
    if (!appCmd) return { error: "app is required for launch" };
    if (/[\r\n]/.test(appCmd)) return { error: "app command must be a single line" };
    if (/[;&|`$<>]/.test(appCmd)) return { error: "app command must not contain shell control characters" };
    const r = await run(`DISPLAY=:${sess.display} nohup ${appCmd} >/tmp/tabyagent-xvfb/app.log 2>&1 & echo $!`);
    const pid = parseInt((r.stdout || "").trim(), 10);
    if (!r.ok || !pid) return { ok: false, action: "launch", app: appCmd, error: `Failed to launch app: ${r.stderr || r.stdout}` };
    sess.apps = sess.apps || [];
    sess.apps.push({ pid, cmd: appCmd });
    saveSession(sess);
    return { ok: true, action: "launch", app: appCmd, pid, session: sess.display };
}

async function doAction(sess, args) {
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
            killPid(pid);
            sess.apps = (sess.apps || []).filter((a) => a.pid !== pid);
            saveSession(sess);
            return { ok: true, action: "kill_app", pid };
        }
        default:
            return { error: `Unknown action: ${args.action}` };
    }
}

export async function executeXvfbGuiTool(name, args, ctx = {}) {
    if (name !== "xvfb_gui") return { error: `Unknown tool: ${name}` };
    if (!isDockerRuntime()) {
        return { error: "xvfb_gui is only available inside the Docker container (Xvfb is Linux-only). On macOS this tool is disabled." };
    }

    const agent = loadAgentConfig();
    if (agent.xvfbGuiEnabled === false) {
        return { error: "xvfb_gui is disabled in agent config" };
    }

    ensureDirs();
    args = args || {};
    const action = args.action;

    if (action === "close") {
        const sess = loadSession();
        if (sess) {
            for (const app of sess.apps || []) killPid(app.pid);
            killPid(sess.xvfb_pid);
            unlinkQuietly(sessionPath());
            await sleep(500);
            cleanupStaleDisplay(sess.display ?? DISPLAY);
        }
        return { ok: true, action: "close" };
    }

    if (action === "launch") {
        let sess = loadSession();
        if (!sess) {
            const geometry = args.geometry == null ? DEFAULT_GEOMETRY : String(args.geometry);
            if (!validGeometry(geometry)) return { error: "geometry must look like 1280x800x24" };
            const r = await newSession(geometry);
            if (r.error) return r;
            sess = r.sess;
        }
        const result = await launchApp(sess, args.app);
        if (result.ok) {
            const settle = settleMs(args.settle_ms, 2500);
            if (settle > 0) await sleep(settle);
            const auto = await screenshot(sess);
            if (auto.__image) {
                result.__image = auto.__image;
                result.shotPath = auto.shotPath;
                result.viewport = auto.viewport;
            }
        }
        return result;
    }

    const sess = loadSession();
    if (!sess) return { error: "No active session. Call xvfb_gui with action=launch (auto-creates one) first." };

    const result = await doAction(sess, args);
    if (result.ok && !result.__image && ["click", "drag", "type", "key", "scroll"].includes(action)) {
        const settle = settleMs(args.settle_ms, 700);
        if (settle > 0) await sleep(settle);
        const auto = await screenshot(sess);
        if (auto.__image) {
            result.__image = auto.__image;
            result.shotPath = auto.shotPath;
            result.viewport = auto.viewport;
        }
    }
    return result;
}
