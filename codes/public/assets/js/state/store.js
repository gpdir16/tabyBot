/* tabyBot 웹 클라이언트: 상태 저장소(구독/발행, 대화 캐시, 봇·폴더·할 일·설정). */
((T) => {
    "use strict";

    T.stateCtx ??= {};
    const C = T.stateCtx;

    const state = {
        bootstrap: null, // GET /api/bootstrap 응답
        settings: null, // GET /api/settings 응답
        bots: [], // GET /api/agents 응답(메신저 라스터)
        folders: [], // GET /api/agents 응답의 에이전트 폴더(순서 = 표시 순서)
        botQuery: "", // 봇 검색 필터
        conversations: [], // 스레드 메타(봇 uuid + 스케줄 결과 등)
        convs: new Map(), // uuid → { meta, loaded, turns, pending, live }
        currentId: null,
        currentTodoId: null,
        todos: [],
        todoSuggestions: [],
        todosFailed: false,
        conn: "disconnected",
        offline: true,
    };

    /* ── 구독/발행 ─────────────────────────────────────────── */
    const subs = new Map();

    function on(topic, fn) {
        let set = subs.get(topic);
        if (!set) {
            set = new Set();
            subs.set(topic, set);
        }
        set.add(fn);
        return () => set.delete(fn);
    }

    function emit(topic, payload) {
        const set = subs.get(topic);
        if (set)
            set.forEach((fn) => {
                try {
                    fn(payload);
                } catch (_e) {
                    /* 관찰자 오류 격리 */
                }
            });
    }

    /* ── 대화 캐시 ─────────────────────────────────────────── */
    function blankConv() {
        return { meta: null, loaded: false, turns: [], pending: [], live: null };
    }

    // 없으면 스텁 메타로 생성(SSE가 목록 로드 전에 도착하는 경우)
    function conv(id) {
        if (!id) return null;
        let c = state.convs.get(id);
        if (!c) {
            c = blankConv();
            c.meta = { id, preview: "", agentId: null, createdAt: null, updatedAt: null };
            state.convs.set(id, c);
        }
        return c;
    }

    function currentConv() {
        return state.currentId ? conv(state.currentId) : null;
    }

    /* ── 봇(메신저 라스터) ─────────────────────────────────── */
    function setBots(list) {
        state.bots = Array.isArray(list) ? list : [];
        // 에이전트 목록에 실린 미리보기를 스레드 메타에 바로 반영한다(클릭 전에 사이드바에 보이게).
        for (const bot of state.bots) {
            const preview = String(bot.preview || "").trim();
            if (!bot.uuid || !preview) continue;
            const c = conv(bot.uuid);
            if (!String(c.meta?.preview || "").trim()) {
                c.meta = Object.assign({}, c.meta, { id: bot.uuid, preview });
            }
        }
        emit("bots", {});
    }

    function setFolders(list) {
        state.folders = Array.isArray(list) ? list : [];
        emit("folders", {});
    }

    // /api/agents 계열 응답 {agents, folders}를 한 번에 반영한다.
    // folders가 없는 예전 응답이면 기존 폴더 상태를 유지한다.
    function applyAgents(payload) {
        setBots(payload?.agents || []);
        if (Array.isArray(payload?.folders)) setFolders(payload.folders);
    }

    function botByUuid(uuid) {
        return state.bots.find((b) => b.uuid === uuid) || null;
    }

    function currentBot() {
        return state.currentId ? botByUuid(state.currentId) : null;
    }

    // 가장 최근에 대화한 봇: 경로 없이 앱을 열었을 때의 기본 대화.
    // 기록이 하나도 없으면 에이전트 순서의 첫 봇으로 폴백한다.
    function mostRecentBot() {
        let best = null;
        let bestAt = "";
        for (const bot of state.bots) {
            const at = String(state.convs.get(bot.uuid)?.meta?.updatedAt || "");
            if (at && at > bestAt) {
                best = bot;
                bestAt = at;
            }
        }
        return best || state.bots[0] || null;
    }

    function sortConversations() {
        state.conversations.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    // 목록 교체: 캐시의 턴/라이브는 보존, 사라진 항목은 라이브 없을 때만 제거
    function replaceConversations(list) {
        const seen = new Set();
        for (const item of list || []) {
            seen.add(item.id);
            const c = conv(item.id);
            c.meta = Object.assign({}, c.meta, item);
            // 재접속 사이에 놓친 turn_done: 서버가 실행 중이 아니면 stale live를 정리한다.
            // (running 필드가 없는 예전 서버와의 하위 호환을 위해 명시적 false만 본다)
            if (item.running === false && c.live) {
                c.live = null;
                emit("live", { id: item.id });
                emit("turn_done", { id: item.id, error: null, finalized: true });
            }
        }
        for (const [id, c] of state.convs) {
            if (!seen.has(id) && !c.live && id !== state.currentId && c.loaded === false) {
                state.convs.delete(id);
            } else if (!seen.has(id) && !c.live) {
                // 로드된 적 있는 대화가 목록에서 사라졌다면(다른 탭 삭제) 함께 정리
                if (c.loaded) {
                    state.convs.delete(id);
                    if (state.currentId === id) {
                        state.currentId = null;
                        emit("current", null);
                    }
                }
            }
        }
        state.conversations = list || [];
        sortConversations();
        emit("conversations");
    }

    function upsertMeta(meta) {
        if (!meta?.id) return;
        const c = conv(meta.id);
        c.meta = Object.assign({}, c.meta, meta);
        const i = state.conversations.findIndex((m) => m.id === meta.id);
        if (i > -1) state.conversations[i] = c.meta;
        else state.conversations.push(c.meta);
        sortConversations();
        emit("conversations");
    }

    function setCurrent(id) {
        if (state.currentId === id) return;
        state.currentId = id;
        if (id) {
            state.currentTodoId = null;
            emit("todos");
        }
        emit("current", id);
    }

    function setTodos(payload) {
        const data = payload && typeof payload === "object" ? payload : {};
        state.todos = Array.isArray(data.items) ? data.items : Array.isArray(payload) ? payload : [];
        state.todoSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
        state.todosRecovered = data.recovered || null;
        emit("todos", true);
    }

    async function fetchTodos() {
        const ticket = todosTicket();
        try {
            const r = await T.api.todos();
            return applyTodos(ticket, r);
        } catch (err) {
            state.todosFailed = true;
            emit("todos");
            throw err;
        }
    }

    let todosReqSeq = 0;

    let todosAppliedSeq = 0;

    function todosTicket() {
        return ++todosReqSeq;
    }

    function applyTodos(ticket, payload) {
        if (ticket <= todosAppliedSeq) return false;
        todosAppliedSeq = ticket;
        state.todosFailed = false;
        setTodos(payload);
        return true;
    }

    function setCurrentTodo(id) {
        const next = id || null;
        if (state.currentTodoId === next) return;
        state.currentTodoId = next;
        emit("current", state.currentId);
        emit("todos");
    }

    /* ── 설정 ──────────────────────────────────────────────── */
    function setSettings(s) {
        state.settings = s || null;
        emit("settings", s);
    }

    // 낙관적 병합(provider는 1단계, selfImprovement는 섹션까지 2단계 깊이 병합)
    function mergeSettingsLocal(patch) {
        if (!state.settings || !patch) return;
        const next = Object.assign({}, state.settings);
        for (const k in patch) {
            if (k === "provider" && next.provider && typeof patch[k] === "object") {
                next.provider = Object.assign({}, next.provider, patch[k]);
            } else if (k === "selfImprovement" && next.selfImprovement && typeof patch[k] === "object") {
                const merged = Object.assign({}, next.selfImprovement);
                for (const sec in patch[k]) {
                    if (patch[k][sec] && typeof patch[k][sec] === "object") merged[sec] = Object.assign({}, merged[sec], patch[k][sec]);
                }
                next.selfImprovement = merged;
            } else {
                next[k] = patch[k];
            }
        }
        state.settings = next;
        emit("settings", next);
    }

    /* ── 연결/기타 ─────────────────────────────────────────── */
    function setConn(s) {
        if (state.conn === s) return;
        state.conn = s;
        emit("conn", s);
    }

    C.state = state;
    C.on = on;
    C.emit = emit;
    C.conv = conv;
    C.currentConv = currentConv;
    C.setBots = setBots;
    C.setFolders = setFolders;
    C.applyAgents = applyAgents;
    C.botByUuid = botByUuid;
    C.currentBot = currentBot;
    C.mostRecentBot = mostRecentBot;
    C.replaceConversations = replaceConversations;
    C.upsertMeta = upsertMeta;
    C.setCurrent = setCurrent;
    C.setTodos = setTodos;
    C.fetchTodos = fetchTodos;
    C.todosTicket = todosTicket;
    C.applyTodos = applyTodos;
    C.setCurrentTodo = setCurrentTodo;
    C.setSettings = setSettings;
    C.mergeSettingsLocal = mergeSettingsLocal;
    C.setConn = setConn;
})(window.Taby);
