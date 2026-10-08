/* tabyBot 웹 클라이언트: 컨텍스트 메뉴 상태·상수와 메뉴 내용 만들기. */
((T) => {
    "use strict";

    T.ctxCtx ??= {};
    const C = T.ctxCtx;
    const t = (k, v) => T.i18n.t(k, v);

    const LONG_PRESS_MS = 400;

    const PRESS_FEEDBACK_MS = 110; // 이 시간 뒤부터 대상이 눌려 보인다(스크롤 시작과 헷갈리지 않게)

    const LONG_PRESS_MOVE_PX = 10;

    const CLOSE_MS = 280; // 닫힘 전환(최대 220ms)이 다 끝난 뒤에 걷어 낸다. 중간에 끊기면 덜컥거린다

    const PANE_MS = 280; // 하위 메뉴 전환(app.css의 .ctx-pane 전환 시간과 같게)

    const PANE_SHIFT_PCT = 100;

    const SHEET_MARGIN = 12;

    const PRESS_SCALE = 0.96; // app.css의 .ctx-pressing과 같게

    const LIFT_MARGIN = 8; // 들어 올린 카드와 화면 가장자리 사이

    const LIFT_GAP = 8; // 카드와 메뉴 사이

    const LIFT_RADIUS = 14; // 모서리가 없는 대상(목록 행)을 카드로 띄울 때

    const LIFT_MIN_H = 72; // 긴 메시지를 잘라 보여 줄 때의 최소 높이

    const ANDROID_DUP_MS = 1200; // 길게 누르기 직후 OS가 쏘는 contextmenu는 같은 제스처다

    const EDITABLE = "input, textarea, [contenteditable]";

    const providers = [];

    const attached = new WeakMap(); // 엘리먼트 → 항목 배열(또는 그것을 돌려주는 함수)

    const itemOf = new WeakMap(); // 버튼 엘리먼트 → 항목

    C.layer = null;

    C.menuEl = null;

    C.cur = null; // { spec, sheet, stack: [항목 배열…], pane, lift, at }

    C.openedAt = 0;

    C.openedByPress = false;

    C.lp = null; // 진행 중인 길게 누르기 { x, y, target, spec }

    C.lpTimer = 0;

    C.fbTimer = 0;

    C.sliding = false; // 시트 위에 손가락이 붙어 있는 동안(강조가 손가락을 따라간다)

    C.slideFrom = "press"; // 그 터치가 시작된 곳: "press"(길게 누른 그 손가락) | "menu" | "backdrop"

    C.hl = null;

    C.suppressClick = false; // 길게 눌러 연 뒤 손을 떼며 오는 합성 클릭 억제

    /* ── 햅틱 ───────────────────────────────────────────────── */
    // Android는 진동 API, iOS Safari는 switch 체크박스 토글이 내는 시스템 햅틱을 쓴다.
    C.hapticLabel = null;

    function haptic() {
        try {
            if (navigator.vibrate) {
                navigator.vibrate(8);
                return;
            }
            if (!C.hapticLabel) {
                C.hapticLabel = T.h("label", { class: "ctx-haptic", "aria-hidden": "true" }, [
                    T.h("input", { type: "checkbox", switch: "", tabindex: "-1" }),
                ]);
                document.body.append(C.hapticLabel);
            }
            C.hapticLabel.click();
        } catch {
            // 햅틱을 지원하지 않는 기기면 무시한다
        }
    }

    /* ── 닫기 ───────────────────────────────────────────────── */
    function close(instant) {
        if (!C.layer) return;
        const el = C.layer;
        const state = C.cur;
        const spec = C.cur.spec;
        C.layer = null;
        C.menuEl = null;
        C.cur = null;
        C.sliding = false;
        C.hl = null;
        document.removeEventListener("pointerdown", onDocPointer, true);
        document.removeEventListener("keydown", onDocKey, true);
        window.removeEventListener("resize", onResize);
        spec.anchor?.setAttribute("aria-expanded", "false");
        const done = () => {
            el.remove();
            // 들어 올린 복제본이 사라진 뒤에 원본을 다시 보인다(겹쳐 보이지 않게).
            if (state.lift) spec.source.classList.remove("ctx-source-hidden");
        };
        if (instant) done();
        else {
            el.classList.remove("in");
            el.classList.add("closing");
            // 들어 올린 대상은 원래 자리·크기·모서리로 내려앉는다. 다 내려앉은 뒤 원본과 바꿔치기해야
            // 이음매가 보이지 않는다.
            if (state.lift) {
                const lift = state.lift;
                lift.el.style.transform = "";
                lift.el.style.height = `${lift.rect.height}px`;
                lift.el.style.borderRadius = C.radiusCss(lift.radii, 1);
                lift.inner.style.transform = "";
            }
            setTimeout(done, CLOSE_MS);
        }
        if (T.tooltip) T.tooltip.hide();
        return CLOSE_MS;
    }

    function onDocPointer(e) {
        if (!C.layer || C.cur.sheet) return; // 시트는 레이어가 화면을 덮고 스스로 닫는다
        if (C.menuEl.contains(e.target) || C.cur.spec.anchor?.contains(e.target)) return;
        close();
    }

    function onDocKey(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            const anchor = C.cur?.spec.anchor;
            close();
            anchor?.focus();
            return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const items = [...C.cur.pane.querySelectorAll(".ctx-item")];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement);
        const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1;
        items[next].focus({ preventScroll: true });
    }

    function onResize() {
        close(true); // 회전/키보드로 좌표가 바뀌면 들어 올린 대상과 메뉴 위치가 어긋난다
    }

    /* ── 메뉴 내용 ──────────────────────────────────────────── */
    function itemEl(it) {
        const right = it.checked ? T.icon("check", "ctx-check") : it.children ? T.icon("chevron", "ctx-more") : it.icon ? T.icon(it.icon) : null;
        const el = T.h(
            "button",
            {
                class: `ctx-item${it.danger ? " danger" : ""}${it.back ? " ctx-back" : ""}`,
                role: it.checked != null ? "menuitemradio" : "menuitem",
                "aria-checked": it.checked != null ? String(!!it.checked) : null,
                "aria-haspopup": it.children ? "menu" : null,
            },
            it.back
                ? [T.icon("chevron", "ctx-back-icon"), T.h("span", { class: "ctx-label", text: it.label })]
                : [T.h("span", { class: "ctx-label", text: it.label }), right],
        );
        itemOf.set(el, it);
        return el;
    }

    function buildPane() {
        const items = C.cur.stack[C.cur.stack.length - 1].filter(Boolean);
        const kids = [];
        if (C.cur.stack.length > 1) kids.push(itemEl({ label: t("back"), back: true }), T.h("div", { class: "ctx-sep", role: "separator" }));
        for (const it of items) kids.push(it.sep ? T.h("div", { class: "ctx-sep", role: "separator" }) : itemEl(it));
        return T.h("div", { class: "ctx-pane" }, kids);
    }

    // 스택 맨 위의 항목들을 보여 준다. dir: 0 = 처음, +1 = 하위 메뉴로(새 내용이 오른쪽에서),
    // -1 = 뒤로(새 내용이 왼쪽에서). 전환 중에는 두 내용이 함께 미끄러지고 메뉴 높이가 따라 변한다.
    function showPane(dir) {
        const prev = C.cur.pane;
        const pane = buildPane();
        C.cur.pane = pane;
        C.hl = null;
        if (!dir || !prev) {
            C.menuEl.replaceChildren(pane);
            C.layout(pane.offsetHeight);
            return;
        }
        const fromH = C.menuEl.offsetHeight;
        C.menuEl.style.height = `${fromH}px`;
        prev.classList.add("ctx-pane-out");
        prev.style.setProperty("--ctx-dx", `${-dir * PANE_SHIFT_PCT}%`);
        pane.classList.add("ctx-pane-in");
        pane.style.setProperty("--ctx-dx", `${dir * PANE_SHIFT_PCT}%`);
        C.menuEl.append(pane);
        const toH = Math.min(pane.offsetHeight, C.maxMenuHeight()) + (C.menuEl.offsetHeight - C.menuEl.clientHeight);
        C.layout(toH);
        void C.menuEl.offsetWidth;
        C.menuEl.style.height = `${toH}px`;
        pane.style.removeProperty("--ctx-dx"); // 제자리로 미끄러져 들어온다
        setTimeout(() => {
            prev.remove();
            if (C.cur?.pane !== pane) return;
            pane.classList.remove("ctx-pane-in");
            C.menuEl.style.height = "";
        }, PANE_MS);
    }

    function activate(el) {
        const it = itemOf.get(el);
        if (!it || !C.cur) return;
        if (it.back) {
            C.cur.stack.pop();
            showPane(-1);
        } else if (it.children) {
            C.cur.stack.push((typeof it.children === "function" ? it.children() : it.children) || []);
            showPane(1);
        } else {
            // 화면을 바꾸는 항목(defer)은 메뉴가 다 닫힌 뒤 실행한다. 들어 올린 카드가 새 화면 위에
            // 남거나 전환 애니메이션과 겹치지 않게. 그 밖(복사 등)은 사용자 제스처 안에서 바로 실행한다.
            const sheet = C.cur.sheet;
            const wait = close();
            if (it.defer && sheet) setTimeout(() => it.onSelect?.(), wait);
            else it.onSelect?.();
            return;
        }
        if (!C.cur.sheet) C.cur.pane.querySelector(".ctx-item")?.focus({ preventScroll: true });
    }

    // 다른 화면 요소(경고창 버튼 등)도 같은 햅틱을 쓴다.
    T.haptic = haptic;

    C.LONG_PRESS_MS = LONG_PRESS_MS;
    C.PRESS_FEEDBACK_MS = PRESS_FEEDBACK_MS;
    C.LONG_PRESS_MOVE_PX = LONG_PRESS_MOVE_PX;
    C.SHEET_MARGIN = SHEET_MARGIN;
    C.PRESS_SCALE = PRESS_SCALE;
    C.LIFT_MARGIN = LIFT_MARGIN;
    C.LIFT_GAP = LIFT_GAP;
    C.LIFT_RADIUS = LIFT_RADIUS;
    C.LIFT_MIN_H = LIFT_MIN_H;
    C.ANDROID_DUP_MS = ANDROID_DUP_MS;
    C.EDITABLE = EDITABLE;
    C.providers = providers;
    C.attached = attached;
    C.haptic = haptic;
    C.close = close;
    C.onDocPointer = onDocPointer;
    C.onDocKey = onDocKey;
    C.onResize = onResize;
    C.showPane = showPane;
    C.activate = activate;
})(window.Taby);
