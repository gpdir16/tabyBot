/* tabyBot 웹 클라이언트: 원격 화면 스트림과 터치·마우스 입력. */
((T) => {
    "use strict";

    T.computerCtx ??= {};
    const C = T.computerCtx;
    const t = (k, p) => T.i18n.t(k, p);

    // 화면 스트림 상태
    C.screenWs = null;

    let screenDims = { w: 1280, h: 800 };

    C.canvas = undefined;

    let ctx2d;

    C.screenMsg = undefined;

    let framePending = null;

    let frameRaf = 0;

    // 화면 조작 모드: "trackpad"(맥북 트랙패드식 상대 커서) | "direct"(직접 터치)
    C.touchMode = "trackpad";
    try {
        C.touchMode = localStorage.getItem("cp.touchMode") === "direct" ? "direct" : "trackpad";
    } catch {
        // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
    }

    const cursor = { x: 640, y: 400 }; // 원격 좌표의 가상 커서

    const zoom = { s: 1, tx: 0, ty: 0 }; // 캔버스 로컬 확대(원격 전송 아님)

    let screenRetry = 0;

    // 키보드 입력을 xdotool로 보낸다. 인쇄 가능 문자는 type, 특수키는 key(+수정자).
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
    for (let i = 1; i <= 12; i++) KEYMAP[`F${i}`] = `F${i}`;

    function setTouchMode(m) {
        C.touchMode = m === "direct" ? "direct" : "trackpad";
        try {
            localStorage.setItem("cp.touchMode", C.touchMode);
        } catch {
            // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
        }
        C.els.screenPane.classList.toggle("tp", C.touchMode === "trackpad");
        C.els.modeBtn.replaceChildren(T.icon(C.touchMode === "trackpad" ? "cursor" : "touch"));
        C.els.modeBtn.dataset.tip = t(C.touchMode === "trackpad" ? "computerModeTouch" : "computerModeTrackpad");
        C.els.modeBtn.setAttribute("aria-label", C.els.modeBtn.dataset.tip);
        renderCursor();
    }

    /* ── 로컬 핀치줌(원격 전송 아님) + 가상 커서 ──────────── */
    function applyZoom(s2, px, py) {
        // (px,py): 스테이지 기준 좌표의 고정점. 그 지점 아래 원격 픽셀이 움직이지 않게
        const w = C.canvas.clientWidth || 1;
        const h = C.canvas.clientHeight || 1;
        const lx = (px - zoom.tx) / zoom.s;
        const ly = (py - zoom.ty) / zoom.s;
        zoom.s = s2;
        zoom.tx = px - lx * s2;
        zoom.ty = py - ly * s2;
        // 확대된 캔버스가 스테이지를 항상 덮도록 팬을 제한한다
        const sw = C.els.screenStage.clientWidth || w;
        const sh = C.els.screenStage.clientHeight || h;
        zoom.tx = Math.min(0, Math.max(sw - w * s2, zoom.tx));
        zoom.ty = Math.min(0, Math.max(sh - h * s2, zoom.ty));
        C.canvas.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${s2})`;
        renderCursor();
    }

    function resetZoom() {
        zoom.s = 1;
        zoom.tx = 0;
        zoom.ty = 0;
        C.canvas.style.transform = "";
        renderCursor();
    }

    function renderCursor() {
        if (!C.els.cursor) return;
        const cr = C.canvas.getBoundingClientRect();
        const sr = C.els.screenStage.getBoundingClientRect();
        const s = Math.min(cr.width / screenDims.w, cr.height / screenDims.h) || 1;
        // 캔버스는 contain 레터박스: 실제 영상 영역의 오프셋을 더한다
        const x = cr.left - sr.left + (cr.width - screenDims.w * s) / 2 + cursor.x * s;
        const y = cr.top - sr.top + (cr.height - screenDims.h * s) / 2 + cursor.y * s;
        C.els.cursor.style.transform = `translate(${Math.round(x - 1)}px, ${Math.round(y - 1)}px)`;
    }

    function showScreenMsg(text, showStart) {
        C.setMsg(C.screenMsg, text);
        C.els.startBtn.classList.toggle("hidden", !showStart);
    }

    function hideScreenMsg() {
        C.screenMsg.classList.add("hidden");
    }

    /* ── 화면 스트림 ──────────────────────────────────────── */
    function connectScreen() {
        if (C.screenWs && C.screenWs.readyState <= WebSocket.OPEN) return;
        showScreenMsg(t("computerConnecting"), false);
        const ws = new WebSocket(C.wsUrl("/ws/computer/screen", { agent: C.openBot ? C.openBot.id : C.openUuid }));
        ws.binaryType = "blob";
        let sawError = false;
        C.screenWs = ws;
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
                    C.canvas.width = screenDims.w;
                    C.canvas.height = screenDims.h;
                    cursor.x = screenDims.w / 2;
                    cursor.y = screenDims.h / 2;
                    resetZoom();
                    hideScreenMsg();
                } else if (msg.type === "inactive") {
                    showScreenMsg(t("computerScreenOff"), true);
                } else if (msg.type === "error") {
                    sawError = true;
                    showScreenMsg(C.errorText(msg.error), msg.error !== "docker_only");
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
                        ctx2d = ctx2d || C.canvas.getContext("2d");
                        ctx2d.drawImage(bmp, 0, 0, C.canvas.width, C.canvas.height);
                        bmp.close();
                    } catch {
                        // 이미 닫혔거나 정리된 대상이면 무시한다
                    }
                });
            }
        };
        ws.onopen = () => {
            screenRetry = 0;
        };
        ws.onclose = () => {
            if (C.screenWs === ws) C.screenWs = null;
            if (!C.isOpen() || C.activeTab !== "screen" || sawError) return;
            // 페이지가 열린 동안 끊기면 자동 재접속(터널·네트워크 일시 단절 대응).
            const delay = Math.min(5000, 500 * 2 ** screenRetry++);
            showScreenMsg(t("computerDisconnected"), false);
            setTimeout(() => {
                if (C.isOpen() && C.activeTab === "screen" && !C.screenWs) connectScreen();
            }, delay);
        };
        ws.onerror = () => {
            /* 오류 뒤에는 항상 close가 오므로 재접속은 onclose에서 처리한다 */
        };
    }

    function screenPoint(e) {
        const rect = C.canvas.getBoundingClientRect();
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
        if (C.screenWs && C.screenWs.readyState === WebSocket.OPEN) C.screenWs.send(JSON.stringify(obj));
    }

    // 화면 제스처(포인터·휠·키보드)는 gestures.js의 엔진이 맡는다. 여기서는 화면 상태를 건넨다.
    function bindScreenInput(el) {
        new C.ScreenGestures(el, {
            dims: () => screenDims,
            zoom,
            cursor,
            touchMode: () => C.touchMode,
            stageRect: () => C.els.screenStage.getBoundingClientRect(),
            screenPoint,
            send: sendScreen,
            applyZoom,
            renderCursor,
            keymap: KEYMAP,
        }).bind();
    }

    async function startScreen() {
        C.els.startBtn.disabled = true;
        try {
            const r = await T.api.computerScreenStart();
            if (r?.screen?.active) {
                hideScreenMsg();
                if (C.screenWs) {
                    try {
                        C.screenWs.close();
                    } catch {
                        // 이미 닫혔거나 정리된 대상이면 무시한다
                    }
                    C.screenWs = null;
                }
                connectScreen();
            }
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            showScreenMsg(C.errorText(err?.payload?.error), err?.payload?.error !== "docker_only");
        } finally {
            C.els.startBtn.disabled = false;
        }
    }

    C.KEYMAP = KEYMAP;
    C.setTouchMode = setTouchMode;
    C.showScreenMsg = showScreenMsg;
    C.connectScreen = connectScreen;
    C.sendScreen = sendScreen;
    C.bindScreenInput = bindScreenInput;
    C.startScreen = startScreen;
})(window.Taby);
