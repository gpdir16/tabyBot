/* tabyBot 웹 클라이언트 — 커스텀 컨텍스트 메뉴.
   브라우저 기본 우클릭 메뉴/iOS 콜아웃을 가로채고 앱 메뉴를 띄운다(네이티브 앱 동작).

   두 가지 모양이 있다.
   - 팝오버(데스크톱 우클릭, ⋯ 버튼): 포인터/버튼 옆에 뜨는 작은 메뉴.
   - 시트(터치 길게 누르기): 메신저 네이티브 앱의 컨텍스트 메뉴를 따른다.
       1) 누르고 있으면 대상이 살짝 눌린다(곧 메뉴가 열린다는 예고).
       2) 열리면 화면 전체가 흐려지고, 대상이 그 위로 튀어 올라 카드처럼 뜬다.
          햅틱과 함께 메뉴가 대상 바로 아래에서 펼쳐진다.
       3) 손을 떼지 않고 항목 위로 밀어서 놓으면 그 항목이 실행된다.
       4) 하위 메뉴는 같은 자리에서 옆으로 미끄러져 바뀌고(들어갈 땐 오른쪽에서, "뒤로"는 왼쪽에서)
          메뉴 높이가 따라 변한다.
       5) 바깥을 누르면 닫힌다.

   쓰는 법 — 엘리먼트에 메뉴를 붙이면 우클릭·길게 누르기(눌림, 들어 올리기, 밀어서 선택)가
   전부 따라온다:

       T.ctxmenu.attach(rowEl, () => [
           { label: "설정", icon: "settings", defer: true, onSelect: openSettings },
           { label: "폴더에 추가…", children: () => folderItems },
           { sep: true },
           { label: "삭제", danger: true, onSelect: remove },
       ]);

   항목 함수는 메뉴를 열 때마다 불린다(그때의 상태로 항목을 만든다). 빈 배열이면 열리지 않는다.
   엘리먼트가 DOM에서 사라지면 등록도 함께 사라지므로 해제할 필요가 없다.
   엘리먼트 단위로 붙이기 어려운 영역은 T.ctxmenu.register(fn(target) → { source, items } | null)을 쓴다.
   여기에는 공통 항목(입력 필드 편집 · 선택 복사 · 링크 · 이미지 · 메시지)이 들어 있다.

   항목 형식: { label, icon?, danger?, checked?, defer?, onSelect?, children? } | { sep: true }
   - children: 하위 메뉴. 배열 또는 배열을 돌려주는 함수(열 때 계산).
   - defer: 화면을 바꾸는 동작이면 true — 메뉴가 다 닫힌 뒤 실행된다. */
(function (T) {
    "use strict";

    const t = (k, v) => T.i18n.t(k, v);

    const LONG_PRESS_MS = 400;
    const PRESS_FEEDBACK_MS = 110; // 이 시간 뒤부터 대상이 눌려 보인다(스크롤 시작과 헷갈리지 않게)
    const LONG_PRESS_MOVE_PX = 10;
    const CLOSE_MS = 280; // 닫힘 전환(최대 220ms)이 다 끝난 뒤에 걷어 낸다 — 중간에 끊기면 덜컥거린다
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

    let layer = null;
    let menuEl = null;
    let cur = null; // { spec, sheet, stack: [항목 배열…], pane, lift, at }
    let openedAt = 0;
    let openedByPress = false;

    let lp = null; // 진행 중인 길게 누르기 { x, y, target, spec }
    let lpTimer = 0;
    let fbTimer = 0;
    let sliding = false; // 시트 위에 손가락이 붙어 있는 동안(강조가 손가락을 따라간다)
    let slideFrom = "press"; // 그 터치가 시작된 곳: "press"(길게 누른 그 손가락) | "menu" | "backdrop"
    let hl = null;
    let suppressClick = false; // 길게 눌러 연 뒤 손을 떼며 오는 합성 클릭 억제

    /* ── 햅틱 ───────────────────────────────────────────────── */
    // Android는 진동 API, iOS Safari는 switch 체크박스 토글이 내는 시스템 햅틱을 쓴다.
    let hapticLabel = null;
    function haptic() {
        try {
            if (navigator.vibrate) {
                navigator.vibrate(8);
                return;
            }
            if (!hapticLabel) {
                hapticLabel = T.h("label", { class: "ctx-haptic", "aria-hidden": "true" }, [
                    T.h("input", { type: "checkbox", switch: "", tabindex: "-1" }),
                ]);
                document.body.append(hapticLabel);
            }
            hapticLabel.click();
        } catch (_) {}
    }

    /* ── 닫기 ───────────────────────────────────────────────── */
    function close(instant) {
        if (!layer) return;
        const el = layer;
        const state = cur;
        const spec = cur.spec;
        layer = null;
        menuEl = null;
        cur = null;
        sliding = false;
        hl = null;
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
            // 들어 올린 대상은 원래 자리·크기·모서리로 내려앉는다 — 다 내려앉은 뒤 원본과 바꿔치기해야
            // 이음매가 보이지 않는다.
            if (state.lift) {
                const lift = state.lift;
                lift.el.style.transform = "";
                lift.el.style.height = `${lift.rect.height}px`;
                lift.el.style.borderRadius = `${lift.radius}px`;
                lift.inner.style.transform = "";
            }
            setTimeout(done, CLOSE_MS);
        }
        if (T.tooltip) T.tooltip.hide();
        return CLOSE_MS;
    }

    function onDocPointer(e) {
        if (!layer || cur.sheet) return; // 시트는 레이어가 화면을 덮고 스스로 닫는다
        if (menuEl.contains(e.target) || cur.spec.anchor?.contains(e.target)) return;
        close();
    }

    function onDocKey(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            const anchor = cur?.spec.anchor;
            close();
            anchor?.focus();
            return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const items = [...cur.pane.querySelectorAll(".ctx-item")];
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
                class: "ctx-item" + (it.danger ? " danger" : "") + (it.back ? " ctx-back" : ""),
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
        const items = cur.stack[cur.stack.length - 1].filter(Boolean);
        const kids = [];
        if (cur.stack.length > 1) kids.push(itemEl({ label: t("back"), back: true }), T.h("div", { class: "ctx-sep", role: "separator" }));
        for (const it of items) kids.push(it.sep ? T.h("div", { class: "ctx-sep", role: "separator" }) : itemEl(it));
        return T.h("div", { class: "ctx-pane" }, kids);
    }

    // 스택 맨 위의 항목들을 보여 준다. dir: 0 = 처음, +1 = 하위 메뉴로(새 내용이 오른쪽에서),
    // -1 = 뒤로(새 내용이 왼쪽에서). 전환 중에는 두 내용이 함께 미끄러지고 메뉴 높이가 따라 변한다.
    function showPane(dir) {
        const prev = cur.pane;
        const pane = buildPane();
        cur.pane = pane;
        hl = null;
        if (!dir || !prev) {
            menuEl.replaceChildren(pane);
            layout(pane.offsetHeight);
            return;
        }
        const fromH = menuEl.offsetHeight;
        menuEl.style.height = `${fromH}px`;
        prev.classList.add("ctx-pane-out");
        prev.style.setProperty("--ctx-dx", `${-dir * PANE_SHIFT_PCT}%`);
        pane.classList.add("ctx-pane-in");
        pane.style.setProperty("--ctx-dx", `${dir * PANE_SHIFT_PCT}%`);
        menuEl.append(pane);
        const toH = Math.min(pane.offsetHeight, maxMenuHeight()) + (menuEl.offsetHeight - menuEl.clientHeight);
        layout(toH);
        void menuEl.offsetWidth;
        menuEl.style.height = `${toH}px`;
        pane.style.removeProperty("--ctx-dx"); // 제자리로 미끄러져 들어온다
        setTimeout(() => {
            prev.remove();
            if (cur?.pane !== pane) return;
            pane.classList.remove("ctx-pane-in");
            menuEl.style.height = "";
        }, PANE_MS);
    }

    function activate(el) {
        const it = itemOf.get(el);
        if (!it || !cur) return;
        if (it.back) {
            cur.stack.pop();
            showPane(-1);
        } else if (it.children) {
            cur.stack.push((typeof it.children === "function" ? it.children() : it.children) || []);
            showPane(1);
        } else {
            // 화면을 바꾸는 항목(defer)은 메뉴가 다 닫힌 뒤 실행한다 — 들어 올린 카드가 새 화면 위에
            // 남거나 전환 애니메이션과 겹치지 않게. 그 밖(복사 등)은 사용자 제스처 안에서 바로 실행한다.
            const sheet = cur.sheet;
            const wait = close();
            if (it.defer && sheet) setTimeout(() => it.onSelect?.(), wait);
            else it.onSelect?.();
            return;
        }
        if (!cur.sheet) cur.pane.querySelector(".ctx-item")?.focus({ preventScroll: true });
    }

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
        // 브라우저마다 소수점 처리(레이아웃 단위)가 달라 반 픽셀의 여유를 둔다 — 눈에는 보이지 않는다.
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

    // 대상을 복제해 흐린 배경 위에 카드로 띄운다. 조상에 걸린 스타일(.msg-row.user .bubble 등)이
    // 그대로 먹도록 조상들의 클래스만 가진 껍데기(display: contents)로 감싼다.
    function buildLift(source) {
        const rect = restRect(source);
        if (rect.width < 8 || rect.height < 8) return null;
        const clone = source.cloneNode(true);
        clone.classList.remove("ctx-pressing");
        clone.classList.add("ctx-clone");
        clone.removeAttribute("id");
        clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        let root = clone;
        for (let a = source.parentElement; a && a !== document.body; a = a.parentElement) {
            const shell = document.createElement("div");
            shell.className = a.className;
            shell.style.display = "contents";
            shell.append(root);
            root = shell;
        }
        const cs = getComputedStyle(source);
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        // 화면 폭을 꽉 채운 대상(목록 행)은 살짝 줄여 양옆에 여백이 있는 카드로 띄운다.
        // 폭을 바꾸지 않고 배율로 줄이므로 안의 글자가 다시 줄바꿈되지 않는다.
        const scale = Math.min(1, (window.innerWidth - 2 * LIFT_MARGIN) / rect.width);
        const inner = T.h("div", { class: "ctx-lift-in" }, [root]);
        const el = T.h("div", { class: "ctx-lift", "aria-hidden": "true" }, [inner]);
        clone.style.width = `${rect.width}px`;
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
        el.style.borderRadius = `${radius}px`;
        // 손가락 아래에서 눌려 있던 크기 그대로 시작해 튀어 오른다.
        el.style.transform = `scale(${PRESS_SCALE})`;
        return { el, inner, clone, rect, radius, scale, seenTop: visibleTop(source, rect) };
    }

    // layout()이 계산해 둔 "떠 있는 모습"을 복제본에 입힌다.
    function applyLift() {
        const { el, inner, shown } = cur.lift;
        el.style.height = shown.height;
        el.style.transform = shown.transform;
        el.style.borderRadius = shown.radius;
        inner.style.transform = shown.inner;
    }

    /* ── 위치 ───────────────────────────────────────────────── */
    function maxMenuHeight() {
        return T.visibleHeight() - 2 * (cur.sheet ? SHEET_MARGIN : 8);
    }

    // menuH: 메뉴가 가질 높이(전환 중에는 목표 높이).
    function layout(menuH) {
        const vw = window.innerWidth;
        const vh = T.visibleHeight();
        const w = menuEl.offsetWidth;
        let left;
        let top;
        let originY = "top";
        let originX = "left";
        if (cur.lift) {
            // 들어 올린 대상 바로 아래에 메뉴를 둔다. 둘이 화면에 다 들어오도록 대상을 위아래로
            // 옮기고, 그래도 넘치면(긴 메시지) 대상을 보이던 부분 위주로 잘라 보여 준다.
            const m = SHEET_MARGIN;
            const lift = cur.lift;
            const r = lift.rect;
            const k = lift.scale;
            const safeTop = m + (parseFloat(getComputedStyle(layer).paddingTop) || 0);
            // 아래 계산은 화면에 보이는 크기(배율 적용 뒤) 기준이다.
            const room = vh - m - safeTop - LIFT_GAP - menuH;
            const fullH = r.height * k;
            const seenH = Math.max(Math.min(fullH, room), Math.min(fullH, LIFT_MIN_H));
            const restTop = r.top + (r.height - fullH) / 2; // 옮기지 않았을 때 보이는 윗변
            let seenTop = Math.max(restTop, safeTop);
            if (seenTop + seenH + LIFT_GAP + menuH > vh - m) seenTop = Math.max(safeTop, vh - m - menuH - LIFT_GAP - seenH);
            // 잘릴 때는 원래 화면에 보이던 윗부분부터 보여 준다.
            const h = seenH / k;
            const skip = Math.max(0, Math.min(lift.seenTop - r.top, r.height - h));
            lift.shown = {
                height: `${h}px`,
                inner: skip ? `translateY(${-skip}px)` : "",
                // 높이가 줄면 가운데 기준 배율의 윗변도 달라지므로 그만큼 보정해 옮긴다.
                transform: `translateY(${seenTop - (r.top + (h - seenH) / 2)}px) scale(${k})`,
                radius: `${(lift.radius || LIFT_RADIUS) / k}px`,
            };
            if (layer.classList.contains("in")) applyLift();
            top = seenTop + seenH + LIFT_GAP;
            // 화면 오른쪽에 붙은 대상(내 메시지)은 오른쪽 끝을, 아니면 왼쪽 끝을 맞춘다.
            const seenLeft = r.left + (r.width * (1 - k)) / 2;
            const seenRight = seenLeft + r.width * k;
            const rightSide = vw - seenRight < seenLeft;
            left = rightSide ? seenRight - w : seenLeft;
            if (rightSide) originX = "right";
            // 카드와 같은 여백을 써서 메뉴 모서리가 카드 모서리와 나란히 선다.
            left = Math.min(Math.max(LIFT_MARGIN, left), vw - w - LIFT_MARGIN);
        } else {
            const m = 8;
            const anchor = cur.spec.anchor;
            if (anchor) {
                const a = anchor.getBoundingClientRect();
                left = a.right - w;
                top = a.bottom + 4;
                originX = "right";
                if (top + menuH > vh - m && a.top - 4 - menuH >= m) {
                    top = a.top - 4 - menuH;
                    originY = "bottom";
                }
            } else if (cur.at) {
                // 하위 메뉴로 넘어가도 메뉴가 포인터 옆 같은 자리에 머문다.
                left = cur.at.left;
                top = cur.at.top;
            } else {
                left = cur.spec.x || 0;
                top = cur.spec.y || 0;
            }
            left = Math.min(Math.max(m, left), vw - w - m);
            top = Math.min(Math.max(m, top), vh - menuH - m);
            if (!anchor) cur.at = { left, top };
        }
        menuEl.style.left = `${left}px`;
        menuEl.style.top = `${top}px`;
        menuEl.style.transformOrigin = `${originY} ${originX}`;
    }

    /* ── 열기 ───────────────────────────────────────────────── */
    // spec: { items, source?, anchor?, x?, y?, touch? }
    //  - source: 메뉴의 대상 엘리먼트. touch와 함께 주면 시트로 열린다.
    //  - anchor: 이 버튼 아래에 붙여 연다(같은 버튼으로 다시 부르면 닫는다).
    function open(spec) {
        if (layer && spec.anchor && cur.spec.anchor === spec.anchor) {
            close();
            return false;
        }
        close(true);
        const items = (spec.items || []).filter(Boolean);
        if (!items.length) return false;
        const lift = spec.touch && spec.source ? buildLift(spec.source) : null;
        const sheet = !!lift;
        cur = { spec, sheet, stack: [items], lift, pane: null, at: null };
        menuEl = T.h("div", { class: "ctx-menu", role: "menu" });
        layer = T.h("div", { class: "ctx-layer" + (sheet ? " sheet" : "") }, [
            sheet ? T.h("div", { class: "ctx-backdrop" }) : null,
            lift?.el,
            menuEl,
        ]);
        menuEl.addEventListener("click", (e) => {
            const el = e.target.closest?.(".ctx-item");
            if (el) {
                e.stopPropagation();
                activate(el);
            }
        });
        // 흐린 배경을 누르면 닫는다. 아래 화면으로는 아무것도 전달하지 않는다.
        if (sheet) {
            layer.addEventListener("click", (e) => {
                if (!menuEl?.contains(e.target)) close();
            });
        }
        document.body.append(layer);
        showPane(0);
        if (lift) {
            // 대상에 제 배경이 없으면(목록 행·탭) 카드 배경을 깐다. 누르는 중의 :active 배경에
            // 속지 않게, 눌리지 않은 복제본의 스타일로 판단한다.
            const bg = getComputedStyle(lift.clone).backgroundColor;
            lift.el.classList.toggle("card", bg === "rgba(0, 0, 0, 0)" || bg === "transparent");
            spec.source.classList.add("ctx-source-hidden");
        }
        // 한 번 그린 뒤 .in을 붙여 등장 전환을 태운다(대상은 튀어 오르고 메뉴는 펼쳐진다).
        void layer.offsetWidth;
        layer.classList.add("in");
        if (lift) applyLift();
        spec.anchor?.setAttribute("aria-expanded", "true");
        document.addEventListener("pointerdown", onDocPointer, true);
        document.addEventListener("keydown", onDocKey, true);
        window.addEventListener("resize", onResize);
        if (!sheet) cur.pane.querySelector(".ctx-item")?.focus({ preventScroll: true });
        openedAt = Date.now();
        openedByPress = false;
        if (T.tooltip) T.tooltip.hide();
        return true;
    }

    /* ── 공통 제공자: 입력 필드 / 선택 / 링크 / 이미지 / 메시지 ── */
    function editableEl(target) {
        const el = target?.closest?.(EDITABLE);
        if (!el || el.disabled) return null;
        const mode = el.getAttribute("contenteditable");
        const ce = mode != null && mode !== "false";
        return { el, ce, readOnly: !!el.readOnly };
    }

    function editSelection(info) {
        if (info.ce) {
            const sel = window.getSelection();
            return sel && !sel.isCollapsed && info.el.contains(sel.anchorNode);
        }
        return info.el.selectionEnd > info.el.selectionStart;
    }

    function insertEditableText(info, text) {
        const el = info.el;
        if (info.ce) {
            el.focus();
            document.execCommand("insertText", false, text);
            return;
        }
        const s = el.selectionStart ?? el.value.length;
        const epos = el.selectionEnd ?? s;
        el.value = el.value.slice(0, s) + text + el.value.slice(epos);
        el.selectionStart = el.selectionEnd = s + text.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function editableItems(info) {
        const el = info.el;
        const hasSel = editSelection(info);
        const items = [];
        if (hasSel && !info.readOnly) {
            items.push({
                label: t("cut"),
                onSelect() {
                    if (info.ce) {
                        document.execCommand("cut");
                        return;
                    }
                    T.copyText(el.value.slice(el.selectionStart, el.selectionEnd));
                    insertEditableText(info, "");
                },
            });
        }
        if (hasSel) {
            items.push({
                label: t("copy"),
                icon: "copy",
                onSelect() {
                    if (info.ce) document.execCommand("copy");
                    else T.copyText(el.value.slice(el.selectionStart, el.selectionEnd));
                },
            });
        }
        if (!info.readOnly) {
            items.push({
                label: t("paste"),
                onSelect() {
                    if (!navigator.clipboard?.readText) {
                        T.toast.show("error", t("clipboardBlocked"));
                        return;
                    }
                    navigator.clipboard
                        .readText()
                        .then((text) => {
                            if (text) insertEditableText(info, text);
                        })
                        .catch(() => T.toast.show("error", t("clipboardBlocked")));
                },
            });
        }
        items.push({
            label: t("selectAll"),
            onSelect() {
                el.focus();
                if (info.ce) selectContents(el);
                else el.select();
            },
        });
        return items;
    }

    function selectContents(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function openImage(img) {
        const src = img.currentSrc || img.src;
        if (!src) return;
        if (T.viewer) {
            // 확장자가 없는 blob/쿼리 URL도 있으므로 image로 강제한다.
            T.viewer.open({ name: img.alt || t("file"), mime: "image/*", url: src });
            return;
        }
        try {
            window.open(src, "_blank", "noopener");
        } catch (_) {}
    }

    // 터치 기기에서는 메시지 본문을 길게 눌러도 글자가 선택되지 않는다(메뉴가 뜬다).
    // "텍스트 선택"을 고르면 그 메시지만 선택 가능해지고 전체가 선택된 채로 시작한다 —
    // 선택이 풀리면 원래대로 돌아간다.
    let selectingRow = null;
    function startTextSelection(row, textEl) {
        endTextSelection();
        selectingRow = row;
        row.classList.add("selecting");
        selectContents(textEl);
    }
    function endTextSelection() {
        selectingRow?.classList.remove("selecting");
        selectingRow = null;
    }

    function messageSpec(target) {
        const row = target?.closest?.(".msg-row");
        if (!row) return null;
        const items = [];
        const link = target.closest("a[href]");
        if (link && link.href && link.getAttribute("href") !== "#") {
            items.push({ label: t("copyLink"), icon: "copy", onSelect: () => void T.copyText(link.href) });
        }
        const img = target.closest("img");
        if (img && (img.closest(".md") || img.classList.contains("thumb"))) {
            items.push({ label: t("openImage"), icon: "eye", onSelect: () => openImage(img) });
        }
        const textEl = row.querySelector(".bubble-text, .md");
        const text = String(textEl?.textContent || "");
        if (text.trim()) {
            if (items.length) items.push({ sep: true });
            items.push({ label: t("copyMessage"), icon: "copy", onSelect: () => void T.copyText(text) });
            items.push({ label: t("selectText"), icon: "text-select", onSelect: () => startTextSelection(row, textEl) });
        }
        if (row.dataset.regen === "1" && T.chat?.regenerate) {
            items.push({ label: t("regenerate"), icon: "refresh", onSelect: () => T.chat.regenerate() });
        }
        if (!items.length) return null;
        return { items, source: target.closest(".bubble, .thumb, .file-attachment") || row.querySelector(".bubble") };
    }

    // 대상에 맞는 메뉴를 고른다. 없으면 null.
    function resolve(target, touch) {
        if (!(target instanceof Element)) return null;
        const ed = editableEl(target);
        if (ed) return { items: editableItems(ed) };

        // 마우스로 글자를 끌어 선택한 상태의 우클릭은 복사만 보여 준다.
        const sel = String(window.getSelection()?.toString() || "");
        if (sel && !touch) return { items: [{ label: t("copy"), icon: "copy", onSelect: () => void T.copyText(sel) }] };

        // attach로 메뉴를 붙인 가장 가까운 조상.
        for (let el = target; el && el !== document.body; el = el.parentElement) {
            const own = attached.get(el);
            if (!own) continue;
            const items = (typeof own === "function" ? own() : own) || [];
            return items.length ? { source: el, items } : null;
        }

        for (const provide of providers) {
            const spec = provide(target, touch);
            if (spec) return spec;
        }

        const msg = messageSpec(target);
        if (msg) return msg;

        const link = target.closest("a[href]");
        if (link && link.href && link.getAttribute("href") !== "#") {
            return { items: [{ label: t("copyLink"), icon: "copy", onSelect: () => void T.copyText(link.href) }] };
        }
        return null;
    }

    /* ── 제스처 ─────────────────────────────────────────────── */
    function cancelPress() {
        clearTimeout(lpTimer);
        clearTimeout(fbTimer);
        lp?.spec?.source?.classList.remove("ctx-pressing");
        lp = null;
    }

    function setHighlight(el) {
        if (el === hl) return;
        hl?.classList.remove("hl");
        hl = el;
        if (el) {
            el.classList.add("hl");
            haptic();
        }
    }

    function init() {
        // 우클릭: 항상 브라우저 메뉴를 차단하고, 의미 있는 대상이면 앱 메뉴를 띄운다.
        // 자체 핸들러가 먼저 preventDefault한 경우(컴퓨터 화면 등)는 건드리지 않는다.
        document.addEventListener("contextmenu", (e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            // Android는 터치 길게 누르기에 실제 contextmenu를 쏜다 — 방금 같은 제스처로 열었으면 무시.
            if (layer && openedByPress && Date.now() - openedAt < ANDROID_DUP_MS) return;
            const spec = resolve(e.target, false);
            close(true);
            if (spec) open({ ...spec, x: e.clientX, y: e.clientY, touch: false });
        });

        // 터치 길게 누르기.
        document.addEventListener(
            "pointerdown",
            (e) => {
                suppressClick = false;
                if (e.pointerType !== "touch" || !e.isPrimary) return;
                cancelPress();
                // 열린 메뉴 위의 터치, 글자를 고르는 중인 메시지 위의 터치는 그대로 둔다.
                if (layer || (selectingRow && selectingRow.contains(e.target))) return;
                const press = { x: e.clientX, y: e.clientY, target: e.target, spec: null };
                lp = press;
                fbTimer = setTimeout(() => {
                    if (lp !== press) return;
                    press.spec = resolve(press.target, true);
                    press.spec?.source?.classList.add("ctx-pressing");
                }, PRESS_FEEDBACK_MS);
                lpTimer = setTimeout(() => {
                    if (lp !== press) return;
                    const spec = press.spec;
                    cancelPress();
                    if (!spec) return;
                    // 햅틱의 합성 클릭이 아래 억제 플래그를 먹지 않게 먼저 울린다.
                    haptic();
                    if (!open({ ...spec, x: press.x, y: press.y, touch: true })) return;
                    openedByPress = true;
                    sliding = true;
                    slideFrom = "press";
                    suppressClick = true;
                }, LONG_PRESS_MS);
            },
            { passive: true },
        );
        document.addEventListener(
            "pointermove",
            (e) => {
                if (!lp || e.pointerType !== "touch") return;
                if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > LONG_PRESS_MOVE_PX) cancelPress();
            },
            { passive: true },
        );
        const onPointerEnd = (e) => {
            // 입력 필드 위의 pointercancel은 브라우저가 제스처를 네이티브 글자 선택으로
            // 가져간 신호다 — iOS는 콜아웃이 차단돼 네이티브 메뉴가 안 뜨므로
            // 타이머를 유지해 커스텀 메뉴(붙여넣기 등)가 대신 열리게 한다.
            if (e?.type === "pointercancel" && lp?.target?.closest?.(EDITABLE)) return;
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
                if (!layer || !cur.sheet || e.touches.length !== 1) return;
                sliding = true;
                slideFrom = menuEl.contains(e.target) ? "menu" : "backdrop";
                setHighlight(itemAt(e.touches[0]));
            },
            { passive: true, capture: true },
        );
        document.addEventListener(
            "touchmove",
            (e) => {
                if (!layer || !cur.sheet) return;
                e.stopPropagation();
                const touch = e.touches[0];
                // 화면보다 긴 메뉴는 스크롤이 먼저다.
                if (cur.pane.scrollHeight > cur.pane.clientHeight + 1 && cur.pane.contains(e.target)) {
                    sliding = false;
                    setHighlight(null);
                    return;
                }
                if (e.cancelable) e.preventDefault();
                if (sliding && touch) setHighlight(itemAt(touch));
            },
            { passive: false, capture: true },
        );
        const onTouchEnd = (e) => {
            if (!sliding) return;
            sliding = false;
            const el = hl;
            const from = slideFrom;
            slideFrom = "press";
            setHighlight(null);
            if (!layer || e.type !== "touchend") return;
            // 여기서 처리했으니 뒤따르는 합성 클릭은 만들지 않는다(두 번 실행 방지).
            if (el) {
                if (e.cancelable) e.preventDefault();
                activate(el);
            } else if (from === "backdrop") {
                if (e.cancelable) e.preventDefault();
                close();
            }
        };
        document.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
        document.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });

        // 길게 눌러 연 직후의 합성 클릭(손을 떼며 발생)이 아래 대상을 실행하지 않게 한 번 삼킨다.
        document.addEventListener(
            "click",
            (e) => {
                if (hapticLabel?.contains(e.target)) {
                    e.stopPropagation(); // 햅틱용 토글은 앱의 다른 클릭 핸들러에 보이지 않게
                    return;
                }
                if (!suppressClick) return;
                suppressClick = false;
                e.preventDefault();
                e.stopPropagation();
            },
            true,
        );

        // "텍스트 선택"으로 연 선택이 풀리면 그 메시지를 다시 선택 불가로 돌린다.
        document.addEventListener("selectionchange", () => {
            if (!selectingRow) return;
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !selectingRow.contains(sel.anchorNode)) endTextSelection();
        });
    }

    T.ctxmenu = {
        init,
        open,
        close: () => close(),
        isOpen: () => !!layer,
        attach(el, items) {
            attached.set(el, items);
            return el;
        },
        register: (fn) => providers.push(fn),
    };
})((window.Taby = window.Taby || {}));
