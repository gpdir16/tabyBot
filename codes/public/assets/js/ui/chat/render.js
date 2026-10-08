/* tabyBot 웹 클라이언트: 대화 렌더링, 라이브 블록, 메시지 전송. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const thread = document.getElementById("thread");

    /* ── 렌더 ───────────────────────────────────────────────── */
    // __SILENT__ 마커가 앞/뒤에 붙은 발화도 침묵 판정으로 본다(서버 toDisplayTurns와 동일 규칙).
    function isSilentMarked(text) {
        const s = String(text || "").trim();
        return s.startsWith("__SILENT__") || s.endsWith("__SILENT__");
    }

    // mem === undefined: 같은 대화 재렌더. 지금 위치 유지. null: 하단으로. 객체: 그 위치로 복원.
    function renderConversation(mem) {
        const keep = mem === undefined ? C.captureScroll() : mem;
        C.liveEls = null;
        C.renderedId = state.state.currentId;
        if (C.bubbleRo) C.bubbleRo.disconnect();
        thread.textContent = "";
        const c = state.currentConv();

        // 봇 스레드 상단 안내는 항상 표시(새로고침/전환과 무관하게 일관).
        // 아직 기록을 받는 중이면 비워 둔다. 안내가 떴다가 메시지에 밀려 사라지지 않게.
        if (!c || c.loaded || state.state.offline) thread.append(C.buildEmptyState());

        if (!c) {
            C.refreshHeader();
            C.restoreScroll(keep);
            return;
        }

        const flat = [];
        c.turns.forEach((turn, ti) => {
            const messages = turn.messages || [];
            let lastAssistant = -1;
            messages.forEach((message, index) => {
                if (message.role === "assistant") lastAssistant = index;
            });
            messages.forEach((m, index) => {
                flat.push({
                    m,
                    turn,
                    t: ti,
                    mi: index,
                    stats: turn.stats,
                    attachments: index === lastAssistant ? turn.attachments || [] : [],
                });
            });
        });
        // 서버 히스토리의 role:"tool" 메시지(JSON 원문)는 화면에 버블로 그리지 않는다.
        // 라이브에서는 툴 카드로 표시되므로 새로고침 화면과의 일관성을 위해 제외.
        const visible = flat.filter((f) => {
            if (f.m.role === "tool") return false;
            const text = typeof f.m.content === "string" ? f.m.content.trim() : "";
            if (f.m.role === "assistant") {
                if (!text && !(f.m.attachments || []).length) return false;
                if (isSilentMarked(text)) return false;
            }
            if (f.m.role === "user" && text.includes("[tabybot-scheduled]")) return false;
            return true;
        });
        // 통계 푸터는 턴의 마지막 보이는 assistant 버블에만 단다. 중간 발화마다 달리지 않게.
        const lastOfTurn = new Map();
        visible.forEach((f, i) => {
            if (f.m.role === "assistant") lastOfTurn.set(f.turn, i);
        });

        let lastDayKey = null;
        visible.forEach((f, i) => {
            let el;
            const msgAt = f.m.at || f.turn.at;
            const dayKey = C.dayKeyOf(msgAt);
            if (dayKey && dayKey !== lastDayKey) {
                lastDayKey = dayKey;
                thread.append(T.h("div", { class: "date-sep", role: "separator" }, [T.h("span", { text: C.fmtMsgDate(msgAt) })]));
            }
            if (f.m.role === "user") {
                const text = f.m.content || (f.m.isParts && !f.m.attachments?.length && !f.m.imageUrl ? t("imagePlaceholder") : "");
                el = C.buildUserMessage(text, f.m.imageUrl, false, f.m.attachments, msgAt);
            } else {
                el = C.buildAssistant(f.m.content || "", {
                    stats: lastOfTurn.get(f.turn) === i ? f.stats : null,
                    attachments: f.attachments,
                    at: msgAt,
                });
            }
            el.dataset.midx = String(i); // 딥링크 ?m=<인덱스> 대상
            el.dataset.t = String(f.t); // 검색 결과 네비게이션: 턴/메시지 인덱스
            el.dataset.m = String(f.mi);
            thread.append(el);
            C.watchBubble(el.querySelector(".bubble"));
        });

        // 낙관적(미확정) 사용자 메시지
        for (const p of c.pending) {
            const el = C.buildUserMessage(p.text, null, true, p.attachments, p.at);
            thread.append(el);
            C.watchBubble(el.querySelector(".bubble"));
        }

        if (c.live) mountLive(c.live);

        C.refreshHeader();
        C.restoreScroll(keep);
        requestAnimationFrame(() => {
            C.fitBubblesIn(thread);
            // 버블 재측정·이미지 로드 등으로 높이가 늘어나면 하단 고정 의도가
            // 실제 위치보다 짧게 끝난다. 레이아웃 확정 뒤 한 번 더 맞춘다.
            if (keep?.pinned && C.pinnedBottom) C.scrollToBottom(false);
        });
    }

    /* ── 라이브 블록 ────────────────────────────────────────── */
    const PHASE_KEY = {
        generating: "generating",
        thinking: "thinking",
        tools: "runningTool",
        compressing: "compressing",
        self_improving: "selfImproving",
        searching: "searching",
    };

    function mountLive(live) {
        const root = T.h("div", { class: "msg-row assistant live" });
        const shimmerEl = T.h("span", { class: "shimmer", text: "●●●" });
        const statusEl = T.h("div", { class: "gen-label", role: "status" }, [shimmerEl]);
        const interEl = T.h("div", { class: "live-inter hidden" });
        const toolsEl = T.h("div", { class: "tool-stack hidden" });
        const asksEl = T.h("div", { class: "asks hidden" });
        const bubble = T.h("div", { class: "bubble" }, [statusEl]);
        root.append(T.h("div", { class: "msg-stack" }, [interEl, toolsEl, asksEl, bubble]));
        thread.append(root);
        C.liveEls = {
            root,
            bubble,
            statusEl,
            toolsEl,
            asksEl,
            interEl,
            toolN: -1,
            interN: -1,
            askSig: "",
            labelKey: null,
        };
        C.watchBubble(bubble);
        syncLive(live);
    }

    function syncLive(live) {
        if (!C.liveEls) return;

        // 원은 고정. 글자를 갈아끼우면 shimmer가 끊긴다.
        const key = PHASE_KEY[live.phase] || "generating";
        if (C.liveEls.labelKey !== key) {
            C.liveEls.labelKey = key;
            C.liveEls.statusEl.setAttribute("aria-label", t(key));
        }

        // 중간 라운드 텍스트(툴 호출 전 코멘트): 새로고침 시 히스토리에 남는 것과 동일하게 표시
        if (live.intermediate.length !== C.liveEls.interN) {
            C.liveEls.interN = live.intermediate.length;
            C.liveEls.interEl.replaceChildren(...live.intermediate.map((t) => T.h("div", { class: "bubble inter" }, [T.md.render(t)])));
            C.liveEls.interEl.classList.toggle("hidden", !live.intermediate.length);
        }

        // 도구 카드
        if (live.tools.length !== C.liveEls.toolN) {
            C.liveEls.toolN = live.tools.length;
            C.liveEls.toolsEl.replaceChildren(...live.tools.map(C.buildToolCard));
            C.liveEls.toolsEl.classList.toggle("hidden", !live.tools.length);
        }

        // ask 카드(답변/해제 상태 변화도 재구성)
        const sig = live.asks.map((a) => `${a.askId}:${a.answer != null}:${a.resolved}`).join("|");
        if (sig !== C.liveEls.askSig) {
            C.liveEls.askSig = sig;
            C.liveEls.asksEl.replaceChildren(...live.asks.map(C.buildAskCard));
            C.liveEls.asksEl.classList.toggle("hidden", !live.asks.length);
        }

        if (C.pinnedBottom) C.scrollToBottom(false);
        C.updateJump();
        C.fitBubbleRadius(C.liveEls.bubble);
    }

    function applySync() {
        const c = state.currentConv();
        if (!c?.live) return;
        // 스트리밍이 렌더 이후 이벤트로 시작된 경우: 라이브 블록을 여기서 마운트
        if (!C.liveEls) {
            mountLive(c.live);
            return;
        }
        syncLive(c.live);
    }

    function requestSync() {
        if (C.rafPending) return;
        C.rafPending = true;
        let flushed = false;
        const run = () => {
            if (flushed) return;
            flushed = true;
            C.rafPending = false;
            applySync();
        };
        // rAF 배치 기본. 숨김 탭 등 rAF 억제 환경에서는 타이머 폴백이 플러시한다.
        requestAnimationFrame(run);
        setTimeout(run, 120);
    }

    // 봇 스레드는 항상 존재한다(봇 선택 시 자동 생성). 새로 만들지 않는다.
    function currentThreadId() {
        return state.state.currentId || null;
    }

    // 컴포저/재생성 공용 진입. attachments: [{id, objUrl}]
    async function submitMessage(payload) {
        const text = (payload?.text ? String(payload.text) : "").trim();
        const atts = payload?.attachments || [];
        if (!text && !atts.length) return false;

        const convId = currentThreadId();
        if (!convId) {
            T.toast.show("error", t("selectBotFirst"));
            return false;
        }
        const c = state.conv(convId);

        const pend = { text, attachments: atts, imageUrl: null, at: new Date().toISOString() };
        c.pending.push(pend);

        // 빈 스레드 첫 진입이면 안내줄을 치운다
        thread.querySelector(".thread-intro")?.remove();
        const el = C.buildUserMessage(text, null, true, atts, pend.at);
        pend._el = el;
        thread.append(el);
        for (const p of c.pending) {
            if (p !== pend && p._el && p._el.parentElement !== thread) thread.append(p._el);
        }
        C.refreshHeader();
        C.scrollToBottom(false);

        try {
            await T.api.sendMessage(convId, text, atts.map((a) => a.id).filter(Boolean));
            el.classList.remove("optimistic");
            return true;
        } catch (err) {
            // 롤백: 낙관적 항목 제거 + 입력 복원은 컴포저가 처리
            const i = c.pending.indexOf(pend);
            if (i > -1) c.pending.splice(i, 1);
            if (pend._el?.parentElement) pend._el.parentElement.remove();
            const notConfigured = err?.status === 409 && err.payload?.error === "not_configured";
            T.toast.show("error", notConfigured ? T.api.errorDetail(err) : T.api.errorText(err, t("sendFailed")));
            if (notConfigured) {
                const tab = err.payload.reason === "model_missing" ? "model" : "provider";
                T.app?.openSettings?.(tab);
            }
            return false;
        }
    }

    C.renderConversation = renderConversation;
    C.applySync = applySync;
    C.requestSync = requestSync;
    C.submitMessage = submitMessage;
})(window.Taby);
