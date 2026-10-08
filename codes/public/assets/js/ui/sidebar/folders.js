/* tabyBot 웹 클라이언트: 에이전트 폴더 탭과 스와이프 전환. */
((T) => {
    "use strict";

    T.sidebarCtx ??= {};
    const C = T.sidebarCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const listEl = document.getElementById("botList");
    const tabsEl = document.getElementById("folderTabs");
    const sidebarEl = document.getElementById("sidebar");

    /* ── 에이전트 폴더 탭 ───────────────────────────
       메신저 폴더 패턴: 목록 위 가로 텍스트 탭으로 필터링한다. "전체" 탭은 고정.
       활성 탭 아래에 밑줄 표시가 미끄러져 따라간다. 탭은 보기 전환만 하고,
       폴더 만들기·이름·순서·소속은 설정의 폴더 탭에서 다룬다.
       활성 탭은 로컬 상태, 실제 데이터는 state.folders/bot.folder. */
    const ACTIVE_TAB_KEY = "tabybot.sidebar.folder.active";

    // 지워진 폴더를 가리키면 "전체"로 되돌린다. 저장값은 존재하는 폴더만 인정.
    function activeFolderId() {
        const id = C.lsGet(ACTIVE_TAB_KEY) || "";
        return id && (state.state.folders || []).some((f) => f.id === id) ? id : "";
    }

    // 폴더를 바꾼다. 탭 클릭·스와이프·가로 스크롤 모두 여기로 온다.
    // 새 목록이 넘어간 방향(오른쪽 탭이면 오른쪽)에서 미끄러져 들어온다.
    // slide=false: 손가락으로 밀어 넘길 때. 목록이 이미 손가락을 따라 들어왔으므로 애니메이션을 다시 틀지 않는다.
    function setActiveFolder(id, slide = true) {
        const order = ["", ...(state.state.folders || []).map((f) => f.id)];
        const dir = order.indexOf(id || "") - order.indexOf(activeFolderId());
        C.lsSet(ACTIVE_TAB_KEY, id || "");
        C.render(true);
        listEl.style.transition = "";
        listEl.style.transform = "";
        listEl.classList.remove("slide-next", "slide-prev");
        if (!dir || !slide) return;
        void listEl.offsetWidth;
        listEl.classList.add(dir > 0 ? "slide-next" : "slide-prev");
    }

    // 존재하는 폴더 id만 인정한다. 지워진 폴더를 가리키는 봇은 미분류로 본다.
    function folderOf(bot) {
        const f = String(bot?.folder || "");
        return f && (state.state.folders || []).some((x) => x.id === f) ? f : "";
    }

    // 설정: "전체" 탭에서 폴더 소속 에이전트를 숨긴다(미분류만 표시).
    function allExcludesFoldered() {
        return state.state.settings?.allTabExcludesFoldered === true;
    }

    async function assignAgentFolder(agentId, folderId) {
        try {
            const r = await T.api.updateAgent(agentId, { folder: folderId || "" });
            state.applyAgents(r);
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
        }
    }

    function buildTab(id, name) {
        const tab = T.h("div", { class: "sb-tab", role: "tab", tabindex: "0", title: name, dataset: { folder: id } }, [
            T.h("span", { class: "sb-tab-in" }, [
                T.h("span", { class: "sb-tab-name", text: name }),
                T.h("span", { class: "sb-tab-count", hidden: true }),
            ]),
        ]);
        T.ctxmenu.attach(tab, () => C.tabMenuItems(id));
        tab.addEventListener("click", () => setActiveFolder(id));
        tab.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                setActiveFolder(id);
            }
        });
        return tab;
    }

    // 밑줄 표시를 활성 탭의 글자 폭에 맞춰 옮긴다. animate=false면 전환 없이 바로 놓는다.
    const tabInd = T.h("span", { class: "sb-tab-ind", "aria-hidden": "true" });

    function placeTabIndicator(animate) {
        const tab = tabsEl.querySelector(".sb-tab.active");
        const inner = tab?.querySelector(".sb-tab-in");
        // 접힌 사이드바 등 레이아웃이 없을 때는 건드리지 않는다(ResizeObserver가 다시 부른다).
        if (!inner || !tab.offsetWidth) return;
        tabInd.classList.toggle("no-anim", !animate);
        tabInd.style.width = `${inner.offsetWidth}px`;
        // offsetLeft는 position:relative인 탭 바 기준이다.
        tabInd.style.transform = `translateX(${inner.offsetLeft}px)`;
        if (!animate) {
            void tabInd.offsetWidth; // 전환 없이 반영한 뒤 다음 이동부터 다시 애니메이션
            tabInd.classList.remove("no-anim");
        }
        // 활성 탭이 가로 스크롤 밖에 있으면 보이는 범위로 들인다.
        const left = tab.offsetLeft - 12;
        const right = tab.offsetLeft + tab.offsetWidth + 12;
        if (left < tabsEl.scrollLeft) tabsEl.scrollTo({ left, behavior: animate ? "smooth" : "auto" });
        else if (right > tabsEl.scrollLeft + tabsEl.clientWidth)
            tabsEl.scrollTo({ left: right - tabsEl.clientWidth, behavior: animate ? "smooth" : "auto" });
    }

    /* 폴더 전환 제스처: 목록을 좌우로 밀거나(터치) 가로로 스크롤하면(트랙패드/Shift+휠)
       옆 폴더로 넘어간다. 검색 중이거나 폴더가 없으면 동작하지 않는다. */
    // dir: +1 = 다음(오른쪽) 탭, -1 = 이전 탭. 끝이면 null.
    function neighborFolder(dir) {
        const folders = state.state.folders || [];
        if (C.query || !folders.length) return null;
        const order = ["", ...folders.map((f) => f.id)];
        const to = order.indexOf(activeFolderId()) + dir;
        return to >= 0 && to < order.length ? order[to] : null;
    }

    function stepFolder(dir) {
        const next = neighborFolder(dir);
        if (next === null) return false;
        setActiveFolder(next);
        return true;
    }

    function initFolderSwipe() {
        const SWIPE_LOCK_PX = 10; // 방향을 정하는 최소 이동
        const SWIPE_COMMIT_PX = 64; // 이만큼 밀면 넘어간다
        const SWIPE_FLICK_PX_MS = 0.45; // 빠르게 튕기면 짧은 거리도 인정
        const SETTLE_MS = 260;
        const SETTLE = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        let sw = null;
        // 미는 동안 옆 폴더의 목록을 담아 지금 목록 바로 옆에 붙여 두는 층. 손가락을 따라 같이 움직인다.
        let ghost = null; // { el, dir }
        let settleTimer = 0;
        const dropGhost = () => {
            clearTimeout(settleTimer);
            ghost?.el.remove();
            ghost = null;
            listEl.style.transition = "";
            listEl.style.transform = "";
        };
        const fillGhost = (dir, folderId) => {
            if (ghost?.dir === dir) return;
            ghost?.el.remove();
            const el = T.h("div", { class: "sb-scroll sb-ghost", "aria-hidden": "true" }, C.listRows(folderId));
            el.style.top = `${listEl.offsetTop}px`;
            el.style.height = `${listEl.offsetHeight}px`;
            sidebarEl.append(el);
            ghost = { el, dir };
        };
        listEl.addEventListener(
            "touchstart",
            (e) => {
                dropGhost(); // 자리 잡는 중에 다시 만지면 그 자리에서 끝낸다
                sw = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, lock: null, dx: 0 } : null;
            },
            { passive: true },
        );
        listEl.addEventListener(
            "touchmove",
            (e) => {
                if (!sw || e.touches.length !== 1) return;
                const dx = e.touches[0].clientX - sw.x;
                const dy = e.touches[0].clientY - sw.y;
                if (sw.lock === null) {
                    if (Math.abs(dx) > SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.5) sw.lock = "x";
                    else if (Math.abs(dy) > SWIPE_LOCK_PX) sw.lock = "y";
                }
                if (sw.lock !== "x") return;
                sw.dx = dx;
                const dir = dx < 0 ? 1 : -1;
                const next = neighborFolder(dir);
                listEl.classList.remove("slide-next", "slide-prev");
                listEl.style.transition = "none";
                if (next === null) {
                    // 넘어갈 폴더가 없는 방향은 뻑뻑하게(고무줄) 조금만 따라온다.
                    ghost?.el.remove();
                    ghost = null;
                    listEl.style.transform = `translateX(${dx * 0.2}px)`;
                    return;
                }
                fillGhost(dir, next);
                listEl.style.transform = `translateX(${dx}px)`;
                ghost.el.style.transform = `translateX(${dx + dir * listEl.offsetWidth}px)`;
            },
            { passive: true },
        );
        const end = (e) => {
            const cur = sw;
            sw = null;
            if (cur?.lock !== "x") return;
            const dir = cur.dx < 0 ? 1 : -1;
            const w = listEl.offsetWidth;
            const speed = Math.abs(cur.dx) / Math.max(1, e.timeStamp - cur.at);
            const commit = e.type === "touchend" && (Math.abs(cur.dx) > SWIPE_COMMIT_PX || (speed > SWIPE_FLICK_PX_MS && Math.abs(cur.dx) > 24));
            const next = commit && ghost ? neighborFolder(dir) : null;
            if (next === null) {
                // 취소: 둘 다 제자리로 돌아간다.
                listEl.style.transition = SETTLE;
                listEl.style.transform = "";
                if (ghost) {
                    ghost.el.style.transition = SETTLE;
                    ghost.el.style.transform = `translateX(${dir * w}px)`;
                }
                settleTimer = setTimeout(dropGhost, SETTLE_MS);
                return;
            }
            // 넘어간다: 폴더를 바로 바꾸고(탭 밑줄이 같이 움직인다), 실제 목록은 들어오던 자리에서 이어서
            // 들어오게 한다. 임시 층에는 떠나는 폴더의 목록을 담아 반대쪽으로 밀어 낸다.
            // 새 목록은 미는 동안 보이던 대로 맨 위에서, 떠나는 목록은 보던 위치 그대로 나간다.
            const from = activeFolderId();
            const fromTop = listEl.scrollTop;
            setActiveFolder(next, false);
            listEl.scrollTop = 0;
            ghost.el.replaceChildren(...C.listRows(from));
            ghost.el.scrollTop = fromTop;
            ghost.el.style.transform = `translateX(${cur.dx}px)`;
            listEl.style.transition = "none";
            listEl.style.transform = `translateX(${cur.dx + dir * w}px)`;
            void listEl.offsetWidth;
            listEl.style.transition = SETTLE;
            listEl.style.transform = "translateX(0)";
            ghost.el.style.transition = SETTLE;
            ghost.el.style.transform = `translateX(${-dir * w}px)`;
            settleTimer = setTimeout(dropGhost, SETTLE_MS);
        };
        listEl.addEventListener("touchend", end, { passive: true });
        listEl.addEventListener("touchcancel", end, { passive: true });

        // 가로 스크롤: 한 번의 제스처(관성 포함)에 한 칸만 넘어가게, 입력이 잠잠해질 때까지 잠근다.
        const WHEEL_COMMIT_PX = 50;
        const WHEEL_IDLE_MS = 160;
        let wheelAcc = 0;
        let wheelLocked = false;
        let wheelIdle = 0;
        listEl.addEventListener(
            "wheel",
            (e) => {
                if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
                if (C.query || !(state.state.folders || []).length) return;
                // 브라우저의 "뒤로 가기" 스와이프가 대신 먹지 않게 한다.
                e.preventDefault();
                clearTimeout(wheelIdle);
                wheelIdle = setTimeout(() => {
                    wheelAcc = 0;
                    wheelLocked = false;
                }, WHEEL_IDLE_MS);
                if (wheelLocked) return;
                wheelAcc += e.deltaX;
                if (Math.abs(wheelAcc) < WHEEL_COMMIT_PX) return;
                stepFolder(wheelAcc > 0 ? 1 : -1);
                wheelLocked = true;
                wheelAcc = 0;
            },
            { passive: false },
        );
        listEl.addEventListener("animationend", () => listEl.classList.remove("slide-next", "slide-prev"));
    }

    // 사이드바는 스트리밍 중에도 자주 다시 그려진다. 탭 구성이 그대로면 DOM을 유지해
    // 밑줄 애니메이션과 가로 스크롤 위치가 끊기지 않게 한다.
    let tabsSig = null;

    function renderTabs() {
        if (!tabsEl) return;
        const folders = state.state.folders || [];
        tabsEl.hidden = !folders.length;
        if (!folders.length) {
            tabsEl.replaceChildren();
            tabsSig = null;
            return;
        }

        // 배지는 메신저처럼 "안 읽은 대화 수"다. 0이면 숨긴다.
        // allTabExcludesFoldered가 켜져 있으면 "전체"는 미분류 에이전트만 센다.
        const counts = new Map();
        for (const b of state.state.bots) {
            if (!C.unreadOf(b)) continue;
            const f = folderOf(b);
            if (f) counts.set(f, (counts.get(f) || 0) + 1);
            if (!f || !allExcludesFoldered()) counts.set("", (counts.get("") || 0) + 1);
        }
        const tabs = [{ id: "", name: t("folderAll"), folder: null }];
        for (const f of folders) tabs.push({ id: f.id, name: f.name, folder: f });

        const sig = JSON.stringify(tabs.map((x) => [x.id, x.name]));
        const rebuilt = sig !== tabsSig;
        if (rebuilt) {
            tabsSig = sig;
            tabsEl.replaceChildren(...tabs.map((x) => buildTab(x.id, x.name)), tabInd);
        }
        const active = activeFolderId();
        // 활성 표시와 배지는 제자리에서 갱신한다. 배지가 생기면 탭 폭이 바뀌므로 밑줄도 다시 맞춘다.
        let moved = false;
        for (const tab of tabsEl.querySelectorAll(".sb-tab")) {
            const on = tab.dataset.folder === active;
            if (tab.classList.contains("active") !== on) moved = true;
            tab.classList.toggle("active", on);
            tab.setAttribute("aria-selected", String(on));
            const n = counts.get(tab.dataset.folder) || 0;
            const badge = tab.querySelector(".sb-tab-count");
            const text = n > 99 ? "99+" : String(n);
            if (badge.hidden !== !n || (n && badge.textContent !== text)) {
                badge.hidden = !n;
                badge.textContent = n ? text : "";
                moved = true;
            }
        }
        if (rebuilt || moved) placeTabIndicator(!rebuilt);
    }

    C.activeFolderId = activeFolderId;
    C.folderOf = folderOf;
    C.allExcludesFoldered = allExcludesFoldered;
    C.assignAgentFolder = assignAgentFolder;
    C.placeTabIndicator = placeTabIndicator;
    C.initFolderSwipe = initFolderSwipe;
    C.renderTabs = renderTabs;
})(window.Taby);
