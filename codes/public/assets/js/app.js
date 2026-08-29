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

    /* ── 테마 ───────────────────────────────────────────────── */
    function applyTheme(theme) {
        const v = theme === "light" ? "light" : "dark";
        document.documentElement.dataset.theme = v;
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.setAttribute("content", v === "light" ? "#ffffff" : "#0d0d0f");
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
