/* tabyBot 웹 클라이언트: 할 일 창(ui/windows.js). 할 일마다 창 세 가지가 있다.
   t:<id>       세부사항: 제목·지시·일정과 담당 행·지금 실행·삭제. 닫으면 고친 것을 저장한다(제목이 비었거나 일정이 잘못됐으면 알리고 머문다).
   t.when:<id>  일정: 고른 값은 그 할 일의 초안에 들어간다. 세부사항 창이 열려 있으면 그 창을 닫을 때, 아니면 일정 창을 닫을 때 저장한다.
   t.who:<id>   담당: 고르면 바로 바꾸고 닫힌다.
   세 창은 같은 할 일이면 초안 하나를 나눠 쓰고(draft.js의 C.eds), 다른 할 일의 창과는 따로 고치고 따로 저장된다. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    const KINDS = ["t", "t.when", "t.who"];
    const isTodoWin = (w) => KINDS.includes(w.kind);

    // 이 할 일의 열린 창들(id를 주지 않으면 모든 할 일의 창).
    function todoWins(id) {
        return T.windows.list().filter((w) => isTodoWin(w) && (id == null || w.arg === id));
    }

    // 목록에서 세부사항 창이 열린 할 일의 행을 표시한다.
    function markOpen() {
        for (const row of page.querySelectorAll(".td-row[data-id]")) row.classList.toggle("is-open", !!T.windows.get(`t:${row.dataset.id}`));
    }

    // 목록의 행을 눌렀다: 그 할 일의 세부사항 창을 연다(이미 열려 있으면 그 창을 보인다). 데스크톱은 제목에 포커스를 준다.
    function openDetail(id) {
        const win = T.windows.open(`t:${id}`);
        if (!win) return;
        markOpen();
        if (T.windows.isMobile()) return;
        const input = win.body?.querySelector(".td-edit-title");
        if (!input) return;
        input.focus({ preventScroll: true });
        input.selectionStart = input.selectionEnd = input.value.length;
    }

    // 이 할 일의 창들을 지금 초안으로 다시 그린다(일정 모드를 바꿈, 일정 창을 닫음 등).
    function redrawTodo(id) {
        C.pullFields(C.eds.get(id));
        T.windows.refresh((w) => isTodoWin(w) && w.arg === id, { force: true });
    }

    // 할 일 데이터가 바뀌었다: 초안을 서버 값에 다시 맞추고 창들을 다시 그린다. 대상이 사라진 창은 windows.js가 닫는다.
    // fresh: 서버에서 새로 받은 목록인가(그때만 사라졌다고 알린다).
    function syncWindows(fresh) {
        for (const id of new Set(todoWins().map((w) => w.arg))) {
            const item = C.item(id);
            const ed = C.eds.get(id);
            if (!item) {
                if (fresh === true) {
                    C.eds.delete(id);
                    C.toastGone(id);
                }
                continue;
            }
            if (!ed?.draft) continue;
            C.pullFields(ed);
            if (C.rebaseDraft(ed.draft, item)) T.toast.show("info", t("todosExternChanged"));
        }
        T.windows.refresh(isTodoWin);
    }

    // 목록과 할 일 창들을 다시 그린다(저장하지 못하고 머물 때 등).
    function redraw() {
        if (C.isOpen()) C.build();
        T.windows.refresh(isTodoWin, { force: true });
    }

    // 창이 닫힌 뒤: 이 할 일의 창이 더 없으면 남은 초안을 저장하고 편집 상태를 치운다.
    // 묻지 않고 닫힌 경우(모바일의 브라우저 뒤로 가기 등)에도 고친 것을 잃지 않는다. 저장하지 못하면 초안을 남겨 다음에 열 때 보인다.
    function afterClose(id) {
        markOpen();
        if (todoWins(id).length) {
            redrawTodo(id);
            return;
        }
        const ed = C.eds.get(id);
        if (!ed) return;
        if (!C.item(id) || !ed.draft) {
            C.eds.delete(id);
            return;
        }
        void C.commitDraft(ed).then((ok) => {
            if (ok && !todoWins(id).length) C.eds.delete(id);
        });
    }

    // 담당을 고를 상대가 있는가: 끝나지 않은 일이고, 맡은 에이전트나 다른 에이전트가 있을 때.
    function canAssign(item) {
        if (!item || item.status === "done") return false;
        const offers = (item.offers || []).filter((o) => o.agentId !== item.assigneeId);
        const bots = (state.state.bots || []).filter((b) => b.id !== item.assigneeId);
        return !!(item.assigneeId || offers.length || bots.length);
    }

    // 값이 오른쪽에 보이고 누르면 한 단계 더 들어가는(창을 여는) 행.
    function navRow(label, value, onclick) {
        return T.h("button", { type: "button", class: "set-row nav-row", onclick }, [
            T.h("span", { class: "set-label", text: label }),
            T.h("span", { class: "nav-val", text: value }),
            T.icon("chevron", "nav-chev"),
        ]);
    }

    /* ── 세부사항 창 ─────────────────────────────────────────── */
    function detailScreen(id) {
        if (!C.item(id)) return null;
        // 새로 고친 뒤 주소에서 다시 열 때도 목록의 행에 표시가 붙게 한다(창이 띠에 들어간 뒤).
        queueMicrotask(markOpen);
        return {
            cls: "td-view",
            on: ["bots"],
            title: () => t("todosDetails"),
            gone: () => !C.item(id),
            build(body, win) {
                const item = C.item(id);
                if (!item) return;
                const ed = C.edFor(id);
                const d = C.draftOf(ed);
                const wait = C.waitNote(item);
                if (wait) body.append(wait);
                body.append(T.h("div", { class: "set-group td-title-group" }, [C.titleHead(item, ed, win)]));
                const prompt = C.promptEl(item, ed);
                if (prompt) body.append(T.h("div", { class: "set-group td-prompt-group" }, [prompt]));
                // 일정과 담당은 이 창 옆에 열리는 창에서 고른다(windows.js가 이어진 행들을 한 묶음으로 감싼다).
                if (item.status !== "done") body.append(navRow(t("todosSchedule"), C.modeLabel(d), () => win.open(`t.when:${id}`)));
                if (canAssign(item)) {
                    // 실행 주체(서버의 executor): 맡은 에이전트, 또는 자동화 작업이면 그 작업을 가진 에이전트. 둘 다 없을 때만 "나"다.
                    const who = item.executor?.name || (item.assigneeId ? t("todosAssigneeRemoved") : t("todosMine"));
                    body.append(navRow(t("todosAssignee"), who, () => win.open(`t.who:${id}`)));
                }
                const offers = C.offersEl(item);
                if (offers) body.append(T.h("div", { class: "set-group td-offers-group" }, [offers]));
                for (const b of [C.runBtn(item), C.deleteBtn(item, win)]) if (b) body.append(T.h("div", { class: "set-group td-act-group" }, [b]));
            },
            // 닫기(× / ‹ / Esc / 밀기): 고친 것을 저장한다. 저장하지 못하면(알린 뒤) 머문다.
            beforeClose() {
                if (!C.item(id)) return true;
                return C.commitDraft(C.edFor(id));
            },
            onClose: () => afterClose(id),
        };
    }

    /* ── 일정 창 ─────────────────────────────────────────────── */
    function whenScreen(id) {
        const editable = () => {
            const item = C.item(id);
            return !!item && item.status !== "done";
        };
        if (!editable()) return null;
        return {
            cls: "td-view",
            title: () => t("todosSchedule"),
            gone: () => !editable(),
            build(body, win) {
                body.append(C.whenEditor(C.edFor(id), win));
            },
            // 세부사항 창이 열려 있으면 고른 일정은 그 창의 초안에 남는다(그 창을 닫을 때 저장한다). 아니면 여기서 저장한다.
            beforeClose() {
                if (!C.item(id)) return true;
                const ed = C.edFor(id);
                C.pullFields(ed);
                return T.windows.get(`t:${id}`) ? true : C.commitDraft(ed);
            },
            onClose: () => afterClose(id),
        };
    }

    /* ── 담당 창 ─────────────────────────────────────────────── */
    // "나"와 에이전트들을 한 목록에 두고, 지금 담당에 체크를 붙인다. 고르면 바로 바꾸고 창을 닫는다.
    function whoList(item, win) {
        const row = (name, color, on, reason, apply, toastMsg) =>
            T.h(
                "button",
                {
                    type: "button",
                    class: `td-hand-item${on ? " on" : ""}`,
                    "aria-pressed": String(on),
                    onclick() {
                        if (!on) void C.assignFor(item, apply, toastMsg);
                        void win.close({ force: true });
                    },
                },
                [
                    color ? C.dotEl(color) : null,
                    T.h("span", { class: "td-offer-main" }, [
                        T.h("span", { class: "td-offer-name", text: name }),
                        reason ? T.h("span", { class: "td-offer-reason", text: reason }) : null,
                    ]),
                ],
            );
        const offers = (item.offers || []).filter((o) => o.agentId !== item.assigneeId);
        const bots = (state.state.bots || []).filter((b) => b.id !== item.assigneeId);
        const list = T.h("div", { class: "td-hand-pop", role: "listbox", "aria-label": t("todosAssignLabel") });
        // 지금 실행 주체(서버의 executor): 맡은 에이전트, 또는 자동화 작업이면 그 작업을 가진 에이전트.
        const now = item.executor || (item.assigneeId ? { id: item.assigneeId, name: t("todosAssigneeRemoved"), color: "#8e8e93" } : null);
        // 자동화 작업은 사람이 직접 하는 일이 아니므로 "나"를 두지 않는다.
        if (!C.isJob(item)) list.append(row(t("todosMine"), null, !now, null, C.unassign(item), t("todosMovedDirect")));
        if (now) list.append(row(now.name, now.color || "#8e8e93", true, null, null, null));
        for (const o of offers.filter((x) => x.agentId !== now?.id)) {
            list.append(
                row(o.name, o.color, false, o.reason || t("todosOffersLabel"), C.assignTo(item, o.agentId), t("todosAssignedTo", { name: o.name })),
            );
        }
        for (const b of bots.filter((x) => x.id !== now?.id && !offers.some((o) => o.agentId === x.id))) {
            list.append(row(b.name, b.color, false, null, C.assignTo(item, b.id), t("todosAssignedTo", { name: b.name })));
        }
        return list;
    }

    function whoScreen(id) {
        const can = () => canAssign(C.item(id));
        if (!can()) return null;
        return {
            cls: "td-view",
            on: ["bots"],
            title: () => t("todosAssignee"),
            gone: () => !can(),
            build(body, win) {
                body.append(whoList(C.item(id), win));
            },
            onClose: () => afterClose(id),
        };
    }

    T.windows.define("t", (arg) => (arg ? detailScreen(arg) : null));
    T.windows.define("t.when", (arg) => (arg ? whenScreen(arg) : null));
    T.windows.define("t.who", (arg) => (arg ? whoScreen(arg) : null));

    C.openDetail = openDetail;
    C.redrawTodo = redrawTodo;
    C.syncWindows = syncWindows;
    C.redraw = redraw;
})(window.Taby);
