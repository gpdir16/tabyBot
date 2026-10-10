/* tabyBot 웹 클라이언트: 목록 행 부품. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const t = (k, v) => T.i18n.t(k, v);

    function dotEl(color) {
        return T.h("i", { class: "td-dot", style: `background:${T.util.safeColor(color)}` });
    }

    function pauseBtn(item) {
        const paused = item.enabled === false;
        const btn = T.h(
            "button",
            {
                type: "button",
                class: `td-check td-pause${paused ? " on" : ""}`,
                "aria-label": paused ? t("todosResume") : t("todosPause"),
                "aria-pressed": String(paused),
                title: paused ? t("todosResume") : t("todosPause"),
            },
            [T.icon(paused ? "play" : "pause")],
        );
        btn.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") e.stopPropagation();
        });
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            C.toggleEnabled(item);
        });
        return btn;
    }

    function checkBtn(item, checked) {
        const btn = T.h(
            "button",
            {
                type: "button",
                class: `td-check${checked ? " on" : ""}`,
                "aria-label": checked ? t("todosMarkOpen") : t("todosMarkDone"),
                "aria-pressed": String(checked),
            },
            [T.icon("check")],
        );
        btn.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") e.stopPropagation();
        });
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            C.toggle(item, !checked);
        });
        return btn;
    }

    function whoSpan(item) {
        if (C.isJob(item)) {
            const exec = item.executor;
            if (!exec) return null;
            return T.h("span", { class: "td-who" }, [dotEl(exec.color || "#8e8e93"), T.h("span", { text: t("todosRunBy", { name: exec.name }) })]);
        }
        if (!item.assigneeId) return null;
        const name = item.assignee?.name || t("todosAssigneeRemoved");
        return T.h("span", { class: "td-who" }, [dotEl(item.assignee?.color || "#8e8e93"), T.h("span", { text: t("todosAssignedTo", { name }) })]);
    }

    // 열린 항목의 상태(멈춤·마지막 실행·응답 대기·실행 중·실패)를 나타내는 표시들.
    function stateParts(item) {
        const parts = [];
        if (C.isJob(item) && item.enabled === false) {
            parts.push(T.h("span", { class: "td-when paused", text: t("todosPaused") }));
        }
        if (C.isJob(item) && item.lastRunAt) {
            parts.push(T.h("span", { class: "td-when", text: t("todosLastRun", { time: C.formatDay(item.lastRunAt) }) }));
        }
        if (item.waiting) {
            parts.push(T.h("span", { class: "td-when waiting", text: t("todosNeedsYou") }));
            const q = String(item.waiting.question || "")
                .replace(/\s+/g, " ")
                .trim();
            if (q) parts.push(T.h("span", { class: "td-wait-q", title: q, text: q }));
        } else if (item.running) {
            parts.push(T.h("span", { class: "td-when running", text: t("todosRunning") }));
        }
        if (item.lastError?.message) {
            const raw = String(item.lastError.message);
            const reason = raw === "interrupted" ? t("todosRunInterrupted") : raw.replace(/\s+/g, " ").trim().slice(0, 80);
            parts.push(T.h("span", { class: "td-when failed", title: raw, text: `${t("todosRunFailed")} · ${reason}` }));
        }
        return parts;
    }

    function metaEl(item, done) {
        const parts = [];
        const when = C.whenLabel(item);
        if (when) {
            const cls = `td-when${done ? "" : C.isOverdue(item) ? " over" : C.isTodayKind(item) ? " today" : ""}`;
            parts.push(T.h("span", { class: cls, text: when }));
        }
        if (!done) parts.push(...stateParts(item));
        if (!done) {
            const who = whoSpan(item);
            if (who) parts.push(who);
        }
        if (!parts.length) return null;
        const meta = T.h("div", { class: "td-row-meta" });
        parts.forEach((p, i) => {
            if (i) meta.append(T.h("span", { class: "td-sep", text: "·" }));
            meta.append(p);
        });
        return meta;
    }

    function rowEl(item, done) {
        const editing = C.editId === item.id && C.draft;
        const job = C.isJob(item);
        const checked = done || (!job && !!item.periodDone);
        // 편집 중인 행도 그대로 두고, 편집기는 상세 화면에 그린다(renderDetail).
        const row = T.h(
            "div",
            {
                class: `td-row${checked ? " is-done" : ""}${editing ? " is-open" : ""}`,
                role: "listitem",
                tabindex: "0",
                dataset: { id: item.id },
                "aria-label": [
                    item.title,
                    C.whenLabel(item),
                    done ? t("todosDoneState") : !job && item.periodDone ? t("todosPeriodDoneState") : "",
                    job && item.enabled === false ? t("todosPaused") : "",
                    item.running ? t("todosRunning") : "",
                    t("todosEditHint"),
                ]
                    .filter(Boolean)
                    .join(", "),
            },
            [
                job && !done ? pauseBtn(item) : checkBtn(item, checked),
                T.h("div", { class: "td-row-main" }, [T.h("div", { class: "td-row-title", text: item.title }), metaEl(item, done)]),
                (!done && C.handoffEl(item, true)) || T.h("span", { class: "td-edit-cue", "aria-hidden": "true" }, [T.icon("chevron", "icon-sm")]),
            ],
        );
        row.addEventListener("click", () => C.openEdit(item.id));
        row.addEventListener("keydown", (e) => {
            if (e.target !== row) return;
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                C.openEdit(item.id);
            }
        });
        return row;
    }

    C.dotEl = dotEl;
    C.pauseBtn = pauseBtn;
    C.checkBtn = checkBtn;
    C.rowEl = rowEl;
})(window.Taby);
