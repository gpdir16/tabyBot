// 브라우저 탭의 화면 좌표를 진짜 마우스로 누른다. browser_click이 좌표나 target을 받았을 때 쓴다.
// ref와 CSS 선택자 클릭은 접근성 트리와 DOM으로만 누르므로 다른 도메인 iframe(Cloudflare Turnstile, reCAPTCHA,
// 결제와 로그인 위젯), 닫힌 shadow root, 캔버스 안에는 닿지 않는다. 브라우저 창은 공유 Xvfb 화면에 떠 있으므로
// 그 탭을 앞으로 가져와 창을 맨 앞으로 올리고 xdotool로 OS 수준 클릭을 보내면, 브라우저가 포인터 아래 요소
// (iframe 안이어도)에 진짜 클릭(isTrusted)을 넘긴다.
import * as display from "../computer/display.js";
import { evaluate, locateTabWindow, tabScreenshot, xdo } from "../web/computer/windows.js";

// 보안 확인 화면을 보고도 봇이 browser_click을 떠올리지 못하고 주소나 API만 다시 부르며 헤매는 일이 있었다.
// 결과에 Cloudflare 확인 화면이 보이면 그 결과에 다음 할 일을 바로 붙인다.
const CHALLENGE_RE = /Performing security verification|Verify you are human|Just a moment\.\.\.|challenges\.cloudflare\.com/i;
const CHALLENGE_HINT =
    'This tab is showing a Cloudflare security check. Reopening the URL or calling the API again will not get past it. Click the checkbox now by calling the `browser_click` tool with `target: "turnstile"` (no coordinates needed), then check the returned title and screenshot.';

export function withChallengeHint(result) {
    if (!result || typeof result !== "object" || !CHALLENGE_RE.test(JSON.stringify(result))) return result;
    return { ...result, hint: CHALLENGE_HINT };
}

// 터미널에서 직접 부른 camofox 명령의 결과에도 같은 안내를 붙인다
export function withTerminalChallengeHint(args, result) {
    const command = String(args?.command || result?.cmd || "");
    return /\bcamofox\b/.test(command) ? withChallengeHint(result) : result;
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
// 누른 뒤 결과 스크린샷까지 기다리는 시간. Turnstile은 누르고 1초쯤 지나야 통과 표시가 뜬다.
const SETTLE_MS = 1500;

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

// 창을 올리고 포인터를 옮기는 사이에 다른 턴이 끼어들면 엉뚱한 창을 누르므로 한 번에 하나씩 한다.
let queue = Promise.resolve();

// tabs: 누를 후보 탭(먼저 볼 것부터). 좌표 클릭은 첫 탭을 누르고, turnstile은 확인 화면이 떠 있는 탭을 찾아 누른다.
export function clickAtPoint(user, tabs, args) {
    const run = queue.then(() => clickOnce(user, tabs, args || {}));
    queue = run.catch(() => {
        // 실패한 클릭이 다음 클릭을 막지 않게 한다
    });
    return run;
}

async function findTurnstile(user, tabs) {
    for (const tab of tabs) {
        const widget = await evaluate(user, tab.tabId, LOCATE_TURNSTILE).catch(() => null);
        if (widget) return { tab, widget };
    }
    return null;
}

async function clickOnce(user, tabs, args) {
    const target = args.target === "turnstile" ? "turnstile" : "";
    let x = Number(args.x);
    let y = Number(args.y);
    if (!target && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
        return { error: 'Pass ref, selector, numeric x and y (>= 0), or target: "turnstile".' };
    }
    const sess = display.loadSession();
    if (!sess) return { error: "The shared display is not running." };

    let tab = tabs[0];
    let widget = null;
    if (target) {
        const found = await findTurnstile(user, tabs);
        if (!found) {
            return {
                error: "No Cloudflare checkbox is visible on any open tab. If the page already passed, continue with it. Otherwise take browser_screenshot and pass x and y.",
                tabs: tabs.map((t) => ({ tab_id: t.tabId, url: t.url })),
            };
        }
        ({ tab, widget } = found);
    }
    const win = await locateTabWindow(user, tab.tabId, sess.display);
    if (win.error) return win;
    if (widget) {
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

    await display.sleep(SETTLE_MS);
    if (origin) await xdo(sess.display, ["windowmove", win.windowId, String(origin.x), String(origin.y)]);
    const result = { ok, tab_id: tab.tabId, x, y };
    if (target) result.target = target;
    // 누른 뒤 확인 화면을 넘겼는지 제목으로 바로 알 수 있게 한다
    const title = await evaluate(user, tab.tabId, "document.title").catch(() => null);
    if (typeof title === "string") result.title = title;
    const shot = await tabScreenshot(user, tab.tabId);
    if (shot) {
        result.__image = shot;
        result.screenshot_path = shot;
    }
    return result;
}
