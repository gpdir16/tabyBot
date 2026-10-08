/* tabyBot 웹 클라이언트: 메시지·도구·질문 카드 같은 말풍선 조각 만들기. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const thread = document.getElementById("thread");

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

    C.bubbleRo = null;

    function watchBubble(el) {
        if (!el) return;
        fitBubbleRadius(el);
        if (!window.ResizeObserver) return;
        if (!C.bubbleRo) {
            C.bubbleRo = new ResizeObserver((entries) => {
                for (const entry of entries) fitBubbleRadius(entry.target);
            });
        }
        C.bubbleRo.observe(el);
    }

    function fileHref(id) {
        return T.api.fileHref(id);
    }

    function buildAttachmentTile(attachment) {
        const src = attachment.objUrl || (attachment.id ? fileHref(attachment.id) : attachment.url || "");
        const name = attachment.name || t("file");
        // 첨부 클릭은 새 탭/다운로드가 아니라 앱 내 미리보기 뷰어로 연다.
        const openViewer = (resolved) => {
            if (T.viewer) T.viewer.open({ name, mime: attachment.mime, url: resolved || src });
        };
        if (attachment.mime?.startsWith("image/") || attachment.mime === "image/*") {
            const img = T.h("img", { class: "thumb", alt: name });
            C.setThumbSrc(img, src);
            img.addEventListener("click", () => openViewer(img.src));
            return img;
        }
        const meta = `${T.util.fileType(attachment.mime, name)}${T.util.formatSize(attachment.size) ? ` · ${T.util.formatSize(attachment.size)}` : ""}`;
        const link = T.h("a", {
            class: "file-attachment",
            href: src || "#",
            download: name,
            title: name,
            rel: "noopener",
            onclick(e) {
                if (!T.viewer) return;
                e.preventDefault();
                openViewer(src);
            },
        });
        link.append(T.h("strong", { class: "file-name", text: name }), T.h("span", { class: "file-meta", text: meta }));
        return link;
    }

    function buildMessageAttachments(items) {
        return items?.length ? T.h("div", { class: "msg-atts" }, items.map(buildAttachmentTile)) : null;
    }

    function buildUserMessage(text, imageUrl, optimistic, attachments, at) {
        const items = attachments?.length ? attachments : imageUrl ? [{ objUrl: imageUrl, mime: "image/*" }] : [];
        const visibleText = T.util.displayUserText(text);
        const stack = T.h("div", { class: "msg-user-stack" });
        const atts = buildMessageAttachments(items);
        if (atts) stack.append(atts);
        if (visibleText) {
            const bubble = T.h("div", { class: "bubble" }, [T.h("div", { class: "bubble-text", text: visibleText })]);
            stack.append(bubble);
        }
        C.placeTime(C.msgTimeEl(at), stack, stack.querySelector(".bubble"));
        return T.h("div", { class: `msg-row user${optimistic ? " optimistic" : ""}` }, [stack]);
    }

    function statsFooter(stats) {
        const parts = [];
        if (stats.modelCallCount != null) parts.push(t("statModelCalls", { n: C.fmt(stats.modelCallCount) }));
        if (stats.toolCallCount != null) parts.push(t("statToolCalls", { n: C.fmt(stats.toolCallCount) }));
        if (stats.tokensUsed != null && stats.contextWindow) {
            parts.push(`${C.fmt(stats.tokensUsed)} / ${C.fmt(stats.contextWindow)}`);
        }
        if (!parts.length) return null;
        return T.h("div", { class: "stats-footer", text: parts.join(" · ") });
    }

    function buildAssistant(text, opt) {
        const o = opt || {};
        const bubble = T.h("div", { class: "bubble" });
        if (text) bubble.append(T.md.render(text));
        bubble.querySelectorAll("img").forEach((img) => {
            img.addEventListener("load", () => fitBubbleRadius(bubble));
        });

        const sf = o.stats && state.state.settings?.showReplyFooter ? statsFooter(o.stats) : null;
        if (sf) bubble.append(sf);

        const stack = T.h("div", { class: "msg-stack" }, [bubble]);
        const atts = buildMessageAttachments(o.attachments);
        if (atts) stack.append(atts);
        C.placeTime(C.msgTimeEl(o.at), stack, bubble);
        return T.h("div", { class: "msg-row assistant" }, [stack]);
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
                T.h("span", { class: "tool-sep", text: "·" }),
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
        const _convId = state.state.currentId;
        const card = T.h("div", { class: "ask-card", dataset: { askId: ask.askId, expires: ask.expiresAt || "" } });
        card.append(T.h("div", { class: "ask-q", text: ask.question }));

        const done = () => ask.answer != null || ask.resolved;

        if (!done()) {
            if (ask.options.length) {
                const opts = T.h("div", { class: "ask-opts" });
                ask.options.forEach((label, i) => {
                    opts.append(
                        T.h("button", {
                            class: `ask-opt${ask.answer && ask.answer.choiceIndex === i ? " selected" : ""}`,
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
            C.requestSync();
            try {
                await T.api.answerAsk(ask.askId, body);
            } catch (err) {
                ask.answer = prev; // 롤백
                C.requestSync();
                T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
            }
        }
        function sendText() {
            const v = card._input?.value.trim() || "";
            if (v) answer({ text: v });
        }

        tickAsk(card, ask, status, time);
        return card;
    }

    // 남은 시간/만료 갱신(전역 티커가 매초 호출)
    function tickAsk(card, ask, status, time) {
        const exp = Date.parse(card.dataset.expires || "");
        if (Number.isNaN(exp)) {
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
            const ask = c?.live?.asks.find((a) => a.askId === id);
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

    C.fitBubbleRadius = fitBubbleRadius;
    C.fitBubblesIn = fitBubblesIn;
    C.watchBubble = watchBubble;
    C.buildUserMessage = buildUserMessage;
    C.buildAssistant = buildAssistant;
    C.buildToolCard = buildToolCard;
    C.buildAskCard = buildAskCard;
    C.buildEmptyState = buildEmptyState;
})(window.Taby);
