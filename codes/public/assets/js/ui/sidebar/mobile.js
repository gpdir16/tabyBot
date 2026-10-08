/* tabyBot 웹 클라이언트: 모바일 사이드바 전환과 모바일 검색 바. */
((T) => {
    "use strict";

    T.sidebarCtx ??= {};
    const C = T.sidebarCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const listEl = document.getElementById("botList");
    const searchEl = document.getElementById("searchInput");
    const collapseBtn = document.getElementById("btnCollapse");
    const sidebarEl = document.getElementById("sidebar");
    const mainEl = document.getElementById("main");
    const menuBtn = document.getElementById("btnMenu");
    const sbScrim = document.getElementById("sbScrim");
    const mobileMq = window.matchMedia("(max-width: 860px)");

    function isMobile() {
        return mobileMq.matches;
    }

    function setIcon(button, name) {
        button?.querySelector("use")?.setAttribute("href", `#i-${name}`);
    }

    function syncMobileNavigation() {
        const chatOpen = isMobile() && document.body.classList.contains("mobile-chat");
        setIcon(collapseBtn, isMobile() ? "settings" : "chevron");
        collapseBtn.setAttribute("data-tip", isMobile() ? t("settings") : t(C.collapsedState ? "expand" : "collapse"));
        collapseBtn.setAttribute("aria-label", isMobile() ? t("settings") : t(C.collapsedState ? "expand" : "collapse"));
        if (isMobile()) collapseBtn.setAttribute("aria-expanded", "false");
        if (!menuBtn) return;
        if (!isMobile()) {
            setIcon(menuBtn, "menu");
            return;
        }
        setIcon(menuBtn, chatOpen ? "chevron-left" : "menu");
        menuBtn.setAttribute("data-tip", t(chatOpen ? "back" : "menu"));
        menuBtn.setAttribute("aria-label", t(chatOpen ? "back" : "menu"));
        menuBtn.setAttribute("aria-expanded", "false");
    }

    function setMobileChat(open, options) {
        if (!isMobile()) return;
        const chatOpen = !!open;
        const instant = options?.animate === false;
        const activeInHiddenPanel = chatOpen ? sidebarEl.contains(document.activeElement) : mainEl?.contains(document.activeElement);
        document.body.classList.toggle("mobile-route-sync", instant);
        document.body.classList.toggle("mobile-chat", chatOpen);
        sidebarEl.setAttribute("aria-hidden", String(chatOpen));
        mainEl?.setAttribute("aria-hidden", String(!chatOpen));
        setMobileOpen(false);
        syncMobileNavigation();
        if (activeInHiddenPanel) {
            // 목록으로 돌아올 때는 포커스를 풀기만 한다. 검색란에 포커스를 주면 접혀 있던 검색 바가 열린다.
            requestAnimationFrame(() => (chatOpen ? menuBtn?.focus({ preventScroll: true }) : document.activeElement?.blur?.()));
        }
        if (instant) requestAnimationFrame(() => document.body.classList.remove("mobile-route-sync"));
    }

    function showMobileList() {
        if (!isMobile()) return;
        setMobileChat(false);
        if (/^(\/a\/|\/s(?:\/|$)|\/t(?:\/|$))/.test(location.pathname)) history.replaceState(null, "", `/${location.search}${location.hash}`);
        T.app?.renderRoute();
    }

    function setMobileChatFromRoute() {
        if (isMobile()) setMobileChat(/^(\/a\/|\/s(?:\/|$)|\/c\/|\/t(?:\/|$))/.test(location.pathname), { animate: false });
    }

    function setMobileOpen(open) {
        if (open) C.applyCollapsed(false);
        sidebarEl.classList.toggle("mobile-open", !!open);
        if (sbScrim) sbScrim.classList.toggle("open", !!open);
        document.body.classList.toggle("sb-open", !!open);
        if (menuBtn) menuBtn.setAttribute("aria-expanded", String(!!open));
        if (T.tooltip) T.tooltip.hide();
    }

    function openBot(bot) {
        try {
            if (T.settingsUI.isOpen()) T.settingsUI.hide();
            if (T.todosUI?.isOpen?.()) T.todosUI.hide();
            history.pushState(null, "", `/a/${encodeURIComponent(bot.uuid)}`);
        } catch {
            // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
        }
        if (isMobile()) setMobileChat(true);
        T.app?.renderRoute();
    }

    // 설정 페이지 내비게이션: 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링한다.
    function settingsPush(agentId) {
        const path = agentId == null ? "/s/general" : agentId === "__new__" ? "/s/agents/new" : `/s/agents/${agentId}`;
        history.pushState(null, "", path);
        T.app?.renderRoute();
    }

    function initTouchDefer() {
        const release = (e) => {
            if (e.touches.length) return;
            C.listTouching = false;
            if (C.renderPending) C.render();
        };
        listEl.addEventListener("touchstart", () => (C.listTouching = true), { passive: true });
        // 문서의 캡처 단계에서 받는다: 뒤로/앞으로 제스처(gestures.js)가 전파를 막아도 놓치지 않는다.
        document.addEventListener("touchend", release, { passive: true, capture: true });
        document.addEventListener("touchcancel", release, { passive: true, capture: true });
    }

    /* 모바일 검색 바: 평소에는 접혀 있다. 목록 맨 위에서 아래로 당기거나 떠 있는 검색 버튼을 누르면
       탐색 바 밑에 나타나고, 빈 채로 목록을 올리거나 닫기 버튼을 누르면 다시 접힌다. */
    function initMobileSearch() {
        const PULL_PX = 36; // 이만큼 당기거나 올리면 열고 닫는다
        const closeBtn = document.getElementById("btnSearchClose");
        const fab = document.getElementById("btnSearchFab");
        const setSearching = (on) => {
            sidebarEl.classList.toggle("searching", on);
            closeBtn.hidden = !on;
        };
        const idle = () => !searchEl.value && document.activeElement !== searchEl;

        searchEl.addEventListener("focus", () => {
            if (isMobile()) setSearching(true);
        });
        // 빈 채로 포커스를 잃으면 접는다(다른 화면에 다녀와도 빈 검색 바가 열려 있지 않게).
        searchEl.addEventListener("blur", () => {
            if (!searchEl.value) setSearching(false);
        });
        fab.addEventListener("click", () => {
            setSearching(true);
            // 누른 그 자리에서 포커스를 줘야 iOS가 키보드를 올린다.
            searchEl.focus();
        });
        // 닫기 버튼이 포커스를 가져가지 않게 해서, 누르는 순간 입력란이 먼저 흐려지는 일을 막는다.
        closeBtn.addEventListener("pointerdown", (e) => e.preventDefault());
        closeBtn.addEventListener("click", () => {
            searchEl.value = "";
            searchEl.dispatchEvent(new Event("input"));
            searchEl.blur();
            setSearching(false);
        });

        let pull = null;
        listEl.addEventListener(
            "touchstart",
            (e) => {
                pull = e.touches.length === 1 ? { y: e.touches[0].clientY, x: e.touches[0].clientX, top: listEl.scrollTop, axis: null } : null;
            },
            { passive: true },
        );
        listEl.addEventListener(
            "touchmove",
            (e) => {
                if (!pull || !isMobile()) return;
                const dy = e.touches[0].clientY - pull.y;
                const dx = e.touches[0].clientX - pull.x;
                // 처음 움직인 방향으로 정한다. 좌우 밀기(폴더 전환)로 시작했으면 손가락이 위아래로 흘러도 무시한다.
                if (pull.axis === null && Math.max(Math.abs(dx), Math.abs(dy)) > 10) pull.axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
                if (pull.axis !== "y") return;
                const open = sidebarEl.classList.contains("searching");
                // 목록을 넘기기 시작하면 키보드를 내린다.
                if (open && document.activeElement === searchEl && Math.abs(dy) > PULL_PX) searchEl.blur();
                if (!open && pull.top <= 0 && dy > PULL_PX) {
                    setSearching(true);
                    pull = null;
                } else if (open && idle() && dy < -PULL_PX) {
                    setSearching(false);
                    pull = null;
                }
            },
            { passive: true },
        );
    }

    C.isMobile = isMobile;
    C.syncMobileNavigation = syncMobileNavigation;
    C.setMobileChat = setMobileChat;
    C.showMobileList = showMobileList;
    C.setMobileChatFromRoute = setMobileChatFromRoute;
    C.setMobileOpen = setMobileOpen;
    C.openBot = openBot;
    C.settingsPush = settingsPush;
    C.initTouchDefer = initTouchDefer;
    C.initMobileSearch = initMobileSearch;
})(window.Taby);
