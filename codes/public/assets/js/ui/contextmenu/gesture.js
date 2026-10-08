/* tabyBot 웹 클라이언트: 길게 누르기·우클릭·손가락 따라가는 선택 제스처와 공개 API. */
((T) => {
    "use strict";

    T.ctxCtx ??= {};
    const C = T.ctxCtx;

    /* ── 제스처 ─────────────────────────────────────────────── */
    function cancelPress() {
        clearTimeout(C.lpTimer);
        clearTimeout(C.fbTimer);
        C.lp?.spec?.source?.classList.remove("ctx-pressing");
        C.lp = null;
    }

    function setHighlight(el) {
        if (el === C.hl) return;
        C.hl?.classList.remove("hl");
        C.hl = el;
        if (el) {
            el.classList.add("hl");
            C.haptic();
        }
    }

    function init() {
        // 우클릭: 항상 브라우저 메뉴를 차단하고, 의미 있는 대상이면 앱 메뉴를 띄운다.
        // 자체 핸들러가 먼저 preventDefault한 경우(컴퓨터 화면 등)는 건드리지 않는다.
        document.addEventListener("contextmenu", (e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            // Android는 터치 길게 누르기에 실제 contextmenu를 쏜다. 방금 같은 제스처로 열었으면 무시.
            if (C.layer && C.openedByPress && Date.now() - C.openedAt < C.ANDROID_DUP_MS) return;
            const spec = C.resolve(e.target, false);
            C.close(true);
            if (spec) C.open({ ...spec, x: e.clientX, y: e.clientY, touch: false });
        });

        // 터치 길게 누르기.
        document.addEventListener(
            "pointerdown",
            (e) => {
                C.suppressClick = false;
                if (e.pointerType !== "touch" || !e.isPrimary) return;
                cancelPress();
                // 열린 메뉴 위의 터치, 글자를 고르는 중인 메시지 위의 터치는 그대로 둔다.
                if (C.layer || C.selectingRow?.contains(e.target)) return;
                const press = { x: e.clientX, y: e.clientY, target: e.target, spec: null };
                C.lp = press;
                C.fbTimer = setTimeout(() => {
                    if (C.lp !== press) return;
                    press.spec = C.resolve(press.target, true);
                    press.spec?.source?.classList.add("ctx-pressing");
                }, C.PRESS_FEEDBACK_MS);
                C.lpTimer = setTimeout(() => {
                    if (C.lp !== press) return;
                    const spec = press.spec;
                    cancelPress();
                    if (!spec) return;
                    // 햅틱의 합성 클릭이 아래 억제 플래그를 먹지 않게 먼저 울린다.
                    C.haptic();
                    if (!C.open({ ...spec, x: press.x, y: press.y, touch: true })) return;
                    C.openedByPress = true;
                    C.sliding = true;
                    C.slideFrom = "press";
                    C.suppressClick = true;
                }, C.LONG_PRESS_MS);
            },
            { passive: true },
        );
        document.addEventListener(
            "pointermove",
            (e) => {
                if (!C.lp || e.pointerType !== "touch") return;
                if (Math.hypot(e.clientX - C.lp.x, e.clientY - C.lp.y) > C.LONG_PRESS_MOVE_PX) cancelPress();
            },
            { passive: true },
        );
        const onPointerEnd = (e) => {
            // 입력 필드 위의 pointercancel은 브라우저가 제스처를 네이티브 글자 선택으로
            // 가져간 신호다. iOS는 콜아웃이 차단돼 네이티브 메뉴가 안 뜨므로
            // 타이머를 유지해 커스텀 메뉴(붙여넣기 등)가 대신 열리게 한다.
            if (e?.type === "pointercancel" && C.lp?.target?.closest?.(C.EDITABLE)) return;
            cancelPress();
        };
        document.addEventListener("pointerup", onPointerEnd, { passive: true });
        document.addEventListener("pointercancel", onPointerEnd, { passive: true });
        document.addEventListener("scroll", () => cancelPress(), { passive: true, capture: true });

        // 시트 위의 터치는 손가락을 따라간다(네이티브 메뉴와 같게):
        //  - 누른 채 움직이면 손가락 아래 항목으로 강조가 옮겨 가고, 메뉴 밖으로 나가면 꺼진다.
        //  - 손을 뗀 자리의 항목이 실행된다. 처음 누른 항목이 아니어도 된다.
        //  - 길게 눌러 연 직후에는 손을 떼지 않고 그대로 항목까지 밀어 놓을 수 있다.
        //  - 배경에서 시작해 배경에서 뗀 터치는 메뉴를 닫는다.
        // 시트가 떠 있는 동안에는 아래 화면이 스크롤되거나 스와이프 제스처가 먹지 않게 터치 이동을 막는다.
        const itemAt = (touch) => document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(".ctx-item") || null;
        document.addEventListener(
            "touchstart",
            (e) => {
                if (!C.layer || !C.cur.sheet || e.touches.length !== 1) return;
                C.sliding = true;
                C.slideFrom = C.menuEl.contains(e.target) ? "menu" : "backdrop";
                setHighlight(itemAt(e.touches[0]));
            },
            { passive: true, capture: true },
        );
        document.addEventListener(
            "touchmove",
            (e) => {
                if (!C.layer || !C.cur.sheet) return;
                e.stopPropagation();
                const touch = e.touches[0];
                // 화면보다 긴 메뉴는 스크롤이 먼저다.
                if (C.cur.pane.scrollHeight > C.cur.pane.clientHeight + 1 && C.cur.pane.contains(e.target)) {
                    C.sliding = false;
                    setHighlight(null);
                    return;
                }
                if (e.cancelable) e.preventDefault();
                if (C.sliding && touch) setHighlight(itemAt(touch));
            },
            { passive: false, capture: true },
        );
        const onTouchEnd = (e) => {
            if (!C.sliding) return;
            C.sliding = false;
            const el = C.hl;
            const from = C.slideFrom;
            C.slideFrom = "press";
            setHighlight(null);
            if (!C.layer || e.type !== "touchend") return;
            // 여기서 처리했으니 뒤따르는 합성 클릭은 만들지 않는다(두 번 실행 방지).
            if (el) {
                if (e.cancelable) e.preventDefault();
                C.activate(el);
            } else if (from === "backdrop") {
                if (e.cancelable) e.preventDefault();
                C.close();
            }
        };
        document.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
        document.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });

        // 길게 눌러 연 직후의 합성 클릭(손을 떼며 발생)이 아래 대상을 실행하지 않게 한 번 삼킨다.
        document.addEventListener(
            "click",
            (e) => {
                if (C.hapticLabel?.contains(e.target)) {
                    e.stopPropagation(); // 햅틱용 토글은 앱의 다른 클릭 핸들러에 보이지 않게
                    return;
                }
                if (!C.suppressClick) return;
                C.suppressClick = false;
                e.preventDefault();
                e.stopPropagation();
            },
            true,
        );

        // "텍스트 선택"으로 연 선택이 풀리면 그 메시지를 다시 선택 불가로 돌린다.
        document.addEventListener("selectionchange", () => {
            if (!C.selectingRow) return;
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !C.selectingRow.contains(sel.anchorNode)) C.endTextSelection();
        });
    }

    // 손가락을 따라가는 선택: root 안에서 누른 채 움직이면 손가락 아래의 selector 요소에 .hl이
    // 옮겨 붙고(바뀔 때마다 햅틱), 손을 뗀 자리의 요소로 onPick이 불린다. 밖에서 떼면 아무 일도 없다.
    // canStart(e)가 false면 그 터치는 추적하지 않는다(스크롤되는 본문에서 시작한 터치 등).
    T.touchPick = (root, selector, onPick, canStart) => {
        let tracking = false;
        let cur = null;
        const set = (el) => {
            if (el === cur) return;
            cur?.classList.remove("hl");
            cur = el;
            if (el) {
                el.classList.add("hl");
                C.haptic();
            }
        };
        const at = (touch) => {
            const el = document.elementFromPoint(touch.clientX, touch.clientY)?.closest?.(selector);
            return el && root.contains(el) ? el : null;
        };
        root.addEventListener(
            "touchstart",
            (e) => {
                tracking = e.touches.length === 1 && (!canStart || canStart(e));
                set(tracking ? at(e.touches[0]) : null);
            },
            { passive: true },
        );
        root.addEventListener(
            "touchmove",
            (e) => {
                if (!tracking) return;
                if (e.cancelable) e.preventDefault();
                set(e.touches[0] ? at(e.touches[0]) : null);
            },
            { passive: false },
        );
        root.addEventListener(
            "touchend",
            (e) => {
                if (!tracking) return;
                tracking = false;
                const el = cur;
                set(null);
                if (!el) return;
                // 여기서 실행했으니 뒤따르는 합성 클릭은 만들지 않는다(두 번 실행 방지).
                if (e.cancelable) e.preventDefault();
                onPick(el);
            },
            { passive: false },
        );
        root.addEventListener(
            "touchcancel",
            () => {
                tracking = false;
                set(null);
            },
            { passive: true },
        );
    };

    T.ctxmenu = {
        init,
        open: C.open,
        close: () => C.close(),
        isOpen: () => !!C.layer,
        attach(el, items) {
            C.attached.set(el, items);
            return el;
        },
        register: (fn) => C.providers.push(fn),
    };
})(window.Taby);
