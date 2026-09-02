/* tabyBot 웹 클라이언트 — 사이드바(봇 라스터).
   메신저 패러다임: 대화 상대는 봇이다. 각 행은 하나의 봇(동료)이고,
   클릭하면 그 봇과의 끊기지 않는 스레드가 열린다. 검색은 봇 필터,
   리사이즈/축소를 지원한다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k) => T.i18n.t(k);

    const listEl = document.getElementById("botList");
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

    // 서버 색상은 UI 팔레트 해시 값이므로 CSS 주입을 막기 위해 형식을 강제한다.
    function safeColor(value) {
        return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : "var(--accent)";
    }

    function initials(name) {
        return (
            String(name || "?")
                .trim()
                .slice(0, 1)
                .toUpperCase() || "?"
        );
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

    // 마지막 발화 → 없으면 "아직 맡은 일이 없어요". 미리보기 줄은 항상 채운다.
    function previewOf(bot) {
        const c = state.conv(bot.threadId);
        const fromMeta = snippet(c?.meta?.preview);
        if (fromMeta) return fromMeta;
        const fromBot = snippet(bot.preview);
        if (fromBot) return fromBot;
        const fromTurns = previewFromTurns(c?.turns);
        if (fromTurns) return fromTurns;
        const pending = c?.pending || [];
        for (let i = pending.length - 1; i >= 0; i--) {
            const text = snippet(pending[i]?.text);
            if (text) return text;
        }
        return "";
    }

    // 클릭하지 않아도 미리보기가 보이도록, 비어 있는 스레드만 상세를 받아 채운다.
    const hydrating = new Set();
    function hydratePreviews() {
        if (state.state.offline) return Promise.resolve();
        const jobs = [];
        for (const bot of state.state.bots) {
            const id = bot.threadId;
            if (!id || hydrating.has(id) || previewOf(bot)) continue;
            hydrating.add(id);
            jobs.push(
                T.api
                    .conversation(id)
                    .then((r) => {
                        const text = snippet(r && r.preview) || previewFromTurns(r && r.turns);
                        if (!text) return;
                        state.upsertMeta({ id, preview: text });
                    })
                    .catch(() => {})
                    .finally(() => hydrating.delete(id)),
            );
        }
        return Promise.all(jobs);
    }

    // 봇 행: 아바타 + 이름 + 대화 미리보기 + 실행중 점 + ⋯ 메뉴
    function buildRow(bot) {
        const live = state.conv(bot.threadId)?.live;
        const preview = previewOf(bot);
        const empty = !preview;
        const previewText = empty ? t("botNoJob") : preview;
        const moreBtn = T.h(
            "button",
            {
                class: "btn-icon btn-xs bot-more",
                "data-tip": t("more"),
                "aria-label": t("more"),
                "aria-haspopup": "menu",
                "aria-expanded": "false",
                onclick(e) {
                    e.stopPropagation();
                    toggleBotMenu(moreBtn, bot);
                },
            },
            [T.icon("more", "icon-sm")],
        );
        const row = T.h(
            "div",
            {
                class: "bot-row" + (state.state.currentId === bot.threadId && !T.settingsUI.isOpen() ? " active" : ""),
                "aria-current": state.state.currentId === bot.threadId && !T.settingsUI.isOpen() ? "true" : null,
                role: "button",
                "aria-label": `${bot.name}. ${previewText}`.trim(),
                tabindex: "0",
            },
            [
                T.h("span", { class: "bot-avatar", text: initials(bot.name), style: `background:${safeColor(bot.color)}` }),
                T.h("span", { class: "bot-meta" }, [
                    T.h("span", { class: "bot-name" }, [
                        document.createTextNode(bot.name),
                        live ? T.h("span", { class: "live-dot", role: "status", "aria-label": T.i18n.t("runningState") }) : null,
                    ]),
                    T.h("span", { class: "bot-persona" + (empty ? " is-empty" : ""), text: previewText }),
                ]),
                T.h("span", { class: "bot-actions" }, [moreBtn]),
            ],
        );
        row.addEventListener("click", () => openBot(bot));
        row.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                openBot(bot);
            }
        });
        return row;
    }

    function listLength() {
        return state.state.bots.length;
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
        setIcon(menuBtn, chatOpen ? "arrow-left" : "menu");
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
            requestAnimationFrame(() => (chatOpen ? menuBtn : searchEl)?.focus({ preventScroll: true }));
        }
        if (instant) requestAnimationFrame(() => document.body.classList.remove("mobile-route-sync"));
    }

    function showMobileList() {
        if (!isMobile()) return;
        setMobileChat(false);
        if (/^(\/a\/|\/s\/)/.test(location.pathname)) history.replaceState(null, "", "/" + location.search + location.hash);
        T.app?.renderRoute();
    }

    function setMobileChatFromRoute() {
        if (isMobile()) setMobileChat(/^(\/a\/|\/s\/)/.test(location.pathname), { animate: false });
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
            history.pushState(null, "", `/a/${encodeURIComponent(bot.uuid || bot.id)}`);
        } catch (_) {}
        if (isMobile()) setMobileChat(true);
        T.app?.renderRoute();
    }

    // 설정 페이지 내비게이션 — 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링한다.
    function settingsPush(agentId) {
        const path = agentId == null ? "/s/general" : agentId === "__new__" ? "/s/agents/new" : `/s/agents/${agentId}`;
        history.pushState(null, "", path);
        T.app?.renderRoute();
    }

    let botMenu = null;
    let botMenuBtn = null;

    function closeBotMenu() {
        if (botMenu) botMenu.remove();
        botMenu = null;
        if (botMenuBtn) botMenuBtn.setAttribute("aria-expanded", "false");
        botMenuBtn = null;
        document.querySelectorAll(".bot-row.menu-open").forEach((el) => el.classList.remove("menu-open"));
        document.removeEventListener("pointerdown", onBotMenuPointer, true);
        document.removeEventListener("keydown", onBotMenuKey, true);
        if (T.tooltip) T.tooltip.hide();
    }

    function onBotMenuPointer(e) {
        if (!botMenu) return;
        if (botMenu.contains(e.target) || (botMenuBtn && botMenuBtn.contains(e.target))) return;
        closeBotMenu();
    }

    function onBotMenuKey(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            const btn = botMenuBtn;
            closeBotMenu();
            btn?.focus();
        }
    }

    function toggleBotMenu(btn, bot) {
        if (botMenu && botMenuBtn === btn) {
            closeBotMenu();
            return;
        }
        closeBotMenu();
        const item = T.h("button", {
            role: "menuitem",
            text: t("botSettings"),
            onclick(e) {
                e.stopPropagation();
                closeBotMenu();
                // 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링된다.
                settingsPush(bot.id);
            },
        });
        botMenu = T.h("div", { class: "menu bot-ctx-menu", role: "menu" }, [item]);
        document.body.append(botMenu);
        botMenuBtn = btn;
        btn.setAttribute("aria-expanded", "true");
        btn.closest(".bot-row")?.classList.add("menu-open");
        const r = btn.getBoundingClientRect();
        const w = botMenu.offsetWidth;
        const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
        const top = Math.min(r.bottom + 4, window.innerHeight - botMenu.offsetHeight - 8);
        botMenu.style.left = `${left}px`;
        botMenu.style.top = `${Math.max(8, top)}px`;
        document.addEventListener("pointerdown", onBotMenuPointer, true);
        document.addEventListener("keydown", onBotMenuKey, true);
        item.focus();
        if (T.tooltip) T.tooltip.hide();
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
        settingsBtn.setAttribute("aria-label", lost ? `${t("settings")} — ${label}` : t("settings"));
    }
    // 라우트에 맞춰 선택 표시를 동기화한다: /s/면 설정 행이, /a/면 해당 봇 행이 '선택'된다.
    function syncRoute() {
        const on = T.settingsUI.isOpen();
        settingsBtn.classList.toggle("active", on);
        settingsBtn.setAttribute("aria-current", on ? "page" : null);
        render();
    }

    /* ── 렌더 ───────────────────────────────────────────────── */
    function render() {
        if (!listEl) return;
        listEl.replaceChildren();
        for (const bot of state.state.bots.filter(matches)) {
            listEl.append(buildRow(bot));
        }
        if (!listEl.children.length) {
            listEl.append(T.h("div", { class: "sb-empty", text: t("noBots") }));
        }
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
    function initResize() {
        const savedW = Number(localStorage.getItem(W_KEY));
        if (savedW >= 240 && savedW <= 460) applyWidth(savedW);
        applyCollapsed(localStorage.getItem(C_KEY) === "1");
        collapsedState = localStorage.getItem(C_KEY) === "1";
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
            localStorage.setItem(W_KEY, String(currentWidth));
        });
        collapseBtn.addEventListener("click", () => {
            if (isMobile()) {
                T.settingsUI.open();
                return;
            }
            const next = !collapsedState;
            localStorage.setItem(C_KEY, next ? "1" : "0");
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
                if (!collapsedState) return;
                collapsedState = false;
                localStorage.setItem(C_KEY, "0");
                applyCollapsed(false);
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
            render();
        });
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
        state.on("current", render);
        state.on("conversations", () => {
            render();
            hydratePreviews();
        });
        state.on("status", render); // 실행중 점
        state.on("user_message", render);
        state.on("turn_done", render);
        state.on("settings", render);
        state.on("conn", renderConn);
        T.i18n.onChange(syncMobileNavigation);

        initResize();
        renderConn();
        render();
    }

    T.sidebar = { init, hydrate: hydratePreviews, showChat: () => setMobileChat(true), showList: showMobileList, syncRoute };
})((window.Taby = window.Taby || {}));
