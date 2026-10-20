/* tabyBot 웹 클라이언트: SSE 구독(/api/events).
   - 토큰 미설정: 네이티브 EventSource(브라우저 자동 재접속)
   - 토큰 설정: EventSource는 헤더를 보낼 수 없으므로 fetch 스트림으로
     Authorization 헤더를 실어 동일 계약을 구현하고 지수 백오프로 재접속.
   모든 이벤트는 JSON 한 줄(data:)로 파싱되어 state mutator로 디스패치된다. */
((T) => {
    "use strict";

    const { state, api } = T;

    let es = null;
    let ctrl = null;
    let timer = null;
    let stopped = true;
    let backoff = 1000;
    let usingFetch = false;
    let refreshTimer = null;
    let fallbackTimer = null;
    let polling = false;
    let pollCursor = 0;
    // connect() 재진입 시 이전 fetch/폴링 루프가 stopped=false를 보고 되살아나
    // 중복 스트림이 되지 않도록 세대 번호로 끊는다.
    let generation = 0;
    const handledSeqs = new Set();
    let receivedEvent = false;

    // 이미 닫혔거나 정리된 대상이면 무시한다.
    function quietly(fn) {
        try {
            fn();
        } catch {
            // 이미 닫혔거나 정리된 대상이면 무시한다
        }
    }

    // 알림 제목: 에이전트 이름. 그룹 방이면 "말한 에이전트 (방 이름)".
    function chatTitle(conversationId, speaker) {
        const chat = conversationId ? state.chatByUuid(conversationId) : null;
        const who = speaker ? state.botByUuid(speaker)?.name : null;
        if (chat?.isGroup && who) return `${who} (${chat.name})`;
        return chat?.name || null;
    }

    function notifyIncoming(conversationId, body, tag, url, speaker) {
        if (!T.notifications) return;
        const title = chatTitle(conversationId, speaker) || "tabyBot";
        // 대화 알림은 눌렀을 때 그 에이전트 스레드로 바로 연다.
        T.notifications.show(title, body, tag, url || (conversationId ? `/a/${conversationId}` : ""));
    }

    const FRESH_LOAD_GAP_MS = 15000;
    const FRESH_BOOT_MS = 5000;
    let freshUntil = 0;

    async function replayGap(since, retried, recentMs) {
        try {
            const r = await api.eventsPoll(since, recentMs);
            for (const ev of r?.events || []) {
                if (ev?.type === "hello") continue;
                handle(ev, true);
            }
        } catch (_) {
            if (!retried) setTimeout(() => void replayGap(since, true, recentMs), 2000);
        }
    }

    // 재생(replay)해도 안전한 이벤트: 다시 받아도 화면이 어긋나지 않는 "다시 읽어라" 신호들이다.
    const GAP_SAFE_TYPES = new Set(["todo_due", "todos_changed", "conversations_changed", "notices_changed", "turns_changed", "hello"]);

    // 재생할 때는 내용을 그대로 다시 적용하지 않고 "그 대화를 다시 읽어라"로만 쓰는 이벤트.
    // 끊긴 사이에 지나간 사용자 메시지·턴 완료를 정본으로 되살린다(알림은 다시 울리지 않는다).
    const REPLAY_AS_REFRESH = new Set(["user_message", "turn_done"]);

    // hello는 서버 이벤트 번호의 기준점이다. 번호가 거꾸로 가면(서버 재시작) 중복 기록을 비우고,
    // 끊긴 사이의 이벤트를 폴링으로 되살린다.
    function trackHello(seq, replay) {
        const prev = pollCursor;
        if (!replay && seq < prev) handledSeqs.clear();
        pollCursor = seq;
        if (replay) return;
        if (prev > 0 && seq !== prev) void replayGap(prev);
        else if (prev === 0) void replayGap(0, false, FRESH_LOAD_GAP_MS);
    }

    // 이벤트를 처리해야 하는지 가린다(이미 본 것, 연결 이전 것, 재생 불가한 것은 버린다).
    function admit(msg, replay) {
        const seq = Number(msg.seq) || 0;
        if (msg.type === "hello") trackHello(seq, replay);
        else if (seq && seq <= pollCursor && !replay) return false;

        // 지난 이벤트인지는 서버 이벤트 번호로만 가린다. 시각으로 비교하면 서버와 이 기기의
        // 시계가 어긋났을 때 방금 온 이벤트(사용자 메시지, 턴 완료)까지 버려진다.
        if (replay && !GAP_SAFE_TYPES.has(msg.type) && !REPLAY_AS_REFRESH.has(msg.type)) return false;
        if (seq && msg.type !== "hello") {
            if (handledSeqs.has(seq)) return false;
            handledSeqs.add(seq);
            if (handledSeqs.size > 4000) handledSeqs.delete(handledSeqs.values().next().value);
        }
        if (seq > pollCursor) pollCursor = seq;
        receivedEvent = true;
        return true;
    }

    // 에이전트 목록을 다시 받아 반영한다. 실패해도 다음 이벤트나 재접속 때 다시 받는다.
    function reloadAgents() {
        api.agents()
            .then((r) => state.applyAgents(r))
            .catch(() => {
                /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
            });
    }

    function errorDetailOf(error) {
        if (typeof error === "string") return error;
        return (error && (error.detail || error.code)) || "";
    }

    // 답을 기다리는 질문 카드는 이벤트로만 오면 새로고침·재접속 때 사라진다(서버는 계속 기다리는데 답할 곳이 없어진다).
    // 접속할 때마다 서버의 대기 목록으로 되살린다. 이미 있는 카드는 applyAsk가 걸러 낸다.
    function restorePendingAsks() {
        api.pendingAsks()
            .then((r) => {
                for (const a of r?.asks || []) {
                    if (!a.expiresAt || Date.parse(a.expiresAt) > Date.now()) state.applyAsk(a.conversationId, a);
                }
            })
            .catch(() => {
                /* 실패해도 다음 접속 때 다시 받는다 */
            });
    }

    // 이벤트 종류별 처리. 모르는 종류는 무시한다(하위 호환).
    const HANDLERS = {
        hello() {
            backoff = 1000;
            state.setConn("connected");
            restorePendingAsks();
            // 부트가 방금 같은 데이터를 받았다. 첫 hello에서 통째로 다시 받지 않는다.
            if (Date.now() < freshUntil) {
                freshUntil = 0;
                return;
            }
            // 재접속 사이에 놓친 턴/목록을 되살린다.
            // 진행 중 턴을 덮지 않게 현재 스레드 동기화는 refreshCurrent가 가드한다.
            refreshConversations();
            reloadAgents();
            state.fetchTodos().catch(() => {
                /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
            });
            T.chat.refreshCurrent?.();
            // 끊긴 사이에 온 시스템 알림(재생되지 않는 이벤트)을 기록에서 되살린다.
            T.notices?.refresh();
        },
        status(msg) {
            state.applySpeaker(msg.conversationId, msg.speaker, Boolean(msg.automated));
            state.applyStatus(msg.conversationId, msg.phase, msg.detail || "", msg.elapsedMs != null ? msg.elapsedMs : null, Boolean(msg.automated));
        },
        delta(msg) {
            state.applySpeaker(msg.conversationId, msg.speaker, Boolean(msg.automated));
            state.applyDelta(msg.conversationId, Number(msg.offset) || 0, msg.text || "", Boolean(msg.automated));
        },
        say(msg) {
            state.applySpeaker(msg.conversationId, msg.speaker, Boolean(msg.automated));
            const sayText = String(msg.text || "").trim();
            state.applySay(msg.conversationId, sayText);
            if (sayText) notifyIncoming(msg.conversationId, sayText.slice(0, 180), `turn-${msg.conversationId || ""}`, "", msg.speaker);
        },
        tool(msg) {
            state.applySpeaker(msg.conversationId, msg.speaker, Boolean(msg.automated));
            const call = msg.call || {};
            state.applyTool(msg.conversationId, call.name, call.argsSummary);
        },
        turn_done(msg) {
            state.applyTurnDone(
                msg.conversationId,
                msg.text || "",
                msg.stats || null,
                msg.error != null ? msg.error : null,
                msg.attachments || [],
                Boolean(msg.silent),
            );
            if (msg.error && msg.error !== "stopped_by_user" && !msg.automated) {
                // 에이전트가 답하지 못했다. 지나가는 표시로는 놓치기 쉬워 경고창으로 알린다.
                const detail = errorDetailOf(msg.error);
                T.notices.alert({
                    title: chatTitle(msg.conversationId, msg.speaker),
                    text: T.i18n.t("errorPrefix") + (detail ? `: ${detail}` : ""),
                });
            }
            if (!msg.stopped && !msg.silent) {
                const body = (msg.text || "").trim() || (msg.error && (msg.error.detail || msg.error.code)) || "";
                if (body) notifyIncoming(msg.conversationId, body, `turn-${msg.conversationId || ""}`, "", msg.speaker);
            }
        },
        user_message(msg) {
            state.applyUserMessage(msg.conversationId, msg.text || "");
        },
        turns_changed(msg) {
            state.touchTurns(msg.conversationId);
        },
        ask(msg) {
            state.applySpeaker(msg.conversationId, msg.speaker, Boolean(msg.automated));
            state.applyAsk(msg.conversationId, {
                askId: msg.askId,
                question: msg.question,
                options: msg.options,
                expiresAt: msg.expiresAt,
                secret: msg.secret,
            });
            notifyIncoming(msg.conversationId, msg.question || "", `ask-${msg.askId || ""}`, "", msg.speaker);
        },
        ask_resolved(msg) {
            state.applyAskResolved(msg.conversationId, msg.askId, msg.answer);
        },
        notice(msg) {
            // 화면 표시는 알림 모달이 맡는다(서버 기록을 다시 받아 읽지 않은 것을 띄운다).
            T.notices?.refresh();
            // 대화 턴이 있는 알림(스케줄 등)의 OS 알림은 turn_done이 담당한다.
            if (!msg.conversationId) notifyIncoming(null, msg.text || "", "notice");
        },
        notices_changed() {
            T.notices?.refresh();
        },
        sessions_compress(msg) {
            // 압축 진행 상태를 설정 스냅샷에 반영: 설정 탭의 버튼이 다시 그려진다.
            state.mergeSettingsLocal({ sessionsCompressing: !!msg.running });
        },
        oauth_done(msg) {
            state.emit("oauth_done", { kind: msg.kind, ok: !!msg.ok, detail: msg.detail || "" });
        },
        conversations_changed() {
            refreshConversations();
            reloadAgents();
        },
        todos_changed() {
            refreshTodos();
        },
        todo_due(msg) {
            const due = T.todosUI?.describeDue?.(msg) || msg.text || msg.title || "";
            T.notices?.refresh();
            notifyIncoming(msg.conversationId, due, `todo-${msg.url || ""}`, msg.url);
            refreshTodos();
        },
    };

    function handle(msg, replay = false) {
        if (!msg || typeof msg !== "object" || !msg.type) return;
        if (!admit(msg, replay)) return;
        if (replay && REPLAY_AS_REFRESH.has(msg.type)) {
            state.touchTurns(msg.conversationId);
            refreshConversations();
            return;
        }
        HANDLERS[msg.type]?.(msg);
    }

    let todosTimer = null;
    function refreshTodos() {
        clearTimeout(todosTimer);
        todosTimer = setTimeout(
            () =>
                state.fetchTodos().catch(() => {
                    /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
                }),
            120,
        );
    }

    // 목록 재조회(연속 이벤트 디바운스)
    function refreshConversations() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
            if (state.state.offline) return;
            try {
                const requestedAt = Date.now();
                const r = await api.conversations();
                state.replaceConversations(r?.conversations || [], requestedAt);
            } catch (_) {
                /* 다음 이벤트에서 재시도 */
            }
        }, 250);
    }

    let lastSeen = 0;
    let watchdog = null;

    function startPolling() {
        if (polling || stopped) return;
        polling = true;
        usingFetch = false;
        if (es) {
            quietly(() => es.close());
            es = null;
        }
        if (ctrl) {
            quietly(() => ctrl.abort());
            ctrl = null;
        }
        state.setConn("connecting");
        void pollLoop(generation);
    }

    async function pollLoop(gen) {
        // 서버 다운 시 connection refused가 즉시 실패하므로 고정 500ms 폴링은
        // 죽은 서버를 두드린다. 실패하면 지수적으로 늘린다(최대 10초).
        let delay = 500;
        let first = true;
        while (polling && !stopped && gen === generation) {
            try {
                // 기준점 없이 시작한 첫 폴링은 접속 전 15초치를 받는다. 이미 지난 일이므로 재생으로 다룬다(다시 읽기 신호만 쓴다).
                const catchUp = first && !pollCursor;
                first = false;
                const result = await api.eventsPoll(pollCursor, catchUp ? FRESH_LOAD_GAP_MS : 0);
                for (const event of result?.events || []) handle(event, catchUp);
                if (result && Number.isFinite(Number(result.cursor)) && Number(result.cursor) !== pollCursor) {
                    pollCursor = Number(result.cursor);
                }
                state.setConn("connected");
                delay = 500;
            } catch (err) {
                state.setConn("disconnected");
                if (err?.status === 401) T.app?.handleUnauthorized?.();
                delay = Math.min(delay * 2, 10_000);
            }
            if (polling && !stopped && gen === generation) await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    function schedulePollingFallback() {
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
            if (!receivedEvent && !stopped) startPolling();
        }, 3000);
    }

    function startNative() {
        usingFetch = false;
        try {
            es = new EventSource("/api/events");
        } catch (_) {
            state.setConn("disconnected");
            return;
        }
        lastSeen = Date.now();
        es.onopen = () => {
            backoff = 1000;
            state.setConn("connected");
        };
        es.onmessage = (e) => {
            lastSeen = Date.now();
            try {
                handle(JSON.parse(e.data));
            } catch (_) {
                /* 잘못된 프레임 무시 */
            }
        };
        es.onerror = () => {
            // 브라우저가 자동 재접속한다. 상태 점만 갱신.
            state.setConn("disconnected");
        };
        schedulePollingFallback();
        armWatchdog();
    }

    function armWatchdog() {
        clearInterval(watchdog);
        watchdog = setInterval(() => {
            if (polling || stopped) return;
            if (Date.now() - lastSeen > 40_000) {
                lastSeen = Date.now(); // 재시작 연쇄 방지
                state.setConn("disconnected");
                if (usingFetch) {
                    quietly(() => ctrl?.abort());
                } else {
                    quietly(() => es?.close());
                    setTimeout(connect, 200);
                }
            }
        }, 5_000);
    }

    // `data: {json}` 한 줄을 이벤트로 처리한다. 깨진 프레임은 무시한다.
    function handleSseLine(line) {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload) return;
        try {
            handle(JSON.parse(payload));
        } catch (_) {
            /* 잘못된 프레임 무시 */
        }
    }

    // 버퍼에서 완성된 줄을 꺼내 onLine에 넘기고, 아직 덜 온 나머지를 돌려준다.
    function drainSseLines(buf, onLine) {
        let rest = buf;
        for (let nl = rest.indexOf("\n"); nl > -1; nl = rest.indexOf("\n")) {
            onLine(rest.slice(0, nl).replace(/\r$/, ""));
            rest = rest.slice(nl + 1);
        }
        return rest;
    }

    async function startFetch(gen) {
        usingFetch = true;
        lastSeen = Date.now();
        armWatchdog();
        schedulePollingFallback();
        while (!stopped && !polling && gen === generation) {
            ctrl = new AbortController();
            try {
                const headers = { Accept: "text/event-stream" };
                const tk = api.getToken();
                if (tk) headers.Authorization = `Bearer ${tk}`;
                const res = await fetch("/api/events", { headers, signal: ctrl.signal });
                if (res.status === 401) T.app?.handleUnauthorized?.();
                if (!res.ok || !res.body) throw new Error(`sse status ${res.status}`);

                state.setConn("connected");
                lastSeen = Date.now();
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = "";
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    lastSeen = Date.now();
                    buf += dec.decode(value, { stream: true });
                    buf = drainSseLines(buf, handleSseLine);
                }
                // 서버가 스트림을 닫았다. 아래에서 백오프 후 재접속한다.
            } catch (_) {
                if (stopped || gen !== generation) break;
            }
            if (stopped || polling || gen !== generation) break;
            state.setConn("disconnected");
            await new Promise((r) => {
                timer = setTimeout(r, backoff);
            });
            backoff = Math.min(backoff * 2, 10000);
        }
    }

    // opt.fresh: 호출 직전에 부트 데이터를 받았다. 곧 올 첫 hello의 재동기화를 생략한다.
    function connect(opt) {
        stopInternal();
        freshUntil = opt?.fresh ? Date.now() + FRESH_BOOT_MS : 0;
        const gen = generation;
        stopped = false;
        backoff = 1000;
        receivedEvent = false;
        if (state.state.offline) {
            state.setConn("disconnected");
            return;
        }
        state.setConn("connecting");
        if (api.getToken()) startFetch(gen);
        else startNative();
    }

    function stopInternal() {
        generation += 1;
        stopped = true;
        polling = false;
        clearTimeout(fallbackTimer);
        clearInterval(watchdog);
        watchdog = null;
        usingFetch = false;
        if (es) {
            quietly(() => es.close());
            es = null;
        }
        if (ctrl) {
            quietly(() => ctrl.abort());
            ctrl = null;
        }
        clearTimeout(timer);
    }

    // 숨김 해제 시: 놓친 내용을 되살린다.
    // 모바일은 백그라운드에서 연결이 겉으로는 열린 채 이벤트만 끊기기도 한다(감시 타이머는 40초 뒤에야 안다).
    // 그동안 목록만 새로 받으면 미리보기에는 답이 뜨는데 열려 있던 대화에는 없다.
    // 잠깐 이상 숨겨져 있었으면 다시 접속해 hello의 전체 재동기화와 놓친 이벤트 재생을 받는다.
    const HIDDEN_RECONNECT_MS = 10_000;
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            hiddenAt = Date.now();
            return;
        }
        const longHidden = hiddenAt > 0 && Date.now() - hiddenAt >= HIDDEN_RECONNECT_MS;
        hiddenAt = 0;
        if (!state.state.offline && (longHidden || state.state.conn === "disconnected")) {
            connect();
            return;
        }
        refreshConversations();
        refreshTodos();
        T.chat?.refreshCurrent?.();
    });

    window.addEventListener("pagehide", stopInternal);
    window.addEventListener("pageshow", (e) => {
        if (e.persisted) connect();
    });
    window.addEventListener("beforeunload", stopInternal);

    T.events = { connect, refreshConversations };
})(window.Taby);
