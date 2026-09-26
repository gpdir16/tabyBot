/* tabyBot 웹 클라이언트 — 봇 컴퓨터 뷰(/c/<uuid>).
   공유 X 디스플레이(브라우저·GUI 앱) JPEG 스트림 + 봇별 PTY 터미널.
   화면 스트림은 /ws/computer/screen, 터미널은 /ws/computer/terminal?agent=<id>.
   화면은 봇이 아닌 컨테이너 공용 데스크톱이지만 터미널·브라우저 프로필은 봇별로 갈린다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, p) => T.i18n.t(k, p);

    let page; // #computerPage
    let built = false;
    let openUuid = null;
    let openBot = null;
    let pushed = false;
    let activeTab = "screen";

    // 화면 스트림 상태
    let screenWs = null;
    let screenDims = { w: 1280, h: 800 };
    let canvas, ctx2d;
    let screenMsg;
    let framePending = null;
    let frameRaf = 0;
    let statusChecked = false;

    // 화면 조작 모드: "trackpad"(맥북 트랙패드식 상대 커서) | "direct"(직접 터치)
    let touchMode = "trackpad";
    try {
        touchMode = localStorage.getItem("cp.touchMode") === "direct" ? "direct" : "trackpad";
    } catch {}
    const cursor = { x: 640, y: 400 }; // 원격 좌표의 가상 커서
    const zoom = { s: 1, tx: 0, ty: 0 }; // 캔버스 로컬 확대(원격 전송 아님)

    // 터미널 상태(xterm.js)
    let termWs = null;
    let term = null;
    let termFit = null;
    let termRo = null;
    let termMsg;
    let screenRetry = 0;
    let termRetry = 0;
    let focusTermOnReady = false;
    // 터미널 특수키 바의 스티키 수정자(다음 키 1회에 적용)
    let stickyCtrl = false;
    let stickyAlt = false;

    // 키보드 → xdotool. 인쇄 가능 문자는 type, 특수키는 key(+수정자).
    const KEYMAP = {
        Enter: "Return",
        Backspace: "BackSpace",
        Tab: "Tab",
        Escape: "Escape",
        Delete: "Delete",
        Insert: "Insert",
        Home: "Home",
        End: "End",
        PageUp: "Page_Up",
        PageDown: "Page_Down",
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        " ": "space",
    };
    for (let i = 1; i <= 12; i++) KEYMAP["F" + i] = "F" + i;

    /* ── 라우트 ───────────────────────────────────────────── */
    function routeFromPath() {
        const m = /^\/c\/([0-9a-f-]{36})$/.exec(location.pathname || "");
        return m ? { uuid: m[1] } : null;
    }
    function pathFor(uuid) {
        return `/c/${uuid}`;
    }
    function isOpen() {
        return !!page && !page.hidden;
    }

    // 봇 헤더 클릭 → 이 경로로. 설정 open()과 같은 push 패턴.
    function navigate(uuid) {
        if (!uuid) return;
        open({ uuid });
    }

    /* ── DOM 빌드 ─────────────────────────────────────────── */
    let els = {};
    function build() {
        if (built) return;
        built = true;
        page.replaceChildren();

        const backBtn = T.h(
            "button",
            {
                class: "btn-icon cp-back",
                "data-tip": t("back"),
                "aria-label": t("back"),
                onclick: () => close(),
            },
            [T.icon("arrow-left")],
        );
        const status = T.h("span", { class: "cp-status" });
        const tabScreen = T.h("button", {
            class: "cp-tab",
            role: "tab",
            text: "Firefox",
            onclick: () => setTab("screen"),
        });
        const tabTerm = T.h("button", {
            class: "cp-tab",
            role: "tab",
            text: "Terminal",
            onclick: () => setTab("terminal"),
        });
        const tabs = T.h("div", { class: "cp-tabs", role: "tablist" }, [tabScreen, tabTerm]);

        /* 화면 탭 — 화면 안에 브라우저 주소창이 있으므로 별도 URL 바는 두지 않는다 */
        // 모바일용: 공유 화면에 키를 보낼 가상 키보드 입력기. canvas는 tabindex라
        // 가상키보드가 안 뜨므로 숨은 textarea를 대신 포커스한다.
        const kbdInput = T.h("textarea", {
            class: "cp-kbd",
            "aria-label": t("computerKeyboard"),
            autocomplete: "off",
            autocorrect: "off",
            autocapitalize: "off",
            spellcheck: "false",
            enterkeyhint: "send",
        });
        const kbdBtn = T.h(
            "button",
            {
                class: "btn-icon cp-tool cp-kbdbtn",
                "data-tip": t("computerKeyboard"),
                "aria-label": t("computerKeyboard"),
                // 버튼으로 포커스가 옮겨가면 mousedown 단계에서 kbdInput blur가 먼저
                // 발생해 data-on이 리셋되고 이어지는 click이 다시 켠다(토글 불가).
                onpointerdown: (e) => e.preventDefault(),
                onmousedown: (e) => e.preventDefault(),
                onclick: () => {
                    if (kbdInput.dataset.on === "1") {
                        kbdInput.dataset.on = "";
                        kbdInput.blur();
                    } else {
                        kbdInput.dataset.on = "1";
                        kbdInput.focus({ preventScroll: true });
                    }
                    kbdBtn.classList.toggle("active", kbdInput.dataset.on === "1");
                },
            },
            [T.icon("keyboard")],
        );
        // 조작 모드 전환: 트랙패드(상대 커서) ↔ 직접 터치
        const modeBtn = T.h(
            "button",
            {
                class: "btn-icon cp-tool cp-modebtn",
                onpointerdown: (e) => e.preventDefault(),
                onmousedown: (e) => e.preventDefault(),
                onclick: () => setTouchMode(touchMode === "trackpad" ? "direct" : "trackpad"),
            },
            [T.icon("cursor")],
        );
        const tools = T.h("div", { class: "cp-tools" }, [modeBtn, kbdBtn]);

        canvas = T.h("canvas", { class: "cp-canvas", tabindex: "0", role: "application", "aria-label": t("computerScreen") });
        const startBtn = T.h("button", { class: "btn cp-start", text: t("computerStartScreen"), onclick: () => startScreen() });
        screenMsg = T.h("div", { class: "cp-msg hidden" }, [startBtn]);
        const cursorEl = T.h("div", { class: "cp-cursor" }, [T.icon("cursor")]);
        const screenStage = T.h("div", { class: "cp-stage" }, [canvas, screenMsg, kbdInput, cursorEl, tools]);
        const screenPane = T.h("div", { class: "cp-pane cp-screen" }, [screenStage]);

        /* 터미널 탭 */
        const restartBtn = T.h("button", { class: "btn-icon cp-tool", title: t("computerRestart"), onclick: () => restartTerminal() }, [
            T.icon("refresh"),
        ]);
        termMsg = T.h("div", { class: "cp-msg hidden" });
        const termHost = T.h("div", { class: "cp-termhost" });
        const termKeys = buildTermKeys();
        const termPane = T.h("div", { class: "cp-pane cp-terminal" }, [
            T.h("div", { class: "cp-stage" }, [termHost, termMsg, T.h("div", { class: "cp-tools" }, [restartBtn])]),
            T.h("div", { class: "cp-termkeyswrap" }, [termKeys]),
        ]);

        /* 헤더는 채팅과 같은 #header 요소를 쓴다 — open()에서 backBtn/status/tabs를 주입한다 */
        page.append(screenPane, termPane);
        els = {
            backBtn,
            status,
            tabs,
            tabScreen,
            tabTerm,
            screenPane,
            termPane,
            termHost,
            startBtn,
            kbdInput,
            kbdBtn,
            modeBtn,
            cursor: cursorEl,
            screenStage,
            termKeys,
        };

        // 숨은 키보드 입력기: input=인쇄 문자(IME 포함), keydown=특수키.
        kbdInput.addEventListener("input", () => {
            const v = kbdInput.value;
            kbdInput.value = "";
            if (v) sendScreen({ type: "type", text: v });
        });
        kbdInput.addEventListener("keydown", (e) => {
            const sym = KEYMAP[e.key];
            if (sym) {
                sendScreen({ type: "key", key: sym, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
                e.preventDefault();
            } else if (e.key === "Unidentified" || e.key === "Process") {
                return; // IME 합성 중 — input 이벤트가 처리한다
            }
        });
        kbdInput.addEventListener("blur", () => {
            if (kbdInput.dataset.on === "1") {
                kbdInput.dataset.on = "";
                kbdBtn.classList.remove("active");
            }
        });

        bindScreenInput(canvas);
        setTouchMode(touchMode); // 아이콘·커서 표시 초기화
    }

    function setTouchMode(m) {
        touchMode = m === "direct" ? "direct" : "trackpad";
        try {
            localStorage.setItem("cp.touchMode", touchMode);
        } catch {}
        els.screenPane.classList.toggle("tp", touchMode === "trackpad");
        els.modeBtn.replaceChildren(T.icon(touchMode === "trackpad" ? "cursor" : "touch"));
        els.modeBtn.dataset.tip = t(touchMode === "trackpad" ? "computerModeTouch" : "computerModeTrackpad");
        els.modeBtn.setAttribute("aria-label", els.modeBtn.dataset.tip);
        renderCursor();
    }

    /* ── 로컬 핀치줌(원격 전송 아님) + 가상 커서 ──────────── */
    function applyZoom(s2, px, py) {
        // (px,py): 스테이지 기준 좌표의 고정점 — 그 지점 아래 원격 픽셀이 움직이지 않게
        const w = canvas.clientWidth || 1;
        const h = canvas.clientHeight || 1;
        const lx = (px - zoom.tx) / zoom.s;
        const ly = (py - zoom.ty) / zoom.s;
        zoom.s = s2;
        zoom.tx = px - lx * s2;
        zoom.ty = py - ly * s2;
        // 확대된 캔버스가 스테이지를 항상 덮도록 팬을 제한한다
        const sw = els.screenStage.clientWidth || w;
        const sh = els.screenStage.clientHeight || h;
        zoom.tx = Math.min(0, Math.max(sw - w * s2, zoom.tx));
        zoom.ty = Math.min(0, Math.max(sh - h * s2, zoom.ty));
        canvas.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${s2})`;
        renderCursor();
    }
    function resetZoom() {
        zoom.s = 1;
        zoom.tx = 0;
        zoom.ty = 0;
        canvas.style.transform = "";
        renderCursor();
    }
    function renderCursor() {
        if (!els.cursor) return;
        const cr = canvas.getBoundingClientRect();
        const sr = els.screenStage.getBoundingClientRect();
        const s = Math.min(cr.width / screenDims.w, cr.height / screenDims.h) || 1;
        // 캔버스는 contain 레터박스 — 실제 영상 영역의 오프셋을 더한다
        const x = cr.left - sr.left + (cr.width - screenDims.w * s) / 2 + cursor.x * s;
        const y = cr.top - sr.top + (cr.height - screenDims.h * s) / 2 + cursor.y * s;
        els.cursor.style.transform = `translate(${Math.round(x - 1)}px, ${Math.round(y - 1)}px)`;
    }

    function setTab(tab) {
        activeTab = tab;
        els.tabScreen.classList.toggle("active", tab === "screen");
        els.tabTerm.classList.toggle("active", tab === "terminal");
        els.tabScreen.setAttribute("aria-selected", tab === "screen" ? "true" : "false");
        els.tabTerm.setAttribute("aria-selected", tab === "terminal" ? "true" : "false");
        els.screenPane.classList.toggle("hidden", tab !== "screen");
        els.termPane.classList.toggle("hidden", tab !== "terminal");
        if (!openBot && !openUuid) return;
        if (tab === "screen") connectScreen();
        else {
            focusTermOnReady = true;
            connectTerminal();
        }
    }

    function wsUrl(path, params) {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const q = new URLSearchParams(params || {});
        const tk = T.api.getToken();
        if (tk) q.set("token", tk);
        const qs = q.toString();
        return `${proto}//${location.host}${path}${qs ? "?" + qs : ""}`;
    }

    function setMsg(el, text) {
        // 첫 자식은 안내 텍스트 노드로 유지한다(뒤에 버튼이 붙어 있을 수 있음).
        if (!el.firstChild || el.firstChild.nodeType !== 3) el.prepend(document.createTextNode(""));
        el.firstChild.textContent = text;
        el.classList.toggle("hidden", !text);
    }
    function errorText(code) {
        if (code === "docker_only") return t("computerDockerOnly");
        if (code === "camofox_missing") return t("computerNoCamofox");
        if (code === "terminal_disabled") return t("computerTermDisabled");
        return t("computerError", { e: code || "" });
    }
    function showScreenMsg(text, showStart) {
        setMsg(screenMsg, text);
        els.startBtn.classList.toggle("hidden", !showStart);
    }
    function hideScreenMsg() {
        screenMsg.classList.add("hidden");
    }

    /* ── 화면 스트림 ──────────────────────────────────────── */
    function connectScreen() {
        if (screenWs && screenWs.readyState <= WebSocket.OPEN) return;
        showScreenMsg(t("computerConnecting"), false);
        const ws = new WebSocket(wsUrl("/ws/computer/screen", { agent: openBot ? openBot.id : openUuid }));
        ws.binaryType = "blob";
        let sawError = false;
        screenWs = ws;
        ws.onmessage = (ev) => {
            if (typeof ev.data === "string") {
                let msg;
                try {
                    msg = JSON.parse(ev.data);
                } catch {
                    return;
                }
                if (msg.type === "ready") {
                    screenDims = { w: msg.width || 1280, h: msg.height || 800 };
                    canvas.width = screenDims.w;
                    canvas.height = screenDims.h;
                    cursor.x = screenDims.w / 2;
                    cursor.y = screenDims.h / 2;
                    resetZoom();
                    hideScreenMsg();
                } else if (msg.type === "inactive") {
                    showScreenMsg(t("computerScreenOff"), true);
                } else if (msg.type === "error") {
                    sawError = true;
                    showScreenMsg(errorText(msg.error), msg.error !== "docker_only");
                }
                return;
            }
            // 바이너리 = JPEG 프레임. 디코딩 중에는 최신 프레임으로 교체만 한다.
            framePending = ev.data;
            if (!frameRaf) {
                frameRaf = requestAnimationFrame(async () => {
                    frameRaf = 0;
                    const b = framePending;
                    framePending = null;
                    if (!b) return;
                    try {
                        const bmp = await createImageBitmap(b);
                        ctx2d = ctx2d || canvas.getContext("2d");
                        ctx2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
                        bmp.close();
                    } catch {}
                });
            }
        };
        ws.onopen = () => {
            screenRetry = 0;
        };
        ws.onclose = () => {
            if (screenWs === ws) screenWs = null;
            if (!isOpen() || activeTab !== "screen" || sawError) return;
            // 페이지가 열린 동안 끊기면 자동 재접속(터널·네트워크 일시 단절 대응).
            const delay = Math.min(5000, 500 * 2 ** screenRetry++);
            showScreenMsg(t("computerDisconnected"), false);
            setTimeout(() => {
                if (isOpen() && activeTab === "screen" && !screenWs) connectScreen();
            }, delay);
        };
        ws.onerror = () => {};
    }

    function screenPoint(e) {
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / screenDims.w, rect.height / screenDims.h);
        const dw = screenDims.w * scale;
        const dh = screenDims.h * scale;
        const ox = (rect.width - dw) / 2;
        const oy = (rect.height - dh) / 2;
        const x = Math.round((e.clientX - rect.left - ox) / scale);
        const y = Math.round((e.clientY - rect.top - oy) / scale);
        if (x < 0 || y < 0 || x > screenDims.w || y > screenDims.h) return null;
        return { x, y };
    }
    function sendScreen(obj) {
        if (screenWs && screenWs.readyState === WebSocket.OPEN) screenWs.send(JSON.stringify(obj));
    }

    // 화면 제스처 엔진.
    //  - 마우스: 절대 좌표 그대로(기존 데스크톱 동작)
    //  - 터치·트랙패드 모드: 맥북 트랙패드식 — 한 손가락=커서, 탭=클릭, 탭 후 드래그=드래그,
    //    두 손가락 탭=우클릭, 두 손가락 이동=스크롤, 핀치=로컬 확대(원격 전송 아님)
    //  - 터치·직접 모드: 탭=그 지점 클릭, 드래그=스크롤, 길게 누르고 드래그=원격 드래그
    function bindScreenInput(el) {
        const ptrs = new Map(); // pointerId → {x,y}
        let down = null; // 단일 포인터 제스처 상태
        let pinch = null; // 두 손가락 제스처 상태
        let dragging = false; // 원격 마우스 버튼이 눌린 상태(드래그 중)
        let lpTimer = 0;
        let lastTap = { at: 0, x: -1e4, y: -1e4 };
        let moveT = 0;
        const scrollAcc = { x: 0, y: 0 };
        const now = () => performance.now();
        const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

        function effScale() {
            // transform이 반영된 실제 표시 배율 — 손가락 델타를 원격 픽셀로 환산
            const r = el.getBoundingClientRect();
            return Math.min(r.width / screenDims.w, r.height / screenDims.h) || 1;
        }
        function stagePt(clientX, clientY) {
            const sr = els.screenStage.getBoundingClientRect();
            return { x: clientX - sr.left, y: clientY - sr.top };
        }
        function throttledMove(p) {
            const n = now();
            if (n - moveT < 60) return;
            moveT = n;
            sendScreen({ type: "move", x: Math.round(p.x), y: Math.round(p.y) });
        }
        function emitScroll(dx, dy, at) {
            // 자연 스크롤(맥): 손가락이 가는 방향으로 컨텐츠가 따라간다
            const step = 42;
            scrollAcc.x += dx;
            scrollAcc.y += dy;
            if (Math.abs(scrollAcc.y) >= step) {
                const n = Math.min(20, Math.max(1, Math.round(Math.abs(scrollAcc.y) / step)));
                sendScreen({ type: "scroll", x: at.x, y: at.y, direction: scrollAcc.y < 0 ? "down" : "up", amount: n });
                scrollAcc.y = 0;
            }
            if (Math.abs(scrollAcc.x) >= step) {
                const n = Math.min(20, Math.max(1, Math.round(Math.abs(scrollAcc.x) / step)));
                sendScreen({ type: "scroll", x: at.x, y: at.y, direction: scrollAcc.x < 0 ? "right" : "left", amount: n });
                scrollAcc.x = 0;
            }
        }
        el.addEventListener("pointerdown", (e) => {
            el.focus({ preventScroll: true });
            try {
                el.setPointerCapture(e.pointerId);
            } catch {}
            ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (ptrs.size === 2) {
                // 두 번째 손가락 → 핀치 줌 + 두 손가락 스크롤(양쪽 모드 공통)
                clearTimeout(lpTimer);
                down = null;
                const [a, b] = [...ptrs.values()];
                pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: zoom.s, lx: (a.x + b.x) / 2, ly: (a.y + b.y) / 2, t0: now(), moved: 0 };
                e.preventDefault();
                return;
            }
            if (ptrs.size > 2) return;
            const isMouse = e.pointerType === "mouse";
            const rel = touchMode === "trackpad" && !isMouse;
            down = {
                x: e.clientX,
                y: e.clientY,
                t: now(),
                moved: 0,
                p: screenPoint(e),
                mode: rel ? "rel" : isMouse ? "abs" : "scroll",
                tapdrag: rel && now() - lastTap.at < 380,
                button: e.button === 2 ? 3 : e.button === 1 ? 2 : 1,
            };
            if (down.mode === "scroll") {
                // 직접 모드: 길게 누른 채 움직이면 원격 드래그로 전환
                lpTimer = setTimeout(() => {
                    if (down && down.mode === "scroll" && down.moved < 10 && down.p) {
                        dragging = true;
                        sendScreen({ type: "mousedown", x: down.p.x, y: down.p.y, button: 1 });
                    }
                }, 480);
            }
            e.preventDefault();
        });
        el.addEventListener("pointermove", (e) => {
            const prev = ptrs.get(e.pointerId);
            if (!prev) {
                // 누르지 않은 마우스 이동 = 호버 — 원격 커서를 절대 좌표로 옮긴다.
                if (e.pointerType === "mouse") {
                    const p = screenPoint(e);
                    if (p) {
                        cursor.x = p.x;
                        cursor.y = p.y;
                        throttledMove(p);
                    }
                }
                return;
            }
            const dx = e.clientX - prev.x;
            const dy = e.clientY - prev.y;
            ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && ptrs.size === 2) {
                const [a, b] = [...ptrs.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
                const cx = (a.x + b.x) / 2;
                const cy = (a.y + b.y) / 2;
                const sp = stagePt(cx, cy);
                applyZoom(clamp((pinch.s0 * d) / pinch.d0, 1, 5), sp.x, sp.y);
                // 중심점 이동 = 두 손가락 스크롤. 트랙패드 모드는 커서 위치에서,
                // 직접 모드는 손가락 아래 지점에서 스크롤한다.
                const rp = touchMode === "trackpad" ? cursor : screenPoint({ clientX: cx, clientY: cy });
                if (rp) emitScroll(cx - pinch.lx, cy - pinch.ly, { x: Math.round(rp.x), y: Math.round(rp.y) });
                pinch.lx = cx;
                pinch.ly = cy;
                pinch.moved += Math.abs(dx) + Math.abs(dy);
                e.preventDefault();
                return;
            }
            if (!down || ptrs.size !== 1) return;
            down.moved += Math.abs(dx) + Math.abs(dy);
            if (down.mode === "rel") {
                // 트랙패드: 손가락 상대 이동이 커서 이동. 두 번째 탭 후 드래그면 원격 드래그.
                if (down.tapdrag && !dragging && down.moved > 6) {
                    dragging = true;
                    sendScreen({ type: "mousedown", x: Math.round(cursor.x), y: Math.round(cursor.y), button: 1 });
                }
                const s = effScale();
                const g = 1 + Math.min(2, Math.hypot(dx, dy) / 24); // 맥식 포인터 가속
                cursor.x = clamp(cursor.x + (dx / s) * g, 0, screenDims.w - 1);
                cursor.y = clamp(cursor.y + (dy / s) * g, 0, screenDims.h - 1);
                throttledMove(cursor);
                renderCursor();
            } else if (dragging) {
                const p = screenPoint(e);
                if (p) {
                    down.p = p;
                    throttledMove(p);
                }
            } else if (down.mode === "abs" && down.moved > 6 && down.p) {
                // 마우스 절대 모드: 드래그 = 원격 드래그
                dragging = true;
                sendScreen({ type: "mousedown", x: down.p.x, y: down.p.y, button: 1 });
            } else if (down.mode === "scroll" && down.moved > 10) {
                clearTimeout(lpTimer);
                const p = screenPoint(e);
                if (p) emitScroll(dx, dy, p);
            }
            e.preventDefault();
        });
        el.addEventListener("pointerup", (e) => {
            ptrs.delete(e.pointerId);
            if (pinch) {
                if (ptrs.size === 0) {
                    // 두 손가락 동시 탭 = 우클릭
                    if (now() - pinch.t0 < 300 && pinch.moved < 14 && Math.abs(zoom.s - pinch.s0) < 0.05) {
                        const rp = touchMode === "trackpad" ? cursor : screenPoint(e);
                        if (rp) sendScreen({ type: "click", x: Math.round(rp.x), y: Math.round(rp.y), button: 3 });
                    }
                    pinch = null;
                } else if (ptrs.size === 1) {
                    // 남은 손가락을 새 단일 제스처로 재개(탭으로 오인하지 않게 moved 시드)
                    const v = [...ptrs.values()][0];
                    pinch = null;
                    down = {
                        x: v.x,
                        y: v.y,
                        t: now(),
                        moved: 20,
                        p: null,
                        mode: touchMode === "trackpad" ? "rel" : "scroll",
                        tapdrag: false,
                        button: 1,
                    };
                }
                e.preventDefault();
                return;
            }
            if (!down) return;
            clearTimeout(lpTimer);
            const dur = now() - down.t;
            if (dragging) {
                dragging = false;
                const rp = down.mode === "rel" ? cursor : down.p;
                if (rp) sendScreen({ type: "mouseup", x: Math.round(rp.x), y: Math.round(rp.y), button: 1 });
            } else {
                // 쓰로틀된 move가 잘려 원격 커서가 가상 커서보다 뒤처지지 않게 마지막 위치를 보낸다
                const rp = down.mode === "rel" ? cursor : down.p;
                if (down.mode === "rel" && down.moved > 2) sendScreen({ type: "move", x: Math.round(cursor.x), y: Math.round(cursor.y) });
                if (dur < 280 && down.moved < 12 && rp) {
                    const dbl = now() - lastTap.at < 380 && Math.hypot(rp.x - lastTap.x, rp.y - lastTap.y) < 12;
                    sendScreen({ type: "click", x: Math.round(rp.x), y: Math.round(rp.y), button: down.button, double: dbl });
                    lastTap = { at: now(), x: rp.x, y: rp.y };
                }
            }
            down = null;
            e.preventDefault();
        });
        el.addEventListener("pointercancel", (e) => {
            ptrs.delete(e.pointerId);
            clearTimeout(lpTimer);
            if (dragging) {
                dragging = false;
                sendScreen({ type: "mouseup", x: Math.round(cursor.x), y: Math.round(cursor.y), button: 1 });
            }
            down = null;
            if (ptrs.size < 2) pinch = null;
        });
        el.addEventListener("contextmenu", (e) => e.preventDefault());
        el.addEventListener(
            "wheel",
            (e) => {
                if (e.ctrlKey || e.metaKey) {
                    // 데스크톱 트랙패드 핀치는 ctrl+wheel로 들어온다 — 로컬 확대만
                    const sp = stagePt(e.clientX, e.clientY);
                    applyZoom(clamp(zoom.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 1, 5), sp.x, sp.y);
                } else {
                    const p = screenPoint(e);
                    if (!p) return;
                    const dir = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? (e.deltaY < 0 ? "up" : "down") : e.deltaX < 0 ? "left" : "right";
                    sendScreen({ type: "scroll", x: p.x, y: p.y, direction: dir, amount: 3 });
                }
                e.preventDefault();
            },
            { passive: false },
        );

        el.addEventListener("keydown", (e) => {
            if (e.metaKey && (e.key === "c" || e.key === "v" || e.key === "a" || e.key === "x")) return; // OS 단축키
            // IME 조합 중엔 keydown이 중간 글자를 보낸다 — 조합 완료 후 input이 확정
            // 문자를내므로 여기서도내면 중복 입력이 된다.
            if (e.isComposing || e.key === "Process" || e.key === "Unidentified") return;
            const sym = KEYMAP[e.key];
            if (sym) {
                sendScreen({ type: "key", key: sym, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
                e.preventDefault();
                return;
            }
            if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                sendScreen({ type: "type", text: e.key });
                e.preventDefault();
            } else if ((e.ctrlKey || e.altKey) && e.key && e.key.length === 1) {
                const k = e.key.toLowerCase();
                if (/^[a-z0-9]$/.test(k)) {
                    sendScreen({ type: "key", key: k, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
                    e.preventDefault();
                }
            }
        });
        el.addEventListener("paste", (e) => {
            const text = e.clipboardData?.getData("text");
            if (text) sendScreen({ type: "type", text: text.slice(0, 4096) });
            e.preventDefault();
        });
    }

    async function startScreen() {
        els.startBtn.disabled = true;
        try {
            const r = await T.api.computerScreenStart();
            if (r?.screen?.active) {
                hideScreenMsg();
                if (screenWs) {
                    try {
                        screenWs.close();
                    } catch {}
                    screenWs = null;
                }
                connectScreen();
            }
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            showScreenMsg(errorText(err?.payload?.error), err?.payload?.error !== "docker_only");
        } finally {
            els.startBtn.disabled = false;
        }
    }

    /* ── 터미널 특수키 바(모바일 키보드가 열렸을 때만 표시) ── */
    // 스티키 Ctrl/Alt: 누르면 켜지고 다음 키 하나에 적용된 뒤 꺼진다.
    const TERM_KEYS = [
        { label: "Esc", seq: "\x1b" },
        { label: "Ctrl", sticky: "ctrl" },
        { label: "Alt", sticky: "alt" },
        { label: "Tab", seq: "\t" },
        { label: "←", seq: "\x1b[D", kind: "csi" },
        { label: "↑", seq: "\x1b[A", kind: "csi" },
        { label: "↓", seq: "\x1b[B", kind: "csi" },
        { label: "→", seq: "\x1b[C", kind: "csi" },
        { label: "Home", seq: "\x1b[H", kind: "csi" },
        { label: "End", seq: "\x1b[F", kind: "csi" },
        { label: "PgUp", seq: "\x1b[5~", kind: "tilde" },
        { label: "PgDn", seq: "\x1b[6~", kind: "tilde" },
        { label: "Del", seq: "\x1b[3~", kind: "tilde" },
        { label: "|", seq: "|", kind: "char" },
        { label: "/", seq: "/", kind: "char" },
        { label: "-", seq: "-", kind: "char" },
        { label: "~", seq: "~", kind: "char" },
    ];
    const stickyBtns = { ctrl: null, alt: null };

    function termSend(data) {
        if (termWs && termWs.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: "input", data }));
    }
    function syncStickyBtns() {
        stickyBtns.ctrl?.classList.toggle("on", stickyCtrl);
        stickyBtns.alt?.classList.toggle("on", stickyAlt);
    }
    function clearSticky() {
        if (!stickyCtrl && !stickyAlt) return;
        stickyCtrl = stickyAlt = false;
        syncStickyBtns();
    }
    // 스티키 수정자를 시퀀스에 적용하고 소비한다(xterm 수정자 파라미터 규약:
    // 1 + Shift? + Alt*2 + Ctrl*4 — Shift는 모바일 키보드가 자체 처리).
    function consumeSticky(seq, kind) {
        let out = seq;
        if (stickyCtrl || stickyAlt) {
            const m = 1 + (stickyAlt ? 2 : 0) + (stickyCtrl ? 4 : 0);
            if (kind === "csi") out = `\x1b[1;${m}${seq.slice(-1)}`;
            else if (kind === "tilde") out = seq.replace("~", `;${m}~`);
            else if (seq.length === 1) {
                if (stickyCtrl && /^[a-z@[\\\]^_?]$/i.test(seq)) out = String.fromCharCode(seq.toLowerCase().charCodeAt(0) & 0x1f);
                else if (stickyAlt) out = "\x1b" + seq;
            }
        }
        clearSticky();
        return out;
    }
    function buildTermKeys() {
        // 채팅 입력 바와 같은 마크업: .composer > .composer-row, 내용만 특수키 버튼
        const row = T.h("div", { class: "composer-row" });
        const bar = T.h("div", { class: "composer cp-termkeys" }, [row]);
        for (const k of TERM_KEYS) {
            const btn = T.h("button", {
                class: "cp-tk",
                text: k.label,
                // 포커스가 빠지면 가상 키보드와 함께 이 바도 닫힌다 — 포커스 유지 필수.
                onpointerdown: (e) => e.preventDefault(),
                onmousedown: (e) => e.preventDefault(),
                onclick: () => {
                    if (k.sticky) {
                        if (k.sticky === "ctrl") stickyCtrl = !stickyCtrl;
                        else stickyAlt = !stickyAlt;
                        syncStickyBtns();
                        return;
                    }
                    termSend(consumeSticky(k.seq, k.kind));
                },
            });
            if (k.sticky) stickyBtns[k.sticky] = btn;
            row.append(btn);
        }
        return bar;
    }

    /* ── 터미널(xterm.js) ─────────────────────────────────── */
    function ensureTerm() {
        if (term) return true;
        // 벤더 xterm 에셋이 안 올라온 경우(캐시된 예전 index.html, 에셋 404 등)
        // TypeError로 탭 전체가 죽지 않게 안내만 표시한다.
        if (!window.Terminal || !window.FitAddon?.FitAddon) {
            setMsg(termMsg, t("computerTerminalUnavailable"));
            return false;
        }
        const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
        term = new window.Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: mono || 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
            scrollback: 2000,
            theme: {
                background: "#000000",
                foreground: "#e5e5e5",
                cursor: "#e5e5e5",
                selectionBackground: "rgba(255,255,255,0.25)",
            },
        });
        termFit = new window.FitAddon.FitAddon();
        term.loadAddon(termFit);
        term.open(els.termHost);
        term.onData((d) => {
            if (stickyCtrl || stickyAlt) {
                if (d.length === 1) d = consumeSticky(d, "char");
                else clearSticky();
            }
            termSend(d);
        });
        term.onResize(({ cols, rows }) => {
            if (termWs && termWs.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: "resize", cols, rows }));
        });
        termRo = new ResizeObserver(() => {
            try {
                termFit.fit();
            } catch {}
        });
        termRo.observe(els.termHost);
        return true;
    }

    function connectTerminal() {
        if (!ensureTerm()) return;
        try {
            termFit.fit();
        } catch {}
        if (termWs && termWs.readyState <= WebSocket.OPEN) return;
        setMsg(termMsg, t("computerConnecting"));
        const ws = new WebSocket(wsUrl("/ws/computer/terminal", { agent: openBot ? openBot.id : openUuid }));
        ws.binaryType = "arraybuffer";
        let sawError = false;
        termWs = ws;
        ws.onopen = () => {
            termRetry = 0;
            term.reset();
            try {
                termFit.fit();
            } catch {}
        };
        ws.onmessage = (ev) => {
            if (typeof ev.data === "string") {
                let msg;
                try {
                    msg = JSON.parse(ev.data);
                } catch {
                    return;
                }
                if (msg.type === "ready") {
                    setMsg(termMsg, "");
                    if (msg.cols && msg.rows && term.cols && term.rows && (msg.cols !== term.cols || msg.rows !== term.rows)) {
                        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                    }
                    // 탭을 막 전환했을 때만 포커스한다 — 자동 재접속 때마다
                    // 키보드가 열리거나 다른 입력(URL 바 등)의 포커스를 뺏지 않게.
                    if (focusTermOnReady) {
                        focusTermOnReady = false;
                        const ae = document.activeElement;
                        if (!ae || ae === document.body || ae === page || ae === els.tabTerm) term.focus();
                    }
                } else if (msg.type === "exit") {
                    term.write(`\r\n\x1b[90m[process exited${msg.code != null ? " " + msg.code : ""}]\x1b[0m\r\n`);
                } else if (msg.type === "error") {
                    sawError = true;
                    setMsg(termMsg, errorText(msg.error));
                }
                return;
            }
            term.write(new Uint8Array(ev.data));
        };
        ws.onclose = () => {
            if (termWs === ws) termWs = null;
            if (!isOpen() || activeTab !== "terminal" || sawError) return;
            setMsg(termMsg, t("computerDisconnected"));
            const delay = Math.min(5000, 500 * 2 ** termRetry++);
            setTimeout(() => {
                if (isOpen() && activeTab === "terminal" && !termWs) connectTerminal();
            }, delay);
        };
    }

    function restartTerminal() {
        term?.reset();
        if (termWs && termWs.readyState === WebSocket.OPEN) {
            termWs.send(JSON.stringify({ type: "restart" }));
        } else {
            connectTerminal();
        }
    }

    async function checkStatus() {
        if (statusChecked) return;
        statusChecked = true;
        try {
            const r = await T.api.computerStatus();
            if (r && r.docker === false) {
                showScreenMsg(t("computerDockerOnly"), false);
                setMsg(termMsg, t("computerDockerOnly"));
                els.status.textContent = t("computerDockerOnly");
            } else if (r && r.terminal === false) {
                setMsg(termMsg, t("computerTermDisabled"));
            }
        } catch (_) {}
    }

    /* ── 페이지 오픈/클로즈 ────────────────────────────────── */
    function open(opt) {
        const o = opt || {};
        build();
        const uuid = o.uuid;
        const bot = (uuid && state.botByUuid(uuid)) || null;
        openUuid = uuid || null;
        openBot = bot;
        // 다른 라우트의 hide()가 컴포저(syncMode)를 건드리므로 computer-route를
        // 켜서 컴포저를 가리기 전에 먼저 정리한다.
        T.settingsUI?.hide?.();
        T.todosUI?.hide?.();
        page.hidden = false;
        document.body.classList.add("computer-route");
        T.sidebar?.showChat?.();
        T.sidebar?.syncRoute?.();
        pushed = false;
        if (!o.fromUrl) {
            try {
                history.pushState(null, "", pathFor(uuid));
                pushed = true;
            } catch (_) {}
        }

        const header = document.getElementById("header");
        const hdrMenu = document.getElementById("btnMenu");
        const hdrComp = document.getElementById("btnHdrComputer");
        const hdrAvatar = document.getElementById("hdrAvatar");
        const hdrName = document.getElementById("hdrName");
        const nameWrap = header?.querySelector(".hd-name-wrap");
        if (header && hdrMenu && hdrComp && nameWrap) {
            hdrMenu.style.display = "none";
            hdrMenu.after(els.backBtn);
            nameWrap.append(els.status);
            hdrComp.style.display = "none";
            header.append(els.tabs);
        }

        const name = bot ? bot.name : "";
        if (hdrAvatar) {
            hdrAvatar.replaceChildren();
            hdrAvatar.textContent = name ? ([...String(name).trim()][0] || "").toUpperCase() : "";
            hdrAvatar.style.background = bot?.color || "var(--surface-2)";
            hdrAvatar.style.color = "#fff";
        }
        if (hdrName) hdrName.textContent = name;
        els.status.textContent = "";
        document.title = name ? `${name} — ${t("computer")} — tabyBot` : "tabyBot";

        if (!bot) {
            showScreenMsg(t("computerNoBot"), false);
            setMsg(termMsg, t("computerNoBot"));
        }
        checkStatus();
        setTab(activeTab || "screen");
        // 이미 페이지 안의 입력 요소(터미널/URL 입력)에 포커스가 있으면 뺏지 않는다.
        // 빼앗으면 모바일에서 열린 가상 키보드가 닫힌다.
        const ae = document.activeElement;
        const focusedInside = ae && page.contains(ae) && ae !== page;
        if (!focusedInside) page.focus({ preventScroll: true });
    }

    function close() {
        if (pushed) {
            pushed = false;
            history.back();
            return;
        }
        const target = openUuid ? `/a/${openUuid}` : "/";
        try {
            history.replaceState(null, "", target);
        } catch (_) {}
        T.app?.renderRoute();
    }

    function hide() {
        if (!page || page.hidden) return;
        // 페이지 안의 포커스를 먼저 뺀다 — 숨겨진 요소에 포커스가 남으면
        // iOS 키보드가 죽은 입력기를 가리켜 돌아온 뒤 컴포저가 입력을 못 받는다.
        if (page.contains(document.activeElement)) document.activeElement.blur();
        if (els.kbdInput) {
            els.kbdInput.dataset.on = "";
            els.kbdInput.value = "";
        }
        els.kbdBtn?.classList.remove("active");
        page.hidden = true;
        document.body.classList.remove("computer-route");
        pushed = false;
        /* #header에 주입한 요소를 빼고 원래 버튼을 복원한다 */
        els.backBtn?.remove();
        els.status?.remove();
        els.tabs?.remove();
        const hdrMenu = document.getElementById("btnMenu");
        const hdrComp = document.getElementById("btnHdrComputer");
        if (hdrMenu) hdrMenu.style.display = "";
        if (hdrComp) hdrComp.style.display = "";
        T.chat?.refreshHeader?.();
        if (screenWs) {
            try {
                screenWs.close();
            } catch {}
            screenWs = null;
        }
        if (termWs) {
            try {
                termWs.close();
            } catch {}
            termWs = null;
        }
    }

    function init() {
        page = document.getElementById("computerPage");
        if (!page) return;
        // 헤더 오른쪽의 컴퓨터 버튼 → 컴퓨터 뷰
        const hdr = document.getElementById("btnHdrComputer");
        if (hdr) {
            hdr.addEventListener("click", () => {
                const uuid = state.state.currentId;
                if (!uuid || T.todosUI?.isOpen?.() || T.settingsUI?.isOpen?.()) return;
                navigate(uuid);
            });
        }
    }

    T.computerUI = { init, open, hide, isOpen, routeFromPath, navigate };
})((window.Taby = window.Taby || {}));
