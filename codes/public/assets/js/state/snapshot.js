/* tabyBot 웹 클라이언트: 즉시 표시용 로컬 스냅샷과 T.state 공개 인터페이스. */
((T) => {
    "use strict";

    T.stateCtx ??= {};
    const C = T.stateCtx;

    /* ── 스냅샷(즉시 표시용 로컬 캐시) ───────────────────────── */
    // 마지막으로 본 목록/설정/현재 대화를 localStorage에 남겨, 다음 실행 때
    // 네트워크 응답을 기다리지 않고 바로 그린다. 서버 응답이 오면 그대로 덮는다(정본은 서버).
    const SNAP_KEY = "tabybot.snapshot.v1";

    const SNAP_TURNS_KEY = "tabybot.snapshot.turns.v1";

    const SNAP_TURNS_MAX = 80; // 현재 대화는 최근 턴만 저장해 용량 한도와 파싱 비용을 묶는다

    const SNAP_TURNS_MAX_CHARS = 400_000;

    let snapTimer = 0;

    function writeSnapshot() {
        snapTimer = 0;
        if (C.state.offline || !C.state.bootstrap) return;
        // 계정이 있는데 세션이 없으면(로그아웃 직후) 다시 쓰지 않는다.
        if (C.state.account?.hasAccount && !T.api.getToken()) return;
        try {
            localStorage.setItem(
                SNAP_KEY,
                JSON.stringify({
                    bootstrap: C.state.bootstrap,
                    settings: C.state.settings,
                    agents: C.state.bots,
                    folders: C.state.folders,
                    conversations: C.state.conversations,
                    todos: { items: C.state.todos, suggestions: C.state.todoSuggestions },
                }),
            );
            const c = C.state.currentId ? C.state.convs.get(C.state.currentId) : null;
            if (c?.loaded) {
                const payload = JSON.stringify({ id: C.state.currentId, turns: c.turns.slice(-SNAP_TURNS_MAX) });
                if (payload.length <= SNAP_TURNS_MAX_CHARS) localStorage.setItem(SNAP_TURNS_KEY, payload);
                else localStorage.removeItem(SNAP_TURNS_KEY);
            }
        } catch (_) {
            /* 용량 초과/스토리지 차단: 스냅샷 없이 동작한다 */
        }
    }

    function scheduleSnapshot() {
        if (snapTimer) return;
        snapTimer = setTimeout(writeSnapshot, 800);
    }

    function clearSnapshot() {
        clearTimeout(snapTimer);
        snapTimer = 0;
        try {
            localStorage.removeItem(SNAP_KEY);
            localStorage.removeItem(SNAP_TURNS_KEY);
        } catch {
            // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
        }
    }

    // 저장된 스냅샷을 상태에 반영한다. 반영했으면 true.
    function restoreSnapshot() {
        let snap = null;
        let cached = null;
        try {
            snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
            cached = JSON.parse(localStorage.getItem(SNAP_TURNS_KEY) || "null");
        } catch (_) {
            return false;
        }
        if (!snap?.bootstrap || !Array.isArray(snap.agents) || !snap.agents.length) return false;
        C.state.bootstrap = snap.bootstrap;
        C.emit("bootstrap");
        if (snap.settings) C.setSettings(snap.settings);
        C.applyAgents({ agents: snap.agents, folders: snap.folders });
        C.replaceConversations(Array.isArray(snap.conversations) ? snap.conversations : []);
        if (snap.todos) C.setTodos(snap.todos);
        if (cached?.id && Array.isArray(cached.turns) && C.botByUuid(cached.id)) {
            const c = C.conv(cached.id);
            c.turns = cached.turns;
            c.turnsSig = JSON.stringify(cached.turns);
            c.loaded = true;
            c.fetchedAt = 0; // 열 때 반드시 서버 정본으로 재검증한다
        }
        return true;
    }

    for (const topic of ["bots", "folders", "conversations", "settings", "turns", "current", "todos"]) C.on(topic, scheduleSnapshot);

    // 탭을 닫거나 백그라운드로 보낼 때 대기 중인 스냅샷을 놓치지 않는다.
    window.addEventListener("pagehide", () => {
        if (snapTimer) {
            clearTimeout(snapTimer);
            writeSnapshot();
        }
    });

    T.state = {
        state: C.state,
        on: C.on,
        emit: C.emit,
        mostRecentBot: C.mostRecentBot,
        restoreSnapshot,
        clearSnapshot,
        conv: C.conv,
        currentConv: C.currentConv,
        setCurrent: C.setCurrent,
        setTodos: C.setTodos,
        todosTicket: C.todosTicket,
        applyTodos: C.applyTodos,
        fetchTodos: C.fetchTodos,
        setCurrentTodo: C.setCurrentTodo,
        upsertMeta: C.upsertMeta,
        replaceConversations: C.replaceConversations,
        setBots: C.setBots,
        setFolders: C.setFolders,
        applyAgents: C.applyAgents,
        botByUuid: C.botByUuid,
        currentBot: C.currentBot,
        applyStatus: C.applyStatus,
        applyDelta: C.applyDelta,
        applySay: C.applySay,
        applyTool: C.applyTool,
        applyAsk: C.applyAsk,
        applyAskResolved: C.applyAskResolved,
        applyUserMessage: C.applyUserMessage,
        applyTurnDone: C.applyTurnDone,
        refreshTurns: C.refreshTurns,
        normalizeTurn: C.normalizeTurn,
        setSettings: C.setSettings,
        mergeSettingsLocal: C.mergeSettingsLocal,
        setConn: C.setConn,
    };
})(window.Taby);
