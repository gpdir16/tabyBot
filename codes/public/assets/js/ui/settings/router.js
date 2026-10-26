/* tabyBot 웹 클라이언트: 설정 창 열기와 서버 저장.
   설정의 목록·탭·편집 화면은 모두 창(ui/windows.js)이다. 창 id는 "s"(목록), "s.<탭>", "s.agent:<id>" 등이고,
   종류마다 그 화면을 그리는 모듈(general.js, models.js, …)이 등록한다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    let putChain = Promise.resolve();

    const TABS = ["general", "folders", "notices", "model", "account", "efficiency", "selfimprovement", "skills", "mcp", "secrets"];

    // 설정 창인지(목록 "s"와 "s."로 시작하는 종류).
    function isSettingsWin(win) {
        return win.kind === "s" || win.kind.startsWith("s.");
    }

    // 열 창의 id. o: { tab, agentId('__new__'면 새 에이전트), folderId, folderNew, folderChat }
    function idFor(o) {
        if (o.agentId) return `s.agent:${o.agentId === "__new__" ? "new" : o.agentId}`;
        if (o.tab === "folders" && o.folderNew) return `s.folder:new${o.folderChat ? `.${o.folderChat}` : ""}`;
        if (o.tab === "folders" && o.folderId) return `s.folder:${o.folderId}`;
        if (TABS.includes(o.tab)) return `s.${o.tab}`;
        return "s";
    }

    // 설정 창 하나를 연다. opt: 없음(목록), 탭 이름, 또는 { tab, agentId, folderId, folderNew, folderChat, from }.
    // 이미 열려 있으면 그 창을 보인다. 연 창을 돌려준다.
    function open(opt) {
        const o = typeof opt === "object" && opt ? opt : { tab: opt };
        return T.windows.open(idFor(o), { from: o.from });
    }

    // 예전 설정 주소(/s, /s/<탭>, /s/agents/<id>)가 가리키던 창들. 설정 주소가 아니면 null.
    function legacyIds(pathname) {
        const path = pathname || "";
        if (/^\/s\/?$/.test(path)) return ["s"];
        const m = /^\/s\/([a-z]+)(?:\/([^/]+))?\/?$/.exec(path);
        if (!m) return null;
        // 그룹 대화방은 이제 대화 정보 창에서 고친다. 예전 주소는 설정 목록만 연다.
        if (m[1] === "groups") return ["s"];
        if (m[1] === "agents") {
            if (!m[2]) return ["s"];
            let id = m[2];
            try {
                id = decodeURIComponent(id);
            } catch {
                return ["s"];
            }
            return ["s", `s.agent:${id}`];
        }
        // 프로바이더 탭은 모델과 프로바이더 탭으로 합쳐졌다.
        const tab = m[1] === "provider" ? "model" : m[1];
        if (!TABS.includes(tab)) return null;
        return ["s", `s.${tab}`];
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
        // OAuth 결과는 설정 창이 닫혀 있어도 반영한다(설정 갱신 + 알림).
        state.on("oauth_done", (p) => {
            C.cliLoginPending = null;
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
            C.forgetModelLists();
            T.windows.refresh((w) => w.kind === "s.model" || w.kind === "s.profile");
        });
    }

    T.settingsUI = {
        init,
        open,
        isOpen: () => T.windows.list().some(isSettingsWin),
        legacyIds,
        // 아래 항목은 나중에 로드되는 모듈이 채우므로 쓰는 시점에 읽는다.
        oauthSection: (...args) => C.oauthSection(...args),
        cliLoginSection: (...args) => C.cliLoginSection(...args),
        secretInput: (...args) => C.secretInput(...args),
        resetOauth: () => {
            C.oauthPending = null;
            C.cliLoginPending = null;
        },
    };

    C.isSettingsWin = isSettingsWin;
    C.refreshBots = refreshBots;
    C.put = put;
    C.agentList = agentList;
    C.firstAgentId = firstAgentId;
})(window.Taby);
