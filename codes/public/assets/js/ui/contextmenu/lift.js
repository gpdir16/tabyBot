/* tabyBot 웹 클라이언트: 대상 들어 올리기(시트)와 메뉴 위치·열기. */
((T) => {
    "use strict";

    T.ctxCtx ??= {};
    const C = T.ctxCtx;

    /* ── 대상 들어 올리기(시트) ─────────────────────────────── */
    // 눌려 보이는 변형(scale)을 걷어 낸 원래 자리.
    function restRect(el) {
        const r = el.getBoundingClientRect();
        // 크기는 계산된 스타일에서 소수점까지 읽는다. offsetWidth는 정수로 반올림돼서, 내용에 딱 맞춘
        // 말풍선(fit-content)을 그 폭으로 복제하면 1px 미만이 모자라 마지막 글자가 다음 줄로 넘어간다.
        const cs = getComputedStyle(el);
        const w = parseFloat(cs.width) || el.offsetWidth || r.width;
        const h = parseFloat(cs.height) || el.offsetHeight || r.height;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // 브라우저마다 소수점 처리(레이아웃 단위)가 달라 반 픽셀의 여유를 둔다. 눈에는 보이지 않는다.
        return { left: cx - w / 2, top: cy - h / 2, width: w + 0.5, height: h };
    }

    // 대상이 실제로 보이던 위쪽 경계: 가장 가까운 스크롤 컨테이너의 패딩 안쪽.
    // (채팅 스크롤러는 패딩이 곧 헤더/컴포저 자리다.)
    function visibleTop(source, rect) {
        for (let box = source.parentElement; box && box !== document.body; box = box.parentElement) {
            const s = getComputedStyle(box);
            if (s.overflowY !== "auto" && s.overflowY !== "scroll") continue;
            return Math.max(rect.top, box.getBoundingClientRect().top + (parseFloat(s.paddingTop) || 0));
        }
        return Math.max(rect.top, 0);
    }

    // 네 모서리 반지름을 CSS 값으로. 배율(k)로 줄여 그리는 동안에도 보이는 반지름이 같도록 나눈다.
    function radiusCss(radii, k) {
        return radii.map((r) => `${r / k}px`).join(" ");
    }

    // 대상을 복제해 흐린 배경 위에 카드로 띄운다. 조상에 걸린 스타일(.msg-row.user .bubble 등)이
    // 그대로 먹도록 조상들의 클래스만 가진 껍데기(display: contents)로 감싼다.
    function buildLift(source) {
        const rect = restRect(source);
        if (rect.width < 8 || rect.height < 8) return null;
        const clone = source.cloneNode(true);
        clone.classList.remove("ctx-pressing");
        clone.classList.add("ctx-clone");
        clone.removeAttribute("id");
        for (const n of clone.querySelectorAll("[id]")) n.removeAttribute("id");
        let root = clone;
        for (let a = source.parentElement; a && a !== document.body; a = a.parentElement) {
            const shell = document.createElement("div");
            shell.className = a.className;
            shell.style.display = "contents";
            shell.append(root);
            root = shell;
        }
        // 네 모서리를 따로 읽는다: 말풍선은 묶음의 마지막일 때 한쪽 아래 모서리만 좁다.
        const cs = getComputedStyle(source);
        const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(
            (v) => parseFloat(v) || 0,
        );
        // 화면 폭을 꽉 채운 대상(목록 행)은 살짝 줄여 양옆에 여백이 있는 카드로 띄운다.
        // 폭을 바꾸지 않고 배율로 줄이므로 안의 글자가 다시 줄바꿈되지 않는다.
        const scale = Math.min(1, (window.innerWidth - 2 * C.LIFT_MARGIN) / rect.width);
        const inner = T.h("div", { class: "ctx-lift-in" }, [root]);
        const el = T.h("div", { class: "ctx-lift", "aria-hidden": "true" }, [inner]);
        clone.style.width = `${rect.width}px`;
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
        el.style.borderRadius = radiusCss(radii, 1);
        // 손가락 아래에서 눌려 있던 크기 그대로 시작해 튀어 오른다.
        el.style.transform = `scale(${C.PRESS_SCALE})`;
        return { el, inner, clone, rect, radii, scale, seenTop: visibleTop(source, rect) };
    }

    // layout()이 계산해 둔 "떠 있는 모습"을 복제본에 입힌다.
    function applyLift() {
        const { el, inner, shown } = C.cur.lift;
        el.style.height = shown.height;
        el.style.transform = shown.transform;
        el.style.borderRadius = shown.radius;
        inner.style.transform = shown.inner;
    }

    /* ── 위치 ───────────────────────────────────────────────── */
    function maxMenuHeight() {
        return T.visibleHeight() - 2 * (C.cur.sheet ? C.SHEET_MARGIN : 8);
    }

    // menuH: 메뉴가 가질 높이(전환 중에는 목표 높이).
    function layout(menuH) {
        const vw = window.innerWidth;
        const vh = T.visibleHeight();
        const w = C.menuEl.offsetWidth;
        let left;
        let top;
        let originY = "top";
        let originX = "left";
        if (C.cur.lift) {
            // 들어 올린 대상 바로 아래에 메뉴를 둔다. 둘이 화면에 다 들어오도록 대상을 위아래로
            // 옮기고, 그래도 넘치면(긴 메시지) 대상을 보이던 부분 위주로 잘라 보여 준다.
            const m = C.SHEET_MARGIN;
            const lift = C.cur.lift;
            const r = lift.rect;
            const k = lift.scale;
            const safeTop = m + (parseFloat(getComputedStyle(C.layer).paddingTop) || 0);
            // 아래 계산은 화면에 보이는 크기(배율 적용 뒤) 기준이다.
            const room = vh - m - safeTop - C.LIFT_GAP - menuH;
            const fullH = r.height * k;
            const seenH = Math.max(Math.min(fullH, room), Math.min(fullH, C.LIFT_MIN_H));
            const restTop = r.top + (r.height - fullH) / 2; // 옮기지 않았을 때 보이는 윗변
            let seenTop = Math.max(restTop, safeTop);
            if (seenTop + seenH + C.LIFT_GAP + menuH > vh - m) seenTop = Math.max(safeTop, vh - m - menuH - C.LIFT_GAP - seenH);
            // 잘릴 때는 원래 화면에 보이던 윗부분부터 보여 준다.
            const h = seenH / k;
            const skip = Math.max(0, Math.min(lift.seenTop - r.top, r.height - h));
            lift.shown = {
                height: `${h}px`,
                inner: skip ? `translateY(${-skip}px)` : "",
                // 높이가 줄면 가운데 기준 배율의 윗변도 달라지므로 그만큼 보정해 옮긴다.
                transform: `translateY(${seenTop - (r.top + (h - seenH) / 2)}px) scale(${k})`,
                // 모서리가 없는 대상(목록 행)은 띄울 때 카드처럼 둥글린다.
                radius: lift.radii.some(Boolean) ? radiusCss(lift.radii, k) : `${C.LIFT_RADIUS / k}px`,
            };
            if (C.layer.classList.contains("in")) applyLift();
            top = seenTop + seenH + C.LIFT_GAP;
            // 화면 오른쪽에 붙은 대상(내 메시지)은 오른쪽 끝을, 아니면 왼쪽 끝을 맞춘다.
            const seenLeft = r.left + (r.width * (1 - k)) / 2;
            const seenRight = seenLeft + r.width * k;
            const rightSide = vw - seenRight < seenLeft;
            left = rightSide ? seenRight - w : seenLeft;
            if (rightSide) originX = "right";
            // 카드와 같은 여백을 써서 메뉴 모서리가 카드 모서리와 나란히 선다.
            left = Math.min(Math.max(C.LIFT_MARGIN, left), vw - w - C.LIFT_MARGIN);
        } else {
            const m = 8;
            const anchor = C.cur.spec.anchor;
            if (anchor) {
                const a = anchor.getBoundingClientRect();
                left = a.right - w;
                top = a.bottom + 4;
                originX = "right";
                if (top + menuH > vh - m && a.top - 4 - menuH >= m) {
                    top = a.top - 4 - menuH;
                    originY = "bottom";
                }
            } else if (C.cur.at) {
                // 하위 메뉴로 넘어가도 메뉴가 포인터 옆 같은 자리에 머문다.
                left = C.cur.at.left;
                top = C.cur.at.top;
            } else {
                left = C.cur.spec.x || 0;
                top = C.cur.spec.y || 0;
            }
            left = Math.min(Math.max(m, left), vw - w - m);
            top = Math.min(Math.max(m, top), vh - menuH - m);
            if (!anchor) C.cur.at = { left, top };
        }
        C.menuEl.style.left = `${left}px`;
        C.menuEl.style.top = `${top}px`;
        C.menuEl.style.transformOrigin = `${originY} ${originX}`;
    }

    /* ── 열기 ───────────────────────────────────────────────── */
    // spec: { items, source?, anchor?, x?, y?, touch? }
    //  - source: 메뉴의 대상 엘리먼트. touch와 함께 주면 시트로 열린다.
    //  - anchor: 이 버튼 아래에 붙여 연다(같은 버튼으로 다시 부르면 닫는다).
    function open(spec) {
        if (C.layer && spec.anchor && C.cur.spec.anchor === spec.anchor) {
            C.close();
            return false;
        }
        C.close(true);
        const items = (spec.items || []).filter(Boolean);
        if (!items.length) return false;
        const lift = spec.touch && spec.source ? buildLift(spec.source) : null;
        const sheet = !!lift;
        C.cur = { spec, sheet, stack: [items], lift, pane: null, at: null };
        C.menuEl = T.h("div", { class: "ctx-menu", role: "menu" });
        C.layer = T.h("div", { class: `ctx-layer${sheet ? " sheet" : ""}` }, [
            sheet ? T.h("div", { class: "ctx-backdrop" }) : null,
            lift?.el,
            C.menuEl,
        ]);
        C.menuEl.addEventListener("click", (e) => {
            const el = e.target.closest?.(".ctx-item");
            if (el) {
                e.stopPropagation();
                C.activate(el);
            }
        });
        // 흐린 배경을 누르면 닫는다. 아래 화면으로는 아무것도 전달하지 않는다.
        if (sheet) {
            C.layer.addEventListener("click", (e) => {
                if (!C.menuEl?.contains(e.target)) C.close();
            });
        }
        document.body.append(C.layer);
        C.showPane(0);
        if (lift) {
            // 대상에 제 배경이 없으면(목록 행·탭) 카드 배경을 깐다. 누르는 중의 :active 배경에
            // 속지 않게, 눌리지 않은 복제본의 스타일로 판단한다.
            const bg = getComputedStyle(lift.clone).backgroundColor;
            lift.el.classList.toggle("card", bg === "rgba(0, 0, 0, 0)" || bg === "transparent");
            spec.source.classList.add("ctx-source-hidden");
        }
        // 한 번 그린 뒤 .in을 붙여 등장 전환을 태운다(대상은 튀어 오르고 메뉴는 펼쳐진다).
        void C.layer.offsetWidth;
        C.layer.classList.add("in");
        if (lift) applyLift();
        spec.anchor?.setAttribute("aria-expanded", "true");
        document.addEventListener("pointerdown", C.onDocPointer, true);
        document.addEventListener("keydown", C.onDocKey, true);
        window.addEventListener("resize", C.onResize);
        if (!sheet) C.cur.pane.querySelector(".ctx-item")?.focus({ preventScroll: true });
        C.openedAt = Date.now();
        C.openedByPress = false;
        if (T.tooltip) T.tooltip.hide();
        return true;
    }

    C.radiusCss = radiusCss;
    C.maxMenuHeight = maxMenuHeight;
    C.layout = layout;
    C.open = open;
})(window.Taby);
