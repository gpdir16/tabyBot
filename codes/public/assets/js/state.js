/* tabyBot 웹 클라이언트 — 중앙 상태 스토어.
   대화 캐시(턴/라이브 스트림), 설정, 연결 상태를 보관하고
   토피 기반 구독(on/emit)으로 UI 모듈에 변경을 알린다. */
(function (T) {
    "use strict";

    const state = {
        bootstrap: null, // GET /api/bootstrap 응답
        settings: null, // GET /api/settings 응답
        bots: [], // GET /api/agents 응답(메신저 라스터)
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
                } catch (e) {
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

    function botByUuid(uuid) {
        return state.bots.find((b) => b.uuid === uuid) || null;
    }

    function currentBot() {
        return state.currentId ? botByUuid(state.currentId) : null;
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
        if (!meta || !meta.id) return;
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

    /* ── SSE 이벤트 반영(mutator) ──────────────────────────── */
    function freshLive() {
        return { phase: "generating", detail: "", elapsedMs: null, text: "", tools: [], asks: [], intermediate: [] };
    }

    // live가 시작되는 전환 지점에서만 "live"를 방출한다(컴포저 정지 버튼 등이 구독).
    function ensureLive(id) {
        const c = conv(id);
        if (!c.live) {
            c.live = freshLive();
            emit("live", { id });
        }
        return c;
    }

    function applyStatus(id, phase, detail, elapsedMs) {
        const c = ensureLive(id);
        if (phase) c.live.phase = phase;
        // 새 라운드(툴 실행) 진입 시점에 이전 라운드 텍스트를 중간 과정 버블로 굳힌다.
        // 새로고침 시 서버 히스토리에 남는 중간 assistant 메시지와 동일하게 보이도록 한다.
        if (phase === "tools" && c.live.text.trim()) {
            c.live.intermediate.push(c.live.text);
            c.live.text = "";
        }
        c.live.detail = detail || "";
        c.live.elapsedMs = elapsedMs != null ? elapsedMs : c.live.elapsedMs;
        emit("status", { id });
    }

    function applyDelta(id, full, text) {
        const c = ensureLive(id);
        // full이 지금까지 전체 누적. 없으면 text를 덧셈 폴백.
        c.live.text = typeof full === "string" ? full : c.live.text + (text || "");
        emit("delta", { id });
    }

    function applyTool(id, name, argsSummary) {
        const c = ensureLive(id);
        c.live.tools.push({ name: name || "", argsSummary: argsSummary || "" });
        emit("tool", { id });
    }

    function applyAsk(id, a) {
        const c = ensureLive(id);
        c.live.asks.push({
            askId: a.askId,
            question: a.question || "",
            options: Array.isArray(a.options) ? a.options : [],
            expiresAt: a.expiresAt || null,
            answer: null, // 사용자가 선택한 답변({choiceIndex}|{text})
            resolved: false,
        });
        emit("ask", { id, askId: a.askId });
    }

    function applyAskResolved(id, askId, answer) {
        const c = conv(id);
        const live = c.live;
        const ask = live && live.asks.find((a) => a.askId === askId);
        if (ask) {
            ask.resolved = true;
            const rawAnswer = typeof answer === "object" && answer !== null ? answer.text : answer;
            const internal = typeof rawAnswer === "string" && (rawAnswer.startsWith("__TIMEOUT__") || rawAnswer.startsWith("__CANCELLED__:"));
            if (!internal && answer != null && ask.answer == null) {
                ask.answer = typeof answer === "object" ? answer : { text: String(answer) };
            }
        }
        emit("ask_resolved", { id, askId });
    }

    function applyUserMessage(id, text, imageUrl, attachments = []) {
        const c = conv(id);
        const attachmentIds = attachments.map((a) => a.id).filter(Boolean);
        // 낙관적으로 추가한 내 메시지와 일치하면 확정 처리, 아니면(멀티탭) 신규 기록
        const idx = c.pending.findIndex(
            (p) =>
                p.text === (text || "") &&
                (p.imageUrl || null) === (imageUrl || null) &&
                (p.attachments || [])
                    .map((a) => a.id)
                    .filter(Boolean)
                    .join(",") === attachmentIds.join(","),
        );
        let confirmed = false;
        if (idx > -1) {
            c.pending.splice(idx, 1);
            confirmed = true;
        }
        // 확정된 사용자 메시지도 turns에 남긴다. 없으면 봇 전환 후 재렌더에서 사라진다.
        const last = c.turns[c.turns.length - 1];
        const lastMsg = last && last.messages && last.messages[last.messages.length - 1];
        const already =
            lastMsg &&
            lastMsg.role === "user" &&
            lastMsg.content === (text || "") &&
            (lastMsg.imageUrl || null) === (imageUrl || null) &&
            (lastMsg.attachments || []).map((a) => a.id).join(",") === attachmentIds.join(",");
        if (!already) {
            c.turns.push({
                at: new Date().toISOString(),
                messages: [{ role: "user", content: text || "", imageUrl: imageUrl || null, attachments }],
                stats: null,
            });
        }
        const snippet = String(text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        if (snippet) c.meta = Object.assign({}, c.meta, { preview: snippet });
        emit("user_message", { id, confirmed });
    }

    function applyTurnDone(id, text, stats, error, attachments = [], silent = false) {
        const c = conv(id);
        const hadLive = !!c.live;
        const fallback = c.live && typeof c.live.text === "string" ? c.live.text : "";
        // 중간 과정 텍스트(툴 호출 전 코멘트)도 턴에 함께 남긴다.
        // 서버 히스토리(새로고침 시 표시)와 동일하게 유지하기 위함.
        const inter = ((c.live && c.live.intermediate) || [])
            .map((t) => ({ role: "assistant", content: t }))
            .filter((m) => m.content && m.content.trim());
        c.live = null;
        if (silent) {
            emit("live", { id });
            emit("turn_done", { id, hadLive });
            return;
        }
        // 라이브가 없거나 SSE text가 비어도, 스트림에 쌓인 본문이 있으면 턴으로 남긴다.
        // 그렇지 않으면 답이 DOM에서 사라지고 새로고침 전까지 안 보인다.
        const finalText = String(text || fallback || "");
        if (finalText || inter.length || attachments.length) {
            const last = c.turns[c.turns.length - 1];
            const lastMsg = last && last.messages && last.messages[last.messages.length - 1];
            const already = lastMsg && lastMsg.role === "assistant" && lastMsg.content === finalText;
            if (!already) {
                c.turns.push({
                    at: new Date().toISOString(),
                    messages: [...inter, ...(finalText ? [{ role: "assistant", content: finalText }] : [])],
                    stats: stats || null,
                    attachments,
                });
            }
            const snippet = finalText.replace(/\s+/g, " ").trim().slice(0, 120);
            if (snippet) c.meta = Object.assign({}, c.meta, { preview: snippet });
        }
        emit("turn_done", { id, error: error != null ? error : null, finalized: hadLive });
        emit("live", { id });
    }

    /* ── 설정 ──────────────────────────────────────────────── */
    function setSettings(s) {
        state.settings = s || null;
        emit("settings", s);
    }

    // 낙관적 병합(provider는 1단계 깊이 병합)
    function mergeSettingsLocal(patch) {
        if (!state.settings || !patch) return;
        const next = Object.assign({}, state.settings);
        for (const k in patch) {
            if (k === "provider" && next.provider && typeof patch[k] === "object") {
                next.provider = Object.assign({}, next.provider, patch[k]);
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

    T.state = {
        state,
        on,
        emit,
        conv,
        currentConv,
        setCurrent,
        setTodos,
        todosTicket,
        applyTodos,
        fetchTodos,
        setCurrentTodo,
        upsertMeta,
        replaceConversations,
        setBots,
        botByUuid,
        currentBot,
        applyStatus,
        applyDelta,
        applyTool,
        applyAsk,
        applyAskResolved,
        applyUserMessage,
        applyTurnDone,
        setSettings,
        mergeSettingsLocal,
        setConn,
    };
})((window.Taby = window.Taby || {}));
