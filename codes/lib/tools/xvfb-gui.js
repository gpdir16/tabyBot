import { loadAgentConfig } from "../config-loader.js";
import { isDockerRuntime } from "../runtime.js";
import * as display from "../computer/display.js";

const XVFB_GUI_DESCRIPTION = `Linux GUI app automation on a virtual X display (Xvfb). Use this for non-browser Linux GUI programs in Docker. For web browsing, use camofox.

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

export async function executeXvfbGuiTool(name, args, ctx = {}) {
    if (name !== "xvfb_gui") return { error: `Unknown tool: ${name}` };
    if (!isDockerRuntime()) {
        return { error: "xvfb_gui is only available inside the Docker container (Xvfb is Linux-only). On macOS this tool is disabled." };
    }

    const agent = loadAgentConfig();
    if (agent.xvfbGuiEnabled === false) {
        return { error: "xvfb_gui is disabled in agent config" };
    }

    display.ensureDirs();
    args = args || {};
    const action = args.action;

    if (action === "close") {
        await display.closeSession();
        return { ok: true, action: "close" };
    }

    if (action === "launch") {
        let sess = display.loadSession();
        if (!sess) {
            const geometry = args.geometry == null ? display.DEFAULT_GEOMETRY : String(args.geometry);
            if (!display.validGeometry(geometry)) return { error: "geometry must look like 1280x800x24" };
            const r = await display.ensureSession(geometry);
            if (r.error) return r;
            sess = r.sess;
        }
        const result = await display.launchApp(sess, args.app);
        if (result.ok) {
            const settle = display.settleMs(args.settle_ms, 2500);
            if (settle > 0) await display.sleep(settle);
            const auto = await display.screenshot(sess);
            if (auto.__image) {
                result.__image = auto.__image;
                result.shotPath = auto.shotPath;
                result.viewport = auto.viewport;
            }
        }
        return result;
    }

    const sess = display.loadSession();
    if (!sess) return { error: "No active session. Call xvfb_gui with action=launch (auto-creates one) first." };

    const result = await display.doAction(sess, args);
    if (result.ok && !result.__image && ["click", "drag", "type", "key", "scroll"].includes(action)) {
        const settle = display.settleMs(args.settle_ms, 700);
        if (settle > 0) await display.sleep(settle);
        const auto = await display.screenshot(sess);
        if (auto.__image) {
            result.__image = auto.__image;
            result.shotPath = auto.shotPath;
            result.viewport = auto.viewport;
        }
    }
    return result;
}
