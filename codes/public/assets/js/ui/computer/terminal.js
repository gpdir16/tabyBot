/* tabyBot 웹 클라이언트: 터미널(xterm.js)과 특수키 바. */
((T) => {
    "use strict";

    T.computerCtx ??= {};
    const C = T.computerCtx;
    const t = (k, p) => T.i18n.t(k, p);

    // 터미널 상태(xterm.js)
    C.termWs = null;

    let term = null;

    let termFit = null;

    let termRo = null;

    C.termMsg = undefined;

    let termRetry = 0;

    C.focusTermOnReady = false;

    // 터미널 특수키 바의 스티키 수정자(다음 키 1회에 적용)
    let stickyCtrl = false;

    let stickyAlt = false;

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
        if (C.termWs && C.termWs.readyState === WebSocket.OPEN) C.termWs.send(JSON.stringify({ type: "input", data }));
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
    // 1 + Shift? + Alt*2 + Ctrl*4: Shift는 모바일 키보드가 자체 처리).
    function consumeSticky(seq, kind) {
        let out = seq;
        if (stickyCtrl || stickyAlt) {
            const m = 1 + (stickyAlt ? 2 : 0) + (stickyCtrl ? 4 : 0);
            if (kind === "csi") out = `\x1b[1;${m}${seq.slice(-1)}`;
            else if (kind === "tilde") out = seq.replace("~", `;${m}~`);
            else if (seq.length === 1) {
                if (stickyCtrl && /^[a-z@[\\\]^_?]$/i.test(seq)) out = String.fromCharCode(seq.toLowerCase().charCodeAt(0) & 0x1f);
                else if (stickyAlt) out = `\x1b${seq}`;
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
                // 포커스가 빠지면 가상 키보드와 함께 이 바도 닫힌다. 포커스 유지 필수.
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
    // xterm(약 290KB)은 터미널 탭을 처음 열 때만 받는다. 앱 시작 경로에서 뺀다.
    // index.html의 <link rel="lazy-script|lazy-style" data-group="xterm">가 URL을 들고 있다.
    let xtermLoading = null;

    function loadXterm() {
        if (window.Terminal && window.FitAddon?.FitAddon) return Promise.resolve(true);
        if (xtermLoading) return xtermLoading;
        const refs = [...document.querySelectorAll('link[data-group="xterm"]')];
        for (const ref of refs.filter((r) => r.rel === "lazy-style")) {
            document.head.append(T.h("link", { rel: "stylesheet", href: ref.getAttribute("href") }));
        }
        xtermLoading = refs
            .filter((r) => r.rel === "lazy-script")
            .reduce(
                (chain, ref) =>
                    chain.then(
                        () =>
                            new Promise((resolve, reject) => {
                                const el = T.h("script", { src: ref.getAttribute("href") });
                                el.onload = resolve;
                                el.onerror = reject;
                                document.head.append(el);
                            }),
                    ),
                Promise.resolve(),
            )
            .then(
                () => true,
                () => {
                    xtermLoading = null; // 다음 시도에서 다시 받는다
                    return false;
                },
            );
        return xtermLoading;
    }

    function ensureTerm() {
        if (term) return true;
        // 벤더 xterm 에셋이 안 올라온 경우(캐시된 예전 index.html, 에셋 404 등)
        // TypeError로 탭 전체가 죽지 않게 안내만 표시한다.
        if (!window.Terminal || !window.FitAddon?.FitAddon) {
            C.setMsg(C.termMsg, t("computerTerminalUnavailable"));
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
        term.open(C.els.termHost);
        term.onData((data) => {
            let d = data;
            if (stickyCtrl || stickyAlt) {
                if (d.length === 1) d = consumeSticky(d, "char");
                else clearSticky();
            }
            termSend(d);
        });
        term.onResize(({ cols, rows }) => {
            if (C.termWs && C.termWs.readyState === WebSocket.OPEN) C.termWs.send(JSON.stringify({ type: "resize", cols, rows }));
        });
        termRo = new ResizeObserver(() => {
            try {
                termFit.fit();
            } catch {
                // 터미널이 아직 화면에 붙기 전이면 크기 맞춤을 건너뛴다
            }
        });
        termRo.observe(C.els.termHost);
        return true;
    }

    function connectTerminal() {
        if (!term && !window.Terminal) {
            C.setMsg(C.termMsg, t("computerConnecting"));
            void loadXterm().then((ok) => {
                if (!ok) C.setMsg(C.termMsg, t("computerTerminalUnavailable"));
                else if (C.isOpen() && C.activeTab === "terminal") connectTerminal();
            });
            return;
        }
        if (!ensureTerm()) return;
        try {
            termFit.fit();
        } catch {
            // 터미널이 아직 화면에 붙기 전이면 크기 맞춤을 건너뛴다
        }
        if (C.termWs && C.termWs.readyState <= WebSocket.OPEN) return;
        C.setMsg(C.termMsg, t("computerConnecting"));
        const ws = new WebSocket(C.wsUrl("/ws/computer/terminal", { agent: C.openBot ? C.openBot.id : C.openUuid }));
        ws.binaryType = "arraybuffer";
        let sawError = false;
        C.termWs = ws;
        ws.onopen = () => {
            termRetry = 0;
            term.reset();
            try {
                termFit.fit();
            } catch {
                // 터미널이 아직 화면에 붙기 전이면 크기 맞춤을 건너뛴다
            }
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
                    C.setMsg(C.termMsg, "");
                    if (msg.cols && msg.rows && term.cols && term.rows && (msg.cols !== term.cols || msg.rows !== term.rows)) {
                        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                    }
                    // 탭을 막 전환했을 때만 포커스한다. 자동 재접속 때마다
                    // 키보드가 열리거나 다른 입력(URL 바 등)의 포커스를 뺏지 않게.
                    if (C.focusTermOnReady) {
                        C.focusTermOnReady = false;
                        const ae = document.activeElement;
                        if (!ae || ae === document.body || ae === C.page || ae === C.els.tabTerm) term.focus();
                    }
                } else if (msg.type === "exit") {
                    term.write(`\r\n\x1b[90m[process exited${msg.code != null ? ` ${msg.code}` : ""}]\x1b[0m\r\n`);
                } else if (msg.type === "error") {
                    sawError = true;
                    C.setMsg(C.termMsg, C.errorText(msg.error));
                }
                return;
            }
            term.write(new Uint8Array(ev.data));
        };
        ws.onclose = () => {
            if (C.termWs === ws) C.termWs = null;
            if (!C.isOpen() || C.activeTab !== "terminal" || sawError) return;
            C.setMsg(C.termMsg, t("computerDisconnected"));
            const delay = Math.min(5000, 500 * 2 ** termRetry++);
            setTimeout(() => {
                if (C.isOpen() && C.activeTab === "terminal" && !C.termWs) connectTerminal();
            }, delay);
        };
    }

    function restartTerminal() {
        term?.reset();
        if (C.termWs && C.termWs.readyState === WebSocket.OPEN) {
            C.termWs.send(JSON.stringify({ type: "restart" }));
        } else {
            connectTerminal();
        }
    }

    C.buildTermKeys = buildTermKeys;
    C.connectTerminal = connectTerminal;
    C.restartTerminal = restartTerminal;
})(window.Taby);
