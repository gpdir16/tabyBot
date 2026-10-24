// 공유 화면에 뜬 camofox 브라우저 창. 프로필(camofox 유저)마다, 탭마다 창이 따로 뜨고 창 관리자가 없어
// 모두 (0,0)에 겹친다. 탭과 X 창을 찾아 잇고 맨 앞으로 올리는 일을 browser_click과 컴퓨터 화면이 같이 쓴다.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as display from "../../computer/display.js";
import { camofoxApi, camofoxUserTabs } from "./camofox.js";

export function xdo(displayNum, args, { stdout = false } = {}) {
    return new Promise((resolve) => {
        execFile("xdotool", args, { env: { ...process.env, DISPLAY: `:${displayNum}` }, timeout: 10_000 }, (err, out, stderr) => {
            resolve({ ok: !err, stdout: stdout ? String(out || "") : "", stderr: String(stderr || "") });
        });
    });
}

export async function evaluate(user, tabId, expression) {
    const r = await camofoxApi(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user, expression }),
        timeoutMs: 10_000,
    });
    if (!r.ok || r.json?.ok === false) throw new Error(r.json?.error || `evaluate failed (status ${r.status})`);
    return r.json?.result;
}

// 열린 탭 전부. 봇이 `camofox --user <이름>`으로 따로 연 프로필의 탭도 같은 화면에 떠 있으므로 함께 본다.
// camofox 서버가 응답하지 않으면 null.
export async function listOpenTabs(ownUser = "") {
    const health = await camofoxApi("/health", { timeoutMs: 5_000 }).catch(() => null);
    const users = new Set([ownUser, ...(Array.isArray(health?.json?.activeUserIds) ? health.json.activeUserIds : [])].filter(Boolean));
    let reachable = Boolean(health?.ok);
    const tabs = [];
    for (const user of users) {
        const list = await camofoxUserTabs(user);
        if (!list) continue;
        reachable = true;
        for (const t of list) {
            const tabId = t.tabId || t.targetId;
            if (tabId) tabs.push({ user, tabId, url: t.url || "", title: t.title || "" });
        }
    }
    return reachable ? tabs : null;
}

// 탭과 X 창을 잇는 고리가 없어 제목에 잠깐 표식을 달아 창을 찾고, 그사이 화면 위 뷰포트 위치를 함께 읽는다.
export async function locateTabWindow(user, tabId, displayNum) {
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

// 탭의 창을 맨 앞으로 올리고 키보드 입력도 그 창으로 가게 한다.
export async function raiseTabWindow(user, tabId) {
    const sess = display.loadSession();
    if (!sess) return { error: "screen_off" };
    const win = await locateTabWindow(user, tabId, sess.display).catch(() => null);
    if (!win?.windowId) return { error: "window_not_found" };
    await xdo(sess.display, ["windowraise", win.windowId]);
    await xdo(sess.display, ["windowfocus", win.windowId]);
    return { ok: true };
}
