// 브라우저 탭의 화면 좌표를 진짜 마우스로 누른다.
// camofox click은 접근성 트리의 ref나 CSS 선택자로만 누르므로 다른 도메인 iframe(Cloudflare Turnstile, reCAPTCHA,
// 결제와 로그인 위젯), 닫힌 shadow root, 캔버스 안에는 닿지 않는다. 브라우저 창은 공유 Xvfb 화면에 떠 있으므로
// 그 탭의 창을 맨 앞으로 올리고 xdotool로 OS 수준 클릭을 보내면, 브라우저가 포인터 아래 요소(iframe 안이어도)에
// 진짜 클릭(isTrusted)을 넘긴다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { isDockerRuntime } from "../runtime.js";
import { USER_DIR } from "../paths.js";
import * as display from "../computer/display.js";
import { camofoxUser } from "../computer/camofox-user.js";
import { camofoxApi, camofoxUserTabs } from "../web/computer/camofox.js";

const SHOTS_DIR = "/tmp/tabybot-xvfb/screenshots";
const ACTIVE_TAB_FILE = path.join(USER_DIR, ".camofox", "active-tab");

export const browserClickToolDefinitions = [
    {
        type: "function",
        function: {
            name: "browser_click",
            description:
                'Click a point in a camofox browser tab with a real OS mouse (xdotool on the shared display). Use it when `camofox click` cannot reach the target: checkboxes and buttons inside cross-origin iframes (Cloudflare Turnstile, reCAPTCHA, payment and login widgets), closed shadow roots, canvas, or anything missing from `camofox snapshot`. For a Cloudflare "Verify you are human" checkbox, pass `target: "turnstile"` and no coordinates: the tool finds the checkbox itself. Otherwise take `camofox screenshot --output <file>` first, `file_read` it, and pass the pixel position from that image. Returns the page title and a fresh screenshot of the tab.',
            parameters: {
                type: "object",
                properties: {
                    target: {
                        type: "string",
                        enum: ["turnstile"],
                        description: "Find and click this widget instead of x and y. turnstile = the Cloudflare checkbox.",
                    },
                    x: { type: "number", description: "X in pixels from the left of the tab screenshot." },
                    y: { type: "number", description: "Y in pixels from the top of the tab screenshot." },
                    tab_id: {
                        type: "string",
                        description:
                            'camofox tab id, from any `--user` profile. Defaults to the tab showing the Cloudflare check for target "turnstile", else the tab the camofox CLI last opened.',
                    },
                    button: { type: "number", enum: [1, 2, 3], description: "1=left (default), 2=middle, 3=right." },
                    double: { type: "boolean", description: "Double-click." },
                    settle_ms: { type: "number", description: "Wait before the result screenshot. Default 1500; max 10000." },
                },
                required: [],
            },
        },
    },
];

// 보안 확인 화면을 보고도 봇이 browser_click을 떠올리지 못하고 주소나 API만 다시 부르며 헤매는 일이 있었다.
// camofox 명령 결과에 Cloudflare 확인 화면이 보이면 그 결과에 다음 할 일을 바로 붙인다.
const CHALLENGE_RE = /Performing security verification|Verify you are human|Just a moment\.\.\.|challenges\.cloudflare\.com/i;
const CHALLENGE_HINT =
    'This tab is showing a Cloudflare security check. Reopening the URL or calling the API again will not get past it. Click the checkbox now by calling the `browser_click` tool with `target: "turnstile"` (no coordinates needed), then check the returned title and screenshot.';

export function withChallengeHint(args, result) {
    if (!result || typeof result !== "object") return result;
    const command = String(args?.command || result.cmd || "");
    if (!/\bcamofox\b/.test(command) || !CHALLENGE_RE.test(JSON.stringify(result))) return result;
    return { ...result, hint: CHALLENGE_HINT };
}

// Turnstile 위젯의 자리(CSS 픽셀). 위젯 iframe이 보이면 그 상자를 쓴다. 닫힌 shadow root 안이라 안 보이면
// 응답 input을 감싼 위젯 높이(약 65)의 상자를 쓰는데, Cloudflare 확인 화면에서는 이 상자가 본문 폭(약 900)으로
// 넓고 위젯은 그 왼쪽에 붙어 있다. 그것도 없으면 위젯 크기(약 300x65)인 가장 안쪽 상자를 쓰되, 아무 페이지의
// 비슷한 상자를 누르지 않게 Turnstile 스크립트를 불러온 페이지에서만 쓴다.
// 체크박스는 위젯 왼쪽 끝에서 약 24px, 세로 가운데에 있다(2026-10-23 regbu.net에서 이 자리를 눌러 통과).
const LOCATE_TURNSTILE = `(() => {
    const shown = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const box = (r, via) => ({ left: r.left, top: r.top, width: r.width, height: r.height, via });
    for (const f of document.querySelectorAll("iframe")) {
        const r = f.getBoundingClientRect();
        if (/challenges\\.cloudflare\\.com|turnstile/i.test(f.src || "") && shown(r)) return box(r, "iframe");
    }
    for (const input of document.querySelectorAll('input[name="cf-turnstile-response"], input[id^="cf-chl-widget"]')) {
        for (let el = input.parentElement; el && el !== document.body; el = el.parentElement) {
            const r = el.getBoundingClientRect();
            if (r.height >= 50 && r.height <= 90 && r.width >= 250 && shown(r)) return box(r, "response");
        }
    }
    if (![...document.scripts].some((s) => /challenges\\.cloudflare\\.com|turnstile/i.test(s.src || ""))) return null;
    let found = null;
    for (const el of document.querySelectorAll("div, span, label")) {
        const r = el.getBoundingClientRect();
        if (r.width >= 280 && r.width <= 320 && r.height >= 60 && r.height <= 80 && shown(r)) found = box(r, "box");
    }
    return found;
})()`;
const TURNSTILE_CHECKBOX_X = 24;

function xdo(displayNum, args, { stdout = false } = {}) {
    return new Promise((resolve) => {
        execFile("xdotool", args, { env: { ...process.env, DISPLAY: `:${displayNum}` }, timeout: 10_000 }, (err, out, stderr) => {
            resolve({ ok: !err, stdout: stdout ? String(out || "") : "", stderr: String(stderr || "") });
        });
    });
}

async function evaluate(user, tabId, expression) {
    const r = await camofoxApi(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user, expression }),
        timeoutMs: 10_000,
    });
    if (!r.ok || r.json?.ok === false) throw new Error(r.json?.error || `evaluate failed (status ${r.status})`);
    return r.json?.result;
}

function readActiveTab() {
    try {
        return fs.readFileSync(ACTIVE_TAB_FILE, "utf8").trim();
    } catch {
        return "";
    }
}

// 열린 탭 전부. 봇이 `camofox --user <이름>`으로 따로 연 프로필의 탭도 같은 화면에 떠 있으므로 함께 본다.
async function listOpenTabs(ownUser) {
    const health = await camofoxApi("/health", { timeoutMs: 5_000 }).catch(() => null);
    const users = new Set([ownUser, ...(Array.isArray(health?.json?.activeUserIds) ? health.json.activeUserIds : [])]);
    let reachable = false;
    const tabs = [];
    for (const user of users) {
        const list = await camofoxUserTabs(user);
        if (!list) continue;
        reachable = true;
        for (const t of list) {
            const tabId = t.tabId || t.targetId;
            if (tabId) tabs.push({ user, tabId, url: t.url || "" });
        }
    }
    return reachable ? tabs : null;
}

// 누를 탭을 고른다. 탭 목록 순서는 연 순서가 아니라서, turnstile은 확인 화면이 실제로 떠 있는 탭을 찾아 고른다.
async function resolveTab(ownUser, requested, target) {
    const tabs = await listOpenTabs(ownUser);
    if (!tabs) return { error: "The camofox server is not responding. Open a page with `camofox open <url>` first." };
    if (!tabs.length) return { error: "No browser tab is open. Open one with `camofox open <url>` first." };
    if (requested) {
        const hit = tabs.find((t) => t.tabId === requested);
        return hit || { error: `Tab ${requested} is not open. Open tabs: ${tabs.map((t) => t.tabId).join(", ")}` };
    }
    // CLI가 마지막으로 연 탭, 이 봇 프로필의 탭(나중 것부터), 다른 프로필의 탭 순서로 본다
    const active = readActiveTab();
    const rest = tabs.filter((t) => t.tabId !== active);
    const ordered = [
        ...tabs.filter((t) => t.tabId === active),
        ...rest.filter((t) => t.user === ownUser).reverse(),
        ...rest.filter((t) => t.user !== ownUser).reverse(),
    ];
    if (!target) return ordered[0];
    for (const tab of ordered) {
        const widget = await evaluate(tab.user, tab.tabId, LOCATE_TURNSTILE).catch(() => null);
        if (widget) return { ...tab, widget };
    }
    return {
        error: "No Cloudflare checkbox is visible on any open tab. If the page already passed, continue with it. Otherwise take a screenshot and pass x and y.",
        tabs: ordered.map((t) => ({ tabId: t.tabId, url: t.url })),
    };
}

// 탭과 X 창을 잇는 고리가 없어 제목에 잠깐 표식을 달아 창을 찾고, 그사이 화면 위 뷰포트 위치를 함께 읽는다.
async function locateTabWindow(user, tabId, displayNum) {
    const marker = `tabybot-click-${crypto.randomBytes(6).toString("hex")}`;
    const info = await evaluate(
        user,
        tabId,
        `(() => { const title = document.title; document.title = ${JSON.stringify(marker)}; return { title, left: window.mozInnerScreenX, top: window.mozInnerScreenY, scale: window.devicePixelRatio || 1 }; })()`,
    );
    let windowId = "";
    try {
        // xdotool search --name은 바뀐 제목을 한참 늦게 잡는다. 창 목록을 받아 이름을 직접 비교한다.
        for (let i = 0; i < 10 && !windowId; i++) {
            const ids = (await xdo(displayNum, ["search", "--class", "camoufox"], { stdout: true })).stdout.split("\n").filter(Boolean);
            for (const id of ids) {
                const name = await xdo(displayNum, ["getwindowname", id], { stdout: true });
                if (name.stdout.includes(marker)) {
                    windowId = id;
                    break;
                }
            }
            if (!windowId) await display.sleep(150);
        }
    } finally {
        await evaluate(user, tabId, `document.title = ${JSON.stringify(info?.title ?? "")}`).catch(() => {
            // 제목을 못 되돌려도 다음 페이지 이동 때 원래대로 바뀐다
        });
    }
    if (!windowId) return { error: "Could not find this tab's window on the shared display." };
    return { windowId: windowId.trim(), left: Number(info?.left) || 0, top: Number(info?.top) || 0, scale: Number(info?.scale) || 1 };
}

async function pointerAt(displayNum) {
    const r = await xdo(displayNum, ["getmouselocation", "--shell"], { stdout: true });
    const x = Number(r.stdout.match(/X=(\d+)/)?.[1]);
    const y = Number(r.stdout.match(/Y=(\d+)/)?.[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

// 사람 손처럼 포인터를 몇 단계에 걸쳐 감속하며 옮긴다. 순간 이동 한 번보다 위젯이 보는 움직임이 자연스럽다.
async function glideTo(displayNum, to) {
    const from = (await pointerAt(displayNum)) || { x: Math.max(0, to.x - 120), y: Math.max(0, to.y + 80) };
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
        const t = 1 - (1 - i / steps) ** 3;
        const jitter = i < steps ? Math.round((Math.random() - 0.5) * 3) : 0;
        await xdo(displayNum, [
            "mousemove",
            String(Math.round(from.x + (to.x - from.x) * t) + jitter),
            String(Math.round(from.y + (to.y - from.y) * t) + jitter),
        ]);
        await display.sleep(15 + Math.round(Math.random() * 15));
    }
}

async function tabScreenshot(user, tabId) {
    try {
        const res = await fetch(
            `http://${process.env.CAMOFOX_HOST || "127.0.0.1"}:${process.env.CAMOFOX_PORT || "9377"}/tabs/${encodeURIComponent(tabId)}/screenshot?userId=${encodeURIComponent(user)}`,
            { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) return null;
        fs.mkdirSync(SHOTS_DIR, { recursive: true });
        const file = path.join(SHOTS_DIR, `tab-${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return file;
    } catch {
        return null;
    }
}

// 창을 올리고 포인터를 옮기는 사이에 다른 턴이 끼어들면 엉뚱한 창을 누르므로 한 번에 하나씩 한다.
let queue = Promise.resolve();

export function executeBrowserClick(args, ctx = {}) {
    const run = queue.then(() => clickOnce(args || {}, ctx));
    queue = run.catch(() => {
        // 실패한 클릭이 다음 클릭을 막지 않게 한다
    });
    return run;
}

async function clickOnce(args, { agentId } = {}) {
    if (!isDockerRuntime()) return { error: "browser_click needs the shared Xvfb display, which exists only in the Docker container." };
    const target = args.target === "turnstile" ? "turnstile" : "";
    let x = Number(args.x);
    let y = Number(args.y);
    if (!target && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
        return { error: 'numeric x and y (>= 0) are required, or target: "turnstile"' };
    }
    const sess = display.loadSession();
    if (!sess) return { error: "The shared display is not running." };

    const tab = await resolveTab(camofoxUser(agentId), args.tab_id ? String(args.tab_id) : "", target);
    if (tab.error) return tab;
    const { user } = tab;
    const win = await locateTabWindow(user, tab.tabId, sess.display);
    if (win.error) return win;
    if (target) {
        const widget = tab.widget || (await evaluate(user, tab.tabId, LOCATE_TURNSTILE).catch(() => null));
        if (!widget) {
            return {
                error: "No Cloudflare checkbox is visible on this tab. If the page already passed, continue with it. Otherwise take a screenshot and pass x and y.",
                tabId: tab.tabId,
            };
        }
        // 스크린샷 픽셀 단위로 맞춘다(아래 계산이 x, y를 스크린샷 픽셀로 받는다)
        x = Math.round((widget.left + Math.min(TURNSTILE_CHECKBOX_X, widget.width / 2)) * win.scale);
        y = Math.round((widget.top + widget.height / 2) * win.scale);
    }

    const { w: screenW, h: screenH } = display.geometryDims(sess.geometry);
    // 스크린샷 픽셀은 CSS 픽셀에 배율을 곱한 값이고, mozInnerScreenX/Y는 CSS 픽셀이다
    let screenX = Math.round(win.left * win.scale + x);
    let screenY = Math.round(win.top * win.scale + y);
    // 창이 화면보다 크면(지문용 창 크기) 누를 곳이 화면 밖일 수 있다. 그때는 창을 잠깐 밀어 그 점을 화면 안에 둔다.
    const shiftX = screenX >= screenW ? screenX - Math.round(screenW / 2) : 0;
    const shiftY = screenY >= screenH ? screenY - Math.round(screenH / 2) : 0;
    await xdo(sess.display, ["windowraise", win.windowId]);
    let origin = null;
    if (shiftX || shiftY) {
        const geo = await xdo(sess.display, ["getwindowgeometry", "--shell", win.windowId], { stdout: true });
        origin = { x: Number(geo.stdout.match(/X=(-?\d+)/)?.[1]) || 0, y: Number(geo.stdout.match(/Y=(-?\d+)/)?.[1]) || 0 };
        await xdo(sess.display, ["windowmove", win.windowId, String(origin.x - shiftX), String(origin.y - shiftY)]);
        screenX -= shiftX;
        screenY -= shiftY;
    }
    await display.sleep(150);

    const button = [1, 2, 3].includes(Number(args.button)) ? String(args.button) : "1";
    await glideTo(sess.display, { x: screenX, y: screenY });
    await display.sleep(60 + Math.round(Math.random() * 80));
    const clicks = args.double ? 2 : 1;
    let ok = true;
    for (let i = 0; i < clicks; i++) {
        const down = await xdo(sess.display, ["mousedown", button]);
        await display.sleep(50 + Math.round(Math.random() * 60));
        const up = await xdo(sess.display, ["mouseup", button]);
        ok = ok && down.ok && up.ok;
        if (i + 1 < clicks) await display.sleep(90);
    }

    await display.sleep(display.settleMs(args.settle_ms, 1500));
    if (origin) await xdo(sess.display, ["windowmove", win.windowId, String(origin.x), String(origin.y)]);
    const result = { ok, tabId: tab.tabId, x, y, screen: { x: screenX + shiftX, y: screenY + shiftY } };
    if (target) result.target = target;
    // 누른 뒤 확인 화면을 넘겼는지 제목으로 바로 알 수 있게 한다
    const title = await evaluate(user, tab.tabId, "document.title").catch(() => null);
    if (typeof title === "string") result.title = title;
    const shot = await tabScreenshot(user, tab.tabId);
    if (shot) {
        result.__image = shot;
        result.shotPath = shot;
    }
    return result;
}
