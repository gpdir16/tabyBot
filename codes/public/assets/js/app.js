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
    function storedLang() {
        try {
            return localStorage.getItem("tabybot.lang");
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

    function enterOffline(initial) {
        state.state.offline = true;
        state.setConn("disconnected");
        T.i18n.init(storedLang(), null);
        T.onboarding.wizard();
        if (!initial) T.toast.show("error", t("offlineNote"));
    }

    /* ── URL 라우팅: /a/<uuid>?m=&q=&settings=1&tab=&bot= ── */
    function botUuidFromPath() {
        const m = /^\/a\/([0-9a-f-]{36})$/.exec(location.pathname || "");
        return m ? m[1] : null;
    }

    function urlParams() {
        const p = new URLSearchParams(location.search);
        return {
            q: p.get("q") || "",
            m: p.get("m") != null && !Number.isNaN(Number(p.get("m"))) ? Number(p.get("m")) : null,
            settings: p.get("settings") === "1",
            tab: p.get("tab") || undefined,
            bot: p.get("bot") || undefined,
        };
    }

    function hasSavedProviderSetup(settings) {
        const provider = settings?.provider || {};
        const defaultPreset = settings?.providers?.find((p) => p.id === "default");
        const customBaseURL = provider.id === "default" && provider.baseURL && provider.baseURL !== defaultPreset?.baseURL;
        return (
            Boolean(provider.id && provider.id !== "default") ||
            Boolean(provider.model?.trim()) ||
            Boolean(provider.apiKeySet) ||
            Boolean(customBaseURL)
        );
    }

    // 1회성 q/m만 제거하고 설정 팝업의 동적 URL은 유지한다.
    function consumeParams(p) {
        if (p.q) T.composer.setValue(p.q);
        if (p.settings) {
            const agentId = p.bot && state.state.bots.some((b) => b.id === p.bot) ? p.bot : undefined;
            T.settingsUI.open({ tab: p.tab || "general", agentId, fromUrl: true });
        }
        const params = new URLSearchParams(location.search);
        params.delete("q");
        params.delete("m");
        const query = params.toString();
        history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    }

    async function boot() {
        // file:// 직접 실행: 네트워크 오류 콘솔 출력 없이 오프라인 모드 진입
        if (location.protocol === "file:") {
            enterOffline(true);
            return;
        }

        const token = ++bootToken;
        try {
            const bs = await T.api.bootstrap();
            if (token !== bootToken) return;
            state.state.bootstrap = bs;
            state.emit("bootstrap");

            T.i18n.init(storedLang(), bs.language);

            try {
                const s = await T.api.getSettings();
                if (s && typeof s === "object") state.setSettings(s);
            } catch (_) {}
            try {
                const r = await T.api.agents();
                state.setBots(Array.isArray(r?.agents) ? r.agents : []);
            } catch (_) {}
            try {
                const r = await T.api.conversations();
                if (token !== bootToken) return;
                state.replaceConversations((r && r.conversations) || []);
            } catch (_) {}
            const bots = state.state.bots;

            state.state.offline = false;
            booted = true;
            if (T.sidebar.hydrate) await T.sidebar.hydrate();

            // 봇 선택: URL uuid → 저장된 마지막 봇 → 첫 봇
            const fromPath = botUuidFromPath();
            let bot = (fromPath && bots.find((b) => b.uuid === fromPath)) || null;
            if (!bot) {
                try {
                    const lastId = localStorage.getItem("tabybot.lastAgent");
                    bot = (lastId && bots.find((b) => b.id === lastId)) || bots[0] || null;
                } catch (_) {
                    bot = bots[0] || null;
                }
            }
            if (token !== bootToken) return;
            if (bot) {
                await T.chat.open(bot.threadId, { params: urlParams() });
                if (fromPath) T.sidebar.showChat?.();
                else T.sidebar.showList?.();
                consumeParams(urlParams());
            } else {
                history.replaceState(null, "", "/");
            }

            T.events.connect();
            T.onboarding.dismiss();

            if (bs.configured === false) {
                // 사용자가 설정 URL로 직접 들어온 경우에는 온보딩이 설정창을 가리지 않게 한다.
                const requested = urlParams();
                const requestedAgent = requested.bot && bots.some((b) => b.id === requested.bot) ? requested.bot : undefined;
                if (requested.settings) {
                    if (!T.settingsUI.isOpen()) T.settingsUI.open({ tab: requested.tab || "general", agentId: requestedAgent, fromUrl: true });
                } else if (hasSavedProviderSetup(state.state.settings)) {
                    T.settingsUI.open({ tab: "provider" });
                } else {
                    T.onboarding.wizard();
                }
            }
        } catch (e) {
            if (token !== bootToken) return;
            if (e instanceof T.api.ApiError && e.status === 401) {
                T.onboarding.showToken(() => boot());
                return;
            }
            enterOffline(false);
        }
    }

    // 뒤/앞 탐색: 경로의 봇 스레드로 복원
    window.addEventListener("popstate", () => {
        if (!booted) return;
        const p = urlParams();
        if (p.settings) {
            const agentId = p.bot && state.state.bots.some((b) => b.id === p.bot) ? p.bot : undefined;
            if (!T.settingsUI.isOpen()) T.settingsUI.open({ tab: p.tab || "general", agentId, fromUrl: true });
        } else if (T.settingsUI.isOpen()) {
            T.settingsUI.close({ updateUrl: false });
        }

        const uuid = botUuidFromPath();
        const bot = uuid && state.state.bots.find((b) => b.uuid === uuid);
        if (bot && bot.threadId !== state.state.currentId) T.chat.open(bot.threadId, { replaceState: true });
    });

    // "/" → 컴포저 포커스. 입력 요소 내부에서는 무시.
    document.addEventListener("keydown", (e) => {
        const tag = document.activeElement?.tagName;
        const typing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
        if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            document.getElementById("composerInput")?.focus();
        }
    });

    /* ── 시작 ───────────────────────────────────────────────── */
    initViewportHeight();
    initTouchGuard();
    applyTheme(storedTheme() || "dark");
    T.i18n.init(storedLang(), null);
    T.i18n.applyStatic();

    T.sidebar.init();
    T.tooltip.init();
    T.chat.init();
    T.composer.init();
    T.settingsUI.init();
    if (T.notifications) T.notifications.init();

    boot();

    T.app = { applyTheme, retryBoot: boot };
})((window.Taby = window.Taby || {}));
