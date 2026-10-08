/* tabyBot 웹 클라이언트: 컴퓨터 화면의 라우팅과 페이지 뼈대. */
((T) => {
    "use strict";

    T.computerCtx ??= {};
    const C = T.computerCtx;
    const t = (k, p) => T.i18n.t(k, p);

    C.page = undefined; // #computerPage

    let built = false;

    C.openUuid = null;

    C.openBot = null;

    C.pushed = false;

    C.activeTab = "screen";

    let statusChecked = false;

    /* ── 라우트 ───────────────────────────────────────────── */
    function routeFromPath() {
        const m = /^\/c\/([0-9a-f-]{36})$/.exec(location.pathname || "");
        return m ? { uuid: m[1] } : null;
    }

    function pathFor(uuid) {
        return `/c/${uuid}`;
    }

    function isOpen() {
        return !!C.page && !C.page.hidden;
    }

    // 봇 헤더를 클릭하면 이 경로로 간다. 설정 open()과 같은 push 패턴.
    function navigate(uuid) {
        if (!uuid) return;
        C.open({ uuid });
    }

    /* ── DOM 빌드 ─────────────────────────────────────────── */
    C.els = {};

    function build() {
        if (built) return;
        built = true;
        C.page.replaceChildren();

        const backBtn = T.h(
            "button",
            {
                class: "btn-icon cp-back",
                "data-tip": t("back"),
                "aria-label": t("back"),
                // 모바일에서는 밀어서 닫을 때와 같은 모양으로 밀려 나간 뒤 닫힌다.
                onclick: () => {
                    if (!T.gestures?.closeInner?.()) C.close();
                },
            },
            [T.icon("chevron-left")],
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

        /* 화면 탭: 화면 안에 브라우저 주소창이 있으므로 별도 URL 바는 두지 않는다 */
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
                onclick: () => C.setTouchMode(C.touchMode === "trackpad" ? "direct" : "trackpad"),
            },
            [T.icon("cursor")],
        );
        const tools = T.h("div", { class: "cp-tools" }, [modeBtn, kbdBtn]);

        C.canvas = T.h("canvas", { class: "cp-canvas", tabindex: "0", role: "application", "aria-label": t("computerScreen") });
        const startBtn = T.h("button", { class: "btn cp-start", text: t("computerStartScreen"), onclick: () => C.startScreen() });
        C.screenMsg = T.h("div", { class: "cp-msg hidden" }, [startBtn]);
        const cursorEl = T.h("div", { class: "cp-cursor" }, [T.icon("cursor")]);
        const screenStage = T.h("div", { class: "cp-stage" }, [C.canvas, C.screenMsg, kbdInput, cursorEl, tools]);
        const screenPane = T.h("div", { class: "cp-pane cp-screen" }, [screenStage]);

        /* 터미널 탭 */
        const restartBtn = T.h("button", { class: "btn-icon cp-tool", title: t("computerRestart"), onclick: () => C.restartTerminal() }, [
            T.icon("refresh"),
        ]);
        C.termMsg = T.h("div", { class: "cp-msg hidden" });
        const termHost = T.h("div", { class: "cp-termhost" });
        const termKeys = C.buildTermKeys();
        const termPane = T.h("div", { class: "cp-pane cp-terminal" }, [
            T.h("div", { class: "cp-stage" }, [termHost, C.termMsg, T.h("div", { class: "cp-tools" }, [restartBtn])]),
            T.h("div", { class: "cp-termkeyswrap" }, [termKeys]),
        ]);

        /* 헤더는 채팅과 같은 #header 요소를 쓴다. open()에서 backBtn/status/tabs를 주입한다 */
        C.page.append(screenPane, termPane);
        C.els = {
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
            if (v) C.sendScreen({ type: "type", text: v });
        });
        kbdInput.addEventListener("keydown", (e) => {
            const sym = C.KEYMAP[e.key];
            if (sym) {
                C.sendScreen({ type: "key", key: sym, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
                e.preventDefault();
            } else if (e.key === "Unidentified" || e.key === "Process") {
                return; // IME 합성 중: input 이벤트가 처리한다
            }
        });
        kbdInput.addEventListener("blur", () => {
            if (kbdInput.dataset.on === "1") {
                kbdInput.dataset.on = "";
                kbdBtn.classList.remove("active");
            }
        });

        C.bindScreenInput(C.canvas);
        C.setTouchMode(C.touchMode); // 아이콘·커서 표시 초기화
    }

    function setTab(tab) {
        C.activeTab = tab;
        C.els.tabScreen.classList.toggle("active", tab === "screen");
        C.els.tabTerm.classList.toggle("active", tab === "terminal");
        C.els.tabScreen.setAttribute("aria-selected", tab === "screen" ? "true" : "false");
        C.els.tabTerm.setAttribute("aria-selected", tab === "terminal" ? "true" : "false");
        C.els.screenPane.classList.toggle("hidden", tab !== "screen");
        C.els.termPane.classList.toggle("hidden", tab !== "terminal");
        if (!C.openBot && !C.openUuid) return;
        if (tab === "screen") C.connectScreen();
        else {
            C.focusTermOnReady = true;
            C.connectTerminal();
        }
    }

    function wsUrl(path, params) {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const q = new URLSearchParams(params || {});
        const tk = T.api.getToken();
        if (tk) q.set("token", tk);
        const qs = q.toString();
        return `${proto}//${location.host}${path}${qs ? `?${qs}` : ""}`;
    }

    function setMsg(el, text) {
        // 첫 자식은 안내 텍스트 노드로 유지한다(뒤에 버튼이 붙어 있을 수 있음).
        if (el.firstChild?.nodeType !== 3) el.prepend(document.createTextNode(""));
        el.firstChild.textContent = text;
        el.classList.toggle("hidden", !text);
    }

    function errorText(code) {
        if (code === "docker_only") return t("computerDockerOnly");
        if (code === "camofox_missing") return t("computerNoCamofox");
        if (code === "terminal_disabled") return t("computerTermDisabled");
        return t("computerError", { e: code || "" });
    }

    async function checkStatus() {
        if (statusChecked) return;
        statusChecked = true;
        try {
            const r = await T.api.computerStatus();
            if (r && r.docker === false) {
                C.showScreenMsg(t("computerDockerOnly"), false);
                setMsg(C.termMsg, t("computerDockerOnly"));
                C.els.status.textContent = t("computerDockerOnly");
            } else if (r && r.terminal === false) {
                setMsg(C.termMsg, t("computerTermDisabled"));
            }
        } catch {
            // 상태 조회에 실패해도 연결 시도는 계속한다
        }
    }

    C.routeFromPath = routeFromPath;
    C.pathFor = pathFor;
    C.isOpen = isOpen;
    C.navigate = navigate;
    C.build = build;
    C.setTab = setTab;
    C.wsUrl = wsUrl;
    C.setMsg = setMsg;
    C.errorText = errorText;
    C.checkStatus = checkStatus;
})(window.Taby);
