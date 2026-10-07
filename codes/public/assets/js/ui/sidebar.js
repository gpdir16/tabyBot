/* tabyBot 웹 클라이언트: 사이드바(봇 라스터).
   메신저 패러다임: 대화 상대는 봇이다. 각 행은 하나의 봇(동료)이고,
   클릭하면 그 봇과의 끊기지 않는 스레드가 열린다. 검색은 봇 필터,
   리사이즈/축소를 지원한다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    const listEl = document.getElementById("botList");
    const tabsEl = document.getElementById("folderTabs");
    const searchEl = document.getElementById("searchInput");
    const connDot = document.getElementById("connDot");
    const mobileConnDot = document.getElementById("mobileConnDot");
    const addBtn = document.getElementById("btnAddBot");
    const settingsBtn = document.getElementById("btnSettings");
    const collapseBtn = document.getElementById("btnCollapse");
    const resizeEl = document.getElementById("sbResize");
    const sidebarEl = document.getElementById("sidebar");
    const mainEl = document.getElementById("main");
    const menuBtn = document.getElementById("btnMenu");
    const sbScrim = document.getElementById("sbScrim");
    const mobileMq = window.matchMedia("(max-width: 860px)");

    let query = "";
    // 서버 메시지 전문 검색 결과 (검색어가 있을 때만 요청).
    let msgResults = null;
    let msgSeq = 0;
    let msgTimer = null;

    function scheduleMsgSearch() {
        clearTimeout(msgTimer);
        if (!query || state.state.offline) {
            msgResults = null;
            return;
        }
        const seq = ++msgSeq;
        msgTimer = setTimeout(async () => {
            try {
                const r = await T.api.searchMessages(query);
                if (seq !== msgSeq) return;
                msgResults = r?.results || [];
                render();
            } catch (_) {}
        }, 300);
    }

    // 서버 색상은 UI 팔레트 해시 값이므로 CSS 주입을 막기 위해 형식을 강제한다.
    function safeColor(value) {
        return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : "var(--accent)";
    }

    function initials(name) {
        return ([...String(name || "?").trim()][0] || "?").toUpperCase();
    }

    function matches(bot) {
        if (!query) return true;
        const q = query.toLowerCase();
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

    function snippet(text) {
        const strip = T.md && T.md.stripPreview;
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
        const liveText = snippet(live?.text);
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
                class: "bot-row" + (state.state.currentId === bot.uuid && !T.settingsUI.isOpen() && !T.todosUI?.isOpen?.() ? " active" : ""),
                "aria-current": state.state.currentId === bot.uuid && !T.settingsUI.isOpen() && !T.todosUI?.isOpen?.() ? "true" : null,
                role: "button",
                "aria-label": `${bot.name}. ${T.md.previewPlain(previewText)}`.trim(),
                tabindex: "0",
            },
            [
                T.h("span", { class: "bot-avatar", text: initials(bot.name), style: `background-color:${safeColor(bot.color)}` }),
                T.h("span", { class: "bot-meta" }, [
                    T.h("span", { class: "bot-line" }, [
                        T.h("span", { class: "bot-name" }, [
                            T.h("span", { class: "bot-name-text", text: bot.name }),
                            live ? T.h("span", { class: "live-dot", role: "status", "aria-label": T.i18n.t("runningState") }) : null,
                        ]),
                        time ? T.h("span", { class: "bot-time", text: time }) : null,
                    ]),
                    T.h("span", { class: "bot-line" }, [
                        T.h("span", { class: "bot-persona" + (live ? " is-live" : "") }, T.md.previewNodes(previewText)),
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
        row.addEventListener("click", () => openBot(bot));
        row.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                openBot(bot);
            }
        });
        return row;
    }

    function isMobile() {
        return mobileMq.matches;
    }

    function setIcon(button, name) {
        button?.querySelector("use")?.setAttribute("href", `#i-${name}`);
    }

    function syncMobileNavigation() {
        const chatOpen = isMobile() && document.body.classList.contains("mobile-chat");
        setIcon(collapseBtn, isMobile() ? "settings" : "chevron");
        collapseBtn.setAttribute("data-tip", isMobile() ? t("settings") : t(collapsedState ? "expand" : "collapse"));
        collapseBtn.setAttribute("aria-label", isMobile() ? t("settings") : t(collapsedState ? "expand" : "collapse"));
        if (isMobile()) collapseBtn.setAttribute("aria-expanded", "false");
        if (!menuBtn) return;
        if (!isMobile()) {
            setIcon(menuBtn, "menu");
            return;
        }
        setIcon(menuBtn, chatOpen ? "chevron-left" : "menu");
        menuBtn.setAttribute("data-tip", t(chatOpen ? "back" : "menu"));
        menuBtn.setAttribute("aria-label", t(chatOpen ? "back" : "menu"));
        menuBtn.setAttribute("aria-expanded", "false");
    }

    function setMobileChat(open, options) {
        if (!isMobile()) return;
        const chatOpen = !!open;
        const instant = options?.animate === false;
        const activeInHiddenPanel = chatOpen ? sidebarEl.contains(document.activeElement) : mainEl?.contains(document.activeElement);
        document.body.classList.toggle("mobile-route-sync", instant);
        document.body.classList.toggle("mobile-chat", chatOpen);
        sidebarEl.setAttribute("aria-hidden", String(chatOpen));
        mainEl?.setAttribute("aria-hidden", String(!chatOpen));
        setMobileOpen(false);
        syncMobileNavigation();
        if (activeInHiddenPanel) {
            // 목록으로 돌아올 때는 포커스를 풀기만 한다. 검색란에 포커스를 주면 접혀 있던 검색 바가 열린다.
            requestAnimationFrame(() => (chatOpen ? menuBtn?.focus({ preventScroll: true }) : document.activeElement?.blur?.()));
        }
        if (instant) requestAnimationFrame(() => document.body.classList.remove("mobile-route-sync"));
    }

    function showMobileList() {
        if (!isMobile()) return;
        setMobileChat(false);
        if (/^(\/a\/|\/s(?:\/|$)|\/t(?:\/|$))/.test(location.pathname)) history.replaceState(null, "", "/" + location.search + location.hash);
        T.app?.renderRoute();
    }

    function setMobileChatFromRoute() {
        if (isMobile()) setMobileChat(/^(\/a\/|\/s(?:\/|$)|\/c\/|\/t(?:\/|$))/.test(location.pathname), { animate: false });
    }

    function setMobileOpen(open) {
        if (open) applyCollapsed(false);
        sidebarEl.classList.toggle("mobile-open", !!open);
        if (sbScrim) sbScrim.classList.toggle("open", !!open);
        document.body.classList.toggle("sb-open", !!open);
        if (menuBtn) menuBtn.setAttribute("aria-expanded", String(!!open));
        if (T.tooltip) T.tooltip.hide();
    }

    function openBot(bot) {
        try {
            if (T.settingsUI.isOpen()) T.settingsUI.hide();
            if (T.todosUI?.isOpen?.()) T.todosUI.hide();
            history.pushState(null, "", `/a/${encodeURIComponent(bot.uuid)}`);
        } catch (_) {}
        if (isMobile()) setMobileChat(true);
        T.app?.renderRoute();
    }

    // 설정 페이지 내비게이션: 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링한다.
    function settingsPush(agentId) {
        const path = agentId == null ? "/s/general" : agentId === "__new__" ? "/s/agents/new" : `/s/agents/${agentId}`;
        history.pushState(null, "", path);
        T.app?.renderRoute();
    }

    /* ── 컨텍스트 메뉴 항목 ─────────────────────────────────
       우클릭과 길게 누르기가 같은 항목을 쓴다. 각 엘리먼트에 T.ctxmenu.attach로 붙인다. */
    function botMenuItems(bot) {
        const newFolder = () => T.settingsUI.open({ tab: "folders", folderNew: true, folderAgent: bot.id });
        const folders = state.state.folders || [];
        return [
            // 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링된다.
            { label: t("botSettings"), icon: "settings", defer: true, onSelect: () => settingsPush(bot.id) },
            folders.length
                ? { label: t("folderAdd"), icon: "folder", children: () => folderPickItems(bot, newFolder) }
                : // 폴더가 하나도 없으면 고를 것이 없다. 곧장 만들기 폼으로 간다.
                  { label: t("folderAdd"), icon: "folder", defer: true, onSelect: newFolder },
        ];
    }

    // "폴더에 추가…" 하위 메뉴: 지금 들어 있는 폴더에는 체크가 붙고, 다시 누르면 폴더에서 뺀다.
    // 맨 아래 "새 폴더"는 설정의 폴더 탭에 있는 만들기 폼을 이 에이전트를 미리 고른 채로 연다.
    function folderPickItems(bot, newFolder) {
        const current = folderOf(bot);
        return [
            ...(state.state.folders || []).map((f) => ({
                label: f.name,
                checked: f.id === current,
                onSelect: () => void assignAgentFolder(bot.id, f.id === current ? "" : f.id),
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

    function todosPreview() {
        const open = (state.state.todos || []).filter((row) => row.status === "open" && !row.periodDone && (row.list || "user") === "user");
        const n = (state.state.todoSuggestions || []).length;
        if (n) return t("todosInbox", { n });
        if (!open.length) return t("todosNone");
        if (open.length === 1) return open[0].title;
        return t("todosCount", { n: open.length });
    }

    function todosVisible() {
        if (!query) return true;
        const q = query.toLowerCase();
        const hay = `${t("todos")} todos ${todosPreview()}`.toLowerCase();
        return hay.includes(q);
    }

    function openTodos() {
        try {
            if (T.settingsUI.isOpen()) T.settingsUI.hide();
            if (!/^\/t\/?$/.test(location.pathname)) history.pushState(null, "", "/t");
        } catch (_) {}
        if (isMobile()) setMobileChat(true);
        T.app?.renderRoute();
    }

    function buildTodosRow() {
        const preview = todosPreview();
        const active = T.todosUI?.isOpen?.();
        const pending = (state.state.todoSuggestions || []).length;
        const row = T.h(
            "div",
            {
                class: "bot-row" + (active ? " active" : ""),
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

    /* ── 에이전트 폴더 탭 ───────────────────────────
       메신저 폴더 패턴: 목록 위 가로 텍스트 탭으로 필터링한다. "전체" 탭은 고정.
       활성 탭 아래에 밑줄 표시가 미끄러져 따라간다. 탭은 보기 전환만 하고,
       폴더 만들기·이름·순서·소속은 설정의 폴더 탭에서 다룬다.
       활성 탭은 로컬 상태, 실제 데이터는 state.folders/bot.folder. */
    const ACTIVE_TAB_KEY = "tabybot.sidebar.folder.active";

    // 지워진 폴더를 가리키면 "전체"로 되돌린다. 저장값은 존재하는 폴더만 인정.
    function activeFolderId() {
        const id = lsGet(ACTIVE_TAB_KEY) || "";
        return id && (state.state.folders || []).some((f) => f.id === id) ? id : "";
    }
    // 폴더를 바꾼다. 탭 클릭·스와이프·가로 스크롤 모두 여기로 온다.
    // 새 목록이 넘어간 방향(오른쪽 탭이면 오른쪽)에서 미끄러져 들어온다.
    // slide=false: 손가락으로 밀어 넘길 때. 목록이 이미 손가락을 따라 들어왔으므로 애니메이션을 다시 틀지 않는다.
    function setActiveFolder(id, slide = true) {
        const order = ["", ...(state.state.folders || []).map((f) => f.id)];
        const dir = order.indexOf(id || "") - order.indexOf(activeFolderId());
        lsSet(ACTIVE_TAB_KEY, id || "");
        render(true);
        listEl.style.transition = "";
        listEl.style.transform = "";
        listEl.classList.remove("slide-next", "slide-prev");
        if (!dir || !slide) return;
        void listEl.offsetWidth;
        listEl.classList.add(dir > 0 ? "slide-next" : "slide-prev");
    }

    // 존재하는 폴더 id만 인정한다. 지워진 폴더를 가리키는 봇은 미분류로 본다.
    function folderOf(bot) {
        const f = String(bot?.folder || "");
        return f && (state.state.folders || []).some((x) => x.id === f) ? f : "";
    }

    // 설정: "전체" 탭에서 폴더 소속 에이전트를 숨긴다(미분류만 표시).
    function allExcludesFoldered() {
        return state.state.settings?.allTabExcludesFoldered === true;
    }

    async function assignAgentFolder(agentId, folderId) {
        try {
            const r = await T.api.updateAgent(agentId, { folder: folderId || "" });
            state.applyAgents(r);
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
        }
    }

    function buildTab(id, name) {
        const tab = T.h("div", { class: "sb-tab", role: "tab", tabindex: "0", title: name, dataset: { folder: id } }, [
            T.h("span", { class: "sb-tab-in" }, [
                T.h("span", { class: "sb-tab-name", text: name }),
                T.h("span", { class: "sb-tab-count", hidden: true }),
            ]),
        ]);
        T.ctxmenu.attach(tab, () => tabMenuItems(id));
        tab.addEventListener("click", () => setActiveFolder(id));
        tab.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                setActiveFolder(id);
            }
        });
        return tab;
    }

    // 밑줄 표시를 활성 탭의 글자 폭에 맞춰 옮긴다. animate=false면 전환 없이 바로 놓는다.
    const tabInd = T.h("span", { class: "sb-tab-ind", "aria-hidden": "true" });
    function placeTabIndicator(animate) {
        const tab = tabsEl.querySelector(".sb-tab.active");
        const inner = tab?.querySelector(".sb-tab-in");
        // 접힌 사이드바 등 레이아웃이 없을 때는 건드리지 않는다(ResizeObserver가 다시 부른다).
        if (!inner || !tab.offsetWidth) return;
        tabInd.classList.toggle("no-anim", !animate);
        tabInd.style.width = `${inner.offsetWidth}px`;
        // offsetLeft는 position:relative인 탭 바 기준이다.
        tabInd.style.transform = `translateX(${inner.offsetLeft}px)`;
        if (!animate) {
            void tabInd.offsetWidth; // 전환 없이 반영한 뒤 다음 이동부터 다시 애니메이션
            tabInd.classList.remove("no-anim");
        }
        // 활성 탭이 가로 스크롤 밖에 있으면 보이는 범위로 들인다.
        const left = tab.offsetLeft - 12;
        const right = tab.offsetLeft + tab.offsetWidth + 12;
        if (left < tabsEl.scrollLeft) tabsEl.scrollTo({ left, behavior: animate ? "smooth" : "auto" });
        else if (right > tabsEl.scrollLeft + tabsEl.clientWidth)
            tabsEl.scrollTo({ left: right - tabsEl.clientWidth, behavior: animate ? "smooth" : "auto" });
    }

    /* 폴더 전환 제스처: 목록을 좌우로 밀거나(터치) 가로로 스크롤하면(트랙패드/Shift+휠)
       옆 폴더로 넘어간다. 검색 중이거나 폴더가 없으면 동작하지 않는다. */
    // dir: +1 = 다음(오른쪽) 탭, -1 = 이전 탭. 끝이면 null.
    function neighborFolder(dir) {
        const folders = state.state.folders || [];
        if (query || !folders.length) return null;
        const order = ["", ...folders.map((f) => f.id)];
        const to = order.indexOf(activeFolderId()) + dir;
        return to >= 0 && to < order.length ? order[to] : null;
    }

    function stepFolder(dir) {
        const next = neighborFolder(dir);
        if (next === null) return false;
        setActiveFolder(next);
        return true;
    }

    function initFolderSwipe() {
        const SWIPE_LOCK_PX = 10; // 방향을 정하는 최소 이동
        const SWIPE_COMMIT_PX = 64; // 이만큼 밀면 넘어간다
        const SWIPE_FLICK_PX_MS = 0.45; // 빠르게 튕기면 짧은 거리도 인정
        const SETTLE_MS = 260;
        const SETTLE = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        let sw = null;
        // 미는 동안 옆 폴더의 목록을 담아 지금 목록 바로 옆에 붙여 두는 층. 손가락을 따라 같이 움직인다.
        let ghost = null; // { el, dir }
        let settleTimer = 0;
        const dropGhost = () => {
            clearTimeout(settleTimer);
            ghost?.el.remove();
            ghost = null;
            listEl.style.transition = "";
            listEl.style.transform = "";
        };
        const fillGhost = (dir, folderId) => {
            if (ghost?.dir === dir) return;
            ghost?.el.remove();
            const el = T.h("div", { class: "sb-scroll sb-ghost", "aria-hidden": "true" }, listRows(folderId));
            el.style.top = `${listEl.offsetTop}px`;
            el.style.height = `${listEl.offsetHeight}px`;
            sidebarEl.append(el);
            ghost = { el, dir };
        };
        listEl.addEventListener(
            "touchstart",
            (e) => {
                dropGhost(); // 자리 잡는 중에 다시 만지면 그 자리에서 끝낸다
                sw = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, lock: null, dx: 0 } : null;
            },
            { passive: true },
        );
        listEl.addEventListener(
            "touchmove",
            (e) => {
                if (!sw || e.touches.length !== 1) return;
                const dx = e.touches[0].clientX - sw.x;
                const dy = e.touches[0].clientY - sw.y;
                if (sw.lock === null) {
                    if (Math.abs(dx) > SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.5) sw.lock = "x";
                    else if (Math.abs(dy) > SWIPE_LOCK_PX) sw.lock = "y";
                }
                if (sw.lock !== "x") return;
                sw.dx = dx;
                const dir = dx < 0 ? 1 : -1;
                const next = neighborFolder(dir);
                listEl.classList.remove("slide-next", "slide-prev");
                listEl.style.transition = "none";
                if (next === null) {
                    // 넘어갈 폴더가 없는 방향은 뻑뻑하게(고무줄) 조금만 따라온다.
                    ghost?.el.remove();
                    ghost = null;
                    listEl.style.transform = `translateX(${dx * 0.2}px)`;
                    return;
                }
                fillGhost(dir, next);
                listEl.style.transform = `translateX(${dx}px)`;
                ghost.el.style.transform = `translateX(${dx + dir * listEl.offsetWidth}px)`;
            },
            { passive: true },
        );
        const end = (e) => {
            const cur = sw;
            sw = null;
            if (!cur || cur.lock !== "x") return;
            const dir = cur.dx < 0 ? 1 : -1;
            const w = listEl.offsetWidth;
            const speed = Math.abs(cur.dx) / Math.max(1, e.timeStamp - cur.at);
            const commit = e.type === "touchend" && (Math.abs(cur.dx) > SWIPE_COMMIT_PX || (speed > SWIPE_FLICK_PX_MS && Math.abs(cur.dx) > 24));
            const next = commit && ghost ? neighborFolder(dir) : null;
            if (next === null) {
                // 취소: 둘 다 제자리로 돌아간다.
                listEl.style.transition = SETTLE;
                listEl.style.transform = "";
                if (ghost) {
                    ghost.el.style.transition = SETTLE;
                    ghost.el.style.transform = `translateX(${dir * w}px)`;
                }
                settleTimer = setTimeout(dropGhost, SETTLE_MS);
                return;
            }
            // 넘어간다: 폴더를 바로 바꾸고(탭 밑줄이 같이 움직인다), 실제 목록은 들어오던 자리에서 이어서
            // 들어오게 한다. 임시 층에는 떠나는 폴더의 목록을 담아 반대쪽으로 밀어 낸다.
            // 새 목록은 미는 동안 보이던 대로 맨 위에서, 떠나는 목록은 보던 위치 그대로 나간다.
            const from = activeFolderId();
            const fromTop = listEl.scrollTop;
            setActiveFolder(next, false);
            listEl.scrollTop = 0;
            ghost.el.replaceChildren(...listRows(from));
            ghost.el.scrollTop = fromTop;
            ghost.el.style.transform = `translateX(${cur.dx}px)`;
            listEl.style.transition = "none";
            listEl.style.transform = `translateX(${cur.dx + dir * w}px)`;
            void listEl.offsetWidth;
            listEl.style.transition = SETTLE;
            listEl.style.transform = "translateX(0)";
            ghost.el.style.transition = SETTLE;
            ghost.el.style.transform = `translateX(${-dir * w}px)`;
            settleTimer = setTimeout(dropGhost, SETTLE_MS);
        };
        listEl.addEventListener("touchend", end, { passive: true });
        listEl.addEventListener("touchcancel", end, { passive: true });

        // 가로 스크롤: 한 번의 제스처(관성 포함)에 한 칸만 넘어가게, 입력이 잠잠해질 때까지 잠근다.
        const WHEEL_COMMIT_PX = 50;
        const WHEEL_IDLE_MS = 160;
        let wheelAcc = 0;
        let wheelLocked = false;
        let wheelIdle = 0;
        listEl.addEventListener(
            "wheel",
            (e) => {
                if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
                if (query || !(state.state.folders || []).length) return;
                // 브라우저의 "뒤로 가기" 스와이프가 대신 먹지 않게 한다.
                e.preventDefault();
                clearTimeout(wheelIdle);
                wheelIdle = setTimeout(() => {
                    wheelAcc = 0;
                    wheelLocked = false;
                }, WHEEL_IDLE_MS);
                if (wheelLocked) return;
                wheelAcc += e.deltaX;
                if (Math.abs(wheelAcc) < WHEEL_COMMIT_PX) return;
                stepFolder(wheelAcc > 0 ? 1 : -1);
                wheelLocked = true;
                wheelAcc = 0;
            },
            { passive: false },
        );
        listEl.addEventListener("animationend", () => listEl.classList.remove("slide-next", "slide-prev"));
    }

    // 사이드바는 스트리밍 중에도 자주 다시 그려진다. 탭 구성이 그대로면 DOM을 유지해
    // 밑줄 애니메이션과 가로 스크롤 위치가 끊기지 않게 한다.
    let tabsSig = null;
    function renderTabs() {
        if (!tabsEl) return;
        const folders = state.state.folders || [];
        tabsEl.hidden = !folders.length;
        if (!folders.length) {
            tabsEl.replaceChildren();
            tabsSig = null;
            return;
        }

        // 배지는 메신저처럼 "안 읽은 대화 수"다. 0이면 숨긴다.
        // allTabExcludesFoldered가 켜져 있으면 "전체"는 미분류 에이전트만 센다.
        const counts = new Map();
        for (const b of state.state.bots) {
            if (!unreadOf(b)) continue;
            const f = folderOf(b);
            if (f) counts.set(f, (counts.get(f) || 0) + 1);
            if (!f || !allExcludesFoldered()) counts.set("", (counts.get("") || 0) + 1);
        }
        const tabs = [{ id: "", name: t("folderAll"), folder: null }];
        for (const f of folders) tabs.push({ id: f.id, name: f.name, folder: f });

        const sig = JSON.stringify(tabs.map((x) => [x.id, x.name]));
        const rebuilt = sig !== tabsSig;
        if (rebuilt) {
            tabsSig = sig;
            tabsEl.replaceChildren(...tabs.map((x) => buildTab(x.id, x.name)), tabInd);
        }
        const active = activeFolderId();
        // 활성 표시와 배지는 제자리에서 갱신한다. 배지가 생기면 탭 폭이 바뀌므로 밑줄도 다시 맞춘다.
        let moved = false;
        for (const tab of tabsEl.querySelectorAll(".sb-tab")) {
            const on = tab.dataset.folder === active;
            if (tab.classList.contains("active") !== on) moved = true;
            tab.classList.toggle("active", on);
            tab.setAttribute("aria-selected", String(on));
            const n = counts.get(tab.dataset.folder) || 0;
            const badge = tab.querySelector(".sb-tab-count");
            const text = n > 99 ? "99+" : String(n);
            if (badge.hidden !== !n || (n && badge.textContent !== text)) {
                badge.hidden = !n;
                badge.textContent = n ? text : "";
                moved = true;
            }
        }
        if (rebuilt || moved) placeTabIndicator(!rebuilt);
    }

    // 검색 히트 행: 에이전트 아바타 + 이름/시각 + 매치 스니펫
    function hitSnippetEl(hit) {
        const el = T.h("span", { class: "bot-persona sb-hit-snippet" });
        const s = String(hit.snippet || "");
        const i = s.toLowerCase().indexOf(query.toLowerCase());
        if (i === -1) {
            el.textContent = s;
        } else {
            el.append(
                document.createTextNode(s.slice(0, i)),
                T.h("mark", { text: s.slice(i, i + query.length) }),
                document.createTextNode(s.slice(i + query.length)),
            );
        }
        return el;
    }

    function buildHitRow(hit) {
        const bot = state.botByUuid(hit.conversationId);
        const row = T.h("div", { class: "bot-row", role: "button", tabindex: "0" }, [
            T.h("span", { class: "bot-avatar", text: initials(bot?.name || "?"), style: `background-color:${safeColor(bot?.color)}` }),
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
            if (isMobile()) setMobileChat(true);
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

    /* ── 렌더 ───────────────────────────────────────────────── */
    // 한 폴더("": 전체)의 목록 행들. 폴더를 미는 동안 옆 폴더를 미리 그릴 때도 쓴다.
    function listRows(active) {
        const rows = [];
        // 최근 메시지 순: 안정 정렬이라 updatedAt이 없는 봇끼리는 에이전트 순서를 유지한다.
        const bots = state.state.bots.filter(matches);
        bots.sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)));
        const shown = active ? bots.filter((b) => folderOf(b) === active) : allExcludesFoldered() ? bots.filter((b) => !folderOf(b)) : bots;
        for (const bot of shown) rows.push(buildRow(bot));
        if ((!active || query) && todosVisible()) rows.push(buildTodosRow());
        if (query && msgResults?.length) {
            rows.push(T.h("div", { class: "sb-sec", text: t("searchMsgs") }));
            for (const hit of msgResults) rows.push(buildHitRow(hit));
        }
        if (!rows.length) rows.push(T.h("div", { class: "sb-empty", text: t("noBots") }));
        return rows;
    }

    // 폴더 탭이 활성이면 그 폴더 소속만 보여 준다. 검색 중에는 폴더와 무관하게 전체 결과를 보여 준다.
    // 손가락이 목록에 닿아 있는 동안에는 미뤘다가 떼면 그린다: 행을 갈아 끼우면 터치가 시작된 행이
    // 떨어져 나가 이후의 움직임이 전달되지 않는다(폴더 넘기기·당겨서 검색·길게 누르기가 그 자리에서 멈춘다).
    let listTouching = false;
    let renderPending = false;
    function render(force) {
        if (!listEl) return;
        if (listTouching && !force) {
            renderPending = true;
            return;
        }
        renderPending = false;
        renderTabs();
        listEl.replaceChildren(...listRows(query ? "" : activeFolderId()));
    }
    function initTouchDefer() {
        const release = (e) => {
            if (e.touches.length) return;
            listTouching = false;
            if (renderPending) render();
        };
        listEl.addEventListener("touchstart", () => (listTouching = true), { passive: true });
        // 문서의 캡처 단계에서 받는다: 뒤로/앞으로 제스처(gestures.js)가 전파를 막아도 놓치지 않는다.
        document.addEventListener("touchend", release, { passive: true, capture: true });
        document.addEventListener("touchcancel", release, { passive: true, capture: true });
    }

    /* 모바일 검색 바: 평소에는 접혀 있다. 목록 맨 위에서 아래로 당기거나 떠 있는 검색 버튼을 누르면
       탐색 바 밑에 나타나고, 빈 채로 목록을 올리거나 닫기 버튼을 누르면 다시 접힌다. */
    function initMobileSearch() {
        const PULL_PX = 36; // 이만큼 당기거나 올리면 열고 닫는다
        const closeBtn = document.getElementById("btnSearchClose");
        const fab = document.getElementById("btnSearchFab");
        const setSearching = (on) => {
            sidebarEl.classList.toggle("searching", on);
            closeBtn.hidden = !on;
        };
        const idle = () => !searchEl.value && document.activeElement !== searchEl;

        searchEl.addEventListener("focus", () => {
            if (isMobile()) setSearching(true);
        });
        // 빈 채로 포커스를 잃으면 접는다(다른 화면에 다녀와도 빈 검색 바가 열려 있지 않게).
        searchEl.addEventListener("blur", () => {
            if (!searchEl.value) setSearching(false);
        });
        fab.addEventListener("click", () => {
            setSearching(true);
            // 누른 그 자리에서 포커스를 줘야 iOS가 키보드를 올린다.
            searchEl.focus();
        });
        // 닫기 버튼이 포커스를 가져가지 않게 해서, 누르는 순간 입력란이 먼저 흐려지는 일을 막는다.
        closeBtn.addEventListener("pointerdown", (e) => e.preventDefault());
        closeBtn.addEventListener("click", () => {
            searchEl.value = "";
            searchEl.dispatchEvent(new Event("input"));
            searchEl.blur();
            setSearching(false);
        });

        let pull = null;
        listEl.addEventListener(
            "touchstart",
            (e) => {
                pull = e.touches.length === 1 ? { y: e.touches[0].clientY, x: e.touches[0].clientX, top: listEl.scrollTop, axis: null } : null;
            },
            { passive: true },
        );
        listEl.addEventListener(
            "touchmove",
            (e) => {
                if (!pull || !isMobile()) return;
                const dy = e.touches[0].clientY - pull.y;
                const dx = e.touches[0].clientX - pull.x;
                // 처음 움직인 방향으로 정한다. 좌우 밀기(폴더 전환)로 시작했으면 손가락이 위아래로 흘러도 무시한다.
                if (pull.axis === null && Math.max(Math.abs(dx), Math.abs(dy)) > 10) pull.axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
                if (pull.axis !== "y") return;
                const open = sidebarEl.classList.contains("searching");
                // 목록을 넘기기 시작하면 키보드를 내린다.
                if (open && document.activeElement === searchEl && Math.abs(dy) > PULL_PX) searchEl.blur();
                if (!open && pull.top <= 0 && dy > PULL_PX) {
                    setSearching(true);
                    pull = null;
                } else if (open && idle() && dy < -PULL_PX) {
                    setSearching(false);
                    pull = null;
                }
            },
            { passive: true },
        );
    }

    /* ── 사이드바 크기/축소 ────────────────────────────────── */
    const W_KEY = "tabybot.sidebar.w";
    const C_KEY = "tabybot.sidebar.collapsed";
    let collapsedState = false;
    let currentWidth = 300;

    function applyWidth(w) {
        currentWidth = w;
        sidebarEl.style.setProperty("--sb-w", `${w}px`);
    }
    function applyCollapsed(collapsed) {
        sidebarEl.classList.toggle("collapsed", !!collapsed);
        document.body.classList.toggle("sb-collapsed", !!collapsed && !isMobile());
        sidebarEl.setAttribute("aria-hidden", collapsed && !isMobile() ? "true" : "false");
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
        const label = collapsed ? t("expand") : t("collapse");
        collapseBtn.setAttribute("data-tip", label);
        collapseBtn.setAttribute("aria-label", label);
        if (menuBtn && !isMobile()) {
            menuBtn.setAttribute("aria-expanded", String(!collapsed));
            const menuLabel = collapsed ? t("expand") : t("menu");
            menuBtn.setAttribute("data-tip", menuLabel);
            menuBtn.setAttribute("aria-label", menuLabel);
        }
    }
    // 프라이빗 모드/스토리지 차단 브라우저에서 localStorage 접근이 SecurityError를
    // 던진다. 사이드바 초기화 전체가 죽지 않게 접근마다 가드한다.
    const lsGet = (k) => {
        try {
            return localStorage.getItem(k);
        } catch {
            return null;
        }
    };
    const lsSet = (k, v) => {
        try {
            localStorage.setItem(k, v);
        } catch {}
    };
    // 접힌 사이드바를 다시 펼친다(설정 화면의 펼치기 버튼 등에서 호출).
    function expandSidebar() {
        if (!collapsedState) return;
        collapsedState = false;
        lsSet(C_KEY, "0");
        applyCollapsed(false);
    }

    function initResize() {
        const savedW = Number(lsGet(W_KEY));
        if (savedW >= 240 && savedW <= 460) applyWidth(savedW);
        applyCollapsed(lsGet(C_KEY) === "1");
        collapsedState = lsGet(C_KEY) === "1";
        let dragging = false;
        resizeEl.addEventListener("pointerdown", (e) => {
            dragging = true;
            resizeEl.setPointerCapture(e.pointerId);
            document.body.classList.add("resizing");
        });
        resizeEl.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const w = Math.min(460, Math.max(240, e.clientX));
            applyWidth(w);
        });
        resizeEl.addEventListener("pointerup", () => {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove("resizing");
            lsSet(W_KEY, String(currentWidth));
        });
        collapseBtn.addEventListener("click", () => {
            if (isMobile()) {
                T.settingsUI.open();
                return;
            }
            const next = !collapsedState;
            lsSet(C_KEY, next ? "1" : "0");
            collapsedState = next;
            applyCollapsed(next);
            if (T.tooltip) T.tooltip.hide();
        });
        if (menuBtn) {
            menuBtn.addEventListener("click", () => {
                if (isMobile()) {
                    showMobileList();
                    return;
                }
                expandSidebar();
                if (T.tooltip) T.tooltip.hide();
            });
        }
        if (sbScrim) {
            sbScrim.addEventListener("click", () => setMobileOpen(false));
        }
        const onMq = () => {
            if (!isMobile()) {
                document.body.classList.remove("mobile-chat");
                mainEl?.removeAttribute("aria-hidden");
                setMobileOpen(false);
                applyCollapsed(collapsedState);
            } else {
                applyCollapsed(false);
                setMobileChatFromRoute();
            }
            syncMobileNavigation();
        };
        if (mobileMq.addEventListener) mobileMq.addEventListener("change", onMq);
        else mobileMq.addListener(onMq);
        window.addEventListener("popstate", setMobileChatFromRoute);
        window.addEventListener("pageshow", setMobileChatFromRoute);
        onMq();
    }

    /* ── 바인딩 ─────────────────────────────────────────────── */
    function init() {
        searchEl.addEventListener("input", () => {
            query = searchEl.value.trim();
            // 바뀐 검색어에 맞지 않는 이전 결과는 즉시 걷어낸다.
            msgResults = null;
            scheduleMsgSearch();
            render();
        });
        initMobileSearch();
        document.addEventListener("keydown", (e) => {
            if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                searchEl.focus();
                searchEl.select();
            }
        });
        addBtn.addEventListener("click", () => T.settingsUI.open({ agentId: "__new__" }));
        settingsBtn.addEventListener("click", () => T.settingsUI.open());
        state.on("bots", () => {
            render();
            hydratePreviews();
        });
        state.on("folders", render);
        state.on("current", render);
        state.on("conversations", () => {
            render();
            hydratePreviews();
        });
        state.on("status", render); // 실행중 점
        // 스트리밍 중 미리보기 갱신: 토큰마다 전체를 다시 그리지 않게 짧게 묶는다.
        let deltaTimer = null;
        state.on("delta", () => {
            if (deltaTimer) return;
            deltaTimer = setTimeout(() => {
                deltaTimer = null;
                render();
            }, 400);
        });
        state.on("user_message", render);
        state.on("turn_done", render);
        state.on("settings", render);
        state.on("conn", renderConn);
        state.on("todos", render);
        T.i18n.onChange(syncMobileNavigation);

        // 사이드바 폭 변경·펼침·글꼴 로드로 탭 위치가 바뀌면 밑줄을 다시 맞춘다.
        if (tabsEl && window.ResizeObserver) new ResizeObserver(() => placeTabIndicator(false)).observe(tabsEl);

        initFolderSwipe();
        initTouchDefer();
        initResize();
        renderConn();
        render();
    }

    T.sidebar = { init, hydrate: hydratePreviews, showChat: () => setMobileChat(true), showList: showMobileList, syncRoute, expand: expandSidebar };
})((window.Taby = window.Taby || {}));
