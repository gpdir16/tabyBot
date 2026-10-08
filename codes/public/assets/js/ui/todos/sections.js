/* tabyBot 웹 클라이언트: 목록 섹션과 화면 빌드. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");
    const touchMq = window.matchMedia?.("(max-width: 860px)");
    const isTouch = () => !!touchMq?.matches;

    let recoveredDismissed = false;

    C.focusRowId = null;

    C.scrollToRow = null;

    C.lastScrollTop = 0;

    C.composing = 0;

    C.buildQueued = false;

    C.composingEl = null;

    C.composingTimer = 0;

    function doneToggleEl(doneItems, doneKey) {
        const frag = document.createDocumentFragment();
        const open = C.doneOpen[doneKey];
        const btn = T.h("button", { type: "button", class: `td-done-btn${open ? " open" : ""}`, "aria-expanded": String(open) }, [
            T.icon("chevron", "icon-sm"),
            T.h("span", { text: t("todosCompleted", { n: doneItems.length }) }),
        ]);
        btn.addEventListener("click", async () => {
            C.doneOpen[doneKey] = !C.doneOpen[doneKey];
            build();
        });
        frag.append(btn);
        if (open) {
            const card = T.h("div", { class: "td-card td-done-card", role: "list" });
            for (const item of doneItems) card.append(C.rowEl(item, true));
            frag.append(card);
        }
        return frag;
    }

    function sectionEl(title, openItems, doneItems, emptyKey, doneKey) {
        const sec = T.h("section", { class: "td-sec" }, [
            T.h("div", { class: "td-sec-head" }, [
                T.h("h2", { class: "td-sec-title", text: title }),
                openItems.length ? T.h("span", { class: "td-sec-count", text: String(openItems.length) }) : null,
            ]),
        ]);
        if (!openItems.length && !doneItems.length) {
            sec.append(T.h("div", { class: "td-empty", text: t(emptyKey) }));
            return sec;
        }
        if (openItems.length) {
            const card = T.h("div", { class: "td-card", role: "list" });
            for (const item of openItems) card.append(C.rowEl(item, false));
            sec.append(card);
        }
        if (doneItems.length) sec.append(doneToggleEl(doneItems, doneKey));
        return sec;
    }

    // "에이전트" 통합 섹션: 봇에게 맡긴 할 일(접기 가능) + 봇 자동화 잡.
    const AGENT_OPEN_KEY = "tabybot.todos.agentOpenCollapsed";

    let agentOpenCollapsed = false;

    try {
        agentOpenCollapsed = localStorage.getItem(AGENT_OPEN_KEY) === "1";
    } catch {
        // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
    }

    function agentsSectionEl(agentOpen, agentDone, jobsOpen, jobsDone) {
        const total = agentOpen.length + jobsOpen.length;
        const sec = T.h("section", { class: "td-sec" }, [
            T.h("div", { class: "td-sec-head" }, [
                T.h("h2", { class: "td-sec-title", text: t("todosAgents") }),
                total ? T.h("span", { class: "td-sec-count", text: String(total) }) : null,
            ]),
        ]);
        if (!total && !agentDone.length && !jobsDone.length) {
            sec.append(T.h("div", { class: "td-empty", text: t("todosEmptyAgents") }));
            return sec;
        }
        if (agentOpen.length) {
            const collapsed = agentOpenCollapsed;
            const head = T.h(
                "button",
                { type: "button", class: `td-done-btn td-sub-head${collapsed ? "" : " open"}`, "aria-expanded": String(!collapsed) },
                [T.icon("chevron", "icon-sm"), T.h("span", { text: `${t("todosAgent")} (${agentOpen.length})` })],
            );
            head.addEventListener("click", async () => {
                agentOpenCollapsed = !collapsed;
                try {
                    localStorage.setItem(AGENT_OPEN_KEY, agentOpenCollapsed ? "1" : "0");
                } catch {
                    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
                }
                build();
            });
            sec.append(head);
            if (!collapsed) {
                const card = T.h("div", { class: "td-card", role: "list" });
                for (const item of agentOpen) card.append(C.rowEl(item, false));
                sec.append(card);
            }
        }
        if (jobsOpen.length) {
            if (agentOpen.length) sec.append(T.h("div", { class: "td-sub-label", text: t("todosJobs") }));
            const card = T.h("div", { class: "td-card", role: "list" });
            for (const item of jobsOpen) card.append(C.rowEl(item, false));
            sec.append(card);
        }
        if (agentDone.length) sec.append(doneToggleEl(agentDone, "agent"));
        if (jobsDone.length) sec.append(doneToggleEl(jobsDone, "jobs"));
        return sec;
    }

    // 편집 중인 항목이 사라졌거나 초안이 없는 상태를 현재 목록에 맞춘다.
    function reconcileEditor() {
        if (C.handPopFor && !C.items().some((row) => row.id === C.handPopFor)) C.handPopFor = null;
        if (C.editId && C.editId !== C.pendingDeepId && !C.items().some((row) => row.id === C.editId)) {
            const goneId = C.editId;
            if (C.draft) C.toastGone(goneId);
            C.closeGoneEditor(goneId);
        } else if (C.editId && !C.draft && C.editId !== C.pendingDeepId) {
            C.beginEdit(C.editId);
            C.focusEdit = true;
        }
    }

    // 다시 그린 뒤 포커스를 되돌릴 수 있게, 지금 포커스가 어디 있는지 기억해 둔다.
    const FOCUSABLE_SELECTOR =
        ".td-edit-title,.td-edit-prompt,.td-time,.td-date,.td-num,.td-sel,.td-cron,.td-chip,.td-check,.td-done-btn,.td-handoff,.td-hand-item,.btn";

    function captureFocus() {
        const active = document.activeElement;
        let focus = null;
        if (C.inUi(active)) {
            const host = active.closest?.(".td-row,.td-sug,.td-view");
            const cls = [...(active.classList || [])].find((c) => FOCUSABLE_SELECTOR.includes(`.${c}`));
            if (cls && host?.dataset?.id) {
                const peers = [...host.querySelectorAll(`.${cls}`)];
                focus = {
                    rid: host.dataset.id,
                    sel: host.classList.contains("td-sug") ? ".td-sug" : host.classList.contains("td-view") ? ".td-view" : ".td-row",
                    // 상세 화면은 열이 여럿일 수 있다(세부사항 + 일정/담당). 어느 열이었는지도 기억한다.
                    view: host.classList.contains("td-view") ? host.dataset.view : null,
                    cls,
                    i: Math.max(0, peers.indexOf(active)),
                    s: active.selectionStart,
                    e: active.selectionEnd,
                };
            }
        }
        const rowFocus = !focus && active && page.contains(active) && active.matches?.(".td-row[data-id]") ? active.dataset.id : null;
        const doneBtnFocus =
            !focus && !rowFocus && active?.matches?.(".td-done-btn") ? [...page.querySelectorAll(".td-done-btn")].indexOf(active) : -1;
        return { focus, rowFocus, doneBtnFocus };
    }

    // 항목을 섹션별로 나눈다: 내가 할 일 / 에이전트에게 맡긴 일 / 에이전트 자동화 잡, 각각 열린 것과 끝난 것.
    function groupItems(all) {
        const doneDesc = (a, b) => String(b.lastDoneAt || b.createdAt || "").localeCompare(String(a.lastDoneAt || a.createdAt || ""));
        const open = (row) => row.status === "open";
        const done = (row) => row.status === "done";
        const mine = (row) => !C.isJob(row) && !row.assigneeId;
        const handed = (row) => !C.isJob(row) && row.assigneeId;
        return {
            mineOpen: all.filter((row) => open(row) && mine(row)),
            agentOpen: all.filter((row) => open(row) && handed(row)),
            jobsOpen: all.filter((row) => open(row) && C.isJob(row)),
            mineDone: all.filter((row) => done(row) && mine(row)).sort(doneDesc),
            agentDone: all.filter((row) => done(row) && handed(row)).sort(doneDesc),
            jobsDone: all.filter((row) => done(row) && C.isJob(row)).sort(doneDesc),
        };
    }

    function loadFailedEl() {
        const retryBtn = T.h("button", { type: "button", class: "btn", text: t("retry") });
        retryBtn.addEventListener("click", () => {
            retryBtn.disabled = true;
            C.refresh().catch(() => {
                /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
            });
        });
        return T.h("div", { class: "td-loadfail" }, [T.h("div", { class: "td-empty", text: t("todosLoadFailed") }), retryBtn]);
    }

    // 저장소가 깨져 복구됐음을 알리는 배너.
    function recoveredBannerEl(rec) {
        const x = T.h("button", { type: "button", class: "td-recovered-x", text: "×", "aria-label": t("todosDismiss") });
        x.addEventListener("click", () => {
            recoveredDismissed = true;
            build();
        });
        return T.h("div", { class: "td-recovered" }, [
            T.h("div", { class: "td-recovered-msg", text: t("todosStoreRecovered", { file: rec.backup || "todos.json.bak" }) }),
            x,
        ]);
    }

    function wrapChildrenFor(all) {
        if (state.state.todosFailed && !all.length) return [loadFailedEl()];
        const groups = groupItems(all);
        const pending = C.suggestions();
        const secUser = sectionEl(t("todosUser"), groups.mineOpen, groups.mineDone, "todosEmptyUser", "user");
        const secAgents = agentsSectionEl(groups.agentOpen, groups.agentDone, groups.jobsOpen, groups.jobsDone);
        const secSug = C.suggestionsEl(pending);
        // 제안이 있으면 맨 위에 둔다.
        return pending.length ? [secSug, secUser, secAgents] : [secUser, secAgents, secSug];
    }

    function restoreFieldFocus(focus) {
        // 편집기가 상세 화면에 있으면 같은 id의 행이 목록에도 있다. 상세 화면 쪽을 먼저 찾는다.
        const hostSel = `${focus.sel || ".td-row"}[data-id="${focus.rid}"]${focus.view ? `[data-view="${focus.view}"]:not(.col-out)` : ""}`;
        const host = focus.rid ? C.sheetHost?.querySelector(hostSel) || page.querySelector(hostSel) : null;
        const el = host ? host.querySelectorAll(`.${focus.cls}`)[focus.i] : null;
        if (!el) return;
        el.focus({ preventScroll: true });
        try {
            el.setSelectionRange?.(focus.s ?? el.value?.length ?? 0, focus.e ?? el.value?.length ?? 0);
        } catch {
            // 선택 범위를 지정할 수 없는 입력 종류면 무시한다
        }
    }

    // 방금 연 편집기의 제목에 포커스를 준다(데스크톱만). 줬으면 true.
    function focusNewEditorTitle() {
        const input = C.find(".td-edit-title");
        if (!input || isTouch()) return false;
        input.focus({ preventScroll: true });
        input.selectionStart = input.selectionEnd = input.value.length;
        return true;
    }

    function focusRow(id) {
        const el = page.querySelector(`.td-row[data-id="${id}"]`);
        if (!el) return;
        // 행을 보이게 하되 앱의 가로 스크롤(데스크톱의 열 위치)은 건드리지 않는다.
        const app = document.getElementById("app");
        const left = app.scrollLeft;
        el.scrollIntoView({ block: "nearest" });
        app.scrollLeft = left;
        el.focus({ preventScroll: true });
    }

    function restoreFocus({ focus, rowFocus, doneBtnFocus }) {
        let titleFocused = false;
        if (focus) {
            restoreFieldFocus(focus);
        } else if (C.focusEdit) {
            C.focusEdit = false;
            titleFocused = focusNewEditorTitle();
        } else {
            C.focusEdit = false;
        }
        // 방금 연 상세의 제목에 포커스를 줬으면, 누른 행으로 포커스를 되돌리지 않는다.
        const targetRow = C.focusRowId || (titleFocused ? null : rowFocus);
        C.focusRowId = null;
        if (targetRow) focusRow(targetRow);
        else if (doneBtnFocus >= 0) page.querySelectorAll(".td-done-btn")[doneBtnFocus]?.focus({ preventScroll: true });
    }

    // 요청받은 행이 화면 밖이면 보이게 스크롤한다. 보이거나 기한이 지나면 요청을 지운다.
    function applyScrollToRow() {
        if (!C.scrollToRow) return;
        const el = C.scrollToRow.id ? page.querySelector(`.td-row[data-id="${C.scrollToRow.id}"]`) : null;
        const scroller = page.parentElement;
        const r = el?.getBoundingClientRect();
        const s = scroller?.getBoundingClientRect();
        const visible = r && s && r.top >= s.top && r.bottom <= s.bottom;
        if (el && !visible) el.scrollIntoView({ block: "nearest" });
        if (!el || visible || Date.now() > C.scrollToRow.until) C.scrollToRow = null;
    }

    function build() {
        if (!page) return;
        if (C.composing) {
            C.buildQueued = true;
            return;
        }
        C.buildQueued = false;
        reconcileEditor();

        const focusSnapshot = captureFocus();
        page.replaceChildren();

        const all = C.items();
        const wrapChildren = wrapChildrenFor(all);
        const rec = state.state.todosRecovered;
        if (rec && !recoveredDismissed) wrapChildren.unshift(recoveredBannerEl(rec));
        page.append(T.h("div", { class: "td-wrap" }, wrapChildren));
        C.renderDetail(all);

        restoreFocus(focusSnapshot);
        applyScrollToRow();
    }

    C.build = build;
})(window.Taby);
