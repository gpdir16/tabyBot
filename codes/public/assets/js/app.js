/* tabyBot 웹 클라이언트 — 부트스트랩.
   테마/i18n 초기화 → 모듈 init → bootstrap/settings/bots 로드
   → configured=false면 온보딩, 401이면 토큰 화면, 실패 시 오프라인 모드
   → SSE 연결. file:// 에서는 네트워크 시도 없이 오프라인 모드로 진입한다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k) => T.i18n.t(k);

    const THEME_KEY = "tabybot.theme";
    let booted = false;
    let wasConnected = false;
    // 부트 재시도 중 이전 비동기 결과가 최신 화면을 덮지 않도록 한다.
    let bootToken = 0;
    // 오프라인 복구 폴링과 401 프롬프트의 중복 방지 플래그.
    let offlineTimer = 0;
    let offlineDelay = 5000;
    let authPromptOpen = false;
    // 키보드가 닫힌 상태의 visual viewport 최대 높이 (키보드 열림 감지 기준)
    let vvFullHeight = 0;
    // 이전 동기화 시점의 높이 (높이 변화 감지용)
    let vvLastHeight = 0;

    /* ── 테마 ───────────────────────────────────────────────── */
    function applyTheme(theme) {
        const v = theme === "light" ? "light" : "dark";
        document.documentElement.dataset.theme = v;
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.setAttribute("content", v === "light" ? "#ffffff" : "#000000");
        try {
            localStorage.setItem(THEME_KEY, v);
        } catch (_) {}
        // 토글 아이콘: 다크에서는 sun(라이트로 전환), 라이트에서는 moon
        const use = document.querySelector("#themeIcon use");
        if (use) use.setAttribute("href", v === "dark" ? "#i-sun" : "#i-moon");
    }

    function storedTheme() {
        try {
            return localStorage.getItem(THEME_KEY);
        } catch (_) {
            return null;
        }
    }
    // 모바일 키보드 대응:
    // 1) visual viewport 높이에 맞춰 --app-height를 다시 계산하고,
    // 2) iOS/Android가 키보드가 열리면 시각 뷰포트를 위로 밀어올리는데
    //    (position:fixed로도 막히지 않음) 밀린 만큼(offsetTop) body를
    //    아래로 내려 #app이 계속 보이도록 보정한다.
    function syncViewportHeight() {
        const vv = window.visualViewport;
        const height = vv?.height || window.innerHeight;
        const anchoring = vvLastHeight && Math.abs(height - vvLastHeight) > 1;
        // 레이아웃 변경 전에 "스크롤 끝에서부터의 거리"를 기록한다(거리는 컨텐츠 기준이라
        // 뷰포트 높이와 무관). 열림/닫힘 모두 이 거리를 유지하도록 계산한다.
        const anchors = anchoring
            ? [...document.querySelectorAll("#scroller, .sb-scroll")].map((el) => ({
                  el,
                  fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
              }))
            : [];
        // 스크롤 계산 전에 레이아웃을 최종 상태로 만든다. kb-open 패딩 변화까지
        // 반영된 뒤 계산해야 컴포저 위 내용이 정확히 붙는다.
        document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
        // 키보드 없는 상태의 최대 높이를 기준으로 삼고, 그보다 100px 이상
        // 줄어들면 키보드가 열린 것으로 본다 (브라우저 UI 변화는 ~80px 이하).
        if (vv) {
            if (height > vvFullHeight) vvFullHeight = height;
            document.body.classList.toggle("kb-open", vvFullHeight - height > 100);
        } else {
            vvFullHeight = 0;
            document.body.classList.remove("kb-open");
        }
        vvLastHeight = height;
        if (anchoring) {
            // 최종 레이아웃 기준으로 하단 고정 거리를 복원한다.
            for (const { el, fromBottom } of anchors) {
                el.scrollTop = el.scrollHeight - el.clientHeight - fromBottom;
            }
        }
        document.body.style.transform = vv?.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
    }

    function initViewportHeight() {
        syncViewportHeight();
        window.addEventListener("resize", syncViewportHeight, { passive: true });
        // 회전 시 기준 높이를 다시 잡도록 초기화
        window.addEventListener(
            "orientationchange",
            () => {
                vvFullHeight = 0;
                vvLastHeight = 0;
                syncViewportHeight();
            },
            { passive: true },
        );
        window.visualViewport?.addEventListener("resize", syncViewportHeight, { passive: true });
        window.visualViewport?.addEventListener("scroll", syncViewportHeight, { passive: true });
    }

    // 컴포저(하단 유리 바) 높이를 CSS 변수로 동기화한다.
    // #scroller가 헤더/컴포저 아래까지 전체 높이를 차지하므로, 마지막 메시지가
    // 컴포저에 가려지지 않으려면 하단 패딩(--composer-h)이 실제 높이를 따라야 한다.
    function initComposerHeight() {
        const el = document.getElementById("composerWrap");
        if (!el || !window.ResizeObserver) return;
        const ro = new ResizeObserver(() => {
            document.documentElement.style.setProperty("--composer-h", `${el.offsetHeight}px`);
        });
        ro.observe(el);
    }

    // 스크롤 가능 영역 밖(헤더, 여백 등)에서 시작된 터치 이동을 차단한다.
    // iOS는 키보드 열림 상태에서 이런 드래그로 문서/비주얼 뷰포트를 끌어당겨
    // 화면 전체가 흔들리는 현상이 생기는데, 당김 자체를 막아 원천 차단한다.
    function initTouchGuard() {
        document.addEventListener(
            "touchmove",
            (e) => {
                if (e.touches.length !== 1 || e.defaultPrevented) return;
                for (let el = e.target; el && el !== document.body; el = el.parentElement) {
                    if (!(el instanceof Element)) return;
                    const s = getComputedStyle(el);
                    if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) return;
                    if ((s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) return;
                }
                e.preventDefault();
            },
            { passive: false },
        );
    }

    /* ── 연결 상태 토스트 ───────────────────────────────────── */
    state.on("conn", (s) => {
        if (s === "connected") wasConnected = true;
        else if (s === "disconnected" && wasConnected && !state.state.offline) {
            wasConnected = false;
            T.toast.show("error", t("connectionLost"));
        }
    });

    // 세션 중 401: 서버 토큰이 바뀌었거나 저장 토큰이 지워졌다. 재인증 화면을 띄우고
    // 성공하면 부트를 다시 시도한다. 연속 401이 프롬프트를 중복으로 띄우지 않게 가드.
    function handleUnauthorized() {
        if (authPromptOpen) return;
        authPromptOpen = true;
        T.onboarding.showToken(() => {
            authPromptOpen = false;
            boot();
        });
    }

    // 서버 다운 후 복구 감지: 주기적으로 bootstrap을 두드려 성공하면 재부팅한다.
    // 실패 시 지수 백오프(최대 30초)로 죽은 서버를 두드리지 않는다.
    function scheduleOfflineRetry() {
        clearTimeout(offlineTimer);
        offlineTimer = setTimeout(async () => {
            if (!state.state.offline) return;
            try {
                await T.api.bootstrap();
            } catch (e) {
                if (e instanceof T.api.ApiError && e.status === 401) {
                    // 서버는 살아있다 — 오프라인이 아니라 인증 문제.
                    state.state.offline = false;
                    handleUnauthorized();
                    return;
                }
                offlineDelay = Math.min(offlineDelay * 2, 30_000);
                scheduleOfflineRetry();
                return;
            }
            state.state.offline = false;
            offlineDelay = 5000;
            boot();
        }, offlineDelay);
    }

    function enterOffline(err) {
        // 오프라인은 온보딩과 무관: 마법사를 띄우지 않고 안내만 표시한다.
        state.state.offline = true;
        state.setConn("disconnected");
        T.i18n.init(null);
        T.toast.show("error", err ? T.api.errorText(err, t("offlineNote")) : t("offlineNote"));
        if (location.protocol !== "file:") scheduleOfflineRetry();
    }

    /* ── URL 라우팅: /a/<uuid>(채팅) · /s/<탭>(설정 페이지) ── */
    function botUuidFromPath() {
        const m = /^\/a\/([0-9a-f-]{36})$/.exec(location.pathname || "");
        return m ? m[1] : null;
    }

    function urlParams() {
        const p = new URLSearchParams(location.search);
        return {
            q: p.get("q") || "",
            m: p.get("m") != null && !Number.isNaN(Number(p.get("m"))) ? Number(p.get("m")) : null,
        };
    }

    // 1회성 q/m만 제거한다.
    function consumeParams(p) {
        if (p.q) T.composer.setValue(p.q);
        const params = new URLSearchParams(location.search);
        params.delete("q");
        params.delete("m");
        const query = params.toString();
        history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    }

    // 현재 경로가 설정 페이지(/s/...)인지 해석한다.
    function settingsRoute() {
        return T.settingsUI.routeFromPath();
    }

    function openSettings(tab) {
        const returnPath = location.pathname + location.search + location.hash;
        history.pushState(null, "", "/s/" + (tab || "model"));
        T.settingsUI.open({ tab: tab || "model", fromUrl: true, returnPath });
    }

    async function boot() {
        // file:// 직접 실행: 네트워크 오류 콘솔 출력 없이 오프라인 모드 진입
        if (location.protocol === "file:") {
            enterOffline();
            return;
        }

        try {
            const tp = new URLSearchParams(location.search).get("token");
            if (tp) {
                const params = new URLSearchParams(location.search);
                params.delete("token");
                const q = params.toString();
                history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
                const prev = T.api.getToken();
                T.api.setToken(tp);
                try {
                    await T.api.bootstrap();
                } catch (_) {
                    T.api.setToken(prev);
                }
            }
        } catch (_) {}

        const token = ++bootToken;
        try {
            const bs = await T.api.bootstrap();
            if (token !== bootToken) return;
            state.state.bootstrap = bs;
            state.emit("bootstrap");

            T.i18n.init(bs.language);

            try {
                const s = await T.api.getSettings();
                if (s && typeof s === "object") state.setSettings(s);
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            }
            try {
                const r = await T.api.agents();
                state.setBots(Array.isArray(r?.agents) ? r.agents : []);
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            }
            try {
                const r = await T.api.conversations();
                if (token !== bootToken) return;
                state.replaceConversations((r && r.conversations) || []);
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            }
            try {
                const ticket = state.todosTicket();
                const r = await T.api.todos();
                if (token !== bootToken) return;
                state.applyTodos(ticket, r);
            } catch (err) {
                state.state.todosFailed = true;
                T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            }
            const bots = state.state.bots;

            state.state.offline = false;
            booted = true;
            if (T.sidebar.hydrate) await T.sidebar.hydrate();

            const fromPath = botUuidFromPath();
            const sr = settingsRoute();
            const tr = T.todosUI?.routeFromPath?.();
            const cr = T.computerUI?.routeFromPath?.();
            let bot =
                (fromPath && bots.find((b) => b.uuid === fromPath)) ||
                (cr && bots.find((b) => b.uuid === cr.uuid)) ||
                (!tr && !cr && bots[0]) ||
                null;
            if (token !== bootToken) return;
            if (bot) {
                await T.chat.open(bot.uuid, { params: urlParams() });
                if (fromPath || sr || cr) T.sidebar.showChat?.();
                else if (!tr) T.sidebar.showList?.();
                consumeParams(urlParams());
            } else if (!sr && !tr && !cr) {
                history.replaceState(null, "", "/");
            }

            if (sr) T.settingsUI.open({ tab: sr.tab, agentId: sr.agentId, fromUrl: true });
            else if (tr) {
                T.sidebar.showChat?.();
                T.todosUI.open({ id: tr.id || null, fromUrl: true });
            }
            if (cr) T.computerUI.open({ uuid: cr.uuid, fromUrl: true });

            T.events.connect();

            // 설정이 불완전하면 온보딩을 연다. 사용자가 /s/*로 직접 들어온 경우에는
            // 위에서 복원한 설정 페이지를 유지한다.
            if (bs.configured === false && !T.settingsUI.isOpen() && !T.onboarding.isSkipped()) T.onboarding.wizard();
        } catch (e) {
            if (token !== bootToken) return;
            if (e instanceof T.api.ApiError && e.status === 401) {
                T.onboarding.showToken(() => boot());
                return;
            }
            enterOffline(e);
        }
    }

    /* ── 공용 라우터: 현재 경로를 해석해 화면을 렌더링한다 ──
       채팅(/a/<uuid>)과 설정(/s/<탭>)이 같은 로직으로 구동된다. */
    function renderRoute() {
        const sr = T.settingsUI.routeFromPath();
        if (sr) {
            // 설정 라우트: 모바일에서도 /a/와 마찬가지로 메인 패널을 표시한다.
            T.todosUI?.hide?.();
            T.computerUI?.hide?.();
            T.sidebar?.showChat?.();
            T.settingsUI.open({ tab: sr.tab, agentId: sr.agentId, fromUrl: true });
            return;
        }
        const tr = T.todosUI?.routeFromPath?.();
        if (tr) {
            T.settingsUI.hide();
            T.computerUI?.hide?.();
            T.sidebar?.showChat?.();
            T.todosUI.open({ id: tr.id || null, fromUrl: true });
            T.sidebar?.syncRoute?.();
            return;
        }
        const cr = T.computerUI?.routeFromPath?.();
        if (cr) {
            // 봇 컴퓨터 라우트: 화면 스트림 + PTY 터미널 페이지.
            T.settingsUI.hide();
            T.todosUI?.hide?.();
            T.sidebar?.showChat?.();
            T.computerUI.open({ uuid: cr.uuid, fromUrl: true });
            T.sidebar?.syncRoute?.();
            return;
        }
        T.settingsUI.hide();
        T.todosUI?.hide?.();
        T.computerUI?.hide?.();
        const uuid = botUuidFromPath();
        const bot = uuid && state.state.bots.find((b) => b.uuid === uuid);
        if (bot && bot.uuid !== state.state.currentId) T.chat.open(bot.uuid, { replaceState: true });
        // 사이드바 선택 표시(설정 행/봇 행)를 라우트에 맞춘다.
        T.sidebar?.syncRoute?.();
    }

    // 뒤/앞 탐색: 경로로 화면 복원
    window.addEventListener("popstate", () => {
        if (!booted) return;
        renderRoute();
    });

    // "/" → 컴포저 포커스. 입력 요소 내부와 채팅이 아닌 라우트(설정/할일/컴퓨터)에서는 무시.
    document.addEventListener("keydown", (e) => {
        const tag = document.activeElement?.tagName;
        const typing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
        if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (T.settingsUI.routeFromPath() || T.todosUI?.routeFromPath?.() || T.computerUI?.routeFromPath?.()) return;
            const composer = document.getElementById("composerInput");
            if (!composer || composer.offsetParent === null) return;
            e.preventDefault();
            composer.focus();
        }
    });

    /* ── 시작 ───────────────────────────────────────────────── */
    // 함수 선언은 호이스팅되므로 모듈 의존 코드보다 먼저 노출한다.
    initViewportHeight();
    initComposerHeight();
    initTouchGuard();
    applyTheme(storedTheme() || "dark");
    T.i18n.init(null);
    T.i18n.applyStatic();

    T.sidebar.init();
    T.tooltip.init();
    T.chat.init();
    T.composer.init();
    T.settingsUI.init();
    T.todosUI?.init?.();
    T.computerUI?.init?.();
    if (T.notifications) T.notifications.init();

    boot();

    T.app = { applyTheme, retryBoot: boot, renderRoute, openSettings, handleUnauthorized };
})((window.Taby = window.Taby || {}));
