/* tabyBot 웹 클라이언트: 할 일 목록 열기/닫기와 이벤트 구독. 할 일의 세부사항·일정·담당은 창이다(detail.js). */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    let pendingDeepId = null; // 예전 주소 /t/<id>로 들어왔는데 목록에서 아직 확인하지 못한 할 일

    /* ── 열기/닫기 ─────────────────────────────────────────── */
    // 주소로 들어온 할 일이 목록에서 확인됐다: 그 창을 열고 행으로 스크롤한다.
    function openDeepLinkTarget(id) {
        pendingDeepId = null;
        C.scrollToRow = { id, until: Date.now() + 1200 };
        C.openDetail(id);
    }

    // 목록을 새로 받아 주소로 들어온 할 일을 확인한다. 없어졌으면 알린다.
    async function resolveDeepLink(id) {
        const ok = await C.refresh().catch(() => false);
        if (pendingDeepId !== id) return;
        if (C.item(id)) {
            openDeepLinkTarget(id);
            return;
        }
        if (!ok) return;
        pendingDeepId = null;
        C.toastGone(id);
    }

    // 할 일 목록을 본문에 띄운다. o: { id(그 할 일의 창도 연다), fromUrl(주소에서 들어옴), replace }
    // 본문 주소는 늘 /t다. 예전 주소 /t/<id>는 /t로 바꾸고 그 할 일의 창(t:<id>)을 연다.
    function open(opt) {
        const o = opt || {};
        if (location.pathname !== "/t") {
            if (o.fromUrl || o.replace) T.util.replaceUrl("/t");
            else T.util.pushUrl("/t");
        }
        T.sidebar?.showChat?.();
        const wasHidden = page.hidden;
        page.hidden = false;
        page.setAttribute("aria-label", t("todos"));
        if (wasHidden && !o.id && !T.windows.isMobile()) page.focus({ preventScroll: true });
        document.body.classList.add("todos-route");
        state.setCurrentTodo("list");
        T.sidebar?.syncRoute?.();
        T.chat?.refreshHeader?.();
        T.composer?.syncMode?.();
        const scroller = page.parentElement;
        if (scroller && wasHidden) scroller.scrollTop = o.id ? 0 : C.lastScrollTop;
        pendingDeepId = o.id && !C.item(o.id) ? o.id : null;
        C.build();
        if (o.id && !pendingDeepId) openDeepLinkTarget(o.id);
        if (pendingDeepId) void resolveDeepLink(pendingDeepId);
        else if (!C.items().length && !C.suggestions().length && !C.loading) C.refresh();
    }

    // 목록을 내린다. 할 일 창들은 본문을 바꿔도 그대로 남고, 고친 것도 그 창들에 남는다.
    function hide() {
        C.lastScrollTop = page.parentElement?.scrollTop ?? 0;
        page.hidden = true;
        document.body.classList.remove("todos-route");
        pendingDeepId = null;
        C.handPopFor = null;
        C.scrollToRow = null;
        state.setCurrentTodo(null);
        page.replaceChildren();
        T.chat?.refreshHeader?.();
        T.composer?.syncMode?.();
    }

    // 처음 보는 에이전트 제안이 생겼는데 할 일 화면이 닫혀 있으면 경고창으로 알린다.
    function notifyNewSuggestions(current) {
        if (!C.seenSugIds || C.isOpen()) return;
        const fresh = current.filter((row) => !C.seenSugIds.has(row.id));
        if (!fresh.length) return;
        const name = fresh[0].agentName || "";
        T.notices.alert({
            key: "todo-suggestion",
            title: t("todos"),
            text: name ? t("todosNewSuggest", { name }) : t("todosNewSuggestAnon"),
            actions: [
                {
                    label: t("open"),
                    run() {
                        if (location.pathname !== "/t") T.util.pushUrl("/t");
                        T.app?.renderRoute?.();
                    },
                },
            ],
        });
    }

    // 서버에서 목록을 새로 받았을 때, 주소로 들어온 할 일이 있는지/사라졌는지 확인한다.
    function settlePendingDeepLink() {
        const id = pendingDeepId;
        if (C.item(id)) {
            openDeepLinkTarget(id);
            return;
        }
        pendingDeepId = null;
        C.toastGone(id);
    }

    // 할 일 데이터가 바뀌었을 때(freshData === true는 서버에서 새로 받은 것).
    // 할 일 창들은 목록이 내려가 있어도 열려 있을 수 있으므로 늘 맞춘다.
    function onTodosChanged(freshData) {
        const current = C.suggestions();
        notifyNewSuggestions(current);
        C.seenSugIds = new Set(current.map((row) => row.id));
        if (pendingDeepId && freshData === true) settlePendingDeepLink();
        C.syncWindows(freshData);
        if (C.isOpen()) C.build();
    }

    // 페이지를 떠난다: 열린 할 일 창들에서 고친 것을 저장 요청으로 남긴다(응답은 기다리지 않는다).
    function flushOnLeave() {
        for (const ed of C.eds.values()) {
            if (!ed.draft) continue;
            C.pullFields(ed);
            const parsed = C.draftToPatch(ed.draft);
            if (parsed.error || !Object.keys(parsed.body).length) continue;
            try {
                const headers = { "Content-Type": "application/json" };
                const tk = localStorage.getItem("tabybot.web.token");
                if (tk) headers.Authorization = `Bearer ${tk}`;
                fetch(`/api/todos/${encodeURIComponent(ed.id)}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ ...parsed.body, baseUpdatedAt: ed.draft.base }),
                    keepalive: true,
                });
            } catch {
                // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
            }
        }
    }

    /* ── 구독 ──────────────────────────────────────────────── */
    function init() {
        const closeHandPop = () => {
            C.handPopFor = null;
            if (C.isOpen()) C.build();
        };
        document.addEventListener("click", (e) => {
            if (C.handPopFor && !e.target.closest?.(".td-hand-wrap")) closeHandPop();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !C.handPopFor || e.defaultPrevented) return;
            e.preventDefault();
            closeHandPop();
        });
        state.on("todos", onTodosChanged);
        // 에이전트가 바뀌면 행의 담당 이름이 달라진다(할 일 창들은 screen.on으로 windows.js가 다시 그린다).
        state.on("bots", () => {
            if (C.isOpen()) C.build();
        });
        window.addEventListener("pagehide", flushOnLeave);
        const scroller = page.parentElement;
        scroller?.addEventListener("wheel", () => (C.scrollToRow = null), { passive: true });
        scroller?.addEventListener("touchmove", () => (C.scrollToRow = null), { passive: true });
        T.i18n.onChange(() => {
            if (!C.isOpen()) return;
            page.setAttribute("aria-label", t("todos"));
            C.build();
            T.chat?.refreshHeader?.();
            T.composer?.syncMode?.();
        });
    }

    function describeDue(msg) {
        const parts = [String(msg?.title || "")];
        const w = C.whenLabel({
            status: "open",
            kind: msg?.kind,
            cron: msg?.cron,
            every: msg?.every,
            at: msg?.at,
            timezone: msg?.timezone,
        });
        if (w) parts.push(w);
        return parts.filter(Boolean).join(", ").slice(0, 180);
    }

    T.todosUI = {
        init,
        open,
        hide,
        isOpen: C.isOpen,
        routeFromPath: C.routeFromPath,
        addFromComposer: C.addFromComposer,
        describeDue,
    };
})(window.Taby);
