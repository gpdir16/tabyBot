// 봇별 브라우저 창 열기·복원·정리.
import fs from "node:fs";
import path from "node:path";
import * as display from "../../computer/display.js";
import { killSession } from "../../computer/pty.js";
import { isDockerRuntime } from "../../runtime.js";
import { USER_DIR } from "../../paths.js";
import { getAgent, getAgentByUuid } from "../../agents-store.js";
import { camofoxUser, camofoxEnv } from "../../computer/camofox-user.js";
import {
    DEFAULT_URL,
    blog,
    camofoxApi,
    camofoxProfilesDir,
    camofoxServerUp,
    camofoxUserTabs,
    ensureProfilePrefs,
    hasCamofox,
    hasStoredSession,
    normalizeUrl,
    readTabSnapshot,
    runFile,
    tabSnapshotFile,
} from "./camofox.js";

// 세션 안에서 현재 탭 이동을 먼저 시도하고, 탭이 없으면 새로 연다.
// CLI의 navigate는 로컬 active-tab 상태 파일에 의존해 stale id를 쏠 수 있다.
// 여기서는 HTTP API로 실제 탭 목록을 보고 마지막 탭을 이동시킨다.
export async function openBrowser(agentId, url) {
    if (!isDockerRuntime()) return { error: "docker_only" };
    if (!(await hasCamofox())) return { error: "camofox_missing" };
    const r = await display.ensureSession();
    if (r.error) return r;
    const sess = r.sess;
    process.env.DISPLAY = `:${sess.display}`;
    const env = camofoxEnv({ ...process.env, DISPLAY: `:${sess.display}`, HOME: USER_DIR });
    const user = camofoxUser(getAgent(agentId) || getAgentByUuid(agentId));
    ensureProfilePrefs(user); // 창이 새로 뜨기 전에 세션 복원 pref를 심는다
    const target = normalizeUrl(url);
    if (target && /^-/.test(target)) return { error: "bad_url" };

    let out = null;
    const tabs = await camofoxUserTabs(user);
    if (tabs?.length) {
        // 탭이 이미 있는데 URL을 안 받으면 그대로 둔다. 빈 URL로 기본 페이지를
        // 덮어쓰면 에이전트가 보고 있던 탭이 "교체된" 것처럼 보인다.
        if (!target) return { ok: true, user, display: sess.display, output: tabs[tabs.length - 1].url || "" };
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
            body: JSON.stringify({ userId: user, sessionKey: "default", url: target || DEFAULT_URL }),
            timeoutMs: 45_000,
        }).catch(() => null);
        out = { ok: !!created?.ok, stdout: JSON.stringify(created?.json || {}), stderr: created?.ok ? "" : `status ${created?.status}` };
    }
    blog("openBrowser", { user, target, ok: out.ok, hadTabs: tabs?.length ?? null });
    if (!out.ok) {
        // API 경로가 실패하면 CLI로 한 번 더 시도한다. 서버가 아예 안 떠 있을 때 CLI가 기동한다.
        out = await runFile("camofox", ["open", target || DEFAULT_URL, "--user", user, "--format", "json"], env);
    }
    return {
        ok: out.ok,
        user,
        display: sess.display,
        output: (out.stdout || out.stderr || "").slice(0, 4000),
    };
}

// 공유 디스플레이에 실제로 보이는 창이 있는지. camofox의 세션 장부가 아니라
// X 화면 그 자체를 본다. 다른 디스플레이에 묶인 브라우저는 여기서 안 잡힌다.
// true=창 있음, false=없음(커서만), null=판별 불가(명령 실패).
async function windowVisible(displayNum) {
    const r = await runFile(
        "xdotool",
        ["search", "--onlyvisible", "--name", ".", "getwindowname", "%@"],
        { ...process.env, DISPLAY: `:${displayNum}` },
        8_000,
    );
    if (!r.ok && !r.stdout.trim()) return null;
    return r.stdout.split("\n").some((l) => l.trim());
}

// 화면을 열 때 빈 데스크톱이 보이지 않게 브라우저 창을 띄운다.
// 단, 화면에 이미 창이 떠 있으면(이 봇이든 다른 봇이든) 건드리지 않는다.
// 사용자는 지금 보이는 에이전트 세션을 보러 온 것이고, 새 창을 띄우면
// 그 세션을 덮어 "교체된" 것처럼 보인다.
const browserInflight = new Set();

export async function ensureBrowserWindow(agentId) {
    const agent = agentId && (getAgent(agentId) || getAgentByUuid(agentId));
    if (!agent || !(await hasCamofox())) return;
    const user = camofoxUser(agent);
    if (browserInflight.has(user)) return;
    browserInflight.add(user);
    try {
        const sess = display.loadSession();
        if (!sess) return;
        if ((await windowVisible(sess.display)) === true) return;
        // 판정은 전부 직접 HTTP로 한다. camofox health CLI 출력은 파싱 실패 여지가 있다.
        let health = await camofoxServerUp();
        // 일시 타임아웃을 서버 다운으로 오인해 재기동하면 살아있는 세션이 날아간다.
        // 한 번 더 확인한다.
        if (!health) health = await camofoxServerUp();
        if (!health) {
            // 서버가 죽어 있으면 먼저 띄운다. 이 경로로 뜬 서버는 7일 타임아웃 env를 물려받는다.
            const env = camofoxEnv({ ...process.env, HOME: USER_DIR, DISPLAY: `:${sess.display}` });
            const started = await runFile("camofox", ["server", "start", "--background"], env, 20_000);
            blog("camofox server start", { user, ok: started.ok, err: (started.stderr || "").slice(0, 200) });
            health = await camofoxServerUp();
        }
        // 세션은 살아있는데 화면에 창이 없다. 창만 닫혔거나 세션이 다른
        // 디스플레이에 묶인 경우다. 같은 컨텍스트에 탭을 하나 열어 창을 되살린다.
        if ((health?.activeUserIds || []).includes(user) || (await camofoxUserTabs(user))?.length) {
            const made = await camofoxApi("/tabs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ userId: user, sessionKey: "default" }),
                timeoutMs: 30_000,
            }).catch(() => null);
            blog("ensureBrowserWindow: reopen window", { user, ok: !!made?.ok });
            return;
        }
        blog("ensureBrowserWindow: launch", { user, serverUp: !!health, stored: hasStoredSession(user), snap: readTabSnapshot(user).length });
        ensureProfilePrefs(user);
        // 이전 세션/스냅샷이 있으면 빈 탭 트리거로 브라우저만 띄워 복원한다.
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
    } catch {
        // 세션이 이미 없으면 지울 것이 없다
    }
    for (const dir of [path.join(camofoxProfilesDir(), user), path.join(USER_DIR, "camofox", "cookies", user)]) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // 이미 닫혔거나 정리된 대상이면 무시한다
        }
    }
    try {
        fs.rmSync(tabSnapshotFile(user), { force: true });
    } catch {
        // 이미 닫혔거나 정리된 대상이면 무시한다
    }
    blog("purgeAgentComputer", { user });
}
