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

    // 침묵 마커가 붙은 발화는 사용자용이 아니다 — 버블로 굳히거나 기록에 남기지 않고 버린다.
    function isSilentMarkedText(t) {
        const s = typeof t === "string" ? t.trim() : "";
        return s.startsWith("__SILENT__") || s.endsWith("__SILENT__");
    }

    function applyStatus(id, phase, detail, elapsedMs) {
        const c = ensureLive(id);
        if (phase) c.live.phase = phase;
        // 새 라운드(툴 실행) 진입 시점에 이전 라운드 텍스트를 중간 과정 버블로 굳힌다.
        // 새로고침 시 서버 히스토리에 남는 중간 assistant 메시지와 동일하게 보이도록 한다.
        if (phase === "tools" && c.live.text.trim()) {
            if (!isSilentMarkedText(c.live.text)) c.live.intermediate.push(c.live.text);
            c.live.text = "";
        }
        // 툴 라운드 경계는 서버 체크포인트/펜딩 메시지 병합 시점과 겹친다 —
        // 정본을 다시 읽어 실행 중 메시지 위치를 새로고침 상태와 맞춘다.
        if (phase === "tools") void refreshTurns(id).catch(() => {});
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

    /* ── 턴 정본 동기화 ─────────────────────────────────────── */
    // 클라이언트가 턴을 직접 조립하면 이벤트 도착/완료 시점 순서로 붙어
    // 전송 직후·생성 중 새로고침·완료·완료 후 새로고침에서 순서가 갈린다.
    // 디스크 히스토리(서버)가 유일한 정본이므로 이벤트마다 통째로 다시 읽는다.

    const ATTACHED_FILES_MARK = "[User attached files]";
    function displayUserText(content) {
        const s = String(content || "");
        const i = s.indexOf(ATTACHED_FILES_MARK);
        return i === -1 ? s : s.slice(0, i).trim();
    }
    function normalizeTurn(turn) {
        return {
            at: turn.at,
            stats: turn.stats || null,
            attachments: turn.attachments || [],
            messages: (turn.messages || []).map((m) => {
                const isParts = Array.isArray(m.content);
                const textPart = isParts ? m.content.find((part) => part?.type === "text")?.text || "" : m.content;
                return {
                    role: m.role,
                    content: displayUserText(textPart),
                    isParts,
                    imageUrl: m.imageUrl || null,
                    attachments: m.attachments || null,
                };
            }),
        };
    }

    // 대화당 최신 요청만 반영 — 오래된 응답이 정본을 덮지 않도록 세대 번호로 가드.
    const turnsReqSeq = new Map();
    async function refreshTurns(id) {
        const c = conv(id);
        if (!c) return false;
        const seq = (turnsReqSeq.get(id) || 0) + 1;
        turnsReqSeq.set(id, seq);
        const r = await T.api.conversation(id);
        if (seq !== turnsReqSeq.get(id)) return true; // 더 새 요청이 진행 중
        const incoming = (Array.isArray(r?.turns) ? r.turns : []).map(normalizeTurn);
        c.turns = incoming;
        c.loaded = true;
        if (r && typeof r === "object") {
            const { turns: _turns, ...meta } = r;
            if (meta && meta.id) upsertMeta(Object.assign({}, c.meta, meta));
        }
        // 정본에 흡수된 확정 pending과 이미 저장된 라이브 중간 발화를 정리한다.
        if (c.pending.length) c.pending = c.pending.filter((p) => !p.confirmed);
        if (c.live) {
            if (r.running === false) {
                // 서버는 끝났는데 live만 남은 경우(turn_done 유실) 정본으로 정리
                c.live = null;
                emit("live", { id });
            } else if (c.live.intermediate?.length) {
                const stored = new Set();
                for (const t of incoming) {
                    for (const m of t.messages || []) {
                        if (m.role === "assistant") stored.add(String(m.content || "").trim());
                    }
                }
                c.live.intermediate = c.live.intermediate.filter((x) => !stored.has(String(x || "").trim()));
            }
        }
        emit("turns", { id });
        return true;
    }

    function applyUserMessage(id, text, imageUrl, attachments = []) {
        const c = conv(id);
        if (!c) return;
        const attachmentIds = attachments.map((a) => a.id).filter(Boolean);
        // 낙관적으로 추가한 내 메시지와 일치하면 확정 표시 — 정본이 도착할 때까지
        // 버블을 유지하기 위해 confirmed 플래그만 세우고 refreshTurns에서 제거한다.
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
            c.pending[idx].confirmed = true;
            confirmed = true;
        }
        const snippet = String(text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        if (snippet) c.meta = Object.assign({}, c.meta, { preview: snippet });
        emit("user_message", { id, confirmed });
        void (async () => {
            let ok = false;
            try {
                ok = await refreshTurns(id);
            } catch (_) {}
            if (ok) return;
            // 정본 읽기 실패 폴백 — 기존처럼 로컬에 붙여 메시지가 안 보이는 일은 막는다.
            c.pending = c.pending.filter((p) => !p.confirmed);
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
            emit("turns", { id });
        })();
    }

    function applyTurnDone(id, text, stats, error, attachments = [], silent = false) {
        const c = conv(id);
        if (!c) return;
        const hadLive = !!c.live;
        const liveSnap = c.live;
        const fallback = liveSnap && typeof liveSnap.text === "string" ? liveSnap.text : "";
        // 중간 과정 발화(툴 호출 전 코멘트)도 메신저 기록에 남긴다 —
        // 라이브에서 이미 보여준 말을 완료 시점에 지우지 않는다.
        const intermediate = (liveSnap ? liveSnap.intermediate : []).filter((t) => !isSilentMarkedText(t));
        void (async () => {
            let ok = false;
            try {
                ok = await refreshTurns(id);
            } catch (_) {}
            if (!ok) {
                // 정본 읽기 실패 폴백 — 라이브 내용을 로컬 턴으로 승격한다.
                if (silent) {
                    // 침묵 마커는 마지막 답변 한 개만 숨긴다 — 이미 보여준 중간 발화는
                    // 회수하지 않고 그대로 메신저 기록에 남긴다.
                    if (intermediate.length) {
                        const last = c.turns[c.turns.length - 1];
                        const lastMsg = last && last.messages && last.messages[last.messages.length - 1];
                        const tail = intermediate[intermediate.length - 1];
                        const already = lastMsg && lastMsg.role === "assistant" && lastMsg.content === tail;
                        if (!already) {
                            c.turns.push({
                                at: new Date().toISOString(),
                                messages: intermediate.map((t) => ({ role: "assistant", content: t })),
                                stats: stats || null,
                                attachments,
                            });
                        }
                    }
                } else {
                    // 라이브가 없거나 SSE text가 비어도, 스트림에 쌓인 본문이 있으면 턴으로 남긴다.
                    // 그렇지 않으면 답이 DOM에서 사라지고 새로고침 전까지 안 보인다.
                    const rawFinal = String(text || fallback || "");
                    const finalText = isSilentMarkedText(rawFinal) ? "" : rawFinal;
                    const spoken = [
                        ...intermediate.map((t) => ({ role: "assistant", content: t })),
                        ...(finalText ? [{ role: "assistant", content: finalText }] : []),
                    ];
                    if (spoken.length || attachments.length) {
                        const last = c.turns[c.turns.length - 1];
                        const lastMsg = last && last.messages && last.messages[last.messages.length - 1];
                        const tail = spoken.length ? spoken[spoken.length - 1].content : null;
                        const already = tail != null && lastMsg && lastMsg.role === "assistant" && lastMsg.content === tail;
                        if (!already) {
                            c.turns.push({
                                at: new Date().toISOString(),
                                messages: spoken,
                                stats: stats || null,
                                attachments,
                            });
                        }
                    }
                }
            }
            // 정본이 턴을 저장한 뒤에만 live를 해제한다 — 답 버블이 깜빡 사라지지 않게.
            if (c.live === liveSnap) c.live = null;
            emit("live", { id });
            emit("turn_done", { id, error: error != null ? error : null, finalized: hadLive });
        })();
        const rawFinal = String(text || fallback || "");
        const snippet = (isSilentMarkedText(rawFinal) ? "" : rawFinal).replace(/\s+/g, " ").trim().slice(0, 120);
        if (snippet && !silent) c.meta = Object.assign({}, c.meta, { preview: snippet });
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
        refreshTurns,
        normalizeTurn,
        setSettings,
        mergeSettingsLocal,
        setConn,
    };
})((window.Taby = window.Taby || {}));
