/* tabyBot 웹 클라이언트: 설정 페이지의 라우팅(열기/닫기/경로 동기화)과 서버 저장. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("settingsPage");
    const mobileMq = window.matchMedia("(max-width: 860px)");
    const isMobile = () => mobileMq.matches;

    C.openTab = null; // "root"(모바일 목록) 또는 탭 id

    C.viewTimer = 0;

    C.viewBusy = false; // 화면이 밀려 움직이는 중(전환 애니메이션·뒤로 제스처). 이 동안에는 다시 그리지 않고 미뤄 둔다

    C.rebuildPending = false;

    C.rootScroll = 0; // 목록을 떠날 때의 스크롤 위치(돌아오면 되살린다)

    let returnPath = null; // 설정 진입 전 경로(닫을 때 돌아갈 페이지)

    let pushed = false; // open()에서 히스토리 항목을 push했는지

    let mobileFromList = false; // 모바일 목록 화면에서 열었는지

    C.editingAgent = null; // 에이전트 페이지 id ('__new__' = 추가)

    let putChain = Promise.resolve();

    /* ── 경로 라우팅(/s/<탭>, /s/agents/<id>) ───────────── */
    const TABS = ["general", "folders", "notices", "provider", "model", "account", "selfimprovement", "skills", "mcp", "agents"];

    // 현재 경로를 설정 라우트로 해석한다. /s나 /s/…가 아니면 null.
    function routeFromPath() {
        if (/^\/s\/?$/.test(location.pathname || "")) return { tab: "root", agentId: null };
        const m = /^\/s\/(general|folders|notices|provider|model|account|selfimprovement|skills|mcp|agents)(?:\/([^/]+))?$/.exec(
            location.pathname || "",
        );
        if (!m) return null;
        const tab = m[1];
        let agentId = null;
        if (tab === "agents") {
            if (m[2] === "new") agentId = "__new__";
            else if (m[2]) agentId = agentList().some((a) => a.id === m[2]) ? m[2] : firstAgentId() || "__new__";
            else agentId = firstAgentId() || "__new__";
        }
        return { tab, agentId };
    }

    // 탭/에이전트를 /s/ 경로로 만든다.
    function pathFor(tab, agent) {
        if (tab === "root") return "/s";
        if (tab === "agents") return `/s/agents/${agent === "__new__" ? "new" : agent}`;
        return `/s/${tab || "general"}`;
    }

    // 탭/에이전트 전환: 현재 설정 페이지의 경로만 교체한다.
    function syncPath() {
        T.util.replaceUrl(pathFor(C.openTab, C.editingAgent) + location.search + location.hash, history.state);
    }

    /* ── 렌더링(뷰 레이어): 히스토리는 호출자/라우터가 담당한다 ──
       채팅의 T.chat.open과 동일한 역할: 경로에 맞게 화면을 그린다. */
    function open(opt) {
        // open({tab, agentId}) 또는 open("model") 형태 모두 지원
        const o = typeof opt === "object" && opt ? opt : { tab: opt };
        C.providerChoice = null;
        let tab, agent;
        if (o.agentId != null && o.agentId !== "" && (!o.tab || o.tab === "agents")) {
            tab = "agents";
            agent = o.agentId;
        } else if (TABS.includes(o.tab)) {
            tab = o.tab;
            agent = o.tab === "agents" ? o.agentId || firstAgentId() || "__new__" : null;
        } else {
            // 탭을 정하지 않고 열면 모바일은 목록, 데스크톱은 목록 옆에 첫 탭까지 연다.
            // 목록만 여는 것(/s)은 어디서든 된다. 데스크톱에서는 상세 열을 닫은 상태다.
            tab = o.tab === "root" || isMobile() ? "root" : "general";
            agent = null;
        }
        // 설정이 닫혀 있다가 열리는 것이면 메인 패널째로 밀려 들어오므로 안에서는 전환하지 않는다.
        if (page.hidden) page.replaceChildren();
        C.openTab = tab;
        C.editingAgent = agent;
        C.skillEditing = null;
        C.mcpEditing = null;
        // open({tab:"folders", folderId}). 사이드바 폴더 탭의 "폴더 편집"이 곧장 편집 폼을 연다.
        // open({tab:"folders", folderNew, folderAgent}). "폴더에 추가…" 안의 "새 폴더"가 그 에이전트를 미리 고른 만들기 폼을 연다.
        C.folderEditing = null;
        if (tab === "folders" && o.folderNew) C.folderEditing = { mode: "new", agentId: o.folderAgent || null };
        else if (tab === "folders" && o.folderId) C.folderEditing = { mode: "edit", id: o.folderId };
        C.advOpen = null;
        C.modelAdvOpen = false;
        C.keyEditing = false;
        C.credsEditing = null;
        returnPath = o.returnPath != null ? o.returnPath : /^\/s(?:\/|$)/.test(location.pathname) ? returnPath || "/" : location.pathname;
        const wasChatOpen = document.body.classList.contains("mobile-chat");
        T.todosUI?.hide?.();
        T.sidebar?.showChat();
        mobileFromList = !wasChatOpen && document.body.classList.contains("mobile-chat");
        pushed = false;
        if (!o.fromUrl) {
            try {
                history.pushState(null, "", pathFor(C.openTab, C.editingAgent));
                pushed = true;
            } catch {
                // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
            }
        }
        const wasHidden = page.hidden;
        C.build();
        page.hidden = false;
        document.body.classList.add("settings-route");
        // 숨겨진 채로 그린 열은 자리를 잴 수 없었다. 보이게 한 뒤 맨 오른쪽 열을 창 안으로 옮긴다(데스크톱).
        if (wasHidden && !isMobile()) T.revealColumn([...page.querySelectorAll(".sp-view:not(.col-out)")].pop());
        T.sidebar?.syncRoute?.();
        page.setAttribute("aria-label", t("settings"));
        page.focus({ preventScroll: true });
    }

    function close(options) {
        const o = options || {};
        if (o.updateUrl !== false) {
            if (pushed) {
                pushed = false;
                history.back();
                return;
            }
            T.util.replaceUrl((returnPath || "/") + location.hash);
        }
        pushed = false;
        returnPath = null;
        page.hidden = true;
        document.body.classList.remove("settings-route");
        // OAuth 대기 중 페이지를 닫아도 폴링이 백그라운드로 계속 도는 걸 막는다.
        // oauthPending은 유지. 다시 열면 oauthSection이 폴링을 재개한다.
        C.stopOauthPoll();
        C.openTab = null;
        C.modelsCache = null;
        C.modelsLoading = false;
        C.modelsFailedKey = null;
        C.modelsReq++;
        C.providerChoice = null;
        C.skillsCache = null;
        C.skillsLoading = false;
        C.skillsFailed = false;
        C.mcpCache = null;
        C.mcpLoading = false;
        C.mcpFailed = false;
        C.skillEditing = null;
        C.mcpEditing = null;
        C.folderEditing = null;
        clearTimeout(C.viewTimer);
        C.viewBusy = false;
        C.rebuildPending = false;
        C.rootScroll = 0;
        page.replaceChildren();
        if (mobileFromList) {
            mobileFromList = false;
            T.sidebar?.showList();
        }
        T.sidebar?.syncRoute?.();
    }

    /* 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링한다. */
    function navigate(tab, agentId) {
        // 이미 열려 있는 항목을 다시 눌렀다(데스크톱은 목록 열이 늘 보인다). 다시 그리면 열어 둔 편집 폼이 닫힌다.
        if (tab === C.openTab && (agentId || null) === (C.editingAgent || null)) return;
        try {
            if (C.openTab === "root") {
                // 목록에서 상세로: 항목을 쌓아 두면 뒤로 가기가 목록으로 돌아온다.
                // 바로 밑에 목록이 있다는 표시를 항목에 남긴다(앞으로 가기·새로 고침 뒤에도 맞게).
                C.rootScroll = page.querySelector(".sp-nav")?.scrollTop || 0;
                history.pushState({ spFromRoot: true }, "", pathFor(tab, agentId));
            } else {
                // 상세에서 다른 상세로: 기록을 쌓지 않는다. 쌓으면 뒤로 가기가 지나온 항목을 하나씩 다시 연다.
                history.replaceState(history.state, "", pathFor(tab, agentId));
            }
        } catch {
            // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
        }
        T.app?.renderRoute();
    }

    // 상세에서 목록으로(모바일). 목록에서 쌓은 항목이면 그 항목을 걷어 내고, 아니면 경로만 바꾼다.
    function popToRoot() {
        if (history.state?.spFromRoot) {
            history.back();
            return;
        }
        T.util.replaceUrl(`/s${location.search}${location.hash}`);
        T.app?.renderRoute();
    }

    /* 페이지를 내린다. 히스토리/모바일 전환은 라우터가 담당한다. */
    function hide() {
        close({ updateUrl: false });
    }

    /* ── 낙관적 PUT ─────────────────────────────────────────── */
    // 봇 라스터는 /api/agents 기준: CRUD 후 갱신한다.
    async function refreshBots() {
        try {
            const r = await T.api.agents();
            state.applyAgents(r);
        } catch {
            // 실패해도 다음 이벤트나 재접속 때 다시 받는다
        }
    }

    function put(patch) {
        const run = async () => {
            const prev = state.state.settings;
            const localPatch = patch && patch.provider && patch.provider.apiKey !== undefined ? { ...patch, provider: { ...patch.provider } } : patch;
            if (localPatch?.provider && localPatch.provider.apiKey !== undefined) {
                delete localPatch.provider.apiKey;
                localPatch.provider.apiKeySet = true;
            }
            state.mergeSettingsLocal(localPatch);
            try {
                const s = await T.api.putSettings(patch);
                if (s) state.setSettings(s);
                return true;
            } catch (err) {
                if (prev) state.setSettings(prev);
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                return false;
            }
        };
        const result = putChain.then(run, run);
        putChain = result.catch(() => {
            /* 앞선 저장의 실패가 뒤따르는 저장을 막지 않도록 체인을 이어 간다 */
        });
        return result;
    }

    function agentList() {
        const s = state.state.settings;
        return state.state.bots?.length ? state.state.bots : s?.agents || [];
    }

    function firstAgentId() {
        return agentList()[0]?.id || null;
    }

    /* ── 전역 바인딩 ────────────────────────────────────────── */
    function init() {
        state.on("settings", C.rebuildIfIdle);
        state.on("bots", C.rebuildIfIdle);
        state.on("folders", C.rebuildIfIdle);
        state.on("notices", () => {
            if (C.openTab === "notices") C.rebuildIfIdle();
        });
        state.on("pwa", C.rebuildIfIdle);
        // OAuth 결과는 시트가 닫혀 있어도 반영한다(설정 갱신 + 토스트).
        state.on("oauth_done", (p) => {
            C.oauthPending = null;
            C.stopOauthPoll();
            void T.api
                .getSettings()
                .then((s) => {
                    if (s) state.setSettings(s);
                })
                .catch(() => {
                    /* 실패해도 다음 설정 이벤트에서 다시 받는다 */
                });
            // 다른 창에서 로그인을 마치고 돌아온 결과: 그사이 화면을 보고 있지 않았을 수 있어 경고창으로 알린다.
            T.notices.alert({ text: p.ok ? t("oauthSuccess") : `${t("errorPrefix")}: ${p.detail || t("oauthFailed")}` });
            C.modelsReq++;
            C.modelsLoading = false;
            C.modelsCache = null;
            C.modelsFailedKey = null;
            if (C.openTab === "model" || C.openTab === "provider") C.build();
        });
        T.i18n.onChange(() => {
            if (C.openTab) C.build();
        });
        // 폭이 모바일과 데스크톱 사이를 오가면 화면 배치(한 화면씩 / 열로 나란히)가 달라지므로 다시 그린다.
        mobileMq.addEventListener("change", () => {
            if (!C.openTab || page.hidden) return;
            page.replaceChildren();
            C.build();
        });
    }

    T.settingsUI = {
        init,
        open,
        close,
        hide,
        isOpen: () => !!C.openTab && !page.hidden,
        routeFromPath,
        // 아래 항목은 나중에 로드되는 모듈이 채우므로 쓰는 시점에 읽는다.
        get gesture() {
            return C.gesture;
        },
        oauthSection: (...args) => C.oauthSection(...args),
        secretInput: (...args) => C.secretInput(...args),
        resetOauth: () => (C.oauthPending = null),
    };

    C.pathFor = pathFor;
    C.syncPath = syncPath;
    C.navigate = navigate;
    C.popToRoot = popToRoot;
    C.refreshBots = refreshBots;
    C.put = put;
    C.agentList = agentList;
    C.firstAgentId = firstAgentId;
})(window.Taby);
