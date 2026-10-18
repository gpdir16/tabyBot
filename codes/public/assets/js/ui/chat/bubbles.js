/* tabyBot 웹 클라이언트: 메시지·도구·질문 카드 같은 말풍선 조각 만들기. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const thread = document.getElementById("thread");
    // askId → { answer, error, resolved }: 서버 정본이 다시 그려지기 전까지 이력 카드에 보여 줄 값.
    C.askOverlay ??= new Map();

    // 질문이 답 없이 끝난 이유. 서버 도구 결과의 error 값을 번역 키로 바꾼다.
    function askErrorKey(error) {
        if (error === "timeout") return "askExpired";
        if (error === "user_sent_message" || error === "aborted" || error === "superseded") return "askUnanswered";
        return "";
    }

    /* ── 빌더 ───────────────────────────────────────────────── */
    // 한 줄이면 pill, 두 줄 이상(또는 블록 요소)이면 radius-l
    function isTallBubble(el) {
        const cs = getComputedStyle(el);
        let line = parseFloat(cs.lineHeight);
        if (!Number.isFinite(line)) line = (parseFloat(cs.fontSize) || 15) * 1.5;
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const inner = el.clientHeight - pad;
        const block = el.querySelector("img, pre, table, ul, ol, h1, h2, h3, h4, blockquote, .thumb, .stats-footer, .codeblock");
        return !!block || inner > line + 2;
    }

    // 모두 잰 뒤에 한꺼번에 바꿈. 재고 바꾸기를 버블마다 번갈아 하면 매번 레이아웃을 새로 계산해
    // 긴 대화에서는 버블 수의 제곱만큼 느려짐(아이폰에서 화면이 멈춤).
    function fitBubbles(els) {
        const list = els.filter(Boolean);
        const tall = list.map(isTallBubble);
        list.forEach((el, i) => {
            if (el.classList.contains("tall") !== tall[i]) el.classList.toggle("tall", tall[i]);
        });
    }

    function fitBubbleRadius(el) {
        fitBubbles([el]);
    }

    function fitBubblesIn(root) {
        fitBubbles([...(root || thread).querySelectorAll(".bubble")]);
    }

    C.bubbleRo = null;

    // 처음 크기도 ResizeObserver가 레이아웃 직후(그리기 전)에 한꺼번에 알려 줌. 여기서 바로 재지 않음.
    function watchBubble(el) {
        if (!el) return;
        if (!window.ResizeObserver) {
            fitBubbleRadius(el);
            return;
        }
        if (!C.bubbleRo) {
            C.bubbleRo = new ResizeObserver((entries) => {
                fitBubbles(entries.map((entry) => entry.target));
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

    /* ── 실제 파일 경로 링크 ───────────────────────────────────
       에이전트가 인라인 코드로 적은 경로 중 실제로 존재하는 것만 눌러서 컴퓨터 파일 탭으로 연다.
       존재 여부는 서버에 한 번 모아 묻고, 결과를 캐시해 다시 그려도 요청을 반복하지 않는다. */
    C.filePathCache ??= new Map(); // path → true(존재) | 확인 시각(없음, 30초 뒤 재확인)
    const FILE_PATH_MISS_TTL_MS = 30_000;

    function pathCandidate(text) {
        const s = String(text || "").trim();
        if (!s || s.length > 512 || s.includes("\n") || s.includes("://") || s.startsWith("#")) return null;
        if (s.includes("{{") || /^\d+(?:\.\d+)+$/.test(s)) return null;
        const absolute = /^(?:~\/|\/|\.{1,2}\/)/.test(s);
        const relative = /^[^\s/]+\/[^\s]*$/.test(s) && !/[<>{}$`*?"|]/.test(s);
        const bare = /^[^\s/]+\.[A-Za-z0-9]{1,16}$/.test(s);
        return absolute || relative || bare ? s : null;
    }

    // 본문에 그냥 적힌 절대 경로("/…", "~/…")도 찾는다. 상대 경로와 파일 이름은 인라인 코드일 때만 본다.
    const ABS_PATH_RE = /(?:~\/|\/)[^\s<>"'`]+/g;

    function plainPathNodes(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const p = node.parentElement;
                if (!p || p.closest("code, a, pre, script, style, .file-path-link")) return NodeFilter.FILTER_REJECT;
                return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return nodes;
    }

    function cleanPlainPath(text) {
        return String(text || "").replace(/[.,;:!?)\]}]+$/, "");
    }

    function collectPlainPaths(root, pending) {
        for (const node of plainPathNodes(root)) {
            const text = node.nodeValue;
            ABS_PATH_RE.lastIndex = 0;
            let m = ABS_PATH_RE.exec(text);
            while (m) {
                const path = cleanPlainPath(m[0]);
                if (!path || path.length > 512) {
                    m = ABS_PATH_RE.exec(text);
                    continue;
                }
                const before = text[m.index - 1] || "";
                if (before === ":" || before === "/") {
                    m = ABS_PATH_RE.exec(text);
                    continue; // URL 조각은 건드리지 않는다
                }
                const cached = C.filePathCache.get(path);
                if (cached !== true && (cached == null || Date.now() - cached > FILE_PATH_MISS_TTL_MS)) pending.add(path);
                m = ABS_PATH_RE.exec(text);
            }
        }
    }

    // 존재가 확인된 절대 경로만 링크로 감싼다. 코드/링크 안의 글자는 건드리지 않는다.
    function wrapPlainPaths(root) {
        for (const node of plainPathNodes(root)) {
            const text = node.nodeValue;
            let last = 0;
            let frag = null;
            ABS_PATH_RE.lastIndex = 0;
            let m = ABS_PATH_RE.exec(text);
            while (m) {
                const path = cleanPlainPath(m[0]);
                const before = text[m.index - 1] || "";
                if (!path || path.length > 512 || C.filePathCache.get(path) !== true || before === ":" || before === "/") {
                    m = ABS_PATH_RE.exec(text);
                    continue;
                }
                frag ??= document.createDocumentFragment();
                if (m.index > last) frag.append(text.slice(last, m.index));
                const span = T.h("span", { text: path });
                markFilePath(span, path);
                frag.append(span);
                last = m.index + path.length;
                m = ABS_PATH_RE.exec(text);
            }
            if (!frag) continue;
            frag.append(text.slice(last));
            node.replaceWith(frag);
        }
    }

    function markFilePath(el, path) {
        if (el.classList.contains("file-path-link")) return;
        el.classList.add("file-path-link");
        el.setAttribute("role", "link");
        el.tabIndex = 0;
        el.title = t("openInComputer");
        const open = (e) => {
            e.preventDefault();
            e.stopPropagation();
            T.computerUI?.openFile?.(path);
        };
        el.addEventListener("click", open);
        el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") open(e);
        });
    }

    function enhanceFileLinks(root) {
        if (!root) return;
        const els = [...root.querySelectorAll("code:not([data-file-link])")].filter((el) => !el.closest("pre"));
        const pending = new Set();
        for (const el of els) {
            const path = pathCandidate(el.textContent);
            if (!path) continue;
            el.dataset.fileLink = path;
            const cached = C.filePathCache.get(path);
            if (cached === true) markFilePath(el, path);
            else if (cached == null || Date.now() - cached > FILE_PATH_MISS_TTL_MS) pending.add(path);
        }
        collectPlainPaths(root, pending);
        wrapPlainPaths(root);
        if (!pending.size) return;
        void T.api
            .resolveContainerPaths([...pending])
            .then((r) => {
                for (const item of r?.results || []) C.filePathCache.set(item.path, item.exists === true ? true : Date.now());
                for (const el of root.querySelectorAll("code[data-file-link]")) {
                    if (el.isConnected && C.filePathCache.get(el.dataset.fileLink) === true) markFilePath(el, el.dataset.fileLink);
                }
                wrapPlainPaths(root);
            })
            .catch(() => {
                /* 해석에 실패하면 링크 없이 둔다 */
            });
    }

    function buildAssistant(text, opt) {
        const o = opt || {};
        const bubble = T.h("div", { class: "bubble" });
        if (text) bubble.append(T.md.render(text));
        enhanceFileLinks(bubble);
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
            if (ask.answer.secretSaved === true) {
                text = t("secretSaved");
            } else if (ask.answer.choiceIndex != null && ask.options[ask.answer.choiceIndex] != null) {
                text = ask.options[ask.answer.choiceIndex];
            } else if (ask.answer.text != null) {
                text = ask.answer.text;
            }
        }
        if (text) card.append(T.h("div", { class: "ask-answer", text }));
    }

    function buildAskCard(original) {
        // 서버 정본에는 아직 답이 반영되지 않았을 수 있다. 방금 보낸 답을 우선 보여 준다.
        const overlay = original.askId ? C.askOverlay.get(original.askId) : null;
        const ask = overlay ? { ...original, ...overlay } : original;
        const card = T.h("div", { class: "ask-card", dataset: { askId: ask.askId, expires: ask.expiresAt || "" } });
        const q = T.h("div", { class: "ask-q" });
        if (ask.secret) {
            // 시크릿 이름은 라벨이므로 마크다운으로 해석하지 않는다.
            q.textContent = ask.question;
        } else {
            q.append(T.md.render(ask.question, { extraClass: "ask-md" }));
            enhanceFileLinks(q);
        }
        card.append(q);

        const done = () => ask.answer != null || ask.resolved || !!ask.error;

        // askId가 없는 예전 기록은 서버에 답할 대상이 없으므로 입력칸 없이 상태만 남긴다.
        if (!done() && ask.askId) {
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
                type: ask.secret ? "password" : "text",
                autocomplete: ask.secret ? "new-password" : "off",
                spellcheck: ask.secret ? "false" : null,
                placeholder: ask.secret ? t("secretAskPlaceholder") : t("askInputPlaceholder"),
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
            if (ask.secret) card.append(T.h("div", { class: "ask-hint", text: t("secretAskHint") }));
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
        card._ask = ask; // 라이브 상태가 없어도(새로고침) 남은 시간을 계속 갱신한다.

        async function answer(body) {
            if (done()) return;
            // 시크릿 값은 요청 본문에만 싣고 화면 상태에는 마스크만 남긴다.
            const optimistic = ask.secret ? { text: "••••••••" } : body;
            const liveAsk = state.currentConv()?.live?.asks.find((a) => a.askId === ask.askId);
            if (liveAsk) {
                liveAsk.answer = optimistic;
                liveAsk.resolved = true;
            }
            C.askOverlay.set(ask.askId, { resolved: true, answer: optimistic });
            C.requestSync();
            // 라이브 카드/이력 카드 모두 입력칸을 즉시 답변 상태로 바꾼다.
            card.replaceWith(buildAskCard(original));
            try {
                await T.api.answerAsk(ask.askId, body);
            } catch (err) {
                // 롤백: 입력칸이 돌아오고 서버 정본과 다시 맞춘다.
                C.askOverlay.delete(ask.askId);
                if (liveAsk) {
                    liveAsk.answer = null;
                    liveAsk.resolved = false;
                }
                C.requestSync();
                document.querySelector(`.ask-card[data-ask-id="${ask.askId}"]`)?.replaceWith(buildAskCard(original));
                // 시크릿 값이 금고 규칙에 안 맞으면 사유를 알려 다시 입력하게 한다.
                const secretKey = {
                    value_too_long: "secretValueTooLong",
                    invalid_value: "secretInvalidValue",
                }[err?.payload?.error || ""];
                T.toast.show("error", secretKey ? t(secretKey) : T.api.errorText(err, t("errorPrefix")));
            }
        }
        function sendText() {
            // 시크릿은 공백도 값의 일부일 수 있어 다듬지 않는다.
            const raw = card._input?.value || "";
            const v = ask.secret ? raw : raw.trim();
            if (v) answer({ text: v });
        }

        tickAsk(card, ask, status, time);
        return card;
    }

    // 남은 시간/만료 갱신(전역 티커가 매초 호출)
    function tickAsk(card, ask, status, time) {
        // 끝난 질문은 만료 시각이 없어도(예전 기록) 상태를 보여 준다.
        if (ask.resolved || ask.answer != null || ask.error) {
            time.textContent = "";
            const errorKey = askErrorKey(ask.error);
            status.textContent = errorKey ? t(errorKey) : t("answered");
            return;
        }
        if (!ask.askId) {
            time.textContent = "";
            status.textContent = t("askUnanswered");
            return;
        }
        const exp = Date.parse(card.dataset.expires || "");
        if (Number.isNaN(exp)) {
            time.textContent = "";
            status.textContent = "";
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
            const ask = c?.live?.asks.find((a) => a.askId === id) || card._ask;
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
    C.enhanceFileLinks = enhanceFileLinks;
})(window.Taby);
