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
    // 스냅샷(로컬 캐시)으로 화면을 이미 그렸는지 — 재시도 부트에서 다시 그리지 않는다.
    let painted = false;
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
    let revealTimer = 0;
    const REVEAL_DELAY_MS = 120;
    const FOCUS_MARGIN = 12;
    const NON_TEXT_INPUT = /^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/;

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
    function syncViewportHeight() {
        if (window.scrollY) window.scrollTo(0, 0);
        const vv = window.visualViewport;
        const height = Math.round(vv?.height || window.innerHeight);
        const changed = vvLastHeight && Math.abs(height - vvLastHeight) > 1;
        const anchors = changed
            ? [...document.querySelectorAll("#scroller, .sb-scroll")].map((el) => ({
                  el,
                  fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
              }))
            : [];
        document.documentElement.style.setProperty("--app-height", `${height}px`);
        if (vv) {
            if (height > vvFullHeight) vvFullHeight = height;
            document.body.classList.toggle("kb-open", vvFullHeight - height > 100);
        } else {
            vvFullHeight = 0;
            document.body.classList.remove("kb-open");
        }
        vvLastHeight = height;
        if (changed) {
            for (const { el, fromBottom } of anchors) {
                el.scrollTop = el.scrollHeight - el.clientHeight - fromBottom;
            }
            clearTimeout(revealTimer);
            revealTimer = setTimeout(revealFocusedInput, REVEAL_DELAY_MS);
        }
        document.body.style.transform = vv?.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
    }

    function isTextEntry(el) {
        if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
        return el.tagName === "INPUT" && !NON_TEXT_INPUT.test(el.type);
    }

    function revealFocusedInput() {
        const el = document.activeElement;
        if (!el || !document.body.classList.contains("kb-open") || !isTextEntry(el)) return;
        const vv = window.visualViewport;
        const vvTop = vv?.offsetTop || 0;
        const vvBottom = vvTop + (vv?.height || window.innerHeight);
        for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
            const s = getComputedStyle(box);
            if (s.overflowY !== "auto" && s.overflowY !== "scroll") continue;
            if (box.scrollHeight <= box.clientHeight + 1) continue;
            const r = el.getBoundingClientRect();
            const b = box.getBoundingClientRect();
            const top = Math.max(b.top + box.clientTop + parseFloat(s.paddingTop), vvTop) + FOCUS_MARGIN;
            const bottom = Math.min(b.top + box.clientTop + box.clientHeight - parseFloat(s.paddingBottom), vvBottom) - FOCUS_MARGIN;
            let delta = 0;
            // 입력이 보이는 범위보다 크면 윗부분이 보이도록 위쪽 기준을 우선한다.
            if (r.bottom > bottom) delta = Math.max(0, Math.min(r.bottom - bottom, r.top - top));
            else if (r.top < top) delta = r.top - top;
            if (delta) box.scrollBy({ top: delta, behavior: "smooth" });
            return;
        }
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
        window.addEventListener("scroll", syncViewportHeight, { passive: true });
        document.addEventListener("focusin", () => requestAnimationFrame(revealFocusedInput));
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

    // 세션 중 401: 세션이 만료됐거나 다른 기기에서 비밀번호가 바뀌었다. 로그인 화면을
    // 띄우고 성공하면 부트를 다시 시도한다. 연속 401이 프롬프트를 중복으로 띄우지 않게 가드.
    function handleUnauthorized() {
        if (authPromptOpen) return;
        authPromptOpen = true;
        T.onboarding.showAuth("login", () => {
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
        // 스냅샷으로 이미 그렸다면 그 언어를 유지한다.
        T.i18n.init(state.state.bootstrap?.language || null);
        // 서버에 닿지 않는다 — 확인이 필요한 일이라 경고창으로 알린다(복구되면 boot가 거둔다).
        T.notices.alert({ key: "offline", text: err ? T.api.errorText(err, t("offlineNote")) : t("offlineNote") });
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
        // 경로가 가리키는 대화(없으면 가장 최근 대화)는 스냅샷 표시 전에 잡아 둔다 —
        // chat.open이 주소를 /a/<uuid>로 바꾸므로 그 뒤에는 "경로 없이 열었다"를 알 수 없다.
        const pathBot = botUuidFromPath();

        // 1) 저장된 스냅샷으로 즉시 그린다(네트워크 대기 없음). 서버 응답이 오면 아래에서 덮는다.
        if (!booted && !painted && state.restoreSnapshot()) {
            painted = true;
            T.i18n.init(state.state.bootstrap.language);
            await showRoute(pathBot, token);
            if (token !== bootToken) return;
        }

        try {
            // 2) 부트 데이터는 한 번에 병렬로 받는다 — 순차 왕복은 느린 회선에서 그대로 지연이 된다.
            const [acctR, bsR, settingsR, agentsR, convsR, todosR] = await Promise.allSettled([
                T.api.accountState(),
                T.api.bootstrap(),
                T.api.getSettings(),
                T.api.agents(),
                T.api.conversations(),
                (() => {
                    const ticket = state.todosTicket();
                    return T.api.todos().then((r) => ({ ticket, r }));
                })(),
            ]);
            if (token !== bootToken) return;

            // 계정 게이트: 계정이 없으면 생성 화면(건너뛰기 가능),
            // 있고 세션이 무효면 로그인 화면을 먼저 띄운다.
            // account/state 실패는 bootstrap이 같은 오류로 처리한다.
            const acct = acctR.status === "fulfilled" ? acctR.value : null;
            if (acct) {
                state.state.account = acct;
                if (!acct.hasAccount && !T.onboarding.setupSkipped()) {
                    T.onboarding.showAuth("setup", () => boot());
                    return;
                }
                if (acct.hasAccount && !acct.authed) {
                    handleUnauthorized();
                    return;
                }
            }

            if (bsR.status === "rejected") throw bsR.reason;
            const bs = bsR.value;
            state.state.bootstrap = bs;
            state.emit("bootstrap");
            state.state.offline = false;
            T.notices.dismiss("offline");

            T.i18n.init(bs.language);

            const failed = (r) => T.notices.alert({ text: T.api.errorText(r.reason, t("errorPrefix")) });
            if (settingsR.status === "rejected") failed(settingsR);
            else if (settingsR.value && typeof settingsR.value === "object") state.setSettings(settingsR.value);
            if (agentsR.status === "rejected") failed(agentsR);
            else state.applyAgents(agentsR.value);
            if (convsR.status === "rejected") failed(convsR);
            else state.replaceConversations((convsR.value && convsR.value.conversations) || []);
            if (todosR.status === "rejected") {
                state.state.todosFailed = true;
                failed(todosR);
            } else state.applyTodos(todosR.value.ticket, todosR.value.r);

            booted = true;
            // 미리보기 채우기는 화면을 막지 않는다.
            void T.sidebar.hydrate?.();

            await showRoute(pathBot, token);
            if (token !== bootToken) return;
            consumeParams(urlParams());

            T.events.connect({ fresh: true });
            prefetchThreads();
            // 앱을 닫아 둔 사이에 쌓인 시스템 알림을 모달로 띄운다.
            T.notices?.refresh();

            // 설정이 불완전하면 온보딩을 연다. 사용자가 /s/*로 직접 들어온 경우에는
            // 위에서 복원한 설정 페이지를 유지한다.
            if (bs.configured === false && !T.settingsUI.isOpen() && !T.onboarding.isSkipped()) T.onboarding.wizard();
        } catch (e) {
            if (token !== bootToken) return;
            if (e instanceof T.api.ApiError && e.status === 401) {
                handleUnauthorized();
                return;
            }
            enterOffline(e);
        }
    }

    // 현재 경로에 맞는 화면을 띄운다. 스냅샷 표시와 서버 응답 반영 양쪽에서 호출된다 —
    // 이미 맞는 화면이 떠 있으면 다시 열지 않는다.
    async function showRoute(pathBot, token) {
        const bots = state.state.bots;
        const sr = settingsRoute();
        const tr = T.todosUI?.routeFromPath?.();
        const cr = T.computerUI?.routeFromPath?.();
        const bot =
            (pathBot && bots.find((b) => b.uuid === pathBot)) ||
            (cr && bots.find((b) => b.uuid === cr.uuid)) ||
            (!tr && !cr && state.mostRecentBot()) ||
            null;
        if (bot) {
            if (bot.uuid !== state.state.currentId) {
                const opened = T.chat.open(bot.uuid, { params: urlParams() });
                // 스냅샷으로 그릴 때는 서버 재검증을 기다리지 않는다.
                if (booted) await opened;
                else void opened;
            } else if (booted) {
                // 스냅샷으로 이미 열어 둔 대화 — 서버 정본으로 재검증만 한다.
                void T.chat.refreshCurrent?.();
            }
            if (token !== bootToken) return;
            if (pathBot || sr || cr) T.sidebar.showChat?.();
            else if (!tr) T.sidebar.showList?.();
        } else if (!sr && !tr && !cr) {
            history.replaceState(null, "", "/");
        }

        if (sr) {
            if (!T.settingsUI.isOpen()) T.settingsUI.open({ tab: sr.tab, agentId: sr.agentId, fromUrl: true });
        } else if (tr) {
            T.sidebar.showChat?.();
            if (!T.todosUI.isOpen?.()) T.todosUI.open({ id: tr.id || null, fromUrl: true });
        }
        if (cr && !T.computerUI.isOpen?.()) T.computerUI.open({ uuid: cr.uuid, fromUrl: true });
    }

    // 한가할 때 나머지 대화 기록을 미리 받아 둔다 — 목록에서 누르면 바로 뜬다.
    // 최근 대화부터, 한 번에 하나씩(부트 직후 회선을 독점하지 않게).
    const PREFETCH_MAX = 8;
    function prefetchThreads() {
        // 데이터 절약 모드에서는 누를 때 받는다.
        if (navigator.connection?.saveData) return;
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 600));
        const ids = state.state.conversations.map((c) => c.id).filter((id) => state.botByUuid(id));
        let n = 0;
        const next = () => {
            const id = ids.shift();
            if (!id || n >= PREFETCH_MAX || state.state.offline) return;
            if (state.conv(id).loaded && state.conv(id).fetchedAt) return next();
            n += 1;
            state
                .refreshTurns(id)
                .catch(() => {})
                .then(() => idle(next));
        };
        idle(next);
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
    T.ctxmenu?.init?.();
    T.tooltip.init();
    T.chat.init();
    T.composer.init();
    T.settingsUI.init();
    T.todosUI?.init?.();
    T.notices?.init?.();
    T.computerUI?.init?.();
    if (T.notifications) T.notifications.init();

    boot();

    T.app = { applyTheme, retryBoot: boot, renderRoute, openSettings, handleUnauthorized };
})((window.Taby = window.Taby || {}));
