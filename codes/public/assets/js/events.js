/* tabyBot 웹 클라이언트 — SSE 구독(/api/events).
   - 토큰 미설정: 네이티브 EventSource(브라우저 자동 재접속)
   - 토큰 설정: EventSource는 헤더를 보낼 수 없으므로 fetch 스트림으로
     Authorization 헤더를 실어 동일 계약을 구현하고 지수 백오프로 재접속.
   모든 이벤트는 JSON 한 줄(data:)로 파싱되어 state mutator로 디스패치된다. */
(function (T) {
    "use strict";

    const { state, api } = T;

    let es = null;
    let ctrl = null;
    let timer = null;
    let stopped = true;
    let backoff = 1000;
    let usingFetch = false;
    let refreshTimer = null;

    function notifyIncoming(conversationId, body, tag) {
        if (!T.notifications) return;
        const title = (conversationId && state.botByThreadId(conversationId)?.name) || "tabyBot";
        T.notifications.show(title, body, tag);
    }

    function handle(msg) {
        if (!msg || typeof msg !== "object" || !msg.type) return;
        switch (msg.type) {
            case "hello":
                backoff = 1000;
                state.setConn("connected");
                // 재접속 사이에 놓친 턴/목록을 되살린다.
                // 진행 중 턴을 덮지 않게 현재 스레드 동기화는 refreshCurrent가 가드한다.
                refreshConversations();
                T.api
                    .agents()
                    .then((r) => state.setBots(r.agents || []))
                    .catch(() => {});
                T.chat.refreshCurrent?.();
                break;
            case "status":
                state.applyStatus(msg.conversationId, msg.phase, msg.detail || "", msg.elapsedMs != null ? msg.elapsedMs : null);
                break;
            case "delta":
                state.applyDelta(msg.conversationId, typeof msg.full === "string" ? msg.full : undefined, msg.text || "");
                break;
            case "tool": {
                const call = msg.call || {};
                state.applyTool(msg.conversationId, call.name, call.argsSummary);
                break;
            }
            case "turn_done": {
                state.applyTurnDone(msg.conversationId, msg.text || "", msg.stats || null, msg.error != null ? msg.error : null);
                // stopped_by_user는 조용히 종료. 그 외 오류는 토스트.
                if (msg.error && msg.error !== "stopped_by_user") {
                    const detail = typeof msg.error === "string" ? msg.error : (msg.error && (msg.error.detail || msg.error.code)) || "";
                    T.toast.show("error", T.i18n.t("errorPrefix") + (detail ? ": " + detail : ""));
                }
                if (!msg.stopped && !msg.silent) {
                    const body = (msg.text || "").trim() || (msg.error && (msg.error.detail || msg.error.code)) || "";
                    if (body) notifyIncoming(msg.conversationId, body, "turn-" + (msg.conversationId || ""));
                }
                break;
            }
            case "user_message":
                state.applyUserMessage(msg.conversationId, msg.text || "", msg.imageUrl || null, msg.attachments || []);
                break;
            case "ask":
                state.applyAsk(msg.conversationId, {
                    askId: msg.askId,
                    question: msg.question,
                    options: msg.options,
                    expiresAt: msg.expiresAt,
                });
                notifyIncoming(msg.conversationId, msg.question || "", "ask-" + (msg.askId || ""));
                break;
            case "ask_resolved":
                state.applyAskResolved(msg.conversationId, msg.askId, msg.answer);
                break;
            case "notice":
                T.toast.show(msg.level === "warn" || msg.level === "error" ? msg.level : "info", msg.text || "");
                // 대화 턴이 있는 알림(크론 등)은 turn_done이 담당한다.
                if (!msg.conversationId) notifyIncoming(null, msg.text || "", "notice");
                break;
            case "oauth_done":
                state.emit("oauth_done", { kind: msg.kind, ok: !!msg.ok, detail: msg.detail || "" });
                break;
            case "conversations_changed":
                refreshConversations();
                T.api
                    .agents()
                    .then((r) => state.setBots(r.agents || []))
                    .catch(() => {});
                break;
            default:
                break; // 미지의 이벤트 타입은 무시 (하위 호환)
        }
    }

    // 목록 재조회(연속 이벤트 디바운스)
    function refreshConversations() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
            if (state.state.offline) return;
            try {
                const r = await api.conversations();
                state.replaceConversations((r && r.conversations) || []);
            } catch (_) {
                /* 다음 이벤트에서 재시도 */
            }
        }, 250);
    }

    let lastSeen = 0;
    let watchdog = null;

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
        // 죽은 연결 감지: 서버는 15초마다 ping을 보낸다. 40초 무응답이면 강제 재접속.
        clearInterval(watchdog);
        watchdog = setInterval(() => {
            if (usingFetch || stopped) return;
            if (Date.now() - lastSeen > 40_000) {
                lastSeen = Date.now(); // 재시작 연쇄 방지
                state.setConn("disconnected");
                try {
                    es.close();
                } catch (_) {}
                setTimeout(connect, 200);
            }
        }, 5_000);
    }

    async function startFetch() {
        usingFetch = true;
        while (!stopped) {
            ctrl = new AbortController();
            try {
                const headers = { Accept: "text/event-stream" };
                const tk = api.getToken();
                if (tk) headers.Authorization = "Bearer " + tk;
                const res = await fetch("/api/events", { headers, signal: ctrl.signal });
                if (!res.ok || !res.body) throw new Error("sse status " + res.status);

                state.setConn("connected");
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = "";
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let nl;
                    while ((nl = buf.indexOf("\n")) > -1) {
                        const line = buf.slice(0, nl).replace(/\r$/, "");
                        buf = buf.slice(nl + 1);
                        if (line.startsWith("data:")) {
                            const payload = line.slice(5).trim();
                            if (payload) {
                                try {
                                    handle(JSON.parse(payload));
                                } catch (_) {
                                    /* 무시 */
                                }
                            }
                        }
                    }
                }
                // 서버가 스트림을 닫음 → 아래에서 백오프 후 재접속
            } catch (_) {
                if (stopped) break;
            }
            if (stopped) break;
            state.setConn("disconnected");
            await new Promise((r) => {
                timer = setTimeout(r, backoff);
            });
            backoff = Math.min(backoff * 2, 10000);
        }
    }

    function connect() {
        stopInternal();
        stopped = false;
        backoff = 1000;
        if (state.state.offline) {
            state.setConn("disconnected");
            return;
        }
        state.setConn("connecting");
        if (api.getToken()) startFetch();
        else startNative();
    }

    function stopInternal() {
        stopped = true;
        clearInterval(watchdog);
        watchdog = null;
        usingFetch = false;
        if (es) {
            try {
                es.close();
            } catch (_) {}
            es = null;
        }
        if (ctrl) {
            try {
                ctrl.abort();
            } catch (_) {}
            ctrl = null;
        }
        clearTimeout(timer);
    }

    // 숨김 해제 시: 끊긴 상태면 즉시 재접속 시도 + 누락 목록 갱신
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        refreshConversations();
        if (!state.state.offline && state.state.conn === "disconnected") connect();
    });

    window.addEventListener("pagehide", stopInternal);
    window.addEventListener("pageshow", (e) => {
        if (e.persisted) connect();
    });
    window.addEventListener("beforeunload", stopInternal);

    T.events = { connect, refreshConversations };
})((window.Taby = window.Taby || {}));
