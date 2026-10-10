/* tabyBot 웹 클라이언트: 상세 화면(모바일 시트·데스크톱 열)과 뒤로 제스처. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");
    const touchMq = window.matchMedia?.("(max-width: 860px)");
    const isTouch = () => !!touchMq?.matches;

    /* 상세 화면: 편집기를 목록 안에서 펼치지 않고, 설정 화면과 같은 모양의 화면에 그린다.
       일정과 담당은 거기서 한 단계 더 들어간 화면에서 고른다. 뒤로 가면 바뀐 내용이 저장된다.
       모바일: 오른쪽에서 밀려 들어와 화면을 덮는다. 문서 맨 위 층(#app 밖)에 놓는다(스크롤 영역 안에 두면 iOS에서 입력창 밑에 깔린다).
       데스크톱: 덮지 않고 목록 오른쪽에 열로 이어 붙는다(#app 안의 마지막 열들). */
    const VIEW_MS = 420; // 화면이 밀려 들어오고 나가는 시간(app.css의 --nav-dur와 같게)

    C.sheetHost = null; // 상세 화면들이 놓이는 층

    let detailView = "main"; // "main" | "when"(일정) | "who"(담당)

    let viewTimer = 0;

    let closeAt = 0; // 데스크톱의 상세 열을 다 닫고 치울 때(performance.now 기준)

    let viewInstant = false; // 손가락으로 이미 다 밀어냈다: 다음 전환은 애니메이션 없이

    // 편집기의 요소는 목록(page)이나 시트 어느 쪽에든 있을 수 있다.
    const find = (sel) => page.querySelector(sel) || C.sheetHost?.querySelector(sel) || null;

    const inUi = (el) => !!el && (page.contains(el) || !!C.sheetHost?.contains(el));

    /* ── 섹션/빌드 ─────────────────────────────────────────── */
    /* ── 모바일 상세 화면 ──────────────────────────────────── */
    // 화면 하나: 설정 화면과 같은 머리(뒤로 버튼 + 가운데 제목)와 스크롤되는 본문.
    function viewEl(item, level, title, onBack, body) {
        const head = T.h("header", { class: "sp-head" }, [
            T.h(
                "div",
                { class: "pblur", "aria-hidden": "true" },
                Array.from({ length: 8 }, () => T.h("i")),
            ),
            T.h("button", { type: "button", class: "btn-icon sp-back", "aria-label": t("back"), onclick: onBack }, [T.icon("chevron-left")]),
            T.h("div", { class: "sp-title", text: title }),
        ]);
        return T.h("div", { class: "td-view", dataset: { id: item.id, level: String(level), view: detailView } }, [
            head,
            T.h("div", { class: "td-view-body" }, body),
        ]);
    }

    // 값이 오른쪽에 보이고 누르면 한 단계 더 들어가는 행.
    function navRow(label, value, view) {
        return T.h(
            "button",
            {
                type: "button",
                class: "set-row nav-row",
                onclick() {
                    C.pullFields();
                    detailView = view;
                    C.build();
                },
            },
            [T.h("span", { class: "set-label", text: label }), T.h("span", { class: "nav-val", text: value }), T.icon("chevron", "nav-chev")],
        );
    }

    // 담당 화면: "나"와 에이전트들을 한 목록에 두고, 지금 담당에 체크를 붙인다. 고르면 반영하고 앞 화면으로 돌아간다.
    function whoListEl(item, offers, bots) {
        const row = (name, color, on, reason, apply, toastMsg) => {
            const btn = T.h("button", { type: "button", class: `td-hand-item${on ? " on" : ""}`, "aria-pressed": String(on) }, [
                color ? C.dotEl(color) : null,
                T.h("span", { class: "td-offer-main" }, [
                    T.h("span", { class: "td-offer-name", text: name }),
                    reason ? T.h("span", { class: "td-offer-reason", text: reason }) : null,
                ]),
            ]);
            btn.addEventListener("click", () => {
                detailView = "main";
                if (on) C.build();
                else C.assignFor(item, apply, toastMsg);
            });
            return btn;
        };
        const assign = (id) => () => {
            const cur = C.items().find((r) => r.id === item.id);
            if (!cur || cur.assignee?.id === id) return;
            const offered = (cur.offers || []).find((o) => o.agentId === id);
            return offered ? T.api.acceptHandoff(item.id, id) : T.api.updateTodo(item.id, { assigneeId: id });
        };
        const list = T.h("div", { class: "td-hand-pop", role: "listbox", "aria-label": t("todosAssignLabel") });
        // 지금 실행 주체(서버의 executor): 맡은 에이전트, 또는 자동화 작업이면 그 작업을 가진 에이전트.
        const now = item.executor || (item.assigneeId ? { id: item.assigneeId, name: t("todosAssigneeRemoved"), color: "#8e8e93" } : null);
        // 자동화 작업은 사람이 직접 하는 일이 아니므로 "나"를 두지 않는다.
        if (!C.isJob(item)) {
            list.append(
                row(
                    t("todosMine"),
                    null,
                    !now,
                    null,
                    () => {
                        const cur = C.items().find((r) => r.id === item.id);
                        if (!cur?.assigneeId) return;
                        return T.api.unassignTodo(item.id);
                    },
                    t("todosMovedDirect"),
                ),
            );
        }
        if (now) list.append(row(now.name, now.color || "#8e8e93", true, null, null, null));
        for (const o of offers.filter((x) => x.agentId !== now?.id)) {
            list.append(row(o.name, o.color, false, o.reason || t("todosOffersLabel"), assign(o.agentId), t("todosAssignedTo", { name: o.name })));
        }
        for (const b of bots.filter((x) => x.id !== now?.id && !offers.some((o) => o.agentId === x.id))) {
            list.append(row(b.name, b.color, false, null, assign(b.id), t("todosAssignedTo", { name: b.name })));
        }
        return list;
    }

    // 상세에서 뒤로: 바뀐 내용을 저장하고 닫는다. 제목이 비었거나 일정이 잘못됐으면 알리고 머문다.
    function leaveDetail() {
        if (C.saving) return;
        void C.commitDraft();
    }

    function backToMain() {
        C.pullFields();
        detailView = "main";
        C.build();
    }

    // 데스크톱 편집기(editEl)를 그대로 만들어 그 부품들을 화면 구성에 맞게 옮겨 담는다.
    // 입력과 버튼의 동작을 한 벌만 유지하기 위해서다.
    function detailEl(item, checked) {
        const ed = C.editEl(item, checked);
        const head = ed.querySelector(".td-edit-head");
        const when = ed.querySelector(".td-when-editor");
        const offers = (item.offers || []).filter((o) => o.agentId !== item.assigneeId);
        const bots = (state.state.bots || []).filter((b) => b.id !== item.assigneeId);
        const done = item.status === "done";
        const canAssign = !done && (item.assigneeId || offers.length || bots.length);

        if (detailView === "when" && when) {
            return viewEl(item, 2, t("todosSchedule"), backToMain, [when]);
        }
        if (detailView === "who" && canAssign) {
            return viewEl(item, 2, t("todosAssignee"), backToMain, [whoListEl(item, offers, bots)]);
        }
        detailView = "main";

        // 맡길 상대는 다음 화면에서 고르므로 제목 칸의 버튼은 뺀다.
        head.querySelector(".td-hand-wrap")?.remove();
        const body = [];
        const wait = ed.querySelector(".td-wait-note");
        if (wait) body.push(wait);
        body.push(T.h("div", { class: "set-group td-title-group" }, [head]));
        const prompt = ed.querySelector(".td-edit-prompt");
        if (prompt) body.push(T.h("div", { class: "set-group td-prompt-group" }, [prompt]));

        const rows = [];
        if (when) rows.push(navRow(t("todosSchedule"), when.querySelector(".td-chip.on")?.textContent || t("todosWhenNone"), "when"));
        if (canAssign) {
            // 실행 주체(서버의 executor): 맡은 에이전트, 또는 자동화 작업이면 그 작업을 가진 에이전트. 둘 다 없을 때만 "나"다.
            const who = item.executor?.name || (item.assigneeId ? t("todosAssigneeRemoved") : t("todosMine"));
            rows.push(navRow(t("todosAssignee"), who, "who"));
        }
        if (rows.length) body.push(T.h("div", { class: "set-group" }, rows));
        const doneOffers = ed.querySelector(".td-edit-offers");
        if (doneOffers) body.push(T.h("div", { class: "set-group td-offers-group" }, [doneOffers]));

        // 아래쪽 버튼 가운데 취소·저장은 뒤로 버튼이 맡는다. 남은 것(지금 실행·삭제)만 행으로 둔다.
        const acts = [...ed.querySelectorAll(".td-edit-foot > .btn")].filter((b) => !b.matches(".td-foot-cancel, .td-foot-save"));
        for (const b of acts.reverse()) body.push(T.h("div", { class: "set-group td-act-group" }, [b]));
        return viewEl(item, 1, t("todosDetails"), leaveDetail, body);
    }

    // 새 화면을 밀려 들어오게/나가게 그린다. 앞 화면(prev)이 있으면 반대쪽으로 밀려 나간다.
    function slideDetailView(anim, view, prev) {
        // 위에 놓이는 쪽이 뒤에 온다: 들어갈 때는 새 화면이, 나올 때는 옛 화면이 위다.
        view.classList.add(anim === "push" ? "sp-in-right" : "sp-in-left");
        if (prev) prev.classList.add("sp-leaving", anim === "push" ? "sp-out-left" : "sp-out-right");
        if (anim === "push") C.sheetHost.append(view);
        else C.sheetHost.prepend(view);
        viewTimer = setTimeout(() => {
            prev?.remove();
            view.classList.remove("sp-in-right", "sp-in-left");
        }, VIEW_MS);
    }

    // 편집 중인 항목이 있으면 상세 화면을 그리고, 없으면 닫는다. 깊이가 달라지면 화면이 밀려 들어오고 나간다.
    function renderDetail(all) {
        const item = C.editId && C.draft ? all.find((row) => row.id === C.editId) : null;
        if (!item) {
            closeDetail();
            return;
        }
        if (!C.sheetHost) C.sheetHost = T.h("div", { class: "td-detail-host", hidden: true });
        if (!isTouch()) {
            renderDetailColumns(item);
            return;
        }
        if (C.sheetHost.parentNode !== document.body) {
            C.sheetHost.replaceChildren();
            document.body.append(C.sheetHost);
        }
        clearTimeout(viewTimer);
        for (const el of C.sheetHost.querySelectorAll(".sp-leaving")) el.remove();
        const prev = C.sheetHost.hidden ? null : C.sheetHost.querySelector(".td-view");
        const done = item.status === "done";
        const view = detailEl(item, done || (!C.isJob(item) && !!item.periodDone));
        const depth = Number(view.dataset.level) - (prev ? Number(prev.dataset.level) : 0);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const anim = !depth || viewInstant || reduce ? null : depth > 0 ? "push" : "pop";
        viewInstant = false;
        C.sheetHost.hidden = false;
        document.body.classList.add("td-detail-open");
        if (!anim) {
            const top = prev && prev.dataset.view === view.dataset.view ? prev.querySelector(".td-view-body").scrollTop : 0;
            C.sheetHost.replaceChildren(view);
            view.querySelector(".td-view-body").scrollTop = top;
            return;
        }
        slideDetailView(anim, view, prev);
    }

    // 데스크톱: 상세 화면을 목록 오른쪽에 열로 놓는다. 일정·담당을 열면 그 오른쪽에 열이 하나 더 붙는다.
    function renderDetailColumns(item) {
        const app = document.getElementById("app");
        if (C.sheetHost.parentNode !== app) {
            C.sheetHost.replaceChildren();
            app.append(C.sheetHost);
        }
        clearTimeout(viewTimer);
        viewInstant = false;
        const checked = item.status === "done" || (!C.isJob(item) && !!item.periodDone);
        const want = detailView;
        detailView = "main";
        const views = [detailEl(item, checked)];
        if (want !== "main") {
            detailView = want;
            // 고를 것이 없어진 화면(끝난 일의 담당 등)은 detailEl이 앞 화면으로 되돌린다.
            const sub = detailEl(item, checked);
            if (sub.dataset.level === "2") views.push(sub);
        }
        const old = C.sheetHost.hidden ? [] : [...C.sheetHost.querySelectorAll(".td-view:not(.col-out)")];
        const tops = views.map(
            (v) => old.find((o) => o.dataset.view === v.dataset.view && o.dataset.id === v.dataset.id)?.querySelector(".td-view-body").scrollTop,
        );
        // 닫힌 열(일정·담당에서 돌아옴)은 왼쪽 이웃 밑으로 미끄러져 들어간 뒤 치워진다.
        // 같은 자리의 열이 다른 것으로 바뀔 때(다른 할 일을 고름)는 움직이지 않고 바로 바뀐다.
        const key = (v) => `${v.dataset.id}:${v.dataset.view}`;
        const sameLevel = (list, v) => list.some((x) => x.dataset.level === v.dataset.level);
        // 닫히는 중인 열도 같은 자리에 새 열이 오면(다른 할 일로 바꿈) 바로 치운다.
        const outs = C.sheetHost.hidden ? [] : [...C.sheetHost.querySelectorAll(".td-view.col-out")];
        const gone = [...old.filter((o) => !views.some((v) => key(v) === key(o))), ...outs];
        const leaving = gone.filter((o) => !sameLevel(views, o));
        C.sheetHost.hidden = false;
        C.sheetHost.replaceChildren(...views, ...leaving);
        for (const v of leaving) T.columnOut(v);
        views.forEach((v, i) => {
            if (tops[i]) v.querySelector(".td-view-body").scrollTop = tops[i];
        });
        // 새로 생긴 열이 창 밖에 있으면 보이도록 앱의 가로 스크롤을 옮긴다.
        const last = views[views.length - 1];
        // 새로 열린 열은 오른쪽에서 미끄러져 들어온다(app.css의 col-in).
        views.forEach((v, i) => {
            T.columnIn(v, `t:${key(v)}`, tops[i] === undefined && !sameLevel(gone, v));
        });
        if (tops[views.length - 1] === undefined) T.revealColumn(last);
    }

    // instant: 화면을 떠날 때나 손가락으로 이미 밀어냈을 때. 애니메이션 없이 바로 치운다.
    function closeDetail(instant) {
        detailView = "main";
        if (!C.sheetHost || C.sheetHost.hidden) return;
        clearTimeout(viewTimer);
        document.body.classList.remove("td-detail-open");
        const clear = () => {
            C.sheetHost.hidden = true;
            C.sheetHost.replaceChildren();
        };
        const view = C.sheetHost.querySelector(".td-view:not(.sp-leaving)");
        if (!isTouch() && !instant && view) {
            // 데스크톱의 열은 왼쪽 이웃 밑으로 미끄러져 들어가며 닫힌다.
            // 닫는 중에 다시 그려져도 숨기는 때를 미루지 않는다(처음 닫기 시작한 때부터 잰다).
            if (C.sheetHost.querySelector(".td-view:not(.col-out)")) closeAt = performance.now() + VIEW_MS;
            for (const v of C.sheetHost.querySelectorAll(".td-view")) T.columnOut(v);
            viewTimer = setTimeout(clear, Math.max(0, closeAt - performance.now()));
            return;
        }
        if (instant || viewInstant || !view) {
            viewInstant = false;
            clear();
            return;
        }
        if (C.sheetHost.contains(document.activeElement)) document.activeElement.blur();
        for (const el of C.sheetHost.querySelectorAll(".sp-leaving")) el.remove();
        view.classList.remove("sp-in-right", "sp-in-left");
        view.classList.add("sp-leaving", "sp-out-right");
        viewTimer = setTimeout(clear, VIEW_MS);
    }

    /* 뒤로 제스처(ui/gestures.js)가 상세 화면을 손가락으로 밀어낼 때 쓴다(설정 화면의 gesture와 같은 약속).
       begin: 밀려 나갈 위 화면과 그 밑에서 드러날 화면을 돌려준다. 맨 앞 상세라면 밑은 할 일 목록(#main)이다. */
    const gesture = {
        host: () => C.sheetHost,
        canPop: () => isTouch() && !!C.sheetHost && !C.sheetHost.hidden && !C.saving && !!C.editId,
        begin() {
            clearTimeout(viewTimer);
            const views = [...C.sheetHost.querySelectorAll(".td-view")];
            const top = views.find((v) => !v.classList.contains("sp-leaving")) || views[views.length - 1];
            for (const v of views) if (v !== top) v.remove();
            top.classList.remove("sp-in-right", "sp-in-left");
            if (top.dataset.level !== "2") return { top, under: document.getElementById("main"), sub: false };
            // 한 단계 들어간 화면: 그 밑에 앞 화면을 깔아 둔다.
            C.pullFields();
            const was = detailView;
            detailView = "main";
            const item = C.items().find((row) => row.id === C.editId);
            const under = detailEl(item, item.status === "done" || (!C.isJob(item) && !!item.periodDone));
            detailView = was;
            C.sheetHost.prepend(under);
            return { top, under, sub: true };
        },
        end(commit, { top, under, sub }) {
            if (sub) {
                if (!commit) {
                    under.remove();
                    return;
                }
                // 깔아 둔 앞 화면이 그대로 지금 화면이 된다.
                top.remove();
                detailView = "main";
                return;
            }
            if (!commit) return;
            // 이미 손가락을 따라 다 나갔다. 저장이 되면 애니메이션 없이 닫고, 안 되면(제목 없음 등) 다시 보인다.
            viewInstant = true;
            C.commitDraft().then((ok) => {
                if (!ok) viewInstant = false;
            });
        },
    };

    C.find = find;
    C.inUi = inUi;
    C.renderDetail = renderDetail;
    C.closeDetail = closeDetail;
    C.gesture = gesture;
})(window.Taby);
