/* tabyBot 웹 클라이언트 — 사이드바(봇 라스터).
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

    // 마지막 발화 → 없으면 "아직 맡은 일이 없어요". 미리보기 줄은 항상 채운다.
    // 최신 순: 확인 전 낙관 메시지 → 실행 중 발화(중간 say/스트리밍) → 서버 메타 →
    // 봇 목록 스냅샷 → 캐시된 턴.
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

    // 클릭하지 않아도 미리보기가 보이도록, 비어 있는 스레드만 상세를 받아 채운다.
    const hydrating = new Set();
    function hydratePreviews() {
        if (state.state.offline) return Promise.resolve();
        const jobs = [];
        for (const bot of state.state.bots) {
            const id = bot.uuid;
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
        const live = state.conv(bot.uuid)?.live;
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
                class: "bot-row" + (state.state.currentId === bot.uuid && !T.settingsUI.isOpen() && !T.todosUI?.isOpen?.() ? " active" : ""),
                "aria-current": state.state.currentId === bot.uuid && !T.settingsUI.isOpen() && !T.todosUI?.isOpen?.() ? "true" : null,
                role: "button",
                "aria-label": `${bot.name}. ${previewText}`.trim(),
                tabindex: "0",
                draggable: "true",
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
        // 행 우클릭은 ⋯ 메뉴와 동일하게 동작한다(네이티브 리스트 동작).
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            toggleBotMenu(moreBtn, bot);
        });
        row.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                openBot(bot);
            }
        });
        row.addEventListener("dragstart", (e) => {
            dragPayload = { type: "agent", id: bot.id };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", bot.id);
        });
        row.addEventListener("dragend", () => {
            dragPayload = null;
            clearDrops();
        });
        // 다른 에이전트 위에 놓으면 그 행과 같은 폴더로 배정한다.
        row.addEventListener("dragover", (e) => {
            if (dragPayload?.type !== "agent" || dragPayload.id === bot.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            row.classList.add("drop-ok");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-ok"));
        row.addEventListener("drop", (e) => {
            e.preventDefault();
            row.classList.remove("drop-ok");
            const p = dragPayload;
            dragPayload = null;
            if (p?.type === "agent" && p.id !== bot.id) void assignAgentFolder(p.id, folderOf(bot));
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
        if (/^(\/a\/|\/s\/|\/t(?:\/|$))/.test(location.pathname)) history.replaceState(null, "", "/" + location.search + location.hash);
        T.app?.renderRoute();
    }

    function setMobileChatFromRoute() {
        if (isMobile()) setMobileChat(/^(\/a\/|\/s\/|\/c\/|\/t(?:\/|$))/.test(location.pathname), { animate: false });
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
        document.querySelectorAll(".menu-open").forEach((el) => el.classList.remove("menu-open"));
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

    function menuItem(label, onclick, opts = {}) {
        return T.h("button", {
            role: "menuitem",
            class: opts.danger ? "danger" : null,
            onclick(e) {
                e.stopPropagation();
                closeBotMenu();
                onclick();
            },
            text: label,
        });
    }

    function openMenuAt(btn, items, hostRow) {
        const menu = T.h("div", { class: "menu bot-ctx-menu", role: "menu" }, items.filter(Boolean));
        document.body.append(menu);
        botMenu = menu;
        botMenuBtn = btn;
        btn.setAttribute("aria-expanded", "true");
        hostRow?.classList.add("menu-open");
        const r = btn.getBoundingClientRect();
        const w = menu.offsetWidth;
        const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
        const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(8, top)}px`;
        document.addEventListener("pointerdown", onBotMenuPointer, true);
        document.addEventListener("keydown", onBotMenuKey, true);
        menu.querySelector("button")?.focus();
        if (T.tooltip) T.tooltip.hide();
    }

    function toggleBotMenu(btn, bot) {
        if (botMenu && botMenuBtn === btn) {
            closeBotMenu();
            return;
        }
        closeBotMenu();
        const items = [
            menuItem(t("botSettings"), () => {
                // 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링된다.
                settingsPush(bot.id);
            }),
        ];
        // 폴더 이동: 폴더가 있으면 목록을 보여주고, 항상 "새 폴더로 이동"을 단다.
        const folders = state.state.folders || [];
        const current = folderOf(bot);
        if (folders.length) {
            items.push(T.h("div", { class: "menu-sep", role: "separator" }));
            for (const f of folders) {
                if (f.id === current) continue;
                items.push(menuItem(`${f.name}`, () => void assignAgentFolder(bot.id, f.id)));
            }
            if (current) items.push(menuItem(t("folderUnassign"), () => void assignAgentFolder(bot.id, "")));
        }
        items.push(
            menuItem(t("folderToNew"), () => {
                pendingAssign = bot.id;
                editingFolder = "new";
                render();
            }),
        );
        openMenuAt(btn, items, btn.closest(".bot-row"));
    }

    function toggleFolderMenu(btn, folder, hostEl) {
        if (botMenu && botMenuBtn === btn) {
            closeBotMenu();
            return;
        }
        closeBotMenu();
        const folders = state.state.folders || [];
        const idx = folders.findIndex((f) => f.id === folder.id);
        const items = [
            menuItem(t("folderRename"), () => {
                editingFolder = folder.id;
                render();
            }),
            idx > 0 ? menuItem(t("folderLeft"), () => void moveFolderBefore(folder.id, folders[idx - 1].id)) : null,
            idx < folders.length - 1
                ? menuItem(t("folderRight"), () => void moveFolderBefore(folder.id, idx + 2 < folders.length ? folders[idx + 2].id : null))
                : null,
            T.h("div", { class: "menu-sep", role: "separator" }),
            menuItem(
                t("folderDelete"),
                () => {
                    void (async () => {
                        try {
                            const r = await T.api.deleteFolder(folder.id);
                            state.applyAgents(r);
                        } catch (err) {
                            T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
                        }
                    })();
                },
                { danger: true },
            ),
        ];
        openMenuAt(btn, items, hostEl || btn);
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
                    T.h("span", { class: "bot-name" }, [
                        document.createTextNode(t("todos")),
                        pending ? T.h("span", { class: "attn-dot", "aria-hidden": "true" }) : null,
                    ]),
                    T.h("span", { class: "bot-persona" + (preview === t("todosNone") ? " is-empty" : ""), text: preview }),
                ]),
            ],
        );
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
       메신저 폴더 패턴: 목록 위 가로 탭으로 필터링한다. "전체" 탭은 고정,
       폴더 탭은 드래그로 순서 변경, 에이전트 행을 탭 위에 놓으면 배정된다.
       활성 탭·이름 편집은 로컬 상태, 실제 데이터는 state.folders/bot.folder. */
    const ACTIVE_TAB_KEY = "tabybot.sidebar.folder.active";
    let dragPayload = null; // {type:"agent"|"folder", id}
    let editingFolder = null; // 폴더 id(이름 변경) | "new"(생성) | null
    let pendingAssign = null; // 새 폴더 생성이 끝나면 그 안에 넣을 에이전트 id

    // 지워진 폴더를 가리키면 "전체"로 되돌린다 — 저장값은 존재하는 폴더만 인정.
    function activeFolderId() {
        const id = lsGet(ACTIVE_TAB_KEY) || "";
        return id && (state.state.folders || []).some((f) => f.id === id) ? id : "";
    }
    function setActiveFolder(id) {
        lsSet(ACTIVE_TAB_KEY, id || "");
        render();
    }

    // 존재하는 폴더 id만 인정한다 — 지워진 폴더를 가리키는 봇은 미분류로 본다.
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

    // dragId 폴더를 beforeId 앞으로 옮긴다. beforeId=null이면 맨 끝.
    async function moveFolderBefore(dragId, beforeId) {
        const ids = (state.state.folders || []).map((f) => f.id).filter((id) => id !== dragId);
        let idx = beforeId == null ? ids.length : ids.indexOf(beforeId);
        if (idx < 0) idx = ids.length;
        ids.splice(idx, 0, dragId);
        try {
            const r = await T.api.orderFolders(ids);
            state.applyAgents(r);
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
        }
    }

    function clearDrops() {
        listEl.querySelectorAll(".drop-ok").forEach((el) => el.classList.remove("drop-ok"));
        tabsEl?.querySelectorAll(".drop-ok").forEach((el) => el.classList.remove("drop-ok"));
    }

    // 탭을 드롭 대상으로 만든다.
    // 에이전트 드롭 → agentFolder 배정, 폴더 드롭 → folderBefore 앞으로 순서 이동.
    function attachTabDrop(el, { agentFolder, folderBefore }) {
        el.addEventListener("dragover", (e) => {
            if (!dragPayload) return;
            if (dragPayload.type === "folder" && dragPayload.id === folderBefore) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            el.classList.add("drop-ok");
        });
        el.addEventListener("dragleave", () => el.classList.remove("drop-ok"));
        el.addEventListener("drop", (e) => {
            e.preventDefault();
            el.classList.remove("drop-ok");
            const p = dragPayload;
            dragPayload = null;
            if (!p) return;
            if (p.type === "agent") void assignAgentFolder(p.id, agentFolder);
            else if (p.type === "folder" && p.id !== folderBefore) void moveFolderBefore(p.id, folderBefore);
        });
    }

    /* 폴더 생성/이름 변경은 모달 없이 탭 자리에 인라인 입력으로 처리한다. */
    function buildFolderTabEditor(f) {
        const input = T.h("input", {
            class: "sb-tab-input",
            type: "text",
            value: f?.name || "",
            placeholder: t("folderNamePh"),
            maxlength: "32",
            spellcheck: "false",
            "aria-label": t("folderNamePh"),
        });
        const tab = T.h("span", { class: "sb-tab editing" }, [input]);
        let done = false;
        const finish = (cancel) => {
            if (done) return;
            done = true;
            editingFolder = null;
            render();
            if (cancel) return;
            const name = input.value.trim();
            if (!name) {
                pendingAssign = null;
                return;
            }
            void (async () => {
                try {
                    if (f) {
                        const r = await T.api.updateFolder(f.id, { name });
                        state.applyAgents(r);
                    } else {
                        const r = await T.api.createFolder({ name });
                        state.applyAgents(r);
                        if (r?.folder?.id) {
                            setActiveFolder(r.folder.id);
                            if (pendingAssign) {
                                const rr = await T.api.updateAgent(pendingAssign, { folder: r.folder.id });
                                state.applyAgents(rr);
                            }
                        }
                    }
                } catch (err) {
                    T.toast.show("error", T.api.errorText(err, t("errorPrefix")));
                }
                pendingAssign = null;
            })();
        };
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") finish(false);
            else if (e.key === "Escape") finish(true);
        });
        input.addEventListener("blur", () => finish(false));
        requestAnimationFrame(() => input.focus());
        return tab;
    }

    function buildFolderTab(f, count, active) {
        const menuBtn = T.h(
            "button",
            {
                class: "btn-icon",
                "aria-label": t("more"),
                "aria-haspopup": "menu",
                "aria-expanded": "false",
                onclick(e) {
                    e.stopPropagation();
                    toggleFolderMenu(menuBtn, f, tab);
                },
            },
            [T.icon("more", "icon-sm")],
        );
        const tab = T.h(
            "div",
            {
                class: "sb-tab" + (active ? " active" : ""),
                role: "tab",
                tabindex: "0",
                draggable: "true",
                "aria-selected": String(active),
                title: f.name,
            },
            [document.createTextNode(f.name), T.h("span", { class: "sb-tab-count", text: String(count) }), active ? menuBtn : null],
        );
        tab.addEventListener("click", () => setActiveFolder(f.id));
        tab.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                setActiveFolder(f.id);
            }
        });
        // 메신저처럼 우클릭/길게눌러도 관리 메뉴가 열리게 한다.
        tab.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            toggleFolderMenu(tab, f, tab);
        });
        tab.addEventListener("dragstart", (e) => {
            dragPayload = { type: "folder", id: f.id };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", f.id);
        });
        tab.addEventListener("dragend", () => {
            dragPayload = null;
            clearDrops();
        });
        attachTabDrop(tab, { agentFolder: f.id, folderBefore: f.id });
        return tab;
    }

    function renderTabs() {
        if (!tabsEl) return;
        const folders = state.state.folders || [];
        const show = folders.length > 0 || editingFolder === "new";
        tabsEl.hidden = !show;
        tabsEl.replaceChildren();
        if (!show) return;

        const active = activeFolderId();
        const counts = new Map();
        for (const b of state.state.bots) {
            const f = folderOf(b);
            if (f) counts.set(f, (counts.get(f) || 0) + 1);
        }

        // 고정 "전체" 탭 — 에이전트를 여기 놓으면 폴더에서 뺀다.
        // allTabExcludesFoldered가 켜져 있으면 미분류 에이전트 수만 센다.
        const allCount = allExcludesFoldered() ? state.state.bots.filter((b) => !folderOf(b)).length : state.state.bots.length;
        const allTab = T.h(
            "div",
            {
                class: "sb-tab" + (active === "" ? " active" : ""),
                role: "tab",
                tabindex: "0",
                "aria-selected": String(active === ""),
            },
            [document.createTextNode(t("folderAll")), T.h("span", { class: "sb-tab-count", text: String(allCount) })],
        );
        allTab.addEventListener("click", () => setActiveFolder(""));
        allTab.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                setActiveFolder("");
            }
        });
        attachTabDrop(allTab, { agentFolder: "", folderBefore: folders[0]?.id || null });
        tabsEl.append(allTab);

        for (const f of folders) {
            if (editingFolder === f.id) {
                tabsEl.append(buildFolderTabEditor(f));
                continue;
            }
            tabsEl.append(buildFolderTab(f, counts.get(f.id) || 0, active === f.id));
        }

        if (editingFolder === "new") {
            tabsEl.append(buildFolderTabEditor(null));
        } else {
            const add = T.h(
                "button",
                {
                    class: "sb-tab sb-tab-add",
                    type: "button",
                    "data-tip": t("folderNew"),
                    "aria-label": t("folderNew"),
                    onclick() {
                        pendingAssign = null;
                        editingFolder = "new";
                        render();
                    },
                },
                [T.icon("plus", "icon-sm")],
            );
            tabsEl.append(add);
        }
    }

    // 검색 히트 행: 에이전트 아바타 + 이름/시각 + 매치 스니펫
    function hitTime(at) {
        const ms = Date.parse(at || "");
        if (!Number.isFinite(ms)) return "";
        try {
            const loc = T.i18n.getLang() === "ko" ? "ko-KR" : T.i18n.getLang() === "ja" ? "ja-JP" : "en-US";
            return new Intl.DateTimeFormat(loc, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
        } catch {
            return "";
        }
    }

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
        const row = T.h("div", { class: "bot-row sb-hit", role: "button", tabindex: "0" }, [
            T.h("span", { class: "bot-avatar", text: initials(bot?.name || "?"), style: `background:${safeColor(bot?.color)}` }),
            T.h("span", { class: "bot-meta" }, [
                T.h("span", { class: "bot-name" }, [
                    document.createTextNode(bot?.name || ""),
                    T.h("span", { class: "sb-hit-time", text: hitTime(hit.at) }),
                ]),
                hitSnippetEl(hit),
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
    // 폴더 탭이 활성이면 그 폴더 소속만 — 검색 중에는 폴더 무관 전체 결과.
    function render() {
        if (!listEl) return;
        listEl.replaceChildren();
        renderTabs();
        // 최근 메시지 순 — 안정 정렬이라 updatedAt이 없는 봇끼리는 에이전트 순서를 유지한다.
        const bots = state.state.bots.filter(matches);
        bots.sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)));
        const active = query ? "" : activeFolderId();
        const shown = active ? bots.filter((b) => folderOf(b) === active) : allExcludesFoldered() ? bots.filter((b) => !folderOf(b)) : bots;
        for (const bot of shown) listEl.append(buildRow(bot));
        if ((!active || query) && todosVisible()) listEl.append(buildTodosRow());
        if (query && msgResults?.length) {
            listEl.append(T.h("div", { class: "sb-sec", text: t("searchMsgs") }));
            for (const hit of msgResults) listEl.append(buildHitRow(hit));
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
    // 프라이빗 모드/스토리지 차단 브라우저에서 localStorage 접근이 SecurityError를
    // 던진다 — 사이드바 초기화 전체가 죽지 않게 접근마다 가드한다.
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
                if (!collapsedState) return;
                collapsedState = false;
                lsSet(C_KEY, "0");
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
            // 바뀐 검색어에 맞지 않는 이전 결과는 즉시 걷어낸다.
            msgResults = null;
            scheduleMsgSearch();
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
        state.on("folders", render);
        state.on("current", render);
        state.on("conversations", () => {
            render();
            hydratePreviews();
        });
        state.on("status", render); // 실행중 점
        // 스트리밍 중 미리보기 갱신 — 토큰마다 전체를 다시 그리지 않게 짧게 묶는다.
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

        initResize();
        renderConn();
        render();
    }

    T.sidebar = { init, hydrate: hydratePreviews, showChat: () => setMobileChat(true), showList: showMobileList, syncRoute };
})((window.Taby = window.Taby || {}));
