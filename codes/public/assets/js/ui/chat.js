/* tabyBot 웹 클라이언트 — 채팅 영역.
   메시지 리스트, 도구카드, ask카드, 첨부 미리보기,
   자동 스크롤 고정 + "새 메시지" 플로팅 버튼, hover 액션(복사/재생성).
   응답 토큰은 그리지 않고, 구간이 끝나면 말풍선으로 뜬다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    const scroller = document.getElementById("scroller");
    const thread = document.getElementById("thread");
    const jump = document.getElementById("jumpLatest");
    jump.setAttribute("aria-label", t("newMessages"));
    const hdrAvatar = document.getElementById("hdrAvatar");
    const hdrName = document.getElementById("hdrName");

    let pinnedBottom = true;
    let rafPending = false;
    let liveEls = null; // 현재 대화의 라이브 블록 참조

    /* ── 스크롤 ─────────────────────────────────────────────── */
    scroller.addEventListener("scroll", () => {
        pinnedBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
        updateJump();
    });
    jump.addEventListener("click", () => scrollToBottom(true));

    function scrollToBottom(smooth) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
        pinnedBottom = true;
        updateJump();
    }
    function updateJump() {
        // 응답 생성 중이 아니어도 현재 위치가 하단에서 벗어나면 표시한다.
        const show = !pinnedBottom;
        jump.setAttribute("aria-hidden", String(!show));
        jump.tabIndex = show ? 0 : -1;
        jump.classList.toggle("show", show);
    }

    /* ── 유틸 ───────────────────────────────────────────────── */
    function fmt(n) {
        try {
            return Number(n).toLocaleString(T.i18n.getLang() === "ko" ? "ko-KR" : T.i18n.getLang() === "ja" ? "ja-JP" : "en-US");
        } catch (_) {
            return String(n);
        }
    }
    // 이미지 src: blob/data는 그대로, 파일 API는 쿼리 토큰을 붙인다.
    function setThumbSrc(img, pathOrUrl) {
        if (!pathOrUrl) return;
        if (pathOrUrl.startsWith("blob:") || pathOrUrl.startsWith("data:") || pathOrUrl.includes("?token=") || !T.api.getToken()) {
            img.src = pathOrUrl;
            return;
        }
        if (pathOrUrl.startsWith("/api/files/")) {
            img.src = T.api.fileHref(pathOrUrl.split("/").pop().split("?")[0]);
            return;
        }
        img.src = pathOrUrl;
    }

    /* ── 빌더 ───────────────────────────────────────────────── */
    // 한 줄이면 pill, 두 줄 이상(또는 블록 요소)이면 radius-l
    function fitBubbleRadius(el) {
        if (!el) return;
        const cs = getComputedStyle(el);
        let line = parseFloat(cs.lineHeight);
        if (!Number.isFinite(line)) line = (parseFloat(cs.fontSize) || 15) * 1.5;
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const inner = el.clientHeight - pad;
        const block = el.querySelector("img, pre, table, ul, ol, h1, h2, h3, h4, blockquote, .thumb, .stats-footer, .codeblock");
        const tall = !!block || inner > line + 2;
        if (el.classList.contains("tall") === tall) return;
        el.classList.toggle("tall", tall);
    }

    function fitBubblesIn(root) {
        (root || thread).querySelectorAll(".bubble").forEach(fitBubbleRadius);
    }

    let bubbleRo = null;
    function watchBubble(el) {
        if (!el) return;
        fitBubbleRadius(el);
        if (!window.ResizeObserver) return;
        if (!bubbleRo) {
            bubbleRo = new ResizeObserver((entries) => {
                for (const entry of entries) fitBubbleRadius(entry.target);
            });
        }
        bubbleRo.observe(el);
    }

    function formatSize(bytes) {
        const size = Number(bytes);
        if (!Number.isFinite(size) || size < 0) return "";
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    function fileType(mime, name) {
        const ext = String(name || "")
            .split(".")
            .pop();
        if (ext && ext !== name && ext.length <= 8) return ext.toUpperCase();
        const sub = String(mime || "")
            .split("/")
            .pop();
        if (sub && sub !== "octet-stream") return sub.toUpperCase();
        return "FILE";
    }

    const ATTACHED_FILES_MARK = "[User attached files]";
    function displayUserText(content) {
        const s = String(content || "");
        const i = s.indexOf(ATTACHED_FILES_MARK);
        return i === -1 ? s : s.slice(0, i).trim();
    }

    function fileHref(id) {
        return T.api.fileHref(id);
    }

    function buildAttachmentTile(attachment) {
        const src = attachment.objUrl || (attachment.id ? fileHref(attachment.id) : attachment.url || "");
        const name = attachment.name || t("file");
        if (attachment.mime?.startsWith("image/") || attachment.mime === "image/*") {
            const img = T.h("img", { class: "thumb", alt: name });
            setThumbSrc(img, src);
            img.addEventListener("click", () => {
                try {
                    window.open(img.src || src, "_blank");
                } catch (_) {}
            });
            return img;
        }
        const meta = `${fileType(attachment.mime, name)}${formatSize(attachment.size) ? ` · ${formatSize(attachment.size)}` : ""}`;
        const link = T.h("a", {
            class: "file-attachment",
            href: src || "#",
            download: name,
            title: name,
            rel: "noopener",
        });
        link.append(T.h("strong", { class: "file-name", text: name }), T.h("span", { class: "file-meta", text: meta }));
        return link;
    }

    function buildUserMessage(text, imageUrl, optimistic, attachments) {
        const items = attachments && attachments.length ? attachments : imageUrl ? [{ objUrl: imageUrl, mime: "image/*" }] : [];
        const visibleText = displayUserText(text);
        const stack = T.h("div", { class: "msg-user-stack" });
        if (items.length) {
            stack.append(T.h("div", { class: "msg-atts" }, items.map(buildAttachmentTile)));
        }
        if (visibleText) {
            const bubble = T.h("div", { class: "bubble" }, [T.h("div", { class: "bubble-text", text: visibleText })]);
            stack.append(bubble);
        }
        return T.h("div", { class: "msg-row user" + (optimistic ? " optimistic" : "") }, [stack]);
    }

    function statsFooter(stats) {
        const parts = [];
        if (stats.modelCallCount != null) parts.push(t("statModelCalls", { n: fmt(stats.modelCallCount) }));
        if (stats.toolCallCount != null) parts.push(t("statToolCalls", { n: fmt(stats.toolCallCount) }));
        if (stats.tokensUsed != null && stats.contextWindow) {
            parts.push(fmt(stats.tokensUsed) + " / " + fmt(stats.contextWindow));
        }
        if (!parts.length) return null;
        return T.h("div", { class: "stats-footer", text: parts.join(" · ") });
    }

    // 복사/재생성 액션(라이브 확정 경로와 동일한 마크업을 쓴다)
    function buildActions(text, opt) {
        const o = opt || {};
        const actions = T.h("div", { class: "msg-actions" });
        const copyBtn = T.h(
            "button",
            {
                class: "btn-icon",
                "data-tip": t("copy"),
                "aria-label": t("copy"),
                onclick() {
                    T.copyText(text).then((ok) => {
                        copyBtn.classList.toggle("copied-ok", !!ok);
                        if (ok) setTimeout(() => copyBtn.classList.remove("copied-ok"), 1200);
                    });
                },
            },
            [T.icon("copy")],
        );
        actions.append(copyBtn);
        if (o.allowRegen) {
            actions.append(
                T.h(
                    "button",
                    {
                        class: "btn-icon",
                        "data-tip": t("regenerate"),
                        "aria-label": t("regenerate"),
                        onclick() {
                            regenerate();
                        },
                    },
                    [T.icon("send")],
                ),
            );
        }
        return actions;
    }

    // 모서리 근처일 때만 코너를 돌려준다. 한가운데는 null.
    function hitCorner(el, x, y) {
        const r = el.getBoundingClientRect();
        const zoneX = Math.min(96, Math.max(44, r.width * 0.34));
        const zoneY = Math.min(96, Math.max(44, r.height * 0.38));
        const distL = x - r.left;
        const distR = r.right - x;
        const distT = y - r.top;
        const distB = r.bottom - y;
        if (distL < -16 || distR < -16 || distT < -16 || distB < -16) return null;
        const nearX = distL <= zoneX || distR <= zoneX;
        const nearY = distT <= zoneY || distB <= zoneY;
        if (!nearX || !nearY) return null;
        const h = distL <= distR ? "l" : "r";
        const v = distT <= distB ? "t" : "b";
        return v + h;
    }

    function dockOffset(actions, bubble, corner) {
        const hang = 14;
        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;
        const aw = actions.offsetWidth || 64;
        const ah = actions.offsetHeight || 30;
        const x = corner[1] === "r" ? Math.max(0, bw - aw) : 0;
        const y = corner[0] === "b" ? bh - ah + hang : -hang;
        return { x, y };
    }

    function bindActionDock(row, actions, anchor) {
        const FADE_MS = 200;
        let hovering = false;

        function place(el, c) {
            const { x, y } = dockOffset(el, anchor, c);
            el.style.setProperty("--ax", `${x}px`);
            el.style.setProperty("--ay", `${y}px`);
            el.dataset.corner = c;
        }

        function spawnGhost() {
            const ghost = actions.cloneNode(true);
            ghost.classList.add("ghost", "show");
            ghost.setAttribute("aria-hidden", "true");
            actions.after(ghost);
            void ghost.offsetWidth;
            ghost.classList.remove("show");
            setTimeout(() => ghost.remove(), FADE_MS + 40);
        }

        function clearGhosts() {
            anchor.querySelectorAll(".msg-actions.ghost").forEach((g) => g.remove());
        }

        function hide() {
            if (!actions.classList.contains("show")) return;
            actions.classList.remove("show");
            clearGhosts();
            if (T.tooltip) T.tooltip.hide();
        }

        function go(c) {
            if (!c) {
                hide();
                return;
            }
            const shown = actions.classList.contains("show");
            if (shown && actions.dataset.corner === c) return;
            if (shown) {
                spawnGhost();
                actions.classList.remove("show");
                void actions.offsetWidth;
            }
            place(actions, c);
            void actions.offsetWidth;
            actions.classList.add("show");
        }

        function onPoint(e) {
            if (e.pointerType === "touch") return;
            if (actions.contains(e.target)) return;
            hovering = true;
            go(hitCorner(anchor, e.clientX, e.clientY));
        }

        row.addEventListener("pointerenter", onPoint);
        row.addEventListener("pointermove", onPoint);
        row.addEventListener("pointerleave", (e) => {
            if (e.relatedTarget && (row.contains(e.relatedTarget) || actions.contains(e.relatedTarget))) return;
            hovering = false;
            hide();
        });
        actions.addEventListener("focusin", () => {
            hovering = true;
            actions.classList.add("show");
        });
        actions.addEventListener("focusout", (e) => {
            if (row.contains(e.relatedTarget)) return;
            hovering = false;
            actions.classList.remove("show");
        });
    }

    function buildAssistant(text, opt) {
        const o = opt || {};
        const bubble = T.h("div", { class: "bubble" });
        bubble.append(T.md.render(text));
        bubble.querySelectorAll("img").forEach((img) => {
            img.addEventListener("load", () => fitBubbleRadius(bubble));
        });

        const sf = o.stats && state.state.settings && state.state.settings.showReplyFooter ? statsFooter(o.stats) : null;
        if (sf) bubble.append(sf);

        const actions = buildActions(text, { allowRegen: o.allowRegen });
        bubble.append(actions);
        const stack = T.h("div", { class: "msg-stack" }, [bubble]);
        const row = T.h("div", { class: "msg-row assistant" }, [stack]);
        bindActionDock(row, actions, bubble);
        return row;
    }

    function buildToolCard(tool) {
        const card = T.h("div", { class: "tool-card" });
        const sum = T.h("span", { class: "tool-sum", text: tool.argsSummary || "" });
        const chevron = T.icon("chevron", "icon-sm tool-chevron");
        const head = T.h(
            "button",
            {
                class: "tool-head",
                "aria-expanded": "false",
                onclick() {
                    card.classList.toggle("open");
                    head.setAttribute("aria-expanded", String(card.classList.contains("open")));
                },
            },
            [
                T.h("span", { class: "tool-glyph", text: "\uD83D\uDD27" }),
                T.h("span", { class: "tool-name", text: tool.name || "" }),
                T.h("span", { class: "tool-sep", text: "—" }),
                sum,
                chevron,
            ],
        );
        const body = T.h("div", { class: "tool-body" }, [T.h("pre", { text: tool.argsSummary || "" })]);
        card.append(head, body);
        return card;
    }

    function appendAnswerSummary(card, ask) {
        let text = "";
        if (ask.answer) {
            if (ask.answer.choiceIndex != null && ask.options[ask.answer.choiceIndex] != null) {
                text = ask.options[ask.answer.choiceIndex];
            } else if (ask.answer.text != null) {
                text = ask.answer.text;
            }
        }
        if (text) card.append(T.h("div", { class: "ask-answer", text }));
    }

    function buildAskCard(ask) {
        const convId = state.state.currentId;
        const card = T.h("div", { class: "ask-card", dataset: { askId: ask.askId, expires: ask.expiresAt || "" } });
        card.append(T.h("div", { class: "ask-q", text: ask.question }));

        const done = () => ask.answer != null || ask.resolved;

        if (!done()) {
            if (ask.options.length) {
                const opts = T.h("div", { class: "ask-opts" });
                ask.options.forEach((label, i) => {
                    opts.append(
                        T.h("button", {
                            class: "ask-opt" + (ask.answer && ask.answer.choiceIndex === i ? " selected" : ""),
                            text: label,
                            onclick() {
                                answer({ choiceIndex: i });
                            },
                        }),
                    );
                });
                card.append(opts);
            }
            const input = T.h("input", {
                class: "ask-input",
                placeholder: t("askInputPlaceholder"),
                onkeydown(e) {
                    e.stopPropagation();
                    if (e.key === "Enter") sendText();
                },
            });
            const sendBtn = T.h(
                "button",
                {
                    class: "ask-send",
                    "data-tip": t("send"),
                    "aria-label": t("send"),
                    onclick() {
                        sendText();
                    },
                },
                [T.icon("send")],
            );
            card.append(T.h("div", { class: "ask-row" }, [input, sendBtn]));
            // Enter에서 input blur로 인한 이벤트 유실 방지: 카드에 입력 보관
            card._input = input;
        } else {
            card.classList.add("done");
            appendAnswerSummary(card, ask);
        }

        const status = T.h("span", {});
        const time = T.h("span", { class: "ask-time" });
        card.append(T.h("div", { class: "ask-foot" }, [status, time]));
        card._status = status;

        async function answer(body) {
            if (done()) return;
            const prev = ask.answer;
            ask.answer = body; // 낙관적 반영
            requestSync();
            try {
                await T.api.answerAsk(ask.askId, body);
            } catch (err) {
                ask.answer = prev; // 롤백
                requestSync();
                T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            }
        }
        function sendText() {
            const v = (card._input && card._input.value.trim()) || "";
            if (v) answer({ text: v });
        }

        tickAsk(card, ask, status, time);
        return card;
    }

    // 남은 시간/만료 갱신(전역 티커가 매초 호출)
    function tickAsk(card, ask, status, time) {
        const exp = Date.parse(card.dataset.expires || "");
        if (isNaN(exp)) {
            time.textContent = "";
            status.textContent = "";
            return;
        }
        if (ask.resolved || ask.answer != null) {
            time.textContent = "";
            status.textContent = t("answered");
            return;
        }
        const left = Math.max(0, Math.round((exp - Date.now()) / 1000));
        if (left <= 0) {
            time.textContent = "";
            status.textContent = t("askExpired");
            card.classList.add("done");
            card.querySelectorAll(".ask-opt,.ask-input,.ask-send").forEach((el) => {
                el.disabled = true;
            });
        } else {
            status.textContent = "";
            time.textContent = t("askTimeLeft", { n: left });
            time.classList.toggle("urgent", left <= 10);
        }
    }
    setInterval(() => {
        thread.querySelectorAll(".ask-card:not(.done)").forEach((card) => {
            const id = card.dataset.askId;
            const c = state.currentConv();
            const ask = c && c.live && c.live.asks.find((a) => a.askId === id);
            if (ask) tickAsk(card, ask, card._status, card.querySelector(".ask-time"));
        });
    }, 1000);

    /* ── 빈 상태 ────────────────────────────────────────────── */
    // 메신저 톤: 거대 인사/제안칩 대신 한 줄 안내
    function buildEmptyState() {
        const bot = T.state.currentBot();
        const name = bot?.name || "tabyBot";
        return T.h("div", { class: "thread-intro" }, [T.h("span", { text: t("botThreadIntro", { name }) })]);
    }

    /* ── 렌더 ───────────────────────────────────────────────── */
    function normalizeTurn(turn) {
        return {
            at: turn.at,
            stats: turn.stats || null,
            messages: (turn.messages || []).map((m) => ({
                role: m.role,
                content: Array.isArray(m.content) ? null : displayUserText(m.content), // parts 배열은 문자열 렌더 제외
                isParts: Array.isArray(m.content),
                imageUrl: m.imageUrl || null,
                attachments: m.attachments || null,
            })),
        };
    }

    function renderConversation() {
        liveEls = null;
        if (bubbleRo) bubbleRo.disconnect();
        thread.textContent = "";
        const c = state.currentConv();

        // 봇 스레드 상단 안내는 항상 표시(새로고침/전환과 무관하게 일관)
        thread.append(buildEmptyState());

        if (!c) {
            refreshHeader();
            return;
        }

        const flat = [];
        for (const turn of c.turns) {
            for (const m of turn.messages) flat.push({ m, stats: turn.stats });
        }
        // 서버 히스토리의 role:"tool" 메시지(JSON 원문)는 화면에 버블로 그리지 않는다.
        // 라이브에서는 툴 카드로 표시되므로 새로고침 화면과의 일관성을 위해 제외.
        const visible = flat.filter((f) => f.m.role !== "tool");
        let lastA = -1;
        visible.forEach((f, i) => {
            if (f.m.role === "assistant") lastA = i;
        });

        visible.forEach((f, i) => {
            let el;
            if (f.m.role === "user") {
                el = buildUserMessage(f.m.isParts ? t("imagePlaceholder") : f.m.content || "", f.m.imageUrl, false, f.m.attachments);
            } else {
                el = buildAssistant(f.m.isParts ? t("imagePlaceholder") : f.m.content || "", {
                    stats: f.stats,
                    allowRegen: i === lastA && !c.live,
                });
            }
            el.dataset.midx = String(i); // 딥링크 ?m=<인덱스> 대상
            thread.append(el);
            watchBubble(el.querySelector(".bubble"));
        });

        // 낙관적(미확정) 사용자 메시지
        for (const p of c.pending) {
            const el = buildUserMessage(p.text, null, true, p.attachments);
            thread.append(el);
            watchBubble(el.querySelector(".bubble"));
        }

        if (c.live) mountLive(c.live);

        refreshHeader();
        scrollToBottom(false);
        requestAnimationFrame(() => fitBubblesIn(thread));
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
        liveEls = {
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
        watchBubble(bubble);
        syncLive(live);
    }

    function syncLive(live) {
        if (!liveEls) return;

        // 원은 고정. 글자를 갈아끼우면 shimmer가 끊긴다.
        const key = PHASE_KEY[live.phase] || "generating";
        if (liveEls.labelKey !== key) {
            liveEls.labelKey = key;
            liveEls.statusEl.setAttribute("aria-label", t(key));
        }

        // 중간 라운드 텍스트(툴 호출 전 코멘트) — 새로고침 시 히스토리에 남는 것과 동일하게 표시
        if (live.intermediate.length !== liveEls.interN) {
            liveEls.interN = live.intermediate.length;
            liveEls.interEl.replaceChildren(...live.intermediate.map((t) => T.h("div", { class: "bubble inter" }, [T.md.render(t)])));
            liveEls.interEl.classList.toggle("hidden", !live.intermediate.length);
        }

        // 도구 카드
        if (live.tools.length !== liveEls.toolN) {
            liveEls.toolN = live.tools.length;
            liveEls.toolsEl.replaceChildren(...live.tools.map(buildToolCard));
            liveEls.toolsEl.classList.toggle("hidden", !live.tools.length);
        }

        // ask 카드(답변/해제 상태 변화도 재구성)
        const sig = live.asks.map((a) => a.askId + ":" + (a.answer != null) + ":" + a.resolved).join("|");
        if (sig !== liveEls.askSig) {
            liveEls.askSig = sig;
            liveEls.asksEl.replaceChildren(...live.asks.map(buildAskCard));
            liveEls.asksEl.classList.toggle("hidden", !live.asks.length);
        }

        if (pinnedBottom) scroller.scrollTop = scroller.scrollHeight;
        updateJump();
        fitBubbleRadius(liveEls.bubble);
    }

    function applySync() {
        const c = state.currentConv();
        if (!c || !c.live) return;
        // 스트리밍이 렌더 이후 이벤트로 시작된 경우: 라이브 블록을 여기서 마운트
        if (!liveEls) {
            mountLive(c.live);
            return;
        }
        syncLive(c.live);
    }

    function requestSync() {
        if (rafPending) return;
        rafPending = true;
        let flushed = false;
        const run = () => {
            if (flushed) return;
            flushed = true;
            rafPending = false;
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
        const text = (payload && payload.text ? String(payload.text) : "").trim();
        const atts = (payload && payload.attachments) || [];
        if (!text && !atts.length) return false;

        const convId = currentThreadId();
        if (!convId) {
            T.toast.show("error", t("selectBotFirst"));
            return false;
        }
        const c = state.conv(convId);

        const pend = { text, attachments: atts, imageUrl: null };
        c.pending.push(pend);

        // 빈 스레드 첫 진입이면 안내줄을 치운다
        thread.querySelector(".thread-intro")?.remove();
        const el = buildUserMessage(text, null, true, atts);
        pend._el = el;
        thread.append(el);
        for (const p of c.pending) {
            if (p !== pend && p._el && p._el.parentElement !== thread) thread.append(p._el);
        }
        refreshHeader();
        scrollToBottom(false);

        try {
            await T.api.sendMessage(convId, text, atts.map((a) => a.id).filter(Boolean));
            el.classList.remove("optimistic");
            return true;
        } catch (err) {
            // 롤백: 낙관적 항목 제거 + 입력 복원은 컴포저가 처리
            const i = c.pending.indexOf(pend);
            if (i > -1) c.pending.splice(i, 1);
            if (pend._el && pend._el.parentElement) pend._el.parentElement.remove();
            T.toast.show("error", T.api.errorText(err, t("sendFailed")));
            return false;
        }
    }

    function regenerate() {
        const c = state.currentConv();
        if (!c || c.live) return;
        let lastUser = null;
        for (let i = c.turns.length - 1; i >= 0 && !lastUser; i--) {
            const msgs = c.turns[i].messages;
            for (let j = msgs.length - 1; j >= 0; j--) {
                if (msgs[j].role === "user" && typeof msgs[j].content === "string" && msgs[j].content.trim()) {
                    lastUser = msgs[j];
                    break;
                }
            }
        }
        if (!lastUser) return;
        submitMessage({ text: lastUser.content });
    }

    /* ── 대화 열기 ──────────────────────────────────────────── */
    async function open(id, opt) {
        const o = opt || {};
        const token = Symbol("open");
        open._token = token;
        state.setCurrent(id == null ? null : String(id));

        // URL 동기화: /a/<uuid>?m=&q= — 설정 페이지(/s/)가 열려 있으면 경로를 덮지 않는다.
        try {
            const bot = id ? state.botByThreadId(String(id)) : null;
            if (!/^\/s\//.test(location.pathname)) {
                const qs = new URLSearchParams();
                if (o.params?.q) qs.set("q", o.params.q);
                if (o.params?.m != null) qs.set("m", String(o.params.m));
                const query = qs.toString();
                const path = bot?.uuid ? `/a/${bot.uuid}` : "/";
                history.replaceState(null, "", path + (query ? `?${query}` : ""));
            }
        } catch (_) {}

        if (id != null) {
            const c = state.conv(id);
            if (!c.loaded) {
                try {
                    const r = await T.api.conversation(id);
                    c.turns = (r.turns || []).map(normalizeTurn);
                    c.loaded = true;
                    if (r && typeof r === "object") {
                        const { turns: _turns, ...meta } = r;
                        state.upsertMeta(Object.assign({}, c.meta, meta));
                    }
                    state.emit("conversations");
                } catch (err) {
                    T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
                }
            }
        }
        if (open._token !== token) return; // 로드 중 다른 대화로 전환됨
        renderConversation();

        // 1회성 파라미터 적용: 특정 메시지 이동(m)
        if (o.params?.m != null) {
            requestAnimationFrame(() => {
                const el = thread.querySelector(`[data-midx="${Number(o.params.m)}"]`);
                if (el) {
                    el.scrollIntoView({ block: "center" });
                    el.classList.add("msg-highlight");
                    setTimeout(() => el.classList.remove("msg-highlight"), 1600);
                }
            });
        }
    }

    // SSE 재접속 직후 서버 스냅샷과 맞춘다.
    // 진행 중이거나 방금 끝난 턴을 오래된 GET 응답으로 덮으면 답이 새로고침 전까지 사라진다.
    let refreshSeq = 0;
    async function refreshCurrent() {
        const id = state.state.currentId;
        if (!id) return;
        const c = state.conv(id);
        const seq = ++refreshSeq;
        try {
            const r = await T.api.conversation(id);
            if (seq !== refreshSeq || state.state.currentId !== id) return;
            if (c.live) return;
            const incoming = (r.turns || []).map(normalizeTurn);
            if (incoming.length < c.turns.length) return;
            c.turns = incoming;
            c.loaded = true;
            if (r && typeof r === "object") {
                const { turns: _turns, ...meta } = r;
                state.upsertMeta(Object.assign({}, c.meta, meta));
            }
            renderConversation();
        } catch (_) {}
    }

    /* ── 헤더(봇 아바타/이름) ────────────────────────────────── */
    function refreshHeader() {
        const bot = T.state.currentBot();
        const name = bot ? bot.name : "";
        document.title = name ? `${name} — tabyBot` : "tabyBot";
        hdrAvatar.textContent = name ? String(name).trim().slice(0, 1).toUpperCase() : "";
        hdrAvatar.style.background = bot?.color || "var(--surface-2)";
        hdrName.textContent = name;
    }

    /* ── 구독 ───────────────────────────────────────────────── */
    function init() {
        const routeIfCurrent = (p) => {
            if (p.id === state.state.currentId) requestSync();
        };

        state.on("status", routeIfCurrent);
        state.on("tool", routeIfCurrent);
        state.on("ask", routeIfCurrent);
        state.on("ask_resolved", routeIfCurrent);
        state.on("settings", () => {
            refreshHeader();
        });

        state.on("user_message", (p) => {
            if (p.id !== state.state.currentId) return;
            const c = state.conv(p.id);
            if (p.confirmed) {
                thread.querySelectorAll(".msg-row.optimistic").forEach((el) => el.classList.remove("optimistic"));
                return;
            }
            const last = c.turns[c.turns.length - 1];
            const m = last && last.messages && last.messages[last.messages.length - 1];
            if (!m || m.role !== "user") return;
            const el = buildUserMessage(m.content || "", m.imageUrl, false, m.attachments);
            thread.append(el);
            watchBubble(el.querySelector(".bubble"));
            if (pinnedBottom) scrollToBottom(false);
            updateJump();
        });

        state.on("turn_done", (p) => {
            if (p.id !== state.state.currentId) return;
            // 라이브 DOM을 승격하지 않는다. 스트림이 없거나 비면 빈 껍데기만 남아
            // 새로고침(서버 히스토리) 전까지 답이 안 보인다. 항상 turns 기준으로 그린다.
            liveEls = null;
            renderConversation();
            refreshHeader();
            if (pinnedBottom) scrollToBottom(false);
        });

        T.i18n.onChange(() => {
            renderConversation();
        });
        window.addEventListener("resize", () => fitBubblesIn(thread));
        // 숨김 복귀 시 버퍼된 스트림을 즉시 반영
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                const c = state.currentConv();
                if (c && c.live) applySync();
            }
        });

        refreshHeader();
    }

    T.chat = { init, open, refreshCurrent, submitMessage, regenerate, refreshHeader };
})((window.Taby = window.Taby || {}));
