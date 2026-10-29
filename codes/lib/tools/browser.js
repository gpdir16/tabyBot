// 에이전트의 브라우저 도구(browser_*). camofox REST API를 그 에이전트의 프로필로만 부른다.
// 세션 기록을 보면 에이전트는 터미널에서 camofox CLI로 이동한 뒤 sleep으로 몇 초씩 기다렸다가 eval로 다시 읽었고,
// 브라우저 시간의 절반 가까이가 그 sleep이었다. 그래서 페이지가 바뀔 수 있는 조작은 도구가 준비될 때까지 기다리고,
// 결과에 URL, 제목, 짧은 스냅샷을 담아 확인용 왕복도 없앤다.
import path from "node:path";
import { isDockerRuntime } from "../runtime.js";
import { USER_DIR } from "../paths.js";
import * as display from "../computer/display.js";
import { camofoxUser } from "../computer/camofox-user.js";
import { camofoxApi, camofoxUserTabs, ensureCamofoxServer, ensureProfilePrefs, normalizeUrl } from "../web/computer/camofox.js";
import { tabScreenshot } from "../web/computer/windows.js";
import { clickAtPoint, withChallengeHint } from "./browser-click.js";

// 조작 뒤 페이지 준비를 기다리는 최대 시간
const SETTLE_TIMEOUT_MS = 10_000;
// 조작 결과에 붙이는 스냅샷 길이. 매번 붙으므로 짧게 두고 나머지는 browser_snapshot으로 이어 본다.
const ACTION_SNAPSHOT_CHARS = 6000;
// browser_snapshot 한 번에 돌려주는 길이
const PAGE_SNAPSHOT_CHARS = 20_000;
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;
const EVAL_RESULT_CHARS = 20_000;

const tabIdProp = { type: "string", description: "Tab id from browser_open or browser_tabs. Omit to use the tab you used last." };
const refProp = { type: "string", description: "Element ref from a snapshot, e.g. e12." };
const selectorProp = { type: "string", description: "CSS selector, used when there is no ref." };

const fn = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
});

export const browserToolDefinitions = [
    fn(
        "browser_open",
        "Open a URL in a new tab of your own browser (logins and cookies persist) and wait until the page is ready. Returns tab_id, url, title, and a snapshot of the page with element refs. Reuse the current tab with browser_navigate instead of opening a new one for every page.",
        { url: { type: "string", description: "URL to open. https:// is added when missing." } },
        ["url"],
    ),
    fn(
        "browser_navigate",
        "Go to a URL, or back, forward, or reload, in a tab and wait until the page is ready. Returns url, title, and a snapshot.",
        {
            url: { type: "string", description: "URL to go to." },
            action: { type: "string", enum: ["back", "forward", "reload"], description: "Use instead of url." },
            tab_id: tabIdProp,
        },
    ),
    fn(
        "browser_snapshot",
        `Read the page as an accessibility tree with element refs (e12) for browser_click, browser_type, and browser_scroll. Returns up to ${PAGE_SNAPSHOT_CHARS} characters; pass next_offset from the result as offset to read further. It does not show images, canvas, or cross-origin iframes; use browser_screenshot for those.`,
        { offset: { type: "number", description: "Character offset to start from. Default 0." }, tab_id: tabIdProp },
    ),
    fn(
        "browser_click",
        'Click an element and wait until the page is ready. Pass a ref from the latest snapshot (preferred) or a CSS selector; returns url, title, a snapshot, and any download it started. Refs change after the page changes, so take them from the latest result. For targets refs cannot reach (cross-origin iframes such as CAPTCHA, payment, and login widgets, closed shadow roots, canvas), pass x and y in pixels from browser_screenshot instead: a real mouse clicks there and a new screenshot comes back. For a Cloudflare "Verify you are human" check, pass target: "turnstile" with no coordinates; it finds the checkbox itself.',
        {
            ref: refProp,
            selector: selectorProp,
            x: { type: "number", description: "X in pixels from the left of the browser_screenshot image." },
            y: { type: "number", description: "Y in pixels from the top of the browser_screenshot image." },
            target: {
                type: "string",
                enum: ["turnstile"],
                description: "Find and click this widget instead of x and y. turnstile = the Cloudflare checkbox.",
            },
            double: { type: "boolean", description: "Double-click (x and y only)." },
            button: { type: "number", enum: [1, 2, 3], description: "1=left (default), 2=middle, 3=right (x and y only)." },
            tab_id: tabIdProp,
        },
    ),
    fn(
        "browser_type",
        "Type text into an input. With submit: true, press Enter afterwards and wait until the page is ready. Returns url, title, and a snapshot. A secret placeholder {{secret:ID}} in text is filled in right before typing.",
        {
            ref: refProp,
            selector: selectorProp,
            text: { type: "string", description: "Text to type. Replaces what the field holds." },
            submit: { type: "boolean", description: "Press Enter after typing." },
            tab_id: tabIdProp,
        },
        ["text"],
    ),
    fn(
        "browser_press",
        "Press a key in the focused element (Enter, Escape, Tab, ArrowDown, PageDown, or a combo such as Control+a) and wait until the page is ready. Returns url, title, and a snapshot.",
        { key: { type: "string", description: "Key name." }, tab_id: tabIdProp },
        ["key"],
    ),
    fn(
        "browser_scroll",
        "Scroll the page, or with ref or selector, scroll inside that element (a scrollable list or panel). Returns url, title, and a snapshot.",
        {
            direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Default down." },
            amount: { type: "number", description: "Pixels. Default 500." },
            ref: refProp,
            selector: selectorProp,
            tab_id: tabIdProp,
        },
    ),
    fn(
        "browser_screenshot",
        "Take a screenshot of the tab and look at it. Use it when the snapshot is not enough: images, canvas, CAPTCHAs, layout, or when a click seems to do nothing. Pixel positions in this image are what browser_click x and y take.",
        { tab_id: tabIdProp },
    ),
    fn(
        "browser_wait",
        `Wait until an element matching selector exists, or text appears on the page. Use it instead of sleeping. Returns matched, url, title, and a snapshot. Timeout default ${WAIT_DEFAULT_MS / 1000}s, max ${WAIT_MAX_MS / 1000}s.`,
        {
            selector: selectorProp,
            text: { type: "string", description: "Text to wait for." },
            timeout: { type: "number", description: "Milliseconds." },
            tab_id: tabIdProp,
        },
    ),
    fn(
        "browser_eval",
        "Run a JavaScript expression in the page and return its value (JSON-serializable; await a Promise by returning it). Use it to read data the snapshot does not show well. To click or type, use browser_click and browser_type with refs instead, since they act like a person. Pages are already ready after the other browser tools return, so do not add waits.",
        { expression: { type: "string", description: "JavaScript expression." }, tab_id: tabIdProp },
        ["expression"],
    ),
    fn(
        "browser_tabs",
        "List your open tabs (tab_id, url, title, which one you used last). Pass close with tab ids to close tabs you no longer need.",
        { close: { type: "array", items: { type: "string" }, description: "Tab ids to close." } },
    ),
];

export const BROWSER_TOOL_NAMES = new Set(browserToolDefinitions.map((d) => d.function.name));

/* ── 탭 고르기: tab_id를 안 주면 그 에이전트가 마지막으로 쓴 탭을 쓴다 ── */
const lastTabByUser = new Map();

async function openTabs(user) {
    const list = await camofoxUserTabs(user);
    return list ? list.map((t) => ({ tabId: t.tabId || t.targetId, url: t.url || "", title: t.title || "" })).filter((t) => t.tabId) : null;
}

const tabSummary = (tabs) => tabs.map((t) => ({ tab_id: t.tabId, url: t.url, title: t.title }));

async function resolveTab(user, requested) {
    const tabs = await openTabs(user);
    if (!tabs?.length) return { error: "No browser tab is open. Open one with browser_open." };
    if (requested) {
        const hit = tabs.find((t) => t.tabId === requested);
        if (!hit) return { error: `Tab ${requested} is not open.`, tabs: tabSummary(tabs) };
        lastTabByUser.set(user, hit.tabId);
        return { tab: hit, tabs };
    }
    // 마지막으로 쓴 탭이 닫혔으면 목록의 마지막 탭을 쓴다
    const tab = tabs.find((t) => t.tabId === lastTabByUser.get(user)) || tabs[tabs.length - 1];
    lastTabByUser.set(user, tab.tabId);
    return { tab, tabs };
}

/* ── camofox 호출 ── */
const post = (apiPath, body, timeoutMs = 30_000) =>
    camofoxApi(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs });

const tabPath = (tabId, action) => `/tabs/${encodeURIComponent(tabId)}${action ? `/${action}` : ""}`;

// ref가 없거나 이미 바뀌었을 때 서버는 "Internal server error"만 돌려준다. ref를 썼으면 흔한 원인을 덧붙인다.
const STALE_REF_HINT = "If the ref came from an older result, the page has changed since. Use refs from the latest result or browser_snapshot.";

function failure(r, what, ref) {
    const error = r?.json?.error || `${what} failed${r?.status ? ` (status ${r.status})` : ""}`;
    return ref ? { error, hint: STALE_REF_HINT } : { error };
}

// DOMContentLoaded, 네트워크 잠잠해짐, 프레임워크 렌더링 완료를 차례로 기다린다. 상한을 넘으면 그때 상태로 넘어간다.
async function settle(user, tabId) {
    await post(tabPath(tabId, "wait"), { userId: user, timeout: SETTLE_TIMEOUT_MS, waitForNetwork: true }, SETTLE_TIMEOUT_MS).catch(() => {
        // 기다림이 상한을 넘거나 실패해도 지금 상태를 돌려주면 된다
    });
}

// 스냅샷의 offset부터 size자. 서버는 8만 자가 넘으면 offset부터 잘라 끝부분을 덧붙여 주므로 앞쪽 내용만 쓴다.
async function readSnapshot(user, tabId, offset, size) {
    const r = await camofoxApi(`${tabPath(tabId, "snapshot")}?userId=${encodeURIComponent(user)}&offset=${offset}`, { timeoutMs: 30_000 }).catch(
        () => null,
    );
    if (!r?.ok) return failure(r, "snapshot");
    const { snapshot = "", truncated, totalChars = snapshot.length } = r.json || {};
    const start = truncated ? Number(r.json.offset) || 0 : Math.min(offset, snapshot.length);
    let text = truncated ? snapshot.slice(0, Math.min(size, totalChars - start)) : snapshot.slice(start, start + size);
    const more = start + text.length < totalChars;
    // 줄 중간에서 끊기면 ref가 잘리므로 마지막 줄바꿈에서 자른다
    if (more) {
        const cut = text.lastIndexOf("\n");
        if (cut > size * 0.8) text = text.slice(0, cut + 1);
    }
    const out = { url: r.json?.url, snapshot: text };
    if (start + text.length < totalChars) out.next_offset = start + text.length;
    return out;
}

// 조작 결과에 붙일 탭 상태
async function pageState(user, tabId, extra = {}) {
    const [tabs, snap] = await Promise.all([openTabs(user), readSnapshot(user, tabId, 0, ACTION_SNAPSHOT_CHARS)]);
    const tab = tabs?.find((t) => t.tabId === tabId);
    const result = { ok: true, tab_id: tabId, url: tab?.url || snap.url || "", title: tab?.title || "", ...extra };
    if (snap.error) result.snapshot_error = snap.error;
    else {
        result.snapshot = snap.snapshot;
        if (snap.next_offset) result.snapshot_more = `Truncated. Call browser_snapshot with offset ${snap.next_offset} to read further.`;
    }
    return withChallengeHint(result);
}

/* ── 도구별 실행 ── */
async function openTab(user, args) {
    const url = normalizeUrl(args.url);
    if (!/^https?:\/\//i.test(url)) return { error: "url must be an http(s) URL." };
    // Docker에서는 공유 화면에 창을 띄워 컴퓨터 화면에 보이게 하고, 로컬 설치는 화면 없이 띄운다
    let displayNum = null;
    if (isDockerRuntime()) {
        const started = await display.ensureSession();
        if (started.error) return started;
        displayNum = started.sess.display;
    }
    if (!(await ensureCamofoxServer(displayNum))) return { error: "The browser server did not start." };
    ensureProfilePrefs(user);
    const r = await post("/tabs", { userId: user, sessionKey: "default", url }, 60_000).catch(() => null);
    const tabId = r?.json?.tabId;
    if (!r?.ok || !tabId) return failure(r, "open");
    lastTabByUser.set(user, tabId);
    await settle(user, tabId);
    return pageState(user, tabId);
}

async function navigate(user, tabId, args) {
    let r;
    if (args.url) {
        const url = normalizeUrl(args.url);
        if (!/^https?:\/\//i.test(url)) return { error: "url must be an http(s) URL." };
        r = await post(tabPath(tabId, "navigate"), { userId: user, url }, 40_000).catch(() => null);
    } else if (["back", "forward", "reload"].includes(args.action)) {
        r = await post(tabPath(tabId, args.action === "reload" ? "refresh" : args.action), { userId: user }, 40_000).catch(() => null);
    } else return { error: "Pass url, or action: back, forward, or reload." };
    if (!r?.ok) return failure(r, "navigate");
    await settle(user, tabId);
    return pageState(user, tabId);
}

async function click(user, resolved, args) {
    const { tab, tabs } = resolved;
    if (!args.ref && !args.selector) {
        if (!isDockerRuntime()) return { error: "Clicking by x and y needs the shared display, which exists only in the Docker container." };
        // turnstile은 지정한 탭이 없으면 확인 화면이 떠 있는 탭을 찾아 누른다(마지막으로 쓴 탭부터)
        const candidates = args.tab_id || args.target !== "turnstile" ? [tab] : [tab, ...tabs.filter((t) => t.tabId !== tab.tabId).reverse()];
        const result = await clickAtPoint(user, candidates, args);
        if (result.tab_id) lastTabByUser.set(user, result.tab_id);
        return result;
    }
    const r = await post(tabPath(tab.tabId, "click"), { userId: user, ref: args.ref, selector: args.selector }, 40_000).catch(() => null);
    if (!r?.ok) return failure(r, "click", args.ref);
    await settle(user, tab.tabId);
    // 클릭이 시작한 다운로드는 받기가 끝나면 그 프로필의 다운로드 폴더에 생긴다
    const downloads = r.json?.downloads?.length ? { downloads: r.json.downloads, download_folder: downloadFolder(user) } : {};
    return pageState(user, tab.tabId, downloads);
}

const downloadFolder = (user) =>
    path.join(process.env.CAMOFOX_DOWNLOADS_DIR || path.join(USER_DIR, "camofox", "downloads"), encodeURIComponent(user));

async function type(user, tabId, args) {
    if (!args.ref && !args.selector) return { error: "Pass ref or selector." };
    const r = await post(
        tabPath(tabId, "type"),
        { userId: user, ref: args.ref, selector: args.selector, text: String(args.text ?? "") },
        40_000,
    ).catch(() => null);
    if (!r?.ok) return failure(r, "type", args.ref);
    if (args.submit) {
        const pressed = await post(tabPath(tabId, "press"), { userId: user, key: "Enter" }).catch(() => null);
        if (!pressed?.ok) return failure(pressed, "press Enter");
        await settle(user, tabId);
    }
    return pageState(user, tabId);
}

async function press(user, tabId, args) {
    if (!args.key) return { error: "key is required." };
    const r = await post(tabPath(tabId, "press"), { userId: user, key: String(args.key) }).catch(() => null);
    if (!r?.ok) return failure(r, "press");
    await settle(user, tabId);
    return pageState(user, tabId);
}

async function scroll(user, tabId, args) {
    const direction = ["up", "down", "left", "right"].includes(args.direction) ? args.direction : "down";
    const amount = Number(args.amount) > 0 ? Number(args.amount) : 500;
    let r;
    if (args.ref || args.selector) {
        const delta = direction === "up" || direction === "left" ? -amount : amount;
        const horizontal = direction === "left" || direction === "right";
        r = await post(tabPath(tabId, "scroll-element"), {
            userId: user,
            ref: args.ref,
            selector: args.selector,
            deltaX: horizontal ? delta : 0,
            deltaY: horizontal ? 0 : delta,
        }).catch(() => null);
    } else r = await post(tabPath(tabId, "scroll"), { userId: user, direction, amount }).catch(() => null);
    if (!r?.ok) return failure(r, "scroll", args.ref);
    return pageState(user, tabId);
}

async function screenshot(user, tab) {
    const file = await tabScreenshot(user, tab.tabId);
    if (!file) return { error: "Could not take a screenshot of this tab." };
    return { ok: true, tab_id: tab.tabId, url: tab.url, title: tab.title, screenshot_path: file, __image: file };
}

async function wait(user, tabId, args) {
    if (!args.selector && !args.text) return { error: "Pass selector or text." };
    const timeout = Math.min(Number(args.timeout) > 0 ? Number(args.timeout) : WAIT_DEFAULT_MS, WAIT_MAX_MS);
    const check = args.selector
        ? `document.querySelector(${JSON.stringify(String(args.selector))})`
        : `(document.body?.innerText || "").includes(${JSON.stringify(String(args.text))})`;
    const expression = `new Promise((resolve) => {
        const deadline = Date.now() + ${timeout};
        const tick = () => {
            try { if (${check}) return resolve(true); } catch {}
            if (Date.now() > deadline) return resolve(false);
            setTimeout(tick, 200);
        };
        tick();
    })`;
    const r = await post(tabPath(tabId, "evaluate"), { userId: user, expression, timeout: timeout + 2000 }, timeout + 5000).catch(() => null);
    if (!r?.ok || r.json?.ok === false) return failure(r, "wait");
    return pageState(user, tabId, { matched: r.json?.result === true });
}

async function evaluateExpression(user, tabId, args) {
    if (!args.expression) return { error: "expression is required." };
    const r = await post(tabPath(tabId, "evaluate"), { userId: user, expression: String(args.expression), timeout: 30_000 }, 35_000).catch(
        () => null,
    );
    if (!r?.ok || r.json?.ok === false) return failure(r, "eval");
    let result = r.json?.result;
    const text = typeof result === "string" ? result : JSON.stringify(result);
    if (text && text.length > EVAL_RESULT_CHARS) result = `${text.slice(0, EVAL_RESULT_CHARS)}… [truncated, ${text.length} characters in all]`;
    return { ok: true, tab_id: tabId, result };
}

async function listOrClose(user, args) {
    const close = Array.isArray(args.close) ? args.close.map(String) : [];
    const before = await openTabs(user);
    if (!before) return { error: "The browser is not running. Open a page with browser_open." };
    const closed = [];
    const notFound = [];
    for (const tabId of close) {
        if (!before.some((t) => t.tabId === tabId)) {
            notFound.push(tabId);
            continue;
        }
        const r = await camofoxApi(tabPath(tabId), {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: user }),
            timeoutMs: 15_000,
        }).catch(() => null);
        if (r?.ok) closed.push(tabId);
        else notFound.push(tabId);
    }
    const tabs = closed.length ? (await openTabs(user)) || [] : before;
    const last = lastTabByUser.get(user);
    const result = {
        ok: true,
        tabs: tabs.map((t) => ({ tab_id: t.tabId, url: t.url, title: t.title, ...(t.tabId === last ? { last_used: true } : {}) })),
    };
    if (closed.length) result.closed = closed;
    if (notFound.length) result.not_closed = notFound;
    return result;
}

export async function executeBrowserTool(name, args = {}, ctx = {}) {
    const user = camofoxUser(ctx.agentId);
    if (name === "browser_open") return openTab(user, args);
    if (name === "browser_tabs") return listOrClose(user, args);

    const resolved = await resolveTab(user, args.tab_id ? String(args.tab_id) : "");
    if (resolved.error) return resolved;
    const { tab } = resolved;
    if (name === "browser_navigate") return navigate(user, tab.tabId, args);
    if (name === "browser_snapshot") {
        const offset = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0;
        const snap = await readSnapshot(user, tab.tabId, offset, PAGE_SNAPSHOT_CHARS);
        return snap.error ? snap : withChallengeHint({ ok: true, tab_id: tab.tabId, title: tab.title, ...snap });
    }
    if (name === "browser_click") return click(user, resolved, args);
    if (name === "browser_type") return type(user, tab.tabId, args);
    if (name === "browser_press") return press(user, tab.tabId, args);
    if (name === "browser_scroll") return scroll(user, tab.tabId, args);
    if (name === "browser_screenshot") return screenshot(user, tab);
    if (name === "browser_wait") return wait(user, tab.tabId, args);
    if (name === "browser_eval") return evaluateExpression(user, tab.tabId, args);
    return { error: `Unknown tool: ${name}` };
}
