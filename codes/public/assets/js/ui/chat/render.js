/* tabyBot 웹 클라이언트: 대화 렌더링, 라이브 블록, 메시지 전송. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const thread = document.getElementById("thread");
    const scroller = document.getElementById("scroller");

    // 긴 대화는 최근 메시지부터 나눠 그림. 처음에는 화면을 채울 만큼만 그려 바로 뜨게 하고,
    // 위로 올리면 PAGE개씩 앞에 덧붙임.
    const FIRST_PAGE = 30;
    const PAGE = 100;
    const LOAD_MORE_PX = 1200;
    const renderFrom = new Map(); // convId → 그리기 시작하는 보이는 메시지 인덱스
    let visibleRefs = []; // 마지막으로 그린 대화의 보이는 메시지 [{ t, mi }] (인덱스 = data-midx)
    let drawn = null; // 마지막으로 그린 대화의 { c, visible, lastOfTurn }: 앞에 덧붙일 때 씀

    /* ── 렌더 ───────────────────────────────────────────────── */
    // __SILENT__ 마커가 앞/뒤에 붙은 발화도 침묵 판정으로 본다(서버 toDisplayTurns와 동일 규칙).
    function isSilentMarked(text) {
        const s = String(text || "").trim();
        return s.startsWith("__SILENT__") || s.endsWith("__SILENT__");
    }

    // mem === undefined: 같은 대화 재렌더. 지금 위치 유지. null: 하단으로. 객체: 그 위치로 복원.
    function renderConversation(mem) {
        const keep = mem === undefined ? C.captureScroll() : mem;
        const same = C.renderedId === state.state.currentId;
        C.liveEls = null;
        C.renderedId = state.state.currentId;
        if (C.bubbleRo) C.bubbleRo.disconnect();
        thread.textContent = "";
        const c = state.currentConv();

        if (!c) {
            visibleRefs = [];
            drawn = null;
            C.askedIds = new Set();
            thread.append(C.buildEmptyState());
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
        visibleRefs = visible.map((f) => ({ t: f.t, mi: f.mi }));
        // 이력에 이미 자리 잡은 질문은 라이브 블록에 중복으로 띄우지 않는다.
        C.askedIds = new Set(visible.filter((f) => f.m.role === "ask" && f.m.askId).map((f) => f.m.askId));
        drawn = { c, visible, lastOfTurn };

        // 다른 대화로 오면 최근 FIRST_PAGE개부터. 같은 대화를 다시 그리면 그리던 범위를 유지함.
        // 복원할 위치의 메시지가 범위 밖이면 그 앞까지 넓힘.
        const id = String(state.state.currentId);
        let from = same && renderFrom.has(id) ? renderFrom.get(id) : Math.max(0, visible.length - FIRST_PAGE);
        if (keep?.midx != null) from = Math.min(from, Math.max(0, Number(keep.midx) - 20));
        from = Math.min(from, Math.max(0, visible.length - FIRST_PAGE));
        renderFrom.set(id, from);

        // 봇 스레드 상단 안내는 대화 맨 앞까지 그렸을 때만 표시(새로고침/전환과 무관하게 일관).
        // 아직 기록을 받는 중이면 비워 둔다. 안내가 떴다가 메시지에 밀려 사라지지 않게.
        if (from === 0 && (c.loaded || state.state.offline)) thread.append(C.buildEmptyState());

        thread.append(buildRows(from, visible.length));

        // 아직 정본에 나타나지 않은 내 메시지(낙관적 버블)
        for (const p of c.pending) thread.append(buildPendingRow(p));

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

    // 그룹 대화방: 에이전트가 바뀌는 첫 발화에만 이름표를 단다. 이름표를 달 에이전트 uuid, 아니면 null.
    function speakerLabelAt(visible, i) {
        const f = visible[i];
        const speaker = f.m.role !== "user" ? f.turn.speaker || null : null;
        const prev = i > 0 ? visible[i - 1] : null;
        return speaker && !(prev && prev.m.role !== "user" && prev.turn.speaker === speaker) ? speaker : null;
    }

    // 보이는 메시지 [from, to)의 행과 날짜 구분선을 만듦.
    function buildRows(from, to) {
        const { visible, lastOfTurn } = drawn;
        const frag = document.createDocumentFragment();
        let lastDayKey = null;
        for (let i = from; i < to; i++) {
            const f = visible[i];
            let el;
            const msgAt = f.m.at || f.turn.at;
            const dayKey = C.dayKeyOf(msgAt);
            if (dayKey && dayKey !== lastDayKey) {
                lastDayKey = dayKey;
                frag.append(T.h("div", { class: "date-sep", role: "separator" }, [T.h("span", { text: C.fmtMsgDate(msgAt) })]));
            }
            const label = speakerLabelAt(visible, i);
            if (f.m.role === "ask") {
                const stack = T.h("div", { class: "msg-stack" }, [C.buildAskCard(f.m)]);
                if (label) stack.prepend(C.buildSpeakerLabel(label));
                el = T.h("div", { class: "msg-row assistant ask-row" }, [stack]);
            } else if (f.m.role === "user") {
                const text = f.m.content || (f.m.isParts && !f.m.attachments?.length && !f.m.imageUrl ? t("imagePlaceholder") : "");
                el = C.buildUserMessage(text, f.m.imageUrl, false, f.m.attachments, msgAt);
            } else {
                el = C.buildAssistant(f.m.content || "", {
                    stats: lastOfTurn.get(f.turn) === i ? f.stats : null,
                    attachments: f.attachments,
                    at: msgAt,
                    speaker: label,
                });
            }
            if (f.m.role !== "user" && f.turn.speaker) el.dataset.speaker = f.turn.speaker;
            el.dataset.midx = String(i); // 딥링크 ?m=<인덱스> 대상
            el.dataset.t = String(f.t); // 검색 결과 네비게이션: 턴/메시지 인덱스
            el.dataset.m = String(f.mi);
            frag.append(el);
            C.watchBubble(el.querySelector(".bubble"));
        }
        return frag;
    }

    // 이전 메시지를 맨 앞에 덧붙임. 이미 그린 행은 다시 만들지 않고, 보던 행은 화면에서 같은 자리에 둠.
    function prependRows(to) {
        const id = String(state.state.currentId);
        const old = renderFrom.get(id) ?? 0;
        if (!drawn || to >= old) return;
        const anchor = thread.querySelector(".msg-row[data-midx]");
        const before = anchor?.getBoundingClientRect().top;
        // 덧붙인 마지막 메시지와 같은 날이면 기존 맨 위 날짜 구분선은 겹치므로 뺌.
        const first = thread.firstElementChild;
        const at = (i) => drawn.visible[i].m.at || drawn.visible[i].turn.at;
        if (first?.classList.contains("date-sep") && C.dayKeyOf(at(old - 1)) === C.dayKeyOf(at(old))) first.remove();
        const frag = buildRows(to, old);
        if (to === 0 && (drawn.c.loaded || state.state.offline)) frag.prepend(C.buildEmptyState());
        thread.prepend(frag);
        renderFrom.set(id, to);
        if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - before;
    }

    // 보이는 메시지 인덱스 i가 그려져 있게 함. 범위 밖이면 그 앞까지 넓혀 다시 그림.
    function revealIndex(i) {
        const id = String(state.state.currentId);
        if (!Number.isInteger(i) || i < 0 || (renderFrom.get(id) ?? 0) <= i) return;
        prependRows(Math.max(0, i - 20));
    }

    // 서버 인덱스(턴/메시지)로 찾아 그려지게 함. 검색 결과 이동용.
    function revealTurnMessage(t, m) {
        revealIndex(visibleRefs.findIndex((r) => r.t === t && r.mi === m));
    }

    // 맨 위 가까이 오면 이전 메시지를 PAGE개 더 그림.
    let loadingMore = false;
    scroller.addEventListener("scroll", () => {
        if (loadingMore || scroller.scrollTop > LOAD_MORE_PX || !C.chatVisible() || C.restorePending) return;
        const from = renderFrom.get(String(state.state.currentId)) ?? 0;
        if (!from || C.renderedId !== state.state.currentId) return;
        loadingMore = true;
        requestAnimationFrame(() => {
            loadingMore = false;
            if (C.renderedId === state.state.currentId) prependRows(Math.max(0, from - PAGE));
        });
    });

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
        const textEl = T.h("div", { class: "live-text" });
        const bubble = T.h("div", { class: "bubble" }, [statusEl, textEl]);
        const speakerEl = T.h("div", { class: "live-speaker" });
        root.append(T.h("div", { class: "msg-stack" }, [speakerEl, interEl, toolsEl, asksEl, bubble]));
        thread.append(root);
        // 생성 중인 답변. 다시 그려 붙여도 이미 보여 준 부분부터 이어서 푼다(live.streamShown).
        const stream = T.mdStream.create(textEl, {
            shown: live.streamShown || 0,
            onProgress(n) {
                live.streamShown = n;
            },
            onRender() {
                const shown = Boolean(stream?.text.trim());
                statusEl.classList.toggle("hidden", shown);
                if (C.pinnedBottom) C.scrollToBottom(false);
                C.updateJump();
                C.fitBubbleRadius(bubble);
            },
        });
        C.liveEls = {
            live,
            root,
            bubble,
            speakerEl,
            speaker: null,
            statusEl,
            toolsEl,
            asksEl,
            interEl,
            stream,
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

        // 그룹 대화방: 지금 답하는 에이전트의 이름표. 바로 위 기록이 같은 에이전트의 발화면 생략한다.
        if (live.speaker !== C.liveEls.speaker) {
            C.liveEls.speaker = live.speaker || null;
            const prev = C.liveEls.root.previousElementSibling;
            const same = prev?.classList.contains("assistant") && prev.dataset.speaker === live.speaker;
            C.liveEls.speakerEl.replaceChildren(...(live.speaker && !same ? [C.buildSpeakerLabel(live.speaker)] : []));
        }

        // 원은 고정. 글자를 갈아끼우면 shimmer가 끊긴다.
        const key = PHASE_KEY[live.phase] || "generating";
        if (C.liveEls.labelKey !== key) {
            C.liveEls.labelKey = key;
            C.liveEls.statusEl.setAttribute("aria-label", t(key));
        }

        // 생성 중인 본문. 자동 실행은 침묵으로 끝날 수 있어 답이 확정되기 전에는 보이지 않는다(목록 미리보기와 같다).
        const text = live.automated ? "" : live.text;
        C.liveEls.stream.update(text);
        if (!text) C.liveEls.statusEl.classList.remove("hidden");

        // 중간 라운드 텍스트(툴 호출 전 코멘트): 새로고침 시 히스토리에 남는 것과 동일하게 표시
        if (live.intermediate.length !== C.liveEls.interN) {
            C.liveEls.interN = live.intermediate.length;
            C.liveEls.interEl.replaceChildren(
                ...live.intermediate.map((text) => {
                    const bubble = T.h("div", { class: "bubble inter" }, [T.md.render(text)]);
                    C.enhanceFileLinks(bubble);
                    return bubble;
                }),
            );
            C.liveEls.interEl.classList.toggle("hidden", !live.intermediate.length);
        }

        // 도구 카드
        if (live.tools.length !== C.liveEls.toolN) {
            C.liveEls.toolN = live.tools.length;
            C.liveEls.toolsEl.replaceChildren(...live.tools.map(C.buildToolCard));
            C.liveEls.toolsEl.classList.toggle("hidden", !live.tools.length);
        }

        // ask 카드(답변/해제 상태 변화도 재구성). 이력에 이미 저장된 질문은 제자리 카드가 맡는다.
        const liveAsks = live.asks.filter((a) => !C.askedIds?.has(a.askId));
        const sig = liveAsks.map((a) => `${a.askId}:${a.answer != null}:${a.resolved}`).join("|");
        if (sig !== C.liveEls.askSig) {
            C.liveEls.askSig = sig;
            C.liveEls.asksEl.replaceChildren(...liveAsks.map(C.buildAskCard));
            C.liveEls.asksEl.classList.toggle("hidden", !liveAsks.length);
        }

        if (C.pinnedBottom) C.scrollToBottom(false);
        C.updateJump();
        C.fitBubbleRadius(C.liveEls.bubble);
    }

    function applySync() {
        const c = state.currentConv();
        if (!c?.live) return;
        // 스트리밍이 렌더 이후 이벤트로 시작된 경우: 라이브 블록을 여기서 마운트
        // 그룹 대화방에서 다음 에이전트가 이어 받으면 라이브가 새것으로 바뀐다. 블록을 새로 붙인다.
        if (C.liveEls && C.liveEls.live !== c.live) {
            C.liveEls.root.remove();
            C.liveEls = null;
        }
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

    // 서버 기록과 짝을 맞출 메시지 id. randomUUID는 보안 컨텍스트(HTTPS/localhost)에서만 있어
    // 내부망 HTTP 접속에서는 getRandomValues로 만든다.
    function newClientId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function buildPendingRow(p) {
        const el = C.buildUserMessage(p.text, null, !p.sent, p.attachments, p.at);
        el.dataset.pending = p.id;
        C.watchBubble(el.querySelector(".bubble"));
        return el;
    }

    function pendingRow(p) {
        return [...thread.querySelectorAll(".msg-row[data-pending]")].find((el) => el.dataset.pending === p.id) || null;
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

        // 서버 기록에 같은 id의 메시지가 나타날 때까지 이 버블을 유지한다(state/live.js reconcilePending).
        const pend = { id: newClientId(), text, attachments: atts, at: new Date().toISOString(), sent: false };
        c.pending.push(pend);

        // 빈 스레드 첫 진입이면 안내줄을 치운다
        thread.querySelector(".thread-intro")?.remove();
        // 낙관적 버블은 다른 대기 버블 뒤, 라이브 블록 앞에 둔다(다시 그릴 때의 순서와 같게).
        const liveRoot = C.liveEls?.root?.parentElement === thread ? C.liveEls.root : null;
        thread.insertBefore(buildPendingRow(pend), liveRoot);
        C.refreshHeader();
        C.scrollToBottom(false);

        try {
            await T.api.sendMessage(convId, text, atts.map((a) => a.id).filter(Boolean), pend.id);
            pend.sent = true;
            // 컴포저가 전송 후 미리보기 주소(objUrl)를 해제한다. 버블은 업로드된 파일 주소로 그린다.
            pend.attachments = atts.map(({ objUrl: _objUrl, ...rest }) => rest);
            pendingRow(pend)?.classList.remove("optimistic");
            return true;
        } catch (err) {
            // 롤백: 낙관적 항목 제거 + 입력 복원은 컴포저가 처리
            const i = c.pending.indexOf(pend);
            if (i > -1) c.pending.splice(i, 1);
            if (state.state.currentId === convId) pendingRow(pend)?.remove();
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
    C.revealIndex = revealIndex;
    C.revealTurnMessage = revealTurnMessage;
    C.applySync = applySync;
    C.requestSync = requestSync;
    C.submitMessage = submitMessage;
})(window.Taby);
