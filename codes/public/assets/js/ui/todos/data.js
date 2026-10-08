/* tabyBot 웹 클라이언트: 할 일 데이터 접근과 서버 동기화. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    C.loading = false;

    C.intentSeq = 0;

    const dispatching = new Set();

    /* ── 라우트 / 데이터 접근 ──────────────────────────────── */
    function routeFromPath() {
        const m = /^\/t(?:\/(.*?))?\/?$/.exec(location.pathname || "");
        if (!m) return null;
        return { id: m[1] && m[1] !== "new" ? m[1] : null };
    }

    function isOpen() {
        return !page.hidden;
    }

    function items() {
        return state.state.todos || [];
    }

    // 봇 소유 자동화 잡인가 (list !== "user")
    function isJob(item) {
        return (item?.list || "user") !== "user";
    }

    // 섹션 키: jobs(봇 자동화) / agent(봇에게 맡긴 일) / user(직접 할 일)
    function secKeyOf(item) {
        if (isJob(item)) return "jobs";
        return item?.assigneeId ? "agent" : "user";
    }

    function suggestions() {
        return state.state.todoSuggestions || [];
    }

    function humanErr(err) {
        const code = typeof err?.payload === "string" ? err.payload : err?.payload?.error;
        const map = {
            title_required: "todosNoTitle",
            not_found: "todosErrGone",
            target_missing: "todosErrTargetGone",
            target_required: "todosErrTargetGone",
            offer_not_found: "todosErrNoOffer",
            too_many: "todosErrTooMany",
            agent_not_found: "todosErrNoAgent",
            "already running": "todosErrRunning",
            "scheduler not ready": "todosErrNotReady",
            not_open: "todosErrNotOpen",
            not_done: "todosErrNotDone",
            invalid_status: "todosErrGone",
            not_assigned: "todosErrNoAssignee",
            schedule_required: "todosErrNeedSchedule",
            not_a_user_todo: "todosErrGone",
            too_many_suggestions: "todosErrTooManySug",
            internal_error: "todosErrInternal",
            invalid_json: "todosErrBadReq",
            conflict: "todosErrConflict",
        };
        if (code && map[code]) return t(map[code]);
        if (typeof code !== "string") return T.api.errorText(err, t("errorPrefix"));
        if (code.startsWith("invalid cron") || code.startsWith("cron never fires")) return t("todosErrCron");
        if (code === "at must be in the future") return t("todosErrPast");
        if (code.startsWith("at must be")) return t("todosErrAt");
        if (code.startsWith("invalid timezone")) return t("todosErrTz");
        if (
            code.startsWith("Provide exactly one") ||
            code.startsWith("invalid datetime") ||
            code.startsWith("at requires") ||
            code.startsWith("interval") ||
            code.startsWith("kind ")
        )
            return t("todosErrSchedule");
        return T.api.errorText(err, t("errorPrefix"));
    }

    /* ── 서버 동기화 ───────────────────────────────────────── */
    async function refresh() {
        C.loading = true;
        let ok = false;
        try {
            await state.fetchTodos();
            ok = true;
        } catch (err) {
            T.toast.show("error", humanErr(err));
        } finally {
            C.loading = false;
            if (C.editId && C.editId !== C.pendingDeepId && !items().some((row) => row.id === C.editId)) {
                const goneId = C.editId;
                C.closeGoneEditor(goneId);
                C.toastGone(goneId);
            } else if (C.editId && !C.draft && C.editId !== C.pendingDeepId) {
                C.beginEdit(C.editId);
                C.focusEdit = true;
            }
            if (isOpen()) C.build();
        }
        return ok;
    }

    async function addFromComposer(title, assigneeId) {
        const text = String(title || "").trim();
        if (!text) return false;
        try {
            const r = await T.api.createTodo({ title: text, timezone: C.browserTz(), assigneeId: assigneeId || undefined });
            C.scrollToRow = { id: r?.item?.id || "", until: Date.now() + 900 };
            await refresh();
            const bot = assigneeId ? (state.state.bots || []).find((b) => b.id === assigneeId) : null;
            T.toast.show("info", bot ? t("todosAssignedTo", { name: bot.name }) : t("todosAdded"));
            return true;
        } catch (err) {
            T.toast.show("error", humanErr(err));
            return false;
        }
    }

    async function toggle(item, on) {
        if (C.saving) {
            C.queuePending(() => {
                if (!routeFromPath()) return;
                const cur = items().find((row) => row.id === item.id);
                if (!cur || !!(cur.status === "done" || cur.periodDone) === !!on) return;
                toggle(cur, on);
            });
            return;
        }
        if (C.editId === item.id && C.draft) {
            const ok = await C.commitDraft();
            if (!ok) {
                C.build();
                return;
            }
        }
        if (C.editId === item.id) C.closeEditor();
        C.saving = true;
        try {
            if (on) await T.api.completeTodo(item.id);
            else await T.api.reopenTodo(item.id);
            if (on) {
                const recurring = item.kind === "every" || item.kind === "cron";
                if (recurring) {
                    T.toast.show("info", t("todosPeriodDone"));
                } else {
                    C.doneOpen[secKeyOf(item)] = true;
                    T.toast.show("info", t("todosMovedDone"));
                }
            } else {
                T.toast.show("info", t("todosReopened"));
            }
            await refresh();
        } catch (err) {
            T.toast.show("error", humanErr(err));
            C.build();
        } finally {
            C.saving = false;
            C.runPending();
        }
    }

    C.dispatching = dispatching;
    C.routeFromPath = routeFromPath;
    C.isOpen = isOpen;
    C.items = items;
    C.isJob = isJob;
    C.suggestions = suggestions;
    C.humanErr = humanErr;
    C.refresh = refresh;
    C.addFromComposer = addFromComposer;
    C.toggle = toggle;
})(window.Taby);
