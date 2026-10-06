/* tabyBot 웹 클라이언트: 시스템 알림.
   서버가 보낸 알림(업데이트, 세션 압축 확인, 할 일 기한, 예약 작업 결과 등)은
   잠깐 떴다 사라지는 토스트가 아니라 OS의 경고창 같은 모달로 띄운다:
   화면 가운데 작은 창에 제목 · 내용 · 버튼이 있고, 버튼을 눌러야 닫힌다.
   한 번에 하나만 뜨고(오래된 것부터), 닫으면 다음 알림이 이어서 뜬다.

   기록은 서버(/api/notices)가 들고 있어서, 그 순간 앱을 열어 두지 않았거나 다른 기기에서
   열어도 읽지 않은 알림이 뜨고, 지난 알림은 설정의 알림 탭에서 다시 볼 수 있다.
   정본은 항상 서버 목록이다: 알림 이벤트가 오면 목록을 다시 받아 "읽지 않은 것"을 순서대로 띄운다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    const root = document.getElementById("overlayRoot");
    const LEVEL_ICON = { info: "info", warn: "warn", error: "error" };
    const ALERT_OUT_MS = 180; // 닫히는 모션(app.css의 .nt-modal.out과 같게)
    const ALERT_GAP_MS = 120; // 닫힌 뒤 다음 알림이 뜨기까지의 틈

    let items = []; // 서버 목록(최신 순)
    let loaded = false;
    let reqSeq = 0;
    let modal = null; // 떠 있는 경고창 { el, id }
    let swapTimer = 0;
    let locals = []; // 이 기기에서만 띄우는 경고창 대기열(alert())
    let localSeq = 0;
    let busyUntil = 0; // 이 시각 전에는 다음 경고창을 띄우지 않는다
    let refreshTimer = 0;
    // 알림의 버튼으로 다른 화면에 갔을 때, 남은 알림이 그 화면을 곧바로 덮지 않게 잠시 미뤄 둔다.
    // 미뤄 둔 뒤에 새 알림이 오거나 앱을 다시 열면 이어서 뜬다. 값은 미룰 당시 읽지 않았던 알림 id들.
    let snoozed = null;

    /* ── 데이터 ─────────────────────────────────────────────── */
    function apply(payload) {
        items = Array.isArray(payload?.notices) ? payload.notices : [];
        loaded = true;
        state.emit("notices");
        syncModal();
    }

    // 연속으로 오는 알림 이벤트를 한 번의 조회로 묶는다.
    function refresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
            if (state.state.offline) return;
            const seq = ++reqSeq;
            try {
                const r = await T.api.notices();
                if (seq === reqSeq) apply(r);
            } catch (_) {
                /* 다음 이벤트/재접속에서 다시 받는다 */
            }
        }, 80);
    }

    // 낙관적으로 읽음 표시한 뒤 서버에 알린다. ids가 없으면 전부.
    function markRead(ids) {
        const only = ids ? new Set(ids) : null;
        const touched = items.filter((n) => !n.read && (!only || only.has(n.id)));
        if (!touched.length) return;
        for (const n of touched) n.read = true;
        state.emit("notices");
        syncModal();
        const seq = ++reqSeq;
        T.api
            .readNotices(ids || null)
            .then((r) => {
                if (seq === reqSeq) apply(r);
            })
            .catch(() => {});
    }

    function clearAll() {
        const seq = ++reqSeq;
        return T.api.clearNotices().then((r) => {
            if (seq === reqSeq) apply(r);
        });
    }

    /* ── 한 건의 내용/동작 ──────────────────────────────────── */
    function textOf(n) {
        // 할 일 기한 알림은 서버가 원자료만 보낸다. 문구는 화면 언어로 여기서 만든다.
        if (n.type === "todo_due") return T.todosUI?.describeDue?.({ ...n, at: n.dueAt }) || n.text || n.title || "";
        return String(n.text || "");
    }

    function timeOf(n) {
        const ms = Date.parse(n.createdAt || "");
        if (!Number.isFinite(ms)) return "";
        const lang = T.i18n.getLang();
        const loc = lang === "ko" ? "ko-KR" : lang === "ja" ? "ja-JP" : "en-US";
        try {
            return new Intl.DateTimeFormat(loc, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
        } catch (_) {
            return "";
        }
    }

    function go(path) {
        snoozed = new Set(items.filter((n) => !n.read).map((n) => n.id));
        closeModal();
        try {
            if (location.pathname !== path) history.pushState(null, "", path);
        } catch (_) {}
        T.app?.renderRoute?.();
    }

    function runCompress(action) {
        void T.api
            .compressAllSessions(action.chatIds)
            .then((r) => {
                const n = Number(r?.compressed) || 0;
                const f = Number(r?.failed) || 0;
                if (f) T.toast.show("warn", t("compressAllPartial", { n, f }));
                else if (!n) T.toast.show("info", t("compressAllNone"));
                else T.toast.show("info", t("compressAllDone", { n }));
            })
            .catch((err) => T.toast.show("error", T.api.errorText(err, t("compressAllFailed"))));
    }

    // 알림에 딸린 동작들. 경고창의 버튼과 기록 목록의 버튼이 같은 것을 쓴다.
    function actionsFor(n) {
        const out = [];
        if (n.action?.kind === "compress_sessions") out.push({ label: t("noticeCompress"), run: () => runCompress(n.action) });
        if (n.type === "todo_due" && n.url) out.push({ label: t("noticeOpenTodo"), run: () => go(n.url) });
        if (n.conversationId && state.botByUuid(n.conversationId)) {
            out.push({ label: t("noticeOpenChat"), run: () => go(`/a/${n.conversationId}`) });
        }
        return out;
    }

    // 동작을 실행한다. 그 알림은 읽은 것으로 친다.
    function runAction(n, action) {
        markRead([n.id]);
        action.run();
    }

    // 설정의 알림 탭에 나오는 기록 한 줄.
    function buildRow(n) {
        const level = LEVEL_ICON[n.level] ? n.level : "info";
        const actions = actionsFor(n).map((a) =>
            T.h("button", { class: "btn ghost btn-sm", type: "button", text: a.label, onclick: () => runAction(n, a) }),
        );
        return T.h("div", { class: `nt-row ${level}` + (n.read ? " read" : "") }, [
            T.icon(LEVEL_ICON[level], "nt-icon"),
            T.h("div", { class: "nt-body" }, [
                // 마크다운 파이프라인을 거쳐 살균되고, 주소는 눌러서 열 수 있는 링크가 된다.
                T.md.render(textOf(n), { extraClass: "nt-text", highlight: false }),
                T.h("div", { class: "nt-time", text: timeOf(n) }),
                actions.length ? T.h("div", { class: "nt-actions" }, actions) : null,
            ]),
        ]);
    }

    /* ── 경고창 ─────────────────────────────────────────────── */
    // 제목: 어디서 온 알림인지. 에이전트 이름, "할 일", 그 밖은 앱 이름.
    function titleOf(n) {
        if (n.type === "todo_due") return t("todos");
        return (n.conversationId && state.botByUuid(n.conversationId)?.name) || "tabyBot";
    }

    function closeModal() {
        if (!modal) return;
        const el = modal.el;
        modal = null;
        el.classList.add("out");
        busyUntil = Date.now() + ALERT_OUT_MS + ALERT_GAP_MS;
        setTimeout(() => el.remove(), ALERT_OUT_MS);
    }

    // 서버 알림을 경고창에 넣을 모양으로 바꾼다.
    function describe(n) {
        return {
            id: n.id,
            title: titleOf(n),
            text: textOf(n),
            actions: actionsFor(n).map((a) => ({ label: a.label, run: () => runAction(n, a) })),
            dismiss: () => markRead([n.id]),
        };
    }

    // 서버 기록과 무관하게 이 기기에서만 띄우는 경고창(앱 새 버전 안내 등). 같은 경고창 모양과
    // 순서를 쓴다. key를 주면 같은 안내가 이미 대기 중일 때 다시 쌓지 않는다.
    // opt: { title?, text, key?, actions?: [{ label, run }] }
    function alert(opt) {
        const id = `local:${opt.key || ++localSeq}`;
        const text = String(opt.text || "");
        // 같은 안내가 이미 대기 중이면 다시 쌓지 않는다(연달아 실패할 때 같은 창이 줄줄이 뜨지 않게).
        if (locals.some((a) => a.id === id || a.text === text)) return;
        const drop = () => {
            locals = locals.filter((a) => a.id !== id);
            syncModal();
        };
        locals.push({
            id,
            title: opt.title || "tabyBot",
            text,
            actions: (opt.actions || []).map((a) => ({
                label: a.label,
                run() {
                    drop();
                    a.run();
                },
            })),
            dismiss: drop,
        });
        syncModal();
    }

    // alert()로 띄운 경고창을 key로 거둔다(원인이 사라졌을 때: 서버 연결 복구 등).
    function dismiss(key) {
        const id = `local:${key}`;
        if (!locals.some((a) => a.id === id)) return;
        locals = locals.filter((a) => a.id !== id);
        syncModal();
    }

    // d: { id, title, text, actions: [{ label, run }], dismiss }
    function openModal(d) {
        const actions = d.actions;
        // 버튼: 동작이 없으면 "확인" 하나. 있으면 "닫기"와 동작(굵게)을 나란히, 셋 이상이면 세로로 쌓는다.
        const dismiss = T.h("button", {
            class: "nt-btn" + (actions.length ? "" : " strong"),
            type: "button",
            text: t(actions.length ? "close" : "noticeOk"),
            onclick: d.dismiss,
        });
        const buttons = [
            dismiss,
            ...actions.map((a, i) =>
                T.h("button", {
                    class: "nt-btn" + (i === actions.length - 1 ? " strong" : ""),
                    type: "button",
                    text: a.label,
                    onclick: a.run,
                }),
            ),
        ];
        const el = T.h(
            "div",
            { class: "nt-modal", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "ntTitle", "aria-describedby": "ntText" },
            [
                T.h("div", { class: "nt-alert" }, [
                    T.h("div", { class: "nt-alert-body" }, [
                        T.h("h2", { id: "ntTitle", class: "nt-alert-title", text: d.title }),
                        // 마크다운 파이프라인을 거쳐 살균되고, 주소는 눌러서 열 수 있는 링크가 된다.
                        T.md.render(d.text, { extraClass: "nt-alert-text", highlight: false }),
                    ]),
                    T.h("div", { class: "nt-alert-btns" + (buttons.length > 2 ? " stack" : "") }, buttons),
                ]),
            ],
        );
        el.querySelector(".nt-alert-text").id = "ntText";
        // 경고창에 포커스가 있을 때는 전역 단축키(/ 등)가 뒤 UI를 건드리지 않게 한다.
        el.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") d.dismiss();
        });
        // 네이티브 경고창처럼 누른 채 버튼 사이를 오가면 강조가 손가락을 따라가고, 뗀 자리의 버튼이 눌린다.
        // 긴 내용을 스크롤하려고 본문에서 시작한 터치는 건드리지 않는다.
        T.touchPick(
            el,
            ".nt-btn",
            (btn) => btn.click(),
            (e) => !e.target.closest(".nt-alert-body"),
        );
        root.append(el);
        modal = { el, id: d.id };
        // 창 자체에 포커스를 둔다. Esc가 먹고, 버튼에는 키보드로 옮겨 갈 때만 강조가 생긴다.
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
    }

    // 읽지 않은 알림을 오래된 것부터 하나씩 띄운다. 떠 있는 알림이 읽음 처리되면(여기서든 다른
    // 기기에서든) 닫고, 닫히는 모션이 끝난 뒤 다음 것을 띄운다.
    function syncModal() {
        const unread = items.filter((n) => !n.read).reverse();
        if (snoozed && unread.some((n) => !snoozed.has(n.id))) snoozed = null;
        if (!unread.length) snoozed = null;
        // 이 기기에서 띄운 안내가 먼저, 그다음 서버 알림을 오래된 것부터.
        const next = locals[0] || (!snoozed && unread[0] ? describe(unread[0]) : null);
        if (modal && next && modal.id === next.id) return;
        clearTimeout(swapTimer);
        closeModal();
        if (!next) return;
        // 방금 닫힌 창의 모션이 끝나고 한 박자 쉰 뒤에 다음 것을 띄운다(두 창이 겹쳐 보이지 않게).
        const wait = busyUntil - Date.now();
        if (wait > 0) swapTimer = setTimeout(syncModal, wait);
        else openModal(next);
    }

    function init() {
        T.i18n.onChange(() => {
            if (modal) {
                closeModal();
                syncModal();
            }
        });
    }

    T.notices = {
        init,
        refresh,
        alert,
        dismiss,
        clearAll,
        buildRow,
        items: () => items,
        loaded: () => loaded,
    };
})((window.Taby = window.Taby || {}));
