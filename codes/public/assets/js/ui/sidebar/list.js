/* tabyBot 웹 클라이언트: 사이드바 목록(미리보기·검색·행·렌더·연결 상태 점). */
((T) => {
    "use strict";

    T.sidebarCtx ??= {};
    const C = T.sidebarCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const listEl = document.getElementById("botList");
    const connDot = document.getElementById("connDot");
    const mobileConnDot = document.getElementById("mobileConnDot");
    const settingsBtn = document.getElementById("btnSettings");

    // 서버 색상은 UI 팔레트 해시 값이므로 CSS 주입을 막기 위해 형식을 강제한다.

    function initials(name) {
        return ([...String(name || "?").trim()][0] || "?").toUpperCase();
    }

    function snippet(text) {
        const strip = T.md?.stripPreview;
        const out = strip
            ? strip(text)
            : String(text || "")
                  .replace(/\s+/g, " ")
                  .trim();
        return out;
    }

    function previewFromTurns(turns) {
        for (let i = (turns || []).length - 1; i >= 0; i--) {
            const messages = turns[i]?.messages || [];
            for (let j = messages.length - 1; j >= 0; j--) {
                const m = messages[j];
                if (m?.role !== "user" && m?.role !== "assistant") continue;
                const text = snippet(m.content);
                if (text) return text;
            }
        }
        return "";
    }

    // 마지막 발화를 보여 주고, 없으면 "아직 맡은 일이 없어요"로 미리보기 줄을 채운다.
    // 다음 순서로 먼저 있는 것을 쓴다: 확인 전 낙관 메시지, 실행 중 발화(중간 say/스트리밍),
    // 서버 메타, 봇 목록 스냅샷, 캐시된 턴.
    function previewOf(bot) {
        const c = state.conv(bot.uuid);
        const pending = c?.pending || [];
        for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i]?.confirmed) continue;
            const text = snippet(pending[i]?.text);
            if (text) return text;
        }
        const live = c?.live;
        const inter = live?.intermediate || [];
        for (let i = inter.length - 1; i >= 0; i--) {
            const text = snippet(inter[i]);
            if (text) return text;
        }
        // 자동 실행의 스트리밍 본문은 침묵으로 끝날 수 있어 답이 확정되기 전에는 미리보기로 쓰지 않는다.
        const liveText = live?.automated ? "" : snippet(live?.text);
        if (liveText) return liveText;
        const fromMeta = snippet(c?.meta?.preview);
        if (fromMeta) return fromMeta;
        const fromBot = snippet(bot.preview);
        if (fromBot) return fromBot;
        const fromTurns = previewFromTurns(c?.turns);
        if (fromTurns) return fromTurns;
        return "";
    }

    // 클릭하지 않아도 미리보기가 보이도록, 비어 있는 스레드만 기록을 받아 채운다.
    // 받은 턴은 대화 캐시에 그대로 남아(previewOf가 읽는다) 열 때 다시 받지 않는다.
    // 기록이 정말 비어 있는 봇을 이벤트마다 다시 조회하지 않게 한 번만 시도한다.
    const hydrated = new Set();

    function hydratePreviews() {
        if (state.state.offline) return Promise.resolve();
        const jobs = [];
        for (const bot of state.state.bots) {
            const id = bot.uuid;
            if (!id || hydrated.has(id) || previewOf(bot)) continue;
            // 이미 받았거나 지금 열려 있는(chat.open이 받는 중인) 대화는 다시 받지 않는다.
            if (id === state.state.currentId || state.conv(id).fetchedAt) continue;
            hydrated.add(id);
            jobs.push(
                state
                    .refreshTurns(id)
                    .then(() => render())
                    .catch(() => hydrated.delete(id)),
            );
        }
        return Promise.all(jobs);
    }

    // 안 읽은 에이전트 발화 수. 지금 보고 있는 대화는 읽은 것으로 친다(읽음 처리가 곧 따라온다).
    function unreadOf(bot) {
        if (T.chat?.isViewing?.(bot.uuid)) return 0;
        return Number(state.state.convs.get(bot.uuid)?.meta?.unread) || 0;
    }

    // 목록 행의 시각: 메신저처럼 오늘이면 시:분, 엿새 안이면 요일, 그보다 오래되면 날짜만 쓴다.
    function locale() {
        const lang = T.i18n.getLang();
        return lang === "ko" ? "ko-KR" : lang === "ja" ? "ja-JP" : "en-US";
    }

    // weekday=false: 검색 결과처럼 같은 주의 항목이 여러 줄 나오는 곳. 요일 대신 날짜를 써서 구별되게 한다.
    function listTime(at, weekday = true) {
        const ms = Date.parse(at || "");
        if (!Number.isFinite(ms)) return "";
        const d = new Date(ms);
        const now = new Date();
        const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
        try {
            if (days <= 0) return new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(d);
            if (weekday && days < 7) return new Intl.DateTimeFormat(locale(), { weekday: "short" }).format(d);
            const sameYear = d.getFullYear() === now.getFullYear();
            return new Intl.DateTimeFormat(
                locale(),
                sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" },
            ).format(d);
        } catch {
            return "";
        }
    }

    C.query = "";

    // 서버 메시지 전문 검색 결과 (검색어가 있을 때만 요청).
    C.msgResults = null;

    let msgSeq = 0;

    let msgTimer = null;

    function scheduleMsgSearch() {
        clearTimeout(msgTimer);
        if (!C.query || state.state.offline) {
            C.msgResults = null;
            return;
        }
        const seq = ++msgSeq;
        msgTimer = setTimeout(async () => {
            try {
                const r = await T.api.searchMessages(C.query);
                if (seq !== msgSeq) return;
                C.msgResults = r?.results || [];
                render();
            } catch {
                // 검색에 실패하면 이전 결과를 유지한다
            }
        }, 300);
    }

    function matches(bot) {
        if (!C.query) return true;
        const q = C.query.toLowerCase();
        return (
            String(bot.name || "")
                .toLowerCase()
                .includes(q) ||
            String(bot.persona || "")
                .toLowerCase()
                .includes(q) ||
            String(previewOf(bot) || "")
                .toLowerCase()
                .includes(q)
        );
    }

    // 검색 히트 행: 에이전트 아바타 + 이름/시각 + 매치 스니펫
    function hitSnippetEl(hit) {
        const el = T.h("span", { class: "bot-persona sb-hit-snippet" });
        const s = String(hit.snippet || "");
        const i = s.toLowerCase().indexOf(C.query.toLowerCase());
        if (i === -1) {
            el.textContent = s;
        } else {
            el.append(
                document.createTextNode(s.slice(0, i)),
                T.h("mark", { text: s.slice(i, i + C.query.length) }),
                document.createTextNode(s.slice(i + C.query.length)),
            );
        }
        return el;
    }

    function buildHitRow(hit) {
        const bot = state.botByUuid(hit.conversationId);
        const row = T.h("div", { class: "bot-row", role: "button", tabindex: "0" }, [
            T.h("span", { class: "bot-avatar", text: initials(bot?.name || "?"), style: `background-color:${T.util.safeColor(bot?.color)}` }),
            T.h("span", { class: "bot-meta" }, [
                T.h("span", { class: "bot-line" }, [
                    T.h("span", { class: "bot-name" }, [T.h("span", { class: "bot-name-text", text: bot?.name || "" })]),
                    T.h("span", { class: "bot-time", text: listTime(hit.at, false) }),
                ]),
                T.h("span", { class: "bot-line" }, [hitSnippetEl(hit)]),
            ]),
        ]);
        const go = () => {
            void T.chat.openMessageTarget?.(hit.conversationId, hit.turnIndex, hit.messageIndex);
            if (C.isMobile()) C.setMobileChat(true);
        };
        row.addEventListener("click", go);
        row.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                go();
            }
        });
        return row;
    }

    // 봇 행: 아바타 + (이름 · 시각) + (대화 미리보기 · 안읽음 배지)
    function buildRow(bot) {
        const live = state.conv(bot.uuid)?.live;
        const preview = previewOf(bot);
        const unread = unreadOf(bot);
        const empty = !preview;
        const previewText = empty ? t("botNoJob") : preview;
        const time = empty ? "" : listTime(recencyOf(bot));
        const row = T.h(
            "div",
            {
                class: `bot-row${state.state.currentId === bot.uuid && !T.settingsUI.isOpen() && !T.todosUI?.isOpen?.() ? " active" : ""}`,
                "aria-current": state.state.currentId === bot.uuid && !T.settingsUI.isOpen() && !T.todosUI?.isOpen?.() ? "true" : null,
                role: "button",
                "aria-label": `${bot.name}. ${T.md.previewPlain(previewText)}`.trim(),
                tabindex: "0",
            },
            [
                T.h("span", { class: "bot-avatar", text: initials(bot.name), style: `background-color:${T.util.safeColor(bot.color)}` }),
                T.h("span", { class: "bot-meta" }, [
                    T.h("span", { class: "bot-line" }, [
                        T.h("span", { class: "bot-name" }, [
                            T.h("span", { class: "bot-name-text", text: bot.name }),
                            live ? T.h("span", { class: "live-dot", role: "status", "aria-label": T.i18n.t("runningState") }) : null,
                        ]),
                        time ? T.h("span", { class: "bot-time", text: time }) : null,
                    ]),
                    T.h("span", { class: "bot-line" }, [
                        T.h("span", { class: `bot-persona${live ? " is-live" : ""}` }, T.md.previewNodes(previewText)),
                        unread
                            ? T.h("span", {
                                  class: "bot-unread",
                                  text: unread > 99 ? "99+" : String(unread),
                                  "aria-label": t("unreadCount", { n: unread }),
                              })
                            : null,
                    ]),
                ]),
            ],
        );
        // 우클릭/길게 누르기 메뉴: 메신저처럼 행에 따로 ⋯ 버튼을 두지 않는다.
        T.ctxmenu.attach(row, () => botMenuItems(bot));
        row.addEventListener("click", () => C.openBot(bot));
        row.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                C.openBot(bot);
            }
        });
        return row;
    }

    /* ── 컨텍스트 메뉴 항목 ─────────────────────────────────
       우클릭과 길게 누르기가 같은 항목을 쓴다. 각 엘리먼트에 T.ctxmenu.attach로 붙인다. */
    function botMenuItems(bot) {
        const newFolder = () => T.settingsUI.open({ tab: "folders", folderNew: true, folderAgent: bot.id });
        const folders = state.state.folders || [];
        return [
            // 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링된다.
            { label: t("botSettings"), icon: "settings", defer: true, onSelect: () => C.settingsPush(bot.id) },
            folders.length
                ? { label: t("folderAdd"), icon: "folder", children: () => folderPickItems(bot, newFolder) }
                : // 폴더가 하나도 없으면 고를 것이 없다. 곧장 만들기 폼으로 간다.
                  { label: t("folderAdd"), icon: "folder", defer: true, onSelect: newFolder },
        ];
    }

    // "폴더에 추가…" 하위 메뉴: 지금 들어 있는 폴더에는 체크가 붙고, 다시 누르면 폴더에서 뺀다.
    // 맨 아래 "새 폴더"는 설정의 폴더 탭에 있는 만들기 폼을 이 에이전트를 미리 고른 채로 연다.
    function folderPickItems(bot, newFolder) {
        const current = C.folderOf(bot);
        return [
            ...(state.state.folders || []).map((f) => ({
                label: f.name,
                checked: f.id === current,
                onSelect: () => void C.assignAgentFolder(bot.id, f.id === current ? "" : f.id),
            })),
            { sep: true },
            { label: t("folderNew"), icon: "plus", defer: true, onSelect: newFolder },
        ];
    }

    // 폴더 탭: 설정의 폴더 탭으로 보낸다. "전체" 탭은 폴더 목록을, 폴더 탭은 그 폴더의 편집 폼을 연다.
    function tabMenuItems(folderId) {
        return [
            {
                label: t(folderId ? "folderEdit" : "folderManage"),
                icon: "settings",
                defer: true,
                onSelect: () => T.settingsUI.open({ tab: "folders", folderId: folderId || null }),
            },
        ];
    }

    function todosPreview() {
        const open = (state.state.todos || []).filter((row) => row.status === "open" && !row.periodDone && (row.list || "user") === "user");
        const n = (state.state.todoSuggestions || []).length;
        if (n) return t("todosInbox", { n });
        if (!open.length) return t("todosNone");
        if (open.length === 1) return open[0].title;
        return t("todosCount", { n: open.length });
    }

    function todosVisible() {
        if (!C.query) return true;
        const q = C.query.toLowerCase();
        const hay = `${t("todos")} todos ${todosPreview()}`.toLowerCase();
        return hay.includes(q);
    }

    function openTodos() {
        try {
            if (T.settingsUI.isOpen()) T.settingsUI.hide();
            if (!/^\/t\/?$/.test(location.pathname)) history.pushState(null, "", "/t");
        } catch {
            // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
        }
        if (C.isMobile()) C.setMobileChat(true);
        T.app?.renderRoute();
    }

    function buildTodosRow() {
        const preview = todosPreview();
        const active = T.todosUI?.isOpen?.();
        const pending = (state.state.todoSuggestions || []).length;
        const row = T.h(
            "div",
            {
                class: `bot-row${active ? " active" : ""}`,
                "aria-current": active ? "page" : null,
                role: "button",
                "aria-label": `${t("todos")}. ${preview}`,
                tabindex: "0",
            },
            [
                T.h("span", { class: "bot-avatar todo-avatar" }, [T.icon("list", "icon-sm")]),
                T.h("span", { class: "bot-meta" }, [
                    T.h("span", { class: "bot-line" }, [
                        T.h("span", { class: "bot-name" }, [
                            T.h("span", { class: "bot-name-text", text: t("todos") }),
                            pending ? T.h("span", { class: "attn-dot", "aria-hidden": "true" }) : null,
                        ]),
                    ]),
                    T.h("span", { class: "bot-line" }, [T.h("span", { class: "bot-persona", text: preview })]),
                ]),
            ],
        );
        // 할 일 행에는 따로 할 동작이 없지만, 목록의 다른 행과 똑같이 눌리고 떠오르게 한다.
        T.ctxmenu.attach(row, () => [{ label: t("open"), icon: "list", defer: true, onSelect: openTodos }]);
        row.addEventListener("click", openTodos);
        row.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                openTodos();
            }
        });
        return row;
    }

    // 목록 정렬 키: 대화 메타의 updatedAt. 기록이 없는 봇은 빈 문자열로 뒤에 둔다.
    function recencyOf(bot) {
        return state.state.convs.get(bot.uuid)?.meta?.updatedAt || "";
    }

    /* ── 연결 상태 점: 끊겼을 때만 설정 옆에 빨간 점 ───────── */
    function renderConn() {
        // 연결 중에는 끊김으로 표시하지 않는다. 실제 연결이 끊긴 상태만 경고한다.
        const lost = state.state.conn === "disconnected" && !state.state.offline;
        const label = t("connectionLost");
        for (const dot of [connDot, mobileConnDot]) {
            dot.hidden = !lost;
            dot.setAttribute("aria-hidden", "true");
            if (lost) dot.setAttribute("title", label);
            else dot.removeAttribute("title");
        }
        settingsBtn.setAttribute("aria-label", lost ? `${t("settings")}, ${label}` : t("settings"));
    }

    // 라우트에 맞춰 선택 표시를 동기화한다: /s/면 설정 행이, /a/면 해당 봇 행이 '선택'된다.
    function syncRoute() {
        const on = T.settingsUI.isOpen();
        settingsBtn.classList.toggle("active", on);
        settingsBtn.setAttribute("aria-current", on ? "page" : null);
        render();
    }

    /* ── 렌더 ───────────────────────────────────────────────── */
    // 한 폴더("": 전체)의 목록 행들. 폴더를 미는 동안 옆 폴더를 미리 그릴 때도 쓴다.
    function listRows(active) {
        const rows = [];
        // 최근 메시지 순: 안정 정렬이라 updatedAt이 없는 봇끼리는 에이전트 순서를 유지한다.
        const bots = state.state.bots.filter(matches);
        bots.sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)));
        const shown = active ? bots.filter((b) => C.folderOf(b) === active) : C.allExcludesFoldered() ? bots.filter((b) => !C.folderOf(b)) : bots;
        for (const bot of shown) rows.push(buildRow(bot));
        if ((!active || C.query) && todosVisible()) rows.push(buildTodosRow());
        if (C.query && C.msgResults?.length) {
            rows.push(T.h("div", { class: "sb-sec", text: t("searchMsgs") }));
            for (const hit of C.msgResults) rows.push(buildHitRow(hit));
        }
        if (!rows.length) rows.push(T.h("div", { class: "sb-empty", text: t("noBots") }));
        return rows;
    }

    // 폴더 탭이 활성이면 그 폴더 소속만 보여 준다. 검색 중에는 폴더와 무관하게 전체 결과를 보여 준다.
    // 손가락이 목록에 닿아 있는 동안에는 미뤘다가 떼면 그린다: 행을 갈아 끼우면 터치가 시작된 행이
    // 떨어져 나가 이후의 움직임이 전달되지 않는다(폴더 넘기기·당겨서 검색·길게 누르기가 그 자리에서 멈춘다).
    C.listTouching = false;

    C.renderPending = false;

    function render(force) {
        if (!listEl) return;
        if (C.listTouching && !force) {
            C.renderPending = true;
            return;
        }
        C.renderPending = false;
        C.renderTabs();
        listEl.replaceChildren(...listRows(C.query ? "" : C.activeFolderId()));
    }

    C.hydratePreviews = hydratePreviews;
    C.unreadOf = unreadOf;
    C.scheduleMsgSearch = scheduleMsgSearch;
    C.tabMenuItems = tabMenuItems;
    C.renderConn = renderConn;
    C.syncRoute = syncRoute;
    C.listRows = listRows;
    C.render = render;
})(window.Taby);
