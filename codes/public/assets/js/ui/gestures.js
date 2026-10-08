/* tabyBot 웹 클라이언트: 뒤로/앞으로 제스처(모바일).
   OS가 제공하는 "밀어서 뒤로/앞으로"(iOS 화면 가장자리 스와이프)는 막고, 앱이 같은 제스처를
   직접 처리한다. OS 것은 화면 전체를 스냅샷으로 밀어내지만, 앱이 처리하면 화면이 손가락을 따라 움직인다.

   - 뒤로: 채팅·설정 등 메인 화면에서 오른쪽으로 민다(왼쪽 가장자리에서든, 화면 어디서든).
     메인 화면이 손가락을 따라 밀려 나가고 그 밑에서 목록이 드러난다. 충분히 밀거나 튕기면
     목록으로 돌아가고, 아니면 제자리로 돌아온다.
   - 컴퓨터 화면은 채팅 위에 한 겹 더 올라온 화면이다. 여기서 뒤로 밀면 컴퓨터 화면만 밀려 나가고
     그 밑의 채팅이 드러난다.
   - 설정의 상세 화면과 편집 폼도 한 겹씩 더 올라온 화면이다. 뒤로 밀면 맨 위 화면만 밀려 나가고 그 밑의 화면이 드러난다.
   - 할 일의 상세 화면도 같다. 맨 앞 상세를 밀어내면 그 밑의 할 일 목록이 드러난다.
   - 컴퓨터 화면은 버튼으로 열고 닫을 때도 같은 모양으로 밀려 들어오고 나간다(openInner/closeInner).
   - 앞으로: 목록에서 오른쪽 가장자리를 잡고 왼쪽으로 밀면 방금 보던 화면이 따라 들어온다.

   데스크톱에는 화면을 밀어 넘기는 개념이 없어 아무것도 하지 않는다. */
((T) => {
    "use strict";

    const mainEl = document.getElementById("main");
    const sidebarEl = document.getElementById("sidebar");
    const mobileMq = window.matchMedia("(max-width: 860px)");

    const EDGE_PX = 20; // 이 안에서 시작한 터치는 시스템 제스처를 막는다
    const LOCK_PX = 10; // 방향을 정하는 최소 이동
    const COMMIT_RATIO = 0.33; // 화면 폭의 이만큼 밀면 넘어간다
    const FLICK_PX_MS = 0.5; // 빠르게 튕기면 짧은 거리도 인정
    const FLICK_MIN_PX = 30;
    const PARALLAX_PCT = 30; // 밑에 깔린 목록은 이만큼만 따라 움직인다
    const SETTLE_MS = 420; // 손을 뗀 뒤 자리 잡는 시간(app.css의 --nav-dur와 같게)
    const SETTLE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)"; // app.css의 --nav-ease와 같게
    const TAP_MAX_MS = 500;
    // 이 화면들이 떠 있는 동안에는 뒤 화면을 움직이지 않는다.
    const BLOCKERS = ".ctx-layer, .nt-modal, .fv-overlay, .onb-page:not([hidden]), .onb-modal";
    // 가로 드래그를 스스로 쓰는 곳: 여기서 시작한 드래그는 화면 전환으로 보지 않는다(가장자리 제스처는 예외).
    const OWN_DRAG = "input, textarea, select, [contenteditable], .computer-page, .xterm";

    /* ── 공통 ───────────────────────────────────────────────── */
    function isMobile() {
        return mobileMq.matches;
    }
    function chatOpen() {
        return document.body.classList.contains("mobile-chat");
    }
    function blocked() {
        return !!document.querySelector(BLOCKERS);
    }

    // el에서 위로 올라가며 가로로 스크롤되는 요소를 찾는다.
    function scrollsX(el, stopAt) {
        for (let n = el; n && n !== stopAt && n !== document.body; n = n.parentElement) {
            if (!(n instanceof Element) || n.scrollWidth <= n.clientWidth + 1) continue;
            const ox = getComputedStyle(n).overflowX;
            if (ox === "auto" || ox === "scroll") return n;
        }
        return null;
    }

    /* ── 모바일: 화면이 손가락을 따라가는 뒤로/앞으로 ─────────── */
    let g = null; // 진행 중인 터치 { x, y, at, edge, lock, mode, dx, w, guarded, target, page(컴퓨터), api·views(설정·할 일 상세) }
    let forwardPath = ""; // 목록으로 돌아오기 전에 보던 화면
    let settleTimer = 0;
    let settleDone = null; // 겹친 화면(설정·할 일 상세)이 자리 잡은 뒤 할 마무리. 그 전에 다시 만지면 바로 실행한다

    function setPanels(mainX, listPct) {
        mainEl.style.transform = `translateX(${mainX}px)`;
        sidebarEl.style.transform = `translateX(${listPct}%)`;
    }

    // 인라인 변형을 걷어 낸다. 클래스가 정한 위치로 "미끄러져" 돌아가지 않게 전환을 잠깐 끈다.
    function clearPanels() {
        document.body.classList.add("mobile-route-sync");
        document.body.classList.remove("gest-drag", "gest-settle");
        mainEl.style.transform = "";
        sidebarEl.style.transform = "";
        requestAnimationFrame(() => document.body.classList.remove("mobile-route-sync"));
    }

    // 컴퓨터 화면이 떠 있는가(채팅 위에 한 겹 더 올라온 화면).
    function innerPage() {
        const page = document.getElementById("computerPage");
        return page && !page.hidden && document.body.classList.contains("computer-route") ? page : null;
    }

    function pickMode(cur, dx) {
        if (!isMobile() || blocked()) return null;
        // 할 일 상세 화면은 메인 화면 밖(맨 위 층)에 떠 있다. 그 위에서의 밀기는 그 화면을 밀어낸다.
        const todo = T.todosUI?.gesture;
        if (todo?.canPop() && todo.host()?.contains(cur.target)) {
            if (dx <= 0) return null;
            if (cur.edge !== "left" && (cur.target.closest?.(OWN_DRAG) || scrollsX(cur.target, todo.host()))) return null;
            cur.api = todo;
            return "panel";
        }
        if (chatOpen()) {
            if (dx <= 0) return null;
            let back = innerPage() ? "inner" : "back";
            if (back === "back" && T.settingsUI?.gesture?.canPop()) {
                back = "panel";
                cur.api = T.settingsUI.gesture;
            }
            if (cur.edge === "left") return back;
            // 화면 어디서든: 메인 화면 안이고, 가로 드래그를 스스로 쓰는 곳이 아닐 때만.
            if (!mainEl.contains(cur.target) || cur.target.closest?.(OWN_DRAG) || scrollsX(cur.target, mainEl)) return null;
            return back;
        }
        if (dx < 0 && cur.edge === "right" && forwardPath) return "forward";
        return null;
    }

    function begin(cur) {
        clearTimeout(settleTimer);
        document.body.classList.remove("gest-settle");
        document.body.classList.add("gest-drag");
        if (cur.mode === "inner") {
            // 밑에 깔린 채팅을 다시 보이게 한다(.gest-inner). 채팅은 보이지 않게만 해 두었으므로 보던 위치 그대로다.
            cur.page = innerPage();
            document.body.classList.add("gest-inner");
        }
        if (cur.mode === "panel") cur.views = cur.api.begin();
        if (cur.mode === "forward") {
            // 들어올 화면을 미리 준비한다: 위치는 인라인 변형이 쥐고 있어 화면은 아직 오른쪽 밖에 있다.
            setPanels(cur.w, 0);
            T.util.pushUrl(forwardPath);
            T.sidebar?.showChat?.();
            T.app?.renderRoute?.();
        }
        T.tooltip?.hide?.();
    }

    function update(cur, dx) {
        cur.dx = dx;
        if (cur.mode === "inner") {
            const x = Math.max(0, dx);
            cur.page.style.transform = `translateX(${x}px)`;
            // 헤더는 채팅과 같이 쓴다. 컴퓨터 화면이 얹어 둔 버튼들은 밀려 나가는 만큼 흐려진다.
            document.body.style.setProperty("--gest-p", String(Math.min(1, x / cur.w)));
        } else if (cur.mode === "panel") {
            const x = Math.max(0, dx);
            setViews(cur.views, x, -PARALLAX_PCT * (1 - x / cur.w), false);
        } else if (cur.mode === "back") {
            const x = Math.max(0, dx);
            setPanels(x, -PARALLAX_PCT * (1 - x / cur.w));
        } else {
            const x = Math.min(0, dx);
            setPanels(cur.w + x, -PARALLAX_PCT * (-x / cur.w));
        }
    }

    function finish(cur, e) {
        const dist = Math.abs(cur.dx);
        const speed = dist / Math.max(1, e.timeStamp - cur.at);
        const moved = cur.mode === "forward" ? cur.dx < 0 : cur.dx > 0;
        const commit = e.type === "touchend" && moved && (dist > cur.w * COMMIT_RATIO || (speed > FLICK_PX_MS && dist > FLICK_MIN_PX));
        if (cur.mode === "inner") {
            finishInner(cur, commit);
            return;
        }
        if (cur.mode === "panel") {
            finishPanel(cur, commit);
            return;
        }
        // 메인 화면이 최종적으로 보이는가.
        const mainShown = cur.mode === "back" ? !commit : commit;
        document.body.classList.remove("gest-drag");
        document.body.classList.add("gest-settle");
        setPanels(mainShown ? 0 : cur.w, mainShown ? -PARALLAX_PCT : 0);
        settleTimer = setTimeout(() => {
            // 다 자리 잡은 뒤에 실제 화면 상태를 바꾼다(변형은 이미 그 모양이라 눈에 띄는 변화가 없다).
            if (!mainShown) T.sidebar?.showList?.();
            clearPanels();
        }, SETTLE_MS);
    }

    // 컴퓨터 화면을 끝까지 밀어내거나(닫기) 제자리로 돌려놓는다.
    function finishInner(cur, commit) {
        const page = cur.page;
        const done = () => {
            document.body.classList.remove("gest-drag", "gest-settle", "gest-inner");
            document.body.style.removeProperty("--gest-p");
            page.style.transform = "";
        };
        document.body.classList.remove("gest-drag");
        document.body.classList.add("gest-settle");
        page.style.transform = commit ? `translateX(${cur.w}px)` : "";
        document.body.style.setProperty("--gest-p", commit ? "1" : "0");
        settleTimer = setTimeout(() => {
            if (!commit) {
                done();
                return;
            }
            // 컴퓨터 화면의 뒤로 버튼과 같은 동작. 히스토리를 거쳐 닫히는 경우 한 박자 늦으므로,
            // 실제로 닫힌 뒤에 정리한다(그 전에 풀면 화면이 잠깐 되돌아와 보인다).
            T.computerUI?.close?.();
            const startedAt = Date.now();
            const waitClosed = () => {
                if (!innerPage() || Date.now() - startedAt > 600) done();
                else requestAnimationFrame(waitClosed);
            };
            waitClosed();
        }, SETTLE_MS);
    }

    // 겹쳐 놓인 두 화면(위: 밀려 나가는 화면, 밑: 드러나는 화면)의 위치. 설정과 할 일 상세가 같이 쓴다.
    // 설정 화면 두 겹(위: 상세, 밑: 목록)의 위치. settle이면 손을 뗀 뒤 자리 잡는 전환을 건다.
    function setViews({ top, under }, topX, underPct, settle) {
        const transition = settle ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : "none";
        top.style.transition = transition;
        under.style.transition = transition;
        top.style.transform = `translateX(${topX}px)`;
        under.style.transform = `translateX(${underPct}%)`;
        top.classList.add("sp-lifted");
    }

    function finishPanel(cur, commit) {
        document.body.classList.remove("gest-drag");
        setViews(cur.views, commit ? cur.w : 0, commit ? 0 : -PARALLAX_PCT, true);
        settleDone = () => {
            settleDone = null;
            for (const el of [cur.views.top, cur.views.under]) {
                el.style.transition = "";
                el.style.transform = "";
                el.classList.remove("sp-lifted");
            }
            cur.api.end(commit, cur.views);
        };
        settleTimer = setTimeout(() => settleDone?.(), SETTLE_MS);
    }

    /* 컴퓨터 화면을 버튼으로 열고 닫을 때의 전환. 손가락으로 밀 때와 같은 층 구조(.gest-inner)를 써서
       채팅 위로 밀려 들어오고, 밀려 나가며 채팅이 드러난다. 전환을 하지 않았으면 false. */
    function canAnimateInner() {
        return isMobile() && !!innerPage() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    function openInner() {
        if (!canAnimateInner()) return false;
        const page = innerPage();
        clearTimeout(settleTimer);
        document.body.classList.remove("gest-drag", "gest-settle");
        document.body.classList.add("gest-inner");
        page.style.transform = `translateX(${window.innerWidth}px)`;
        document.body.style.setProperty("--gest-p", "1");
        void page.offsetWidth; // 시작 위치를 반영한 뒤 전환을 건다
        document.body.classList.add("gest-settle");
        page.style.transform = "";
        document.body.style.setProperty("--gest-p", "0");
        settleTimer = setTimeout(() => {
            document.body.classList.remove("gest-settle", "gest-inner");
            document.body.style.removeProperty("--gest-p");
        }, SETTLE_MS);
        return true;
    }
    function closeInner() {
        if (!canAnimateInner()) return false;
        clearTimeout(settleTimer);
        document.body.classList.remove("gest-settle");
        document.body.classList.add("gest-inner");
        document.body.style.setProperty("--gest-p", "0");
        void innerPage().offsetWidth;
        finishInner({ page: innerPage(), w: window.innerWidth }, true);
        return true;
    }

    // 가장자리 터치는 시스템 제스처를 막느라 기본 동작(클릭 포함)까지 막혔다. 탭이었으면 대신 눌러 준다.
    function tapThrough(cur) {
        const el = document.elementFromPoint(cur.x, cur.y);
        if (!el) return;
        if (el.matches?.("input, textarea, select")) el.focus();
        el.click();
    }

    function initTouch() {
        document.addEventListener(
            "touchstart",
            (e) => {
                // 설정 화면이 자리 잡는 중이면 지난 제스처를 먼저 끝낸다(안 그러면 깔아 둔 화면이 남는다).
                if (settleDone) {
                    clearTimeout(settleTimer);
                    settleDone();
                }
                if (e.touches.length !== 1) {
                    g = null;
                    return;
                }
                const t = e.touches[0];
                const w = window.innerWidth;
                const edge = t.clientX < EDGE_PX ? "left" : t.clientX > w - EDGE_PX ? "right" : null;
                g = { x: t.clientX, y: t.clientY, at: e.timeStamp, edge, lock: null, mode: null, dx: 0, w, guarded: false, target: e.target };
                // iOS의 가장자리 스와이프(브라우저 뒤로/앞으로)는 touchstart를 막아야만 꺼진다.
                if (edge && e.cancelable) {
                    e.preventDefault();
                    g.guarded = true;
                }
                if (isMobile() && chatOpen()) forwardPath = location.pathname + location.search;
            },
            { passive: false, capture: true },
        );
        document.addEventListener(
            "touchmove",
            (e) => {
                if (!g || e.touches.length !== 1) return;
                const dx = e.touches[0].clientX - g.x;
                const dy = e.touches[0].clientY - g.y;
                if (g.lock === null) {
                    if (Math.abs(dx) > LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.5) g.lock = "x";
                    else if (Math.abs(dy) > LOCK_PX) g.lock = "y";
                    if (g.lock === "x") {
                        g.mode = pickMode(g, dx);
                        if (g.mode) begin(g);
                    }
                }
                if (!g.mode) return;
                // 화면 전환 중에는 아래 내용이 스크롤되거나 다른 스와이프(폴더 전환)가 먹지 않게 한다.
                if (e.cancelable) e.preventDefault();
                e.stopPropagation();
                update(g, dx);
            },
            { passive: false, capture: true },
        );
        let pendingTap = null;
        const end = (e) => {
            const cur = g;
            g = null;
            pendingTap = null;
            if (!cur) return;
            if (cur.mode) {
                if (e.cancelable) e.preventDefault();
                e.stopPropagation();
                finish(cur, e);
                return;
            }
            if (cur.guarded && e.type === "touchend" && cur.lock === null && e.timeStamp - cur.at < TAP_MAX_MS) pendingTap = cur;
        };
        document.addEventListener("touchend", end, { passive: false, capture: true });
        document.addEventListener("touchcancel", end, { passive: true, capture: true });
        // 대신 눌러 주기는 다른 처리기들이 다 지나간 뒤에 한다. 이미 누가 이 터치를 처리했으면
        // (컨텍스트 메뉴 항목, 경고창 버튼 등은 touchend에서 직접 실행하고 기본 동작을 막는다) 겹치지 않게.
        document.addEventListener("touchend", (e) => {
            const cur = pendingTap;
            pendingTap = null;
            if (cur && !e.defaultPrevented) tapThrough(cur);
        });
    }

    function init() {
        initTouch();
    }

    T.gestures = { init, openInner, closeInner };
})(window.Taby);
