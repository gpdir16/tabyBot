/* tabyBot 웹 클라이언트: 사이드바 초기화. */
((T) => {
    "use strict";

    T.sidebarCtx ??= {};
    const C = T.sidebarCtx;
    const { state } = T;
    const tabsEl = document.getElementById("folderTabs");
    const searchEl = document.getElementById("searchInput");
    const addBtn = document.getElementById("btnAddBot");
    const settingsBtn = document.getElementById("btnSettings");

    /* ── 바인딩 ─────────────────────────────────────────────── */
    function init() {
        searchEl.addEventListener("input", () => {
            C.query = searchEl.value.trim();
            // 바뀐 검색어에 맞지 않는 이전 결과는 즉시 걷어낸다.
            C.msgResults = null;
            C.scheduleMsgSearch();
            C.render();
        });
        C.initMobileSearch();
        document.addEventListener("keydown", (e) => {
            if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                searchEl.focus();
                searchEl.select();
            }
        });
        // + 메뉴: 길게 누르기와 우클릭은 다른 목록 행처럼 attach로 붙인다.
        // 터치로 탭하면 길게 누를 때와 같은 시트로, 마우스로 누르면 버튼 아래 메뉴로 연다.
        T.ctxmenu.attach(addBtn, () => T.chatInfo.newMenuItems());
        let addTouch = false;
        addBtn.addEventListener("pointerdown", (e) => {
            addTouch = e.pointerType === "touch";
        });
        addBtn.addEventListener("click", () => {
            const items = T.chatInfo.newMenuItems();
            if (addTouch) T.ctxmenu.open({ source: addBtn, touch: true, items });
            else T.ctxmenu.open({ anchor: addBtn, items });
        });
        settingsBtn.addEventListener("click", () => T.settingsUI.open());
        state.on("bots", () => {
            C.render();
            C.hydratePreviews();
        });
        state.on("folders", C.render);
        state.on("current", C.render);
        state.on("conversations", () => {
            C.render();
            C.hydratePreviews();
        });
        state.on("status", C.render); // 실행중 점
        // 스트리밍 중 미리보기 갱신: 토큰마다 전체를 다시 그리지 않게 짧게 묶는다.
        let deltaTimer = null;
        state.on("delta", () => {
            if (deltaTimer) return;
            deltaTimer = setTimeout(() => {
                deltaTimer = null;
                C.render();
            }, 400);
        });
        state.on("user_message", C.render);
        state.on("turn_done", C.render);
        state.on("settings", C.render);
        state.on("conn", C.renderConn);
        state.on("todos", C.render);
        T.i18n.onChange(C.syncMobileNavigation);

        // 사이드바 폭 변경·펼침·글꼴 로드로 탭 위치가 바뀌면 밑줄을 다시 맞춘다.
        if (tabsEl && window.ResizeObserver) new ResizeObserver(() => C.placeTabIndicator(false)).observe(tabsEl);

        C.initFolderSwipe();
        C.initTouchDefer();
        C.initResize();
        C.renderConn();
        C.render();
    }

    T.sidebar = {
        init,
        hydrate: C.hydratePreviews,
        showChat: () => C.setMobileChat(true),
        showList: C.showMobileList,
        syncRoute: C.syncRoute,
        expand: C.expandSidebar,
    };
})(window.Taby);
