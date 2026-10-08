/* tabyBot 웹 클라이언트: 컴퓨터 화면 열기/닫기와 초기화. */
((T) => {
    "use strict";

    T.computerCtx ??= {};
    const C = T.computerCtx;
    const { state } = T;
    const t = (k, p) => T.i18n.t(k, p);

    /* ── 페이지 오픈/클로즈 ────────────────────────────────── */
    function open(opt) {
        const o = opt || {};
        C.build();
        const uuid = o.uuid;
        const bot = (uuid && state.botByUuid(uuid)) || null;
        C.openUuid = uuid || null;
        C.openBot = bot;
        // 다른 라우트의 hide()가 컴포저(syncMode)를 건드리므로 computer-route를
        // 켜서 컴포저를 가리기 전에 먼저 정리한다.
        T.settingsUI?.hide?.();
        T.todosUI?.hide?.();
        C.page.hidden = false;
        document.body.classList.add("computer-route");
        T.sidebar?.showChat?.();
        T.sidebar?.syncRoute?.();
        C.pushed = false;
        if (!o.fromUrl) {
            try {
                history.pushState(null, "", C.pathFor(uuid));
                C.pushed = true;
            } catch {
                // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
            }
        }

        const header = document.getElementById("header");
        const hdrMenu = document.getElementById("btnMenu");
        const hdrComp = document.getElementById("btnHdrComputer");
        const hdrAvatar = document.getElementById("hdrAvatar");
        const hdrName = document.getElementById("hdrName");
        const nameWrap = header?.querySelector(".hd-name-wrap");
        if (header && hdrMenu && hdrComp && nameWrap) {
            hdrMenu.style.display = "none";
            hdrMenu.after(C.els.backBtn);
            nameWrap.append(C.els.status);
            hdrComp.style.display = "none";
            header.append(C.els.tabs);
        }

        const name = bot ? bot.name : "";
        if (hdrAvatar) {
            hdrAvatar.replaceChildren();
            hdrAvatar.textContent = name ? ([...String(name).trim()][0] || "").toUpperCase() : "";
            hdrAvatar.style.backgroundColor = bot?.color || "var(--surface-2)";
            hdrAvatar.style.color = "#fff";
        }
        if (hdrName) hdrName.textContent = name;
        C.els.status.textContent = "";
        document.title = name ? `${name} · ${t("computer")} · tabyBot` : "tabyBot";

        if (!bot) {
            C.showScreenMsg(t("computerNoBot"), false);
            C.setMsg(C.termMsg, t("computerNoBot"));
        }
        C.checkStatus();
        C.setTab(C.activeTab || "screen");
        // 이미 페이지 안의 입력 요소(터미널/URL 입력)에 포커스가 있으면 뺏지 않는다.
        // 빼앗으면 모바일에서 열린 가상 키보드가 닫힌다.
        const ae = document.activeElement;
        const focusedInside = ae && C.page.contains(ae) && ae !== C.page;
        if (!focusedInside) C.page.focus({ preventScroll: true });
    }

    function close() {
        if (C.pushed) {
            C.pushed = false;
            history.back();
            return;
        }
        const target = C.openUuid ? `/a/${C.openUuid}` : "/";
        T.util.replaceUrl(target);
        T.app?.renderRoute();
    }

    function hide() {
        if (!C.page || C.page.hidden) return;
        // 페이지 안의 포커스를 먼저 뺀다. 숨겨진 요소에 포커스가 남으면
        // iOS 키보드가 죽은 입력기를 가리켜 돌아온 뒤 컴포저가 입력을 못 받는다.
        if (C.page.contains(document.activeElement)) document.activeElement.blur();
        if (C.els.kbdInput) {
            C.els.kbdInput.dataset.on = "";
            C.els.kbdInput.value = "";
        }
        C.els.kbdBtn?.classList.remove("active");
        C.page.hidden = true;
        document.body.classList.remove("computer-route");
        C.pushed = false;
        /* #header에 주입한 요소를 빼고 원래 버튼을 복원한다 */
        C.els.backBtn?.remove();
        C.els.status?.remove();
        C.els.tabs?.remove();
        const hdrMenu = document.getElementById("btnMenu");
        const hdrComp = document.getElementById("btnHdrComputer");
        if (hdrMenu) hdrMenu.style.display = "";
        if (hdrComp) hdrComp.style.display = "";
        T.chat?.refreshHeader?.();
        if (C.screenWs) {
            try {
                C.screenWs.close();
            } catch {
                // 이미 닫혔거나 정리된 대상이면 무시한다
            }
            C.screenWs = null;
        }
        if (C.termWs) {
            try {
                C.termWs.close();
            } catch {
                // 이미 닫혔거나 정리된 대상이면 무시한다
            }
            C.termWs = null;
        }
    }

    function init() {
        C.page = document.getElementById("computerPage");
        if (!C.page) return;
        // 헤더 오른쪽의 컴퓨터 버튼은 컴퓨터 뷰를 연다.
        const hdr = document.getElementById("btnHdrComputer");
        if (hdr) {
            hdr.addEventListener("click", () => {
                const uuid = state.state.currentId;
                if (!uuid || T.todosUI?.isOpen?.() || T.settingsUI?.isOpen?.()) return;
                C.navigate(uuid);
                // 모바일에서는 채팅 위로 오른쪽에서 밀려 들어온다.
                T.gestures?.openInner?.();
            });
        }
    }

    T.computerUI = { init, open, close, hide, isOpen: C.isOpen, routeFromPath: C.routeFromPath, navigate: C.navigate };

    C.open = open;
    C.close = close;
    C.hide = hide;
    C.init = init;
})(window.Taby);
