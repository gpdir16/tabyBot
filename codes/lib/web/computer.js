// 봇의 "컴퓨터" 뷰 백엔드: 공유 X 디스플레이 스트림 + 봇별 PTY 터미널 + 브라우저 실행.
// 화면은 JPEG 프레임을 WebSocket으로 밀고, 입력은 xdotool로 되돌린다.
// 터미널은 봇 id별 상주 PTY 셸에 다중 접속을 지원한다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createWsServer } from "./ws.js";
import * as display from "../computer/display.js";
import { attachTerminal, killSession, killAllSessions, terminalEnabled } from "../computer/pty.js";
import { isDockerRuntime } from "../runtime.js";
import { USER_DIR } from "../paths.js";
import { getAgent, getAgentByUuid } from "../agents-store.js";
import { camofoxUser, camofoxEnv } from "../computer/camofox-user.js";

const FRAME_TARGET_MS = 90; // 캡처 시간 포함 목표 주기 — 느려도 최소 간격으로 자연 감속
const FRAME_MIN_GAP_MS = 30;
const MAX_INPUT_MSG_BYTES = 64 * 1024;

let wsServer = null;
let camofoxBin = undefined; // "yes" | null | undefined(미확인)

function statusPayload() {
    const sess = display.loadSession();
    const dims = display.geometryDims(sess?.geometry);
    return {
        docker: isDockerRuntime(),
        screen: sess ? { active: true, display: sess.display, width: dims.w, height: dims.h, apps: (sess.apps || []).length } : { active: false },
        terminal: terminalEnabled(),
    };
}

function runFile(file, args, env, timeoutMs = 45_000) {
    return new Promise((resolve) => {
        execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err && typeof err.code === "number" ? err.code : err ? -1 : 0,
                stdout: (stdout || "").toString(),
                stderr: (stderr || "").toString(),
            });
        });
    });
}

async function hasCamofox() {
    if (camofoxBin === undefined) {
        const r = await display.run("command -v camofox", { timeout: 5_000 });
        camofoxBin = r.ok && r.stdout.trim() ? true : null;
    }
    return camofoxBin === true;
}

function normalizeUrl(url) {
    const u = String(url || "").trim();
    if (!u) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u;
    return `https://${u}`;
}

// camofox는 http(s)만 허용한다 — 빈 창(about:blank)은 차단되므로 기본 페이지를 둔다.
const DEFAULT_URL = "https://start.duckduckgo.com/";

function camofoxBase() {
    return `http://${process.env.CAMOFOX_HOST || "127.0.0.1"}:${process.env.CAMOFOX_PORT || "9377"}`;
}

function camofoxProfilesDir() {
    return process.env.CAMOFOX_PROFILES_DIR || path.join(USER_DIR, "camofox", "profiles");
}

// Firefox 세션 복원을 켠다 — 브라우저가 재시작돼도 이전 탭/창을 그대로 되살린다.
// user.js는 실행 때마다 prefs.js에 병합되므로 프로필 생성 전에 미리 써둬도 된다.
function ensureProfilePrefs(user) {
    try {
        const dir = path.join(camofoxProfilesDir(), user);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "user.js");
        const body = ['user_pref("browser.startup.page", 3);', 'user_pref("browser.sessionstore.resume_from_crash", true);', ""].join("\n");
        if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) fs.writeFileSync(file, body);
    } catch {}
}

// 이전 실행에서 남긴 세션 저장 파일이 있는가 — 있으면 재기동 시 탭이 복원된다.
function hasStoredSession(user) {
    const dir = path.join(camofoxProfilesDir(), user);
    return (
        fs.existsSync(path.join(dir, "sessionstore.jsonlz4")) ||
        fs.existsSync(path.join(dir, "sessionstore-backups", "recovery.jsonlz4")) ||
        fs.existsSync(path.join(dir, "sessionstore-backups", "previous.jsonlz4"))
    );
}

/* ── 탭 스냅샷: 정상 종료 시엔 Firefox가 세션 복원을 건너뛰므로
   마지막으로 열려 있던 URL을 직접 저장해 재기동 때 다시 연다 ── */
function tabSnapshotFile(user) {
    return path.join(USER_DIR, "camofox", "last-tabs", `${user}.json`);
}

function readTabSnapshot(user) {
    try {
        const urls = JSON.parse(fs.readFileSync(tabSnapshotFile(user), "utf8"));
        return Array.isArray(urls) ? urls.filter((u) => /^https?:\/\//.test(u)) : [];
    } catch {
        return [];
    }
}

function writeTabSnapshot(user, urls) {
    try {
        const file = tabSnapshotFile(user);
        const body = JSON.stringify(urls);
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    } catch {}
}

async function camofoxApi(apiPath, opts = {}) {
    const res = await fetch(`${camofoxBase()}${apiPath}`, {
        ...opts,
        signal: AbortSignal.timeout(opts.timeoutMs || 15_000),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

// 브라우저 결정 경로는 전부 로그를 남긴다 — 세션이 언제/왜 재생성됐는지 추적용.
function blog(msg, extra) {
    console.log(`[computer] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}

// 서버/세션 상태를 직접 HTTP로 판정한다 — CLI 출력 파싱은 경고 문구·타임아웃에 취약하다.
async function camofoxServerUp() {
    const h = await camofoxApi("/health", { timeoutMs: 4_000 }).catch(() => null);
    return h?.ok ? h.json || null : null;
}

async function camofoxUserTabs(user) {
    const t = await camofoxApi(`/tabs?userId=${encodeURIComponent(user)}`, { timeoutMs: 6_000 }).catch(() => null);
    return t?.ok && Array.isArray(t.json?.tabs) ? t.json.tabs : null;
}

// 브라우저가 살아있는 동안 유저별 열린 탭 URL을 주기적으로 저장한다.
async function snapshotAllTabs() {
    try {
        const h = await camofoxApi("/health", { timeoutMs: 5_000 });
        const users = h.json?.activeUserIds;
        if (!Array.isArray(users)) return;
        for (const user of users) {
            const t = await camofoxApi(`/tabs?userId=${encodeURIComponent(user)}`, { timeoutMs: 5_000 });
            const urls = (t.json?.tabs || []).map((x) => x.url).filter((u) => /^https?:\/\//.test(u));
            if (urls.length) writeTabSnapshot(user, urls);
        }
    } catch {}
}

let tabSnapTimer = null;
function startTabSnapshotter() {
    if (tabSnapTimer) return;
    tabSnapTimer = setInterval(() => void snapshotAllTabs(), 15_000);
    tabSnapTimer.unref?.();
    void snapshotAllTabs();
}

// 세션 안에서 현재 탭 이동을 먼저 시도하고, 탭이 없으면 새로 연다.
// CLI의 navigate는 로컬 active-tab 상태 파일에 의존해 stale id를 쏠 수 있다 —
// 여기서는 HTTP API로 실제 탭 목록을 보고 마지막 탭을 이동시킨다.
async function openBrowser(agentId, url) {
    if (!isDockerRuntime()) return { error: "docker_only" };
    if (!(await hasCamofox())) return { error: "camofox_missing" };
    const r = await display.ensureSession();
    if (r.error) return r;
    const sess = r.sess;
    process.env.DISPLAY = `:${sess.display}`;
    const env = camofoxEnv({ ...process.env, DISPLAY: `:${sess.display}`, HOME: USER_DIR });
    const user = camofoxUser(getAgent(agentId) || getAgentByUuid(agentId));
    ensureProfilePrefs(user); // 창이 새로 뜨기 전에 세션 복원 pref를 심는다
    const target = normalizeUrl(url) || DEFAULT_URL;
    if (/^-/.test(target)) return { error: "bad_url" };

    let out = null;
    const tabs = await camofoxUserTabs(user);
    if (tabs?.length) {
        const last = tabs[tabs.length - 1];
        const nav = await camofoxApi(`/tabs/${encodeURIComponent(last.tabId || last.targetId)}/navigate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: user, url: target }),
            timeoutMs: 30_000,
        }).catch(() => null);
        if (nav?.ok) out = { ok: true, stdout: JSON.stringify(nav.json || {}) };
    }
    if (!out) {
        const created = await camofoxApi("/tabs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: user, sessionKey: "default", url: target }),
            timeoutMs: 45_000,
        }).catch(() => null);
        out = { ok: !!created?.ok, stdout: JSON.stringify(created?.json || {}), stderr: created?.ok ? "" : `status ${created?.status}` };
    }
    blog("openBrowser", { user, target, ok: out.ok, hadTabs: tabs?.length ?? null });
    if (!out.ok) {
        // API 경로가 실패하면 CLI로 한 번 더 — 서버가 아예 안 떠 있을 때 CLI가 기동한다.
        out = await runFile("camofox", ["open", target, "--user", user, "--format", "json"], env);
    }
    return {
        ok: out.ok,
        user,
        display: sess.display,
        output: (out.stdout || out.stderr || "").slice(0, 4000),
    };
}

// 화면을 열 때 봇의 브라우저 창이 없으면 띄워 빈 데스크톱이 보이지 않게 한다.
// activeUserIds 기준 — 창은 이미 떠 있는데 탭만 닫힌 경우도 이 목록에 남는다.
const browserInflight = new Set();
async function ensureBrowserWindow(agentId) {
    const agent = agentId && (getAgent(agentId) || getAgentByUuid(agentId));
    if (!agent || !(await hasCamofox())) return;
    const user = camofoxUser(agent);
    if (browserInflight.has(user)) return;
    browserInflight.add(user);
    try {
        const sess = display.loadSession();
        if (!sess) return;
        // 판정은 전부 직접 HTTP로 — camofox health CLI 출력은 파싱 실패 여지가 있다.
        let health = await camofoxServerUp();
        if (health && Array.isArray(health.activeUserIds) && health.activeUserIds.includes(user)) return;
        if (!health) {
            // 서버가 죽어 있으면 먼저 띄운다 — 이 경로로 뜬 서버는 7일 타임아웃 env를 물려받는다.
            const env = camofoxEnv({ ...process.env, HOME: USER_DIR, DISPLAY: `:${sess.display}` });
            const started = await runFile("camofox", ["server", "start", "--background"], env, 20_000);
            blog("camofox server start", { user, ok: started.ok, err: (started.stderr || "").slice(0, 200) });
            health = await camofoxServerUp();
        }
        if (health && Array.isArray(health.activeUserIds) && health.activeUserIds.includes(user)) return;
        // 서버는 떴는데 active 목록이 비면 탭으로 교차확인 — 이미 탭이 있으면 살아있는 것.
        const tabs = await camofoxUserTabs(user);
        if (tabs?.length) return;
        blog("ensureBrowserWindow: launch", { user, serverUp: !!health, stored: hasStoredSession(user), snap: readTabSnapshot(user).length });
        ensureProfilePrefs(user);
        // 이전 세션/스냅샷이 있으면 빈 탭 트리거로 브라우저만 띄워 복원한다 —
        // 새로 만든 빈 탭은 안에서 바로 닫는다.
        if ((hasStoredSession(user) || readTabSnapshot(user).length) && (await restoreBrowserSession(user))) return;
        await openBrowser(agent.id, "");
    } finally {
        browserInflight.delete(user);
    }
}

// URL 없는 탭 생성으로 브라우저만 띄운다. 크래시 후면 Firefox가 이전 탭을 복원하고,
// 정상 종료로 복원이 비어 있으면 저장해 둔 스냅샷 URL을 다시 연다.
// 마지막에 트리거용 빈 탭은 닫아 복원된 탭만 남긴다.
async function restoreBrowserSession(user) {
    try {
        const created = await camofoxApi("/tabs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: user, sessionKey: "default" }),
            timeoutMs: 30_000,
        });
        if (!created.ok || !created.json?.tabId) {
            blog("restore: trigger tab failed", { user, status: created.status });
            return false;
        }
        const triggerId = created.json.tabId;
        await new Promise((res) => setTimeout(res, 1200)); // 복원 탭이 인덱스에 잡힐 때까지
        const cur = await camofoxApi(`/tabs?userId=${encodeURIComponent(user)}`, { timeoutMs: 10_000 });
        const curUrls = new Set((cur.json?.tabs || []).map((t) => t.url));
        const reopened = [];
        for (const u of readTabSnapshot(user)) {
            if (!curUrls.has(u)) {
                await camofoxApi("/tabs", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ userId: user, sessionKey: "default", url: u }),
                    timeoutMs: 30_000,
                });
                curUrls.add(u);
                reopened.push(u);
            }
        }
        await camofoxApi(`/tabs/${triggerId}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: user }),
            timeoutMs: 10_000,
        });
        blog("restore: done", { user, tabs: curUrls.size, reopened: reopened.length });
        return true;
    } catch (e) {
        blog("restore: error", { user, err: String(e).slice(0, 200) });
        return false;
    }
}

// 봇이 삭제될 때 그 봇의 브라우저 세션·프로필·PTY를 정리한다.
// 세션 자체는 만료되지 않으므로 삭제가 유일한 해제 시점이다.
export async function purgeAgentComputer(agentId) {
    const user = camofoxUser(agentId);
    killSession(agentId);
    try {
        await camofoxApi(`/sessions/${encodeURIComponent(user)}`, { method: "DELETE", timeoutMs: 10_000 });
    } catch {}
    for (const dir of [path.join(camofoxProfilesDir(), user), path.join(USER_DIR, "camofox", "cookies", user)]) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    }
    try {
        fs.rmSync(tabSnapshotFile(user), { force: true });
    } catch {}
    blog("purgeAgentComputer", { user });
}

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
        } catch {}
    }
}

// 캡처 완료 시점부터 다시 재는 자기재스케줄 루프 — 고정 인터벌보다 응답이 빠르고
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

export function initComputerWs(token) {
    wsServer = createWsServer({ token });
    wsServer.add("/ws/computer/screen", (conn, req, url) => void handleScreenConn(conn, url));
    wsServer.add("/ws/computer/terminal", (conn, req, url) => handleTerminalConn(conn, url));
    return wsServer;
}

export function handleComputerUpgrade(req, socket, head) {
    wsServer.handleUpgrade(req, socket, head);
}

export function shutdownComputer() {
    killAllSessions();
}

export { killSession };
