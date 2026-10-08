/* tabyBot 웹 클라이언트: SSE 이벤트 반영(라이브 상태)과 턴 정본 동기화. */
((T) => {
    "use strict";

    T.stateCtx ??= {};
    const C = T.stateCtx;

    /* ── SSE 이벤트 반영(mutator) ──────────────────────────── */
    function freshLive(automated) {
        return { phase: "generating", detail: "", elapsedMs: null, text: "", tools: [], asks: [], intermediate: [], automated };
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
        if (phase === "tools") c.live.text = "";
        // 툴 라운드 경계는 서버 체크포인트/펜딩 메시지 병합 시점과 겹친다.
        // 정본을 다시 읽어 실행 중 메시지 위치를 새로고침 상태와 맞춘다.
        if (phase === "tools")
            void refreshTurns(id).catch(() => {
                /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
            });
        c.live.detail = detail || "";
        c.live.elapsedMs = elapsedMs != null ? elapsedMs : c.live.elapsedMs;
        C.emit("status", { id });
    }

    function applyDelta(id, full, text, automated = false) {
        const c = ensureLive(id, automated);
        // full이 지금까지 전체 누적. 없으면 text를 덧셈 폴백.
        c.live.text = typeof full === "string" ? full : c.live.text + (text || "");
        C.emit("delta", { id });
    }

    // user_say 도구 호출: 모델이 명시적으로 사용자에게 보낸 중간 발화만 버블로 쌓는다.
    function applySay(id, text) {
        const s = String(text || "");
        if (!s.trim() || isSilentMarkedText(s)) return;
        const c = ensureLive(id);
        if (!c.live.intermediate.includes(s)) c.live.intermediate.push(s);
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
        c.live.asks.push({
            askId: a.askId,
            question: a.question || "",
            options: Array.isArray(a.options) ? a.options : [],
            expiresAt: a.expiresAt || null,
            answer: null, // 사용자가 선택한 답변({choiceIndex}|{text})
            resolved: false,
        });
        C.emit("ask", { id, askId: a.askId });
    }

    function applyAskResolved(id, askId, answer) {
        const c = C.conv(id);
        const live = c.live;
        const ask = live?.asks.find((a) => a.askId === askId);
        if (ask) {
            ask.resolved = true;
            const rawAnswer = typeof answer === "object" && answer !== null ? answer.text : answer;
            const internal = typeof rawAnswer === "string" && (rawAnswer.startsWith("__TIMEOUT__") || rawAnswer.startsWith("__CANCELLED__:"));
            if (!internal && answer != null && ask.answer == null) {
                ask.answer = typeof answer === "object" ? answer : { text: String(answer) };
            }
        }
        C.emit("ask_resolved", { id, askId });
    }

    /* ── 턴 정본 동기화 ─────────────────────────────────────── */
    // 클라이언트가 턴을 직접 조립하면 이벤트 도착/완료 시점 순서로 붙어
    // 전송 직후·생성 중 새로고침·완료·완료 후 새로고침에서 순서가 갈린다.
    // 디스크 히스토리(서버)가 유일한 정본이므로 이벤트마다 통째로 다시 읽는다.

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
                    content: T.util.displayUserText(textPart),
                    at: typeof m.at === "string" ? m.at : null,
                    isParts,
                    imageUrl: m.imageUrl || null,
                    attachments: m.attachments || null,
                };
            }),
        };
    }

    // 대화당 최신 요청만 반영: 오래된 응답이 정본을 덮지 않도록 세대 번호로 가드.
    const turnsReqSeq = new Map();

    // 새 정본 턴에 이미 담긴 assistant 발화를 기준으로 라이브 상태를 정리한다. 바뀌었으면 true.
    function settleLive(c, id, running, incoming) {
        if (!c.live) return false;
        if (running === false) {
            // 서버는 끝났는데 live만 남은 경우(turn_done 유실) 정본으로 정리
            c.live = null;
            C.emit("live", { id });
            return true;
        }
        if (!c.live.intermediate?.length) return false;
        // 이미 저장된 라이브 중간 발화는 라이브에서 걷어 낸다.
        const stored = new Set();
        for (const turn of incoming) {
            for (const m of turn.messages || []) {
                if (m.role === "assistant") stored.add(String(m.content || "").trim());
            }
        }
        const before = c.live.intermediate.length;
        c.live.intermediate = c.live.intermediate.filter((x) => !stored.has(String(x || "").trim()));
        return c.live.intermediate.length !== before;
    }

    async function refreshTurns(id) {
        const c = C.conv(id);
        if (!c) return false;
        const seq = (turnsReqSeq.get(id) || 0) + 1;
        turnsReqSeq.set(id, seq);
        const r = await T.api.conversation(id);
        if (seq !== turnsReqSeq.get(id)) return true; // 더 새 요청이 진행 중
        const incoming = (Array.isArray(r?.turns) ? r.turns : []).map(normalizeTurn);
        // 정본이 그대로면 다시 그리지 않는다. 스레드 전체 재렌더(마크다운/하이라이트)가 비싸다.
        const sig = JSON.stringify(incoming);
        let changed = !c.loaded || sig !== c.turnsSig;
        c.turns = incoming;
        c.turnsSig = sig;
        c.loaded = true;
        c.fetchedAt = Date.now();
        if (r && typeof r === "object") {
            const { turns: _turns, ...meta } = r;
            if (meta?.id) C.upsertMeta(Object.assign({}, c.meta, meta));
        }
        // 정본에 흡수된 확정 pending을 정리한다.
        if (c.pending.some((p) => p.confirmed)) {
            c.pending = c.pending.filter((p) => !p.confirmed);
            changed = true;
        }
        if (settleLive(c, id, r.running, incoming)) changed = true;
        if (changed) C.emit("turns", { id });
        return true;
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

    const attachmentIdsOf = (list) => (list || []).map((a) => a.id).filter(Boolean);

    function lastMessageOf(c) {
        const last = c.turns[c.turns.length - 1];
        return last?.messages?.[last.messages.length - 1];
    }

    function applyUserMessage(id, text, imageUrl, attachments = []) {
        const c = C.conv(id);
        if (!c) return;
        const attachmentIds = attachmentIdsOf(attachments);
        // 낙관적으로 추가한 내 메시지와 일치하면 확정 표시: 정본이 도착할 때까지
        // 버블을 유지하기 위해 confirmed 플래그만 세우고 refreshTurns에서 제거한다.
        const pending = c.pending.find(
            (p) =>
                p.text === (text || "") &&
                (p.imageUrl || null) === (imageUrl || null) &&
                attachmentIdsOf(p.attachments).join(",") === attachmentIds.join(","),
        );
        if (pending) pending.confirmed = true;
        const snippet = String(text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        c.meta = Object.assign({}, c.meta, { updatedAt: new Date().toISOString(), ...(snippet ? { preview: snippet } : {}) });
        C.emit("user_message", { id, confirmed: Boolean(pending) });
        void (async () => {
            if (await refreshTurnsQuietly(id)) return;
            // 정본 읽기 실패 폴백: 기존처럼 로컬에 붙여 메시지가 안 보이는 일은 막는다.
            c.pending = c.pending.filter((p) => !p.confirmed);
            const lastMsg = lastMessageOf(c);
            const already =
                lastMsg?.role === "user" &&
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
            C.emit("turns", { id });
        })();
    }

    // 정본을 읽지 못했을 때, 라이브로 보여 준 발화를 로컬 턴으로 남긴다.
    // 같은 발화가 이미 마지막 메시지면 다시 넣지 않는다.
    function promoteSpokenToTurn(c, spoken, { stats, attachments }) {
        if (!spoken.length && !attachments.length) return;
        const lastMsg = lastMessageOf(c);
        const tail = spoken.length ? spoken[spoken.length - 1].content : null;
        const already = tail != null && lastMsg?.role === "assistant" && lastMsg.content === tail;
        if (already) return;
        c.turns.push({ at: new Date().toISOString(), messages: spoken, stats: stats || null, attachments });
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
            if (c.live === liveSnap) c.live = null;
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
    C.applyUserMessage = applyUserMessage;
    C.applyTurnDone = applyTurnDone;
})(window.Taby);
