/* tabyBot 웹 클라이언트: SSE 이벤트 반영(라이브 상태)과 턴 정본 동기화. */
((T) => {
    "use strict";

    T.stateCtx ??= {};
    const C = T.stateCtx;

    /* ── SSE 이벤트 반영(mutator) ──────────────────────────── */
    function freshLive(automated) {
        return {
            phase: "generating",
            detail: "",
            elapsedMs: null,
            text: "",
            tools: [],
            asks: [],
            intermediate: [],
            automated,
            startedAt: Date.now(), // 이보다 먼저 보낸 요청의 "실행 중 아님" 응답으로는 지우지 않는다
        };
    }

    // 목록 정렬(updatedAt)을 새 활동 시각으로 맞춘다. 정본은 뒤따르는
    // refreshTurns/upsertMeta가 서버 값으로 덮는다.
    function touchMeta(c, id) {
        c.meta = Object.assign({}, c.meta, { id, updatedAt: new Date().toISOString() });
    }

    // live가 시작되는 전환 지점에서만 "live"를 방출한다(컴포저 정지 버튼 등이 구독).
    // 자동 실행(예약·능동 체크인)은 답이 나오기 전까지 목록 순서를 건드리지 않는다.
    // 침묵으로 끝나면 기록에 남지 않으므로 먼저 올려 두면 순서가 튀었다가 되돌아간다.
    function ensureLive(id, automated = false) {
        const c = C.conv(id);
        if (!c.live) {
            c.live = freshLive(automated);
            if (!automated) touchMeta(c, id);
            C.emit("live", { id });
        }
        return c;
    }

    // 침묵 마커가 붙은 발화는 사용자용이 아니다. 버블로 굳히거나 기록에 남기지 않고 버린다.
    function isSilentMarkedText(t) {
        const s = typeof t === "string" ? t.trim() : "";
        return s.startsWith("__SILENT__") || s.endsWith("__SILENT__");
    }

    function applyStatus(id, phase, detail, elapsedMs, automated = false) {
        const c = ensureLive(id, automated);
        if (phase) c.live.phase = phase;
        // 툴 호출에 붙은 텍스트는 사용자에게 가지 않는 내부 메모: 버리기만 한다.
        // 사용자용 중간 발화는 user_say 호출(applySay)로만 들어온다.
        // 정본이 바뀌는 시점은 서버가 turns_changed로 따로 알린다.
        if (phase === "tools") c.live.text = "";
        c.live.detail = detail || "";
        c.live.elapsedMs = elapsedMs != null ? elapsedMs : c.live.elapsedMs;
        C.emit("status", { id });
    }

    // 서버는 늘어난 부분만 보낸다. offset은 그 조각이 붙을 자리(지금까지의 길이)다.
    function applyDelta(id, offset, text, automated = false) {
        const c = ensureLive(id, automated);
        if (offset === 0) c.live.text = text || "";
        else if (offset === c.live.text.length) c.live.text += text || "";
        // 중간을 놓쳤다(재접속 등). 어긋난 본문을 잇지 않고 다음 본문이 처음부터 올 때까지 비워 둔다.
        else c.live.text = "";
        C.emit("delta", { id });
    }

    // user_say 도구 호출: 모델이 명시적으로 사용자에게 보낸 중간 발화만 버블로 쌓는다.
    function applySay(id, text) {
        const s = String(text || "");
        if (!s.trim() || isSilentMarkedText(s)) return;
        const c = ensureLive(id);
        // 발화는 도구 실행 전에 이미 기록에 적힌다. 정본이 먼저 도착했으면 라이브에 또 쌓지 않는다.
        if (!c.live.intermediate.includes(s) && !runningTurnTexts(c.turns).has(s.trim())) c.live.intermediate.push(s);
        // 자동 실행은 실제로 사용자에게 말을 건 이 시점에 처음으로 목록 순서가 오른다.
        if (c.live.automated) touchMeta(c, id);
        C.emit("status", { id });
    }

    function applyTool(id, name, argsSummary) {
        const c = ensureLive(id);
        c.live.tools.push({ name: name || "", argsSummary: argsSummary || "" });
        C.emit("tool", { id });
    }

    function applyAsk(id, a) {
        const c = ensureLive(id);
        // 새로고침 뒤 서버 목록으로 되살릴 때 이미 있는 카드는 건드리지 않는다.
        if (c.live.asks.some((x) => x.askId === a.askId)) return;
        c.live.asks.push({
            askId: a.askId,
            question: a.question || "",
            options: Array.isArray(a.options) ? a.options : [],
            expiresAt: a.expiresAt || null,
            secret: a.secret || null, // 시크릿 입력 요청이면 이름. 값은 상태에 남기지 않는다
            answer: null, // 사용자가 선택한 답변({choiceIndex}|{text})
            resolved: false,
        });
        C.emit("ask", { id, askId: a.askId });
    }

    function applyAskResolved(id, askId, answer) {
        const c = C.conv(id);
        const live = c.live;
        const rawAnswer = typeof answer === "object" && answer !== null ? answer.text : answer;
        const error =
            rawAnswer === "__TIMEOUT__"
                ? "timeout"
                : typeof rawAnswer === "string" && rawAnswer.startsWith("__CANCELLED__:")
                  ? rawAnswer.slice("__CANCELLED__:".length)
                  : null;
        const normalizedAnswer = typeof answer === "object" && answer !== null ? answer : answer != null ? { text: String(answer) } : null;
        // 이력 카드는 서버 정본이 다시 그려질 때까지 이 값으로 답/상태를 낙관적으로 보여 준다.
        if (!T.chatCtx.askOverlay) T.chatCtx.askOverlay = new Map();
        T.chatCtx.askOverlay.set(askId, {
            resolved: true,
            ...(error ? { error } : normalizedAnswer ? { answer: normalizedAnswer } : {}),
        });
        const ask = live?.asks.find((a) => a.askId === askId);
        if (ask) {
            ask.resolved = true;
            if (!error && answer != null && ask.answer == null) {
                ask.answer = typeof answer === "object" ? answer : { text: String(answer) };
            }
        }
        C.emit("ask_resolved", { id, askId });
    }

    /* ── 턴 정본 동기화 ─────────────────────────────────────── */
    // 클라이언트가 턴을 직접 조립하면 이벤트 도착/완료 시점 순서로 붙어
    // 전송 직후·생성 중 새로고침·완료·완료 후 새로고침에서 순서가 갈린다.
    // 디스크 히스토리(서버)가 유일한 정본이므로 바뀔 때마다 통째로 다시 읽는다.

    function normalizeTurn(turn) {
        return {
            at: turn.at,
            status: turn.status || null,
            stats: turn.stats || null,
            attachments: turn.attachments || [],
            messages: (turn.messages || []).map((m) => {
                const isParts = Array.isArray(m.content);
                const textPart = isParts ? m.content.find((part) => part?.type === "text")?.text || "" : m.content;
                const out = {
                    role: m.role,
                    id: typeof m.id === "string" ? m.id : null,
                    content: T.util.displayUserText(textPart),
                    at: typeof m.at === "string" ? m.at : null,
                    isParts,
                    imageUrl: m.imageUrl || null,
                    attachments: m.attachments || null,
                };
                // 질문 카드는 화면 전용 필드를 그대로 옮겨야 대화를 다시 그려도 질문/답/만료가 남는다.
                if (m.role === "ask") {
                    out.askId = typeof m.askId === "string" ? m.askId : null;
                    out.question = String(m.question || "");
                    out.options = Array.isArray(m.options) ? m.options : [];
                    out.expiresAt = typeof m.expiresAt === "string" ? m.expiresAt : null;
                    out.secret = m.secret || null;
                    out.answer = m.answer || null;
                    out.resolved = m.resolved === true;
                    out.error = m.error || null;
                }
                return out;
            }),
        };
    }

    // 실행 중인 턴에 이미 저장된 assistant 발화.
    function runningTurnTexts(turns) {
        const texts = new Set();
        for (const turn of turns || []) {
            if (turn.status !== "in_progress") continue;
            for (const m of turn.messages || []) {
                if (m.role === "assistant") texts.add(String(m.content || "").trim());
            }
        }
        return texts;
    }

    // 정본에 들어온 내 메시지는 낙관적 버블에서 걷어 낸다. 메시지 id로만 맞춘다:
    // 정본에 실제로 나타나기 전에는 지우지 않으므로 보낸 메시지가 화면에서 사라지지 않는다.
    function reconcilePending(c, incoming) {
        if (!c.pending.length) return false;
        const stored = new Set();
        for (const turn of incoming) {
            for (const m of turn.messages || []) {
                if (m.role === "user" && m.id) stored.add(m.id);
            }
        }
        const before = c.pending.length;
        c.pending = c.pending.filter((p) => !stored.has(p.id));
        return c.pending.length !== before;
    }

    // 서버의 실행 상태와 새 정본에 맞춰 라이브 상태를 정리한다. 바뀌었으면 true.
    function settleLive(c, id, detail, incoming, requestedAt) {
        if (detail.running === false) {
            // 서버는 끝났는데 live만 남은 경우(turn_done 유실). 요청을 보낸 뒤에 시작된 live는
            // 새 턴의 것이므로(응답이 그 전 상태다) 건드리지 않는다.
            if (!c.live || c.live.startedAt >= requestedAt) return false;
            c.live = null;
            C.emit("live", { id });
            return true;
        }
        if (detail.running === true && !c.live) {
            // 새로고침·재접속 뒤: 진행 중인 턴을 다음 상태 이벤트를 기다리지 않고 바로 붙인다.
            c.live = freshLive(Boolean(detail.runningAutomated));
            C.emit("live", { id });
            C.emit("status", { id });
            return true;
        }
        if (!c.live?.intermediate.length) return false;
        // 이미 저장된 라이브 중간 발화는 라이브에서 걷어 낸다.
        const stored = runningTurnTexts(incoming);
        const before = c.live.intermediate.length;
        c.live.intermediate = c.live.intermediate.filter((x) => !stored.has(String(x || "").trim()));
        return c.live.intermediate.length !== before;
    }

    async function loadTurns(id) {
        const requestedAt = Date.now();
        const r = await T.api.conversation(id);
        const c = C.conv(id);
        const incoming = (Array.isArray(r?.turns) ? r.turns : []).map(normalizeTurn);
        // 정본이 그대로면 다시 그리지 않는다. 스레드 전체 재렌더(마크다운/하이라이트)가 비싸다.
        const sig = JSON.stringify(incoming);
        let changed = !c.loaded || sig !== c.turnsSig;
        c.turns = incoming;
        c.turnsSig = sig;
        c.loaded = true;
        c.fetchedAt = Date.now();
        c.running = r?.running === true;
        if (r && typeof r === "object") {
            const { turns: _turns, ...meta } = r;
            if (meta?.id) C.upsertMeta(Object.assign({}, c.meta, meta));
        }
        if (reconcilePending(c, incoming)) changed = true;
        if (settleLive(c, id, r || {}, incoming, requestedAt)) changed = true;
        if (changed) C.emit("turns", { id });
    }

    // 대화당 요청은 한 번에 하나만 보낸다. 받는 중에 또 요청이 오면 끝난 뒤 한 번 더 읽는다:
    // 응답이 뒤바뀌어 오래된 정본이 새 정본을 덮는 일이 없고, 연달아 온 이벤트가 요청을 쌓지도 않는다.
    const turnsInFlight = new Map();

    function refreshTurns(id) {
        if (!id) return Promise.resolve(false);
        const running = turnsInFlight.get(id);
        if (running) {
            running.again = true;
            return running.promise;
        }
        const entry = { again: false, promise: null };
        entry.promise = (async () => {
            try {
                do {
                    entry.again = false;
                    await loadTurns(id);
                } while (entry.again);
                return true;
            } finally {
                turnsInFlight.delete(id);
            }
        })();
        turnsInFlight.set(id, entry);
        return entry.promise;
    }

    // refreshTurns를 부르되 실패해도 던지지 않는다. 정본을 읽었으면 true.
    async function refreshTurnsQuietly(id) {
        try {
            return await refreshTurns(id);
        } catch {
            // 실패해도 다음 이벤트나 재접속 때 다시 받는다
            return false;
        }
    }

    // 정본이 바뀌었다는 신호. 보고 있는 대화는 바로 다시 읽고, 나머지는 열 때 다시 읽도록 표시만 한다
    // (실행 중인 모든 대화의 기록 전체를 체크포인트마다 받지 않게).
    function touchTurns(id) {
        if (!id) return;
        if (id === C.state.currentId) void refreshTurnsQuietly(id);
        else C.conv(id).fetchedAt = 0;
    }

    function lastMessageOf(c) {
        const last = c.turns[c.turns.length - 1];
        return last?.messages?.[last.messages.length - 1];
    }

    // 다른 탭·기기에서 보낸 것까지 포함해, 사용자 메시지가 접수됐다는 알림.
    // 이 탭이 보낸 메시지의 낙관적 버블은 정본에 같은 id가 나타날 때 reconcilePending이 걷어 낸다.
    function applyUserMessage(id, text) {
        const c = C.conv(id);
        if (!c) return;
        const snippet = String(text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        c.meta = Object.assign({}, c.meta, { updatedAt: new Date().toISOString(), ...(snippet ? { preview: snippet } : {}) });
        C.emit("user_message", { id });
        void refreshTurnsQuietly(id);
    }

    // 정본을 읽지 못했을 때, 라이브로 보여 준 발화를 로컬 턴으로 남긴다.
    // 같은 발화가 이미 마지막 메시지면 다시 넣지 않는다.
    function promoteSpokenToTurn(c, spoken, { stats, attachments }) {
        if (!spoken.length && !attachments.length) return;
        const lastMsg = lastMessageOf(c);
        const tail = spoken.length ? spoken[spoken.length - 1].content : null;
        const already = tail != null && lastMsg?.role === "assistant" && lastMsg.content === tail;
        if (already) return;
        c.turns.push({ at: new Date().toISOString(), status: null, messages: spoken, stats: stats || null, attachments });
    }

    // 정본 읽기 실패 폴백: 라이브 내용을 로컬 턴으로 승격한다.
    function promoteLiveToTurn(c, { intermediate, text, fallback, silent, stats, attachments }) {
        const asAssistant = (content) => ({ role: "assistant", content });
        if (silent) {
            // 침묵 마커는 마지막 답변 한 개만 숨긴다. 이미 보여준 중간 발화는
            // 회수하지 않고 그대로 메신저 기록에 남긴다.
            if (intermediate.length) promoteSpokenToTurn(c, intermediate.map(asAssistant), { stats, attachments });
            return;
        }
        // 라이브가 없거나 SSE text가 비어도, 스트림에 쌓인 본문이 있으면 턴으로 남긴다.
        // 그렇지 않으면 답이 DOM에서 사라지고 새로고침 전까지 안 보인다.
        const rawFinal = String(text || fallback || "");
        const finalText = isSilentMarkedText(rawFinal) ? "" : rawFinal;
        const spoken = [...intermediate.map(asAssistant), ...(finalText ? [asAssistant(finalText)] : [])];
        promoteSpokenToTurn(c, spoken, { stats, attachments });
    }

    function applyTurnDone(id, text, stats, error, attachments = [], silent = false) {
        const c = C.conv(id);
        if (!c) return;
        const hadLive = !!c.live;
        const liveSnap = c.live;
        const fallback = liveSnap && typeof liveSnap.text === "string" ? liveSnap.text : "";
        // user_say로 이미 전달된 중간 발화는 메신저 기록에 남긴다.
        // 라이브에서 이미 보여준 말을 완료 시점에 지우지 않는다.
        const intermediate = (liveSnap ? liveSnap.intermediate : []).filter((t) => !isSilentMarkedText(t));
        void (async () => {
            const ok = await refreshTurnsQuietly(id);
            if (!ok) promoteLiveToTurn(c, { intermediate, text, fallback, silent, stats, attachments });
            // 정본이 턴을 저장한 뒤에만 live를 해제한다. 답 버블이 깜빡 사라지지 않게.
            // 서버가 곧바로 다음 턴(끝나기 직전에 보낸 메시지)을 돌리고 있으면 새 라이브로 갈아 끼운다.
            if (c.live === liveSnap) c.live = ok && c.running ? freshLive(Boolean(c.meta?.runningAutomated)) : null;
            C.emit("live", { id });
            C.emit("turn_done", { id, error: error != null ? error : null, finalized: hadLive });
        })();
        const rawFinal = String(text || fallback || "");
        const snippet = (isSilentMarkedText(rawFinal) ? "" : rawFinal).replace(/\s+/g, " ").trim().slice(0, 120);
        // 자동 실행이 말없이 끝났으면 기록에 남은 것이 없으므로 순서도 그대로 둔다.
        const quietAuto = Boolean(liveSnap?.automated) && !snippet;
        if (quietAuto) return;
        c.meta = Object.assign({}, c.meta, { updatedAt: new Date().toISOString(), ...(snippet && !silent ? { preview: snippet } : {}) });
    }

    C.applyStatus = applyStatus;
    C.applyDelta = applyDelta;
    C.applySay = applySay;
    C.applyTool = applyTool;
    C.applyAsk = applyAsk;
    C.applyAskResolved = applyAskResolved;
    C.normalizeTurn = normalizeTurn;
    C.refreshTurns = refreshTurns;
    C.touchTurns = touchTurns;
    C.freshLive = freshLive;
    C.applyUserMessage = applyUserMessage;
    C.applyTurnDone = applyTurnDone;
})(window.Taby);
