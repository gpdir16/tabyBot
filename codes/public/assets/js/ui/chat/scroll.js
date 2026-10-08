/* tabyBot 웹 클라이언트: 채팅 스레드의 스크롤 고정·위치 기억·복원. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const scroller = document.getElementById("scroller");
    const thread = document.getElementById("thread");
    const jump = document.getElementById("jumpLatest");

    jump.setAttribute("aria-label", t("newMessages"));

    C.pinnedBottom = true;

    C.rafPending = false;

    C.liveEls = null; // 현재 대화의 라이브 블록 참조

    C.renderedId = null; // 스레드에 그려진 대화 id: 스크롤 메모리 키

    const scrollMem = new Map(); // convId → { top, midx, dy, pinned }: 대화별 스크롤 위치

    let memRaf = 0;

    /* ── 스크롤 ─────────────────────────────────────────────── */
    // 채팅 스레드가 #scroller의 내용으로 보이는가.
    // 설정(/s)·컴퓨터(/c)는 스크롤러를 display:none으로 숨기고(위치가 리셋된다),
    // 할일(/t)은 같은 스크롤러를 할일 페이지가 쓴다. 그 사이 스크롤은 채팅 위치가 아니다.
    function chatVisible() {
        const b = document.body.classList;
        return !b.contains("settings-route") && !b.contains("todos-route") && !b.contains("computer-route");
    }

    // display가 none에서 block으로 바뀌어 다시 보인 직후 WebKit이 scrollTop을 0으로 리셋하며 쏘는
    // 스크롤 이벤트는 사용자 스크롤이 아니다. 복원이 끝날 때까지 플래그/메모리
    // 갱신을 무시해 오염을 막는다.
    C.restorePending = false;

    scroller.addEventListener("scroll", () => {
        if (!chatVisible() || C.restorePending) return; // 다른 페이지가 스크롤러를 쓰는 동안의 스크롤은 무시
        C.pinnedBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
        updateJump();
        // 위치 기록은 프레임당 한 번: 스크롤 이벤트는 연속으로 쏟아진다.
        if (memRaf || !C.renderedId) return;
        memRaf = requestAnimationFrame(() => {
            memRaf = 0;
            if (chatVisible() && !C.restorePending && C.renderedId) scrollMem.set(C.renderedId, captureScroll());
        });
    });

    jump.addEventListener("click", () => scrollToBottom(true));

    // 마크다운 이미지(.md img)는 크기가 정해져 있지 않아 로드되며 내용을 밀어낸다.
    // 하단 고정 중이면 따라간다. (load는 버블링하지 않아 캡처 단계에서 잡는다)
    thread.addEventListener(
        "load",
        (e) => {
            if (e.target instanceof HTMLImageElement && C.pinnedBottom) scrollToBottom(false);
        },
        true,
    );

    function scrollToBottom(smooth) {
        C.pinnedBottom = true;
        if (chatVisible()) {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
        } else if (C.renderedId) {
            // 숨겨진 동안의 하단 이동 의도를 남겨 둔다. 다시 보일 때 복원된다.
            scrollMem.set(C.renderedId, { pinned: true });
        }
        updateJump();
    }

    // 현재 스크롤 위치를 복원용 메모리로 캡처한다.
    // 뷰포트 상단(--hdr-h 아래)에 걸린 메시지를 앵커로 기억해 두면
    // 이미지 로딩 등으로 높이가 달려져도 같은 메시지 위치를 복원할 수 있다.
    function captureScroll() {
        if (!chatVisible()) return (C.renderedId && scrollMem.get(C.renderedId)) || { pinned: C.pinnedBottom };
        if (C.pinnedBottom) return { pinned: true };
        const mem = { top: scroller.scrollTop, midx: null, dy: 0, pinned: false };
        const rect = scroller.getBoundingClientRect();
        const padTop = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
        const line = rect.top + padTop;
        const cx = rect.left + rect.width / 2;
        // 행 사이 간격에 포인트가 걸릴 수 있으므로 아래로 조금씩 더 파본다.
        for (const probe of [2, 30, 90]) {
            const y = line + probe;
            if (y > rect.bottom - 4) break;
            const hit = document.elementFromPoint(cx, y);
            const row = hit?.closest ? hit.closest(".msg-row[data-midx]") : null;
            if (row) {
                mem.midx = row.dataset.midx;
                mem.dy = row.getBoundingClientRect().top - line;
                break;
            }
        }
        return mem;
    }

    function restoreScroll(mem) {
        if (!chatVisible()) {
            // 숨겨진 스크롤러에 쓰면 위치가 리셋되거나 다른 페이지를 밀어버린다.
            // 의도만 메모리에 남기고, 다시 보일 때 아래 MutationObserver가 복원한다.
            if (C.renderedId) scrollMem.set(C.renderedId, mem && !mem.pinned ? mem : { pinned: true });
            return;
        }
        if (!mem || mem.pinned) {
            scrollToBottom(false);
            return;
        }
        let placed = false;
        if (mem.midx != null) {
            const el = thread.querySelector(`[data-midx="${mem.midx}"]`);
            if (el) {
                const padTop = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
                const want = scroller.getBoundingClientRect().top + padTop + mem.dy;
                scroller.scrollTop += el.getBoundingClientRect().top - want;
                placed = true;
            }
        }
        if (!placed) scroller.scrollTop = mem.top || 0;
        C.pinnedBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
        updateJump();
    }

    function updateJump() {
        // 응답 생성 중이 아니어도 현재 위치가 하단에서 벗어나면 표시한다.
        const show = !C.pinnedBottom;
        jump.setAttribute("aria-hidden", String(!show));
        jump.tabIndex = show ? 0 : -1;
        jump.classList.toggle("show", show);
    }

    C.scrollMem = scrollMem;
    C.chatVisible = chatVisible;
    C.scrollToBottom = scrollToBottom;
    C.captureScroll = captureScroll;
    C.restoreScroll = restoreScroll;
    C.updateJump = updateJump;
})(window.Taby);
