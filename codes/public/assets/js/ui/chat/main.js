/* tabyBot 웹 클라이언트: 대화 열기, 읽음 처리, 헤더, 이벤트 구독. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const thread = document.getElementById("thread");
    const hdrAvatar = document.getElementById("hdrAvatar");
    const hdrName = document.getElementById("hdrName");

    /* ── 대화 열기 ──────────────────────────────────────────── */
    const REVALIDATE_AFTER_MS = 3000;

    // 설정·할 일·컴퓨터 페이지는 자기 경로를 쓰므로, 채팅이 주소를 덮어쓰면 안 된다.
    const OTHER_ROUTE_RE = /^\/(?:s(?:\/|$)|t(?:\/|$)|c\/)/;

    // 주소를 /a/<uuid>?m=&q= 로 맞춘다. 다른 페이지가 열려 있으면 건드리지 않는다.
    function syncUrlForChat(id, params) {
        if (OTHER_ROUTE_RE.test(location.pathname)) return;
        const bot = id ? state.botByUuid(String(id)) : null;
        const qs = new URLSearchParams();
        if (params?.q) qs.set("q", params.q);
        if (params?.m != null) qs.set("m", String(params.m));
        const query = qs.toString();
        const path = bot?.uuid ? `/a/${bot.uuid}` : "/";
        T.util.replaceUrl(path + (query ? `?${query}` : ""));
    }

    // 캐시는 낡았을 수 있다. 방금 받은 게 아니면 서버 정본으로 재검증한다.
    // 내용이 같으면 refreshTurns가 재렌더를 건너뛴다.
    async function revalidateConversation(id) {
        const c = state.conv(id);
        if (c.loaded && Date.now() - (c.fetchedAt || 0) <= REVALIDATE_AFTER_MS) return;
        try {
            await state.refreshTurns(id);
        } catch (err) {
            if (!c.loaded) T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
        }
    }

    async function open(id, opt) {
        const o = opt || {};
        const token = Symbol("open");
        open._token = token;
        state.setCurrent(id == null ? null : String(id));
        syncUrlForChat(id, o.params);

        // 먼저 그린다. 캐시된 턴이 있으면 그대로, 없으면 빈 스레드. 로드를 기다렸다 그리면
        // 그동안 이전 대화가 화면에 남아 "다른 대화가 떴다가 바뀌는" 것처럼 보인다.
        // 그 대화에서 마지막으로 보던 위치로 돌아간다. 기억이 없으면 하단.
        C.renderConversation(id != null ? C.scrollMem.get(String(id)) || null : null);

        if (id != null && !state.state.offline) await revalidateConversation(id);
        if (open._token !== token) return; // 로드 중 다른 대화로 전환됨

        // 1회성 파라미터 적용: 특정 메시지 이동(m)
        if (o.params?.m != null) {
            requestAnimationFrame(() => {
                scrollToMessage(`[data-midx="${Number(o.params.m)}"]`);
            });
        }
    }

    // 검색 결과 등에서 특정 메시지로 점프: 찾으면 중앙으로 스크롤하고 하이라이트.
    function scrollToMessage(selector) {
        const el = thread.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.classList.add("msg-highlight");
        setTimeout(() => el.classList.remove("msg-highlight"), 1600);
        return true;
    }

    // 검색 결과를 클릭하면 그 대화를 열고 서버 인덱스(턴/메시지)의 행으로 이동한다.
    // 다른 페이지(설정/할일/컴퓨터)가 열려 있어도 닫고 라우트를 채팅으로 바꾼다.
    async function openMessageTarget(convId, t, m) {
        const target = `/a/${encodeURIComponent(convId)}`;
        try {
            if (T.settingsUI.isOpen()) T.settingsUI.hide();
            if (T.todosUI?.isOpen?.()) T.todosUI.hide();
            if (T.computerUI?.isOpen?.()) T.computerUI.hide();
        } catch (err) {
            console.error("tabyBot: closing pages for search jump failed:", err);
        }
        if (location.pathname !== target) T.util.pushUrl(target);
        T.app?.renderRoute();
        const sel = `[data-t="${Number(t)}"][data-m="${Number(m)}"]`;
        // 라우트 전환과 대화 로드가 비동기라 행이 생길 때까지 짧게 기다린다.
        for (let i = 0; i < 40; i++) {
            if (scrollToMessage(sel)) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    }

    // SSE 재접속 직후 서버 스냅샷과 맞춘다.
    // 정본은 서버 히스토리: refreshTurns가 실행 중 live/중간 발화와 병합해 적용한다.
    async function refreshCurrent() {
        const id = state.state.currentId;
        if (!id) return;
        try {
            await state.refreshTurns(id);
        } catch {
            // 실패해도 다음 이벤트나 재접속 때 다시 받는다
        }
    }

    /* ── 읽음 처리 ──────────────────────────────────────────── */
    // 사용자가 지금 이 대화를 실제로 보고 있는가: 현재 대화이고, 채팅 화면이 떠 있고
    // (모바일은 목록이 아닌 채팅 패널), 탭이 보이는 상태.
    const mobileMq = window.matchMedia("(max-width: 860px)");

    function isViewing(id) {
        if (!id || id !== state.state.currentId || document.hidden || !C.chatVisible()) return false;
        return !mobileMq.matches || document.body.classList.contains("mobile-chat");
    }

    // 보고 있는 대화에 안 읽은 발화가 있으면 서버에 읽음으로 알린다(다른 기기 배지도 지워진다).
    const readInFlight = new Set();

    function syncRead() {
        const id = state.state.currentId;
        if (!isViewing(id) || state.state.offline || readInFlight.has(id)) return;
        if (!(Number(state.state.convs.get(id)?.meta?.unread) > 0)) return;
        readInFlight.add(id);
        state.upsertMeta({ id, unread: 0 });
        T.api
            .markRead(id)
            .catch(() => {
                /* 읽음 표시 실패는 서버 목록이 다음에 다시 내려줄 때 바로잡힌다 */
            })
            .finally(() => readInFlight.delete(id));
    }

    /* ── 헤더(봇 아바타/이름) ────────────────────────────────── */
    function refreshHeader() {
        // 컴퓨터 뷰가 열려 있으면 헤더/타이틀은 그 페이지가 소유한다.
        if (T.computerUI?.isOpen?.()) return;
        hdrAvatar.replaceChildren();
        if (T.todosUI?.isOpen?.()) {
            const name = t("todos");
            document.title = `${name} · tabyBot`;
            hdrAvatar.append(T.icon("list", "icon-sm"));
            hdrAvatar.style.backgroundColor = "var(--accent)";
            hdrAvatar.style.color = "#fff";
            hdrName.textContent = name;
            return;
        }
        const bot = T.state.currentBot();
        const name = bot ? bot.name : "";
        document.title = name ? `${name} · tabyBot` : "tabyBot";
        hdrAvatar.textContent = name ? ([...String(name).trim()][0] || "").toUpperCase() : "";
        hdrAvatar.style.backgroundColor = bot?.color || "var(--surface-2)";
        hdrAvatar.style.color = "#fff";
        hdrName.textContent = name;
    }

    /* ── 구독 ───────────────────────────────────────────────── */
    function init() {
        const routeIfCurrent = (p) => {
            if (p.id === state.state.currentId) C.requestSync();
        };

        state.on("status", routeIfCurrent);
        state.on("tool", routeIfCurrent);
        state.on("ask", routeIfCurrent);
        state.on("ask_resolved", routeIfCurrent);
        state.on("settings", () => {
            refreshHeader();
        });
        state.on("todos", () => {
            if (T.todosUI?.isOpen?.()) refreshHeader();
        });

        // 서버 정본 갱신: 턴 순서/병합은 항상 서버 응답 기준으로 다시 그린다.
        state.on("turns", (p) => {
            if (p.id !== state.state.currentId) return;
            C.liveEls = null;
            C.renderConversation();
            C.updateJump();
        });

        state.on("user_message", (p) => {
            if (p.id !== state.state.currentId) return;
            // 낙관적 버블의 확인 표시만 한다. 턴 렌더는 "turns" 이벤트가 담당한다.
            if (p.confirmed) {
                for (const el of thread.querySelectorAll(".msg-row.optimistic")) el.classList.remove("optimistic");
            }
        });

        state.on("turn_done", (p) => {
            if (p.id !== state.state.currentId) return;
            // 라이브 DOM을 승격하지 않는다. 스트림이 없거나 비면 빈 껍데기만 남아
            // 새로고침(서버 히스토리) 전까지 답이 안 보인다. 항상 turns 기준으로 그린다.
            C.liveEls = null;
            C.renderConversation();
            refreshHeader();
        });

        state.on("conversations", syncRead);
        state.on("current", syncRead);

        T.i18n.onChange(() => {
            C.renderConversation();
        });
        window.addEventListener("resize", () => C.fitBubblesIn(thread));
        // 다른 라우트가 채팅을 가렸다가 놓는 순간을 감지한다. display:none으로
        // 숨겨진 스크롤러는 위치가 리셋되고 할일 페이지는 같은 스크롤러를 쓰므로,
        // 다시 보이는 시점에 마지막으로 기억한 위치를 복원한다.
        let chatShown = C.chatVisible();
        new MutationObserver(() => {
            // 화면 전환(목록↔채팅, 설정 닫힘 등)으로 대화가 보이게 됐으면 읽음 처리한다.
            syncRead();
            const shown = C.chatVisible();
            if (shown === chatShown) return;
            chatShown = shown;
            // WebKit은 display가 none에서 block으로 바뀌어 다시 보이는 스크롤러의 scrollTop을
            // 레이아웃 단계에서 0으로 리셋한다. 마이크로태스크/첫 rAF에서 복원하면
            // 리셋이 복원을 덮어 채팅이 맨 위로 튄다. 레이아웃이 확정된 뒤에 복원하며,
            // 그 사이 리셋이 쏘는 스크롤 이벤트는 restorePending으로 걸러낸다.
            if (shown) {
                C.restorePending = true;
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        C.restorePending = false;
                        C.restoreScroll(C.renderedId ? C.scrollMem.get(C.renderedId) : null);
                    }),
                );
            }
        }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
        // 숨김 복귀 시 버퍼된 스트림을 즉시 반영
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                const c = state.currentConv();
                if (c?.live) C.applySync();
                syncRead();
            }
        });

        refreshHeader();
    }

    T.chat = { init, open, refreshCurrent, submitMessage: C.submitMessage, refreshHeader, openMessageTarget, isViewing };

    C.refreshHeader = refreshHeader;
})(window.Taby);
