/* tabyBot 웹 클라이언트: 사이드바 너비·접기·크기 조절. */
((T) => {
    "use strict";

    T.sidebarCtx ??= {};
    const C = T.sidebarCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const collapseBtn = document.getElementById("btnCollapse");
    const resizeEl = document.getElementById("sbResize");
    const sidebarEl = document.getElementById("sidebar");
    const mainEl = document.getElementById("main");
    const menuBtn = document.getElementById("btnMenu");
    const sbScrim = document.getElementById("sbScrim");
    const mobileMq = window.matchMedia("(max-width: 860px)");

    /* ── 사이드바 크기/축소 ────────────────────────────────── */
    const W_KEY = "tabybot.sidebar.w";

    const C_KEY = "tabybot.sidebar.collapsed";

    C.collapsedState = false;

    let currentWidth = 300;

    function applyWidth(w) {
        currentWidth = w;
        sidebarEl.style.setProperty("--sb-w", `${w}px`);
    }

    function applyCollapsed(collapsed) {
        sidebarEl.classList.toggle("collapsed", !!collapsed);
        document.body.classList.toggle("sb-collapsed", !!collapsed && !C.isMobile());
        sidebarEl.setAttribute("aria-hidden", collapsed && !C.isMobile() ? "true" : "false");
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
        const label = collapsed ? t("expand") : t("collapse");
        collapseBtn.setAttribute("data-tip", label);
        collapseBtn.setAttribute("aria-label", label);
        if (menuBtn && !C.isMobile()) {
            menuBtn.setAttribute("aria-expanded", String(!collapsed));
            const menuLabel = collapsed ? t("expand") : t("menu");
            menuBtn.setAttribute("data-tip", menuLabel);
            menuBtn.setAttribute("aria-label", menuLabel);
        }
    }

    // 프라이빗 모드/스토리지 차단 브라우저에서 localStorage 접근이 SecurityError를
    // 던진다. 사이드바 초기화 전체가 죽지 않게 접근마다 가드한다.
    const lsGet = (k) => {
        try {
            return localStorage.getItem(k);
        } catch {
            return null;
        }
    };

    const lsSet = (k, v) => {
        try {
            localStorage.setItem(k, v);
        } catch {
            // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
        }
    };

    // 접힌 사이드바를 다시 펼친다(설정 화면의 펼치기 버튼 등에서 호출).
    function expandSidebar() {
        if (!C.collapsedState) return;
        C.collapsedState = false;
        lsSet(C_KEY, "0");
        applyCollapsed(false);
    }

    function initResize() {
        const savedW = Number(lsGet(W_KEY));
        if (savedW >= 240 && savedW <= 460) applyWidth(savedW);
        applyCollapsed(lsGet(C_KEY) === "1");
        C.collapsedState = lsGet(C_KEY) === "1";
        let dragging = false;
        resizeEl.addEventListener("pointerdown", (e) => {
            dragging = true;
            resizeEl.setPointerCapture(e.pointerId);
            document.body.classList.add("resizing");
        });
        resizeEl.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const w = Math.min(460, Math.max(240, e.clientX));
            applyWidth(w);
        });
        resizeEl.addEventListener("pointerup", () => {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove("resizing");
            lsSet(W_KEY, String(currentWidth));
        });
        collapseBtn.addEventListener("click", () => {
            if (C.isMobile()) {
                T.settingsUI.open();
                return;
            }
            const next = !C.collapsedState;
            lsSet(C_KEY, next ? "1" : "0");
            C.collapsedState = next;
            applyCollapsed(next);
            if (T.tooltip) T.tooltip.hide();
        });
        if (menuBtn) {
            menuBtn.addEventListener("click", () => {
                if (C.isMobile()) {
                    C.showMobileList();
                    return;
                }
                expandSidebar();
                if (T.tooltip) T.tooltip.hide();
            });
        }
        if (sbScrim) {
            sbScrim.addEventListener("click", () => C.setMobileOpen(false));
        }
        const onMq = () => {
            if (!C.isMobile()) {
                document.body.classList.remove("mobile-chat");
                mainEl?.removeAttribute("aria-hidden");
                C.setMobileOpen(false);
                applyCollapsed(C.collapsedState);
            } else {
                applyCollapsed(false);
                C.setMobileChatFromRoute();
            }
            C.syncMobileNavigation();
        };
        if (mobileMq.addEventListener) mobileMq.addEventListener("change", onMq);
        else mobileMq.addListener(onMq);
        window.addEventListener("popstate", C.setMobileChatFromRoute);
        window.addEventListener("pageshow", C.setMobileChatFromRoute);
        onMq();
    }

    C.applyCollapsed = applyCollapsed;
    C.lsGet = lsGet;
    C.lsSet = lsSet;
    C.expandSidebar = expandSidebar;
    C.initResize = initResize;
})(window.Taby);
