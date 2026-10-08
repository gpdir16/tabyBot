/* tabyBot 웹 클라이언트: 할 일 화면 열기/닫기와 이벤트 구독. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");
    const touchMq = window.matchMedia?.("(max-width: 860px)");
    const isTouch = () => !!touchMq?.matches;

    C.pendingDeepId = null;

    /* ── 열기/닫기 ─────────────────────────────────────────── */
    // 주소로 들어온 항목이 목록에서 확인됐을 때: 편집을 열고 그 행으로 스크롤한다.
    function openDeepLinkTarget(id) {
        C.pendingDeepId = null;
        if (!C.draft) {
            C.beginEdit(id);
            C.focusEdit = true;
        }
        if (C.editId === id) C.scrollToRow = { id, until: Date.now() + 1200 };
    }

    async function resolveDeepLink(id) {
        const ok = await C.refresh().catch(() => false);
        if (C.pendingDeepId !== id) return;
        if (C.items().some((row) => row.id === id)) {
            openDeepLinkTarget(id);
            if (C.isOpen()) C.build();
            return;
        }
        if (!ok) return;
        C.pendingDeepId = null;
        if (C.editId === id) C.closeEditor();
        if (C.editId) {
            if (C.isOpen()) C.build();
            return;
        }
        T.util.replaceUrl("/t");
        C.toastGone(id);
        if (C.isOpen()) C.build();
    }

    // 열려는 항목을 편집 상태에 반영한다. 항목이 아직 목록에 없으면 딥링크로 보고 나중에 확인한다.
    function applyOpenTarget(o) {
        if (o.id) {
            if (o.id !== C.editId) C.draft = null;
            else if (C.draft) {
                const cur = C.items().find((row) => row.id === o.id);
                if (cur) C.draft.base = cur.updatedAt || C.draft.base;
            }
            C.editId = o.id;
            C.pendingDeepId = C.items().some((row) => row.id === o.id) ? null : o.id;
            if (!C.pendingDeepId) C.scrollToRow = { id: o.id, until: Date.now() + 1200 };
        } else {
            C.pendingDeepId = null;
            C.closeEditor();
        }
    }

    // 주소를 화면 상태에 맞춘다. 주소에서 들어온 것(fromUrl)이면 바꾸지 않는다.
    function syncUrlForOpen(o) {
        if (!o.fromUrl) {
            const path = o.id ? `/t/${o.id}` : "/t";
            if (o.replace) T.util.replaceUrl(path);
            else T.util.pushUrl(path);
        } else if (!o.id && location.pathname !== "/t") {
            T.util.replaceUrl("/t");
        }
    }

    function open(opt) {
        const o = opt || {};
        const my = ++C.intentSeq;
        if (C.saving) {
            C.queuePending(() => {
                if (C.routeFromPath()) open(o);
            });
            return;
        }
        if (o.id !== C.editId && C.draft) {
            C.commitDraft().then((ok) => {
                if (ok && my === C.intentSeq && C.routeFromPath()) open(o);
                else if (!ok && my === C.intentSeq && C.routeFromPath()) open({ id: C.editId, replace: true });
            });
            return;
        }
        applyOpenTarget(o);
        T.settingsUI?.hide?.();
        T.sidebar?.showChat?.();
        syncUrlForOpen(o);
        const wasHidden = page.hidden;
        page.hidden = false;
        page.setAttribute("aria-label", t("todos"));
        if (wasHidden && !o.id && !isTouch()) page.focus({ preventScroll: true });
        document.body.classList.add("todos-route");
        state.setCurrentTodo("list");
        T.sidebar?.syncRoute?.();
        T.chat?.refreshHeader?.();
        T.composer?.syncMode?.();
        const scroller = page.parentElement;
        if (scroller && wasHidden) scroller.scrollTop = o.id ? 0 : C.lastScrollTop;
        C.build();
        if (C.pendingDeepId) void resolveDeepLink(C.pendingDeepId);
        else if (!C.items().length && !C.suggestions().length && !C.loading) C.refresh();
    }

    function hide() {
        C.lastScrollTop = page.parentElement?.scrollTop ?? 0;
        page.hidden = true;
        document.body.classList.remove("todos-route");
        C.pendingDeepId = null;
        C.handPopFor = null;
        C.composing = 0;
        C.composingEl = null;
        clearTimeout(C.composingTimer);
        C.buildQueued = false;
        C.scrollToRow = null;
        if (C.editId && C.draft) void C.commitDraft();
        else C.closeEditor();
        state.setCurrentTodo(null);
        page.replaceChildren();
        C.closeDetail(true);
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

    // 서버에서 목록을 새로 받았을 때, 주소로 들어온 항목이 있는지/사라졌는지 확인한다.
    function settlePendingDeepLink() {
        const id = C.pendingDeepId;
        if (C.items().some((row) => row.id === id)) {
            openDeepLinkTarget(id);
            return;
        }
        C.pendingDeepId = null;
        if (C.editId === id) C.closeGoneEditor(id);
        if (!C.editId) {
            T.util.replaceUrl("/t");
            C.toastGone(id);
        }
    }

    // 할 일 데이터가 바뀌었을 때(freshData === true는 서버에서 새로 받은 것).
    function onTodosChanged(freshData) {
        const current = C.suggestions();
        notifyNewSuggestions(current);
        C.seenSugIds = new Set(current.map((row) => row.id));
        if (C.pendingDeepId && freshData === true) settlePendingDeepLink();
        if (!C.isOpen()) return;
        if (freshData === true && C.editId && !C.items().some((row) => row.id === C.editId)) {
            const goneId = C.editId;
            C.closeGoneEditor(goneId);
            C.toastGone(goneId);
        }
        if (C.editId && C.draft) {
            if (!C.composing) C.pullFields();
            const fresh = C.items().find((row) => row.id === C.editId);
            if (fresh && C.rebaseDraft(fresh)) T.toast.show("info", t("todosExternChanged"));
        }
        C.build();
    }

    /* ── 구독 ──────────────────────────────────────────────── */
    function init() {
        document.addEventListener("click", (e) => {
            if (!C.handPopFor || e.target.closest?.(".td-hand-wrap")) return;
            C.handPopFor = null;
            if (C.isOpen()) C.build();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !C.handPopFor || e.defaultPrevented) return;
            C.handPopFor = null;
            if (C.isOpen()) C.build();
        });
        state.on("todos", onTodosChanged);
        page.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
            if (C.handPopFor) {
                e.preventDefault();
                C.handPopFor = null;
                C.build();
                return;
            }
            if (C.editId && !e.target?.closest?.(".td-sug")) {
                e.preventDefault();
                C.cancelEdit();
            }
        });
        const endComposition = () => {
            C.composing = 0;
            C.composingEl = null;
            clearTimeout(C.composingTimer);
            if (C.buildQueued) {
                C.buildQueued = false;
                C.build();
            }
        };
        // 편집기는 목록(page) 밖의 상세 화면에도 있으므로 문서에서 듣고, 할 일 화면 안의 입력만 받는다.
        document.addEventListener("compositionstart", (e) => {
            if (!C.inUi(e.target)) return;
            C.composing += 1;
            C.composingEl = e.target;
            clearTimeout(C.composingTimer);
            C.composingTimer = setTimeout(endComposition, 15000);
        });
        document.addEventListener("compositionend", (e) => {
            if (!C.inUi(e.target)) return;
            C.composing = Math.max(0, C.composing - 1);
            if (!C.composing) endComposition();
        });
        document.addEventListener("focusout", (e) => {
            if (C.composing && e.target === C.composingEl) endComposition();
        });
        state.on("bots", () => {
            if (C.draft?.pendingAssignee && !(state.state.bots || []).some((b) => b.id === C.draft.pendingAssignee)) {
                C.draft.pendingAssignee = null;
                T.toast.show("info", t("todosAssigneeGone"));
            }
            if (C.editId && C.draft) C.pullFields();
            if (C.isOpen()) C.build();
        });
        window.addEventListener("pagehide", () => {
            if (!C.editId || !C.draft) return;
            C.pullFields();
            const parsed = C.draftToPatch();
            const body = parsed.error ? {} : { ...parsed.body };
            const botId = C.draft.pendingAssignee;
            if (botId) {
                body.assigneeId = botId;
                const cur = C.items().find((r) => r.id === C.editId);
                const offered = (cur?.offers || []).find((o) => o.agentId === botId);
                if (offered?.prompt && body.prompt == null) body.prompt = offered.prompt;
            }
            if (!Object.keys(body).length) return;
            try {
                const headers = { "Content-Type": "application/json" };
                const tk = localStorage.getItem("tabybot.web.token");
                if (tk) headers.Authorization = `Bearer ${tk}`;
                fetch(`/api/todos/${C.editId}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ ...body, baseUpdatedAt: C.draft.base }),
                    keepalive: true,
                });
            } catch {
                // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
            }
        });
        const scroller = page.parentElement;
        scroller?.addEventListener("wheel", () => (C.scrollToRow = null), { passive: true });
        scroller?.addEventListener("touchmove", () => (C.scrollToRow = null), { passive: true });
        T.i18n.onChange(() => {
            if (C.isOpen()) {
                if (C.editId && C.draft) C.pullFields();
                page.setAttribute("aria-label", t("todos"));
                C.build();
                T.chat?.refreshHeader?.();
                T.composer?.syncMode?.();
            }
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
        gesture: C.gesture,
    };

    C.hide = hide;
})(window.Taby);
