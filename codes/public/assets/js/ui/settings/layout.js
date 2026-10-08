/* tabyBot 웹 클라이언트: 설정 페이지의 화면 구성(목록·상세·열 배치·뒤로 제스처). */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("settingsPage");
    const mobileMq = window.matchMedia("(max-width: 860px)");
    const isMobile = () => mobileMq.matches;
    const VIEW_MS = 420; // 화면이 밀려 들어오고 나가는 시간(app.css의 --nav-dur와 같게)

    /* ── 프레임 ─────────────────────────────────────────────
       화면 하나(.sp-view)는 머리(뒤로 버튼 + 제목)와 본문(목록 + 상세)으로 이뤄진다.
       모바일에서는 data-view에 따라 목록과 상세 중 하나만 보인다. */
    const NAV = [
        [
            { id: "general", label: "general", icon: "settings", color: "#8e8e93" },
            { id: "folders", label: "folders", icon: "folder", color: "#0a84ff" },
            { id: "notices", label: "notices", icon: "bell", color: "#ff453a" },
        ],
        [
            { id: "provider", label: "provider", icon: "cloud", color: "#5e5ce6" },
            { id: "model", label: "model", icon: "cpu", color: "#bf5af2" },
            { id: "account", label: "account", icon: "person", color: "#30d158" },
        ],
        [
            { id: "selfimprovement", label: "selfImprovement", icon: "sparkles", color: "#ff9f0a" },
            { id: "skills", label: "skills", icon: "book", color: "#40c8e0" },
            { id: "mcp", label: "mcpTab", icon: "plug", color: "#636366" },
            { id: "secrets", label: "secretsTab", icon: "lock", color: "#ff375f" },
        ],
    ];

    // 편집 폼이 열려 있는가(상세에서 한 단계 더 들어간 화면).
    function formOpen() {
        return !!(C.folderEditing || C.skillEditing || C.mcpEditing || C.secretEditing);
    }

    function closeForm() {
        C.folderEditing = null;
        C.skillEditing = null;
        C.mcpEditing = null;
        C.secretEditing = null;
        build();
    }

    function formTitle() {
        if (C.folderEditing)
            return C.folderEditing.mode === "new" ? t("folderNew") : C.folderList().find((f) => f.id === C.folderEditing.id)?.name || t("folders");
        if (C.skillEditing) return C.skillEditing.mode === "new" ? t("addSkill") : C.skillEditing.name;
        if (C.mcpEditing) return C.mcpEditing.mode === "new" ? t("addMcpServer") : C.mcpEditing.name;
        if (C.secretEditing) return C.secretEditing.mode === "new" ? t("addSecret") : C.secretEditing.name;
        return "";
    }

    function tabTitle(tab, agentId) {
        if (tab === "root") return t("settings");
        if (tab === "agents") return agentId === "__new__" ? t("addAgent") : C.agentList().find((a) => a.id === agentId)?.name || t("agents");
        const item = NAV.flat().find((x) => x.id === tab);
        return item ? t(item.label) : t("settings");
    }

    // 목록의 한 행: 색 타일(또는 에이전트 아바타) + 이름 + 꺾쇠(모바일).
    function navItem({ active, label, tile, accent, onclick }) {
        return T.h(
            "button",
            {
                class: `sp-item${active ? " active" : ""}${accent ? " accent" : ""}`,
                role: "tab",
                "aria-selected": String(!!active),
                tabindex: active ? "0" : "-1",
                onclick,
            },
            [tile, T.h("span", { class: "sp-item-label", text: label }), T.icon("chevron", "sp-item-chev")],
        );
    }

    function buildNav(tab, agentId) {
        const groups = NAV.map((items) =>
            T.h(
                "div",
                { class: "sp-nav-group" },
                items.map((x) =>
                    navItem({
                        active: tab === x.id,
                        label: t(x.label),
                        tile: T.h("span", { class: "sp-tile sym", style: `--tile:${x.color}` }, [T.icon(x.icon)]),
                        onclick: () => C.navigate(x.id, null),
                    }),
                ),
            ),
        );
        const agents = C.agentList().map((a) =>
            navItem({
                active: tab === "agents" && agentId === a.id,
                label: a.name || "?",
                tile: T.h("span", {
                    class: "sp-tile round",
                    text: ([...String(a.name || "?").trim()][0] || "?").toUpperCase(),
                    style: /^#[0-9a-f]{6}$/i.test(String(a.color || "")) ? `background-color:${a.color}` : null,
                }),
                onclick: () => C.navigate("agents", a.id),
            }),
        );
        agents.push(
            navItem({
                active: tab === "agents" && agentId === "__new__",
                label: t("addAgent"),
                accent: true,
                tile: T.h("span", { class: "sp-tile plain" }, [T.icon("plus")]),
                onclick: () => C.navigate("agents", "__new__"),
            }),
        );
        return T.h("nav", { class: "sp-nav", role: "tablist", "aria-label": t("settings") }, [
            ...groups,
            T.h("div", { class: "sp-nav-head", text: t("agents") }),
            T.h("div", { class: "sp-nav-group" }, agents),
        ]);
    }

    // mark: 목록에서 강조할 항목({ tab, agentId }). 데스크톱의 목록 열이 옆에 열린 상세를 가리킬 때 쓴다.
    function buildView(tab = C.openTab, agentId = C.editingAgent, mark = null) {
        const title = T.h("div", { class: "sp-title", text: tabTitle(tab, agentId) });
        const head = T.h("header", { class: "sp-head" }, [
            // 채팅 헤더와 같은 점진적 블러: 내용이 헤더 밑으로 흐려지며 지나간다.
            T.h(
                "div",
                { class: "pblur", "aria-hidden": "true" },
                Array.from({ length: 8 }, () => T.h("i")),
            ),
            // 데스크톱에서 사이드바가 접힌 상태로 설정에 들어오면 채팅 헤더(메뉴 버튼)가
            // 숨겨져 다시 펼칠 방법이 없다. 접힌 때만 보이는 펼치기 버튼을 둔다.
            T.h(
                "button",
                {
                    class: "btn-icon sp-expand",
                    "aria-label": t("menu"),
                    onclick() {
                        T.sidebar?.expand?.();
                    },
                },
                [T.icon("menu")],
            ),
            // 뒤로 버튼: 폼에서는 상세로, 상세에서는 설정 목록으로, 목록에서는 대화 목록으로 돌아간다.
            // (데스크톱에서는 그 열을 닫는 버튼이다. 목록 열에는 보이지 않는다.)
            T.h(
                "button",
                {
                    class: "btn-icon sp-back",
                    "aria-label": t("back"),
                    onclick(e) {
                        const level = e.currentTarget.closest(".sp-view")?.dataset.level;
                        if (level === "2") {
                            closeForm();
                            return;
                        }
                        if (level === "1") {
                            C.popToRoot();
                            return;
                        }
                        T.sidebar?.showList();
                        T.app?.renderRoute();
                    },
                },
                [T.icon("chevron-left")],
            ),
            title,
        ]);

        const body = T.h("div", { class: "sp-body" });
        if (tab === "general") C.buildGeneral(body);
        else if (tab === "folders") C.buildFolders(body);
        else if (tab === "notices") C.buildNotices(body);
        else if (tab === "provider") C.buildProvider(body);
        else if (tab === "model") C.buildModel(body);
        else if (tab === "account") C.buildAccount(body);
        else if (tab === "selfimprovement") C.buildSelfImprovement(body);
        else if (tab === "skills") C.buildSkills(body);
        else if (tab === "mcp") C.buildMcp(body);
        else if (tab === "secrets") C.buildSecrets(body);
        else if (tab === "agents") C.buildAgents(body);
        groupRows(body);

        // 깊이: 목록 0, 상세 1, 편집 폼 2. 깊이가 달라지면 화면이 밀려 들어오고 나간다.
        // (폼 여부는 본문을 그린 뒤에 본다. 지워진 대상의 폼은 그리는 중에 닫힌다.)
        const form = tab !== "root" && formOpen();
        if (form) title.textContent = formTitle();
        const level = tab === "root" ? 0 : form ? 2 : 1;
        return T.h(
            "div",
            {
                class: "sp-view",
                dataset: { view: tab === "root" ? "root" : "detail", level: String(level), key: C.pathFor(tab, agentId) + (form ? "#form" : "") },
            },
            [head, T.h("div", { class: "sp-main" }, [buildNav(mark ? mark.tab : tab, mark ? mark.agentId : agentId), body])],
        );
    }

    // 이어진 설정 행들을 둥근 묶음(.set-group) 하나로 감싼다. 탭마다 행을 그냥 늘어놓아도 묶음 목록이 된다.
    function groupRows(root) {
        for (const box of [root, ...root.querySelectorAll(".set-section, .agent-editor, .adv-panel")]) {
            let run = null;
            for (const el of [...box.children]) {
                if (el.matches(".set-row, .ext-row")) {
                    if (!run) {
                        run = T.h("div", { class: "set-group" });
                        el.before(run);
                    }
                    run.append(el);
                } else {
                    run = null;
                }
            }
        }
    }

    // 화면을 다시 그린다. 깊이가 달라졌으면 모바일에서 새 화면이 밀려 들어오고(깊어질 때) 옛 화면이 밀려 나간다(얕아질 때).
    // 같은 화면을 다시 그릴 때는 스크롤 위치를 지킨다.
    function build() {
        if (!isMobile()) {
            buildColumns();
            return;
        }
        const prev = page.querySelector(".sp-view:not(.sp-leaving)");
        const view = buildView();
        const sameKey = prev && prev.dataset.key === view.dataset.key;
        const depth = prev ? Number(view.dataset.level) - Number(prev.dataset.level) : 0;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const anim = depth && isMobile() && !reduce ? (depth > 0 ? "push" : "pop") : null;
        // 화면이 움직이는 중에 통째로 갈아 끼우면 애니메이션이 끊기고 제스처가 죽는다.
        // (모델·스킬 목록이 도착하거나 설정 이벤트가 올 때) 다 움직인 뒤에 한 번 그린다.
        if (!anim && C.viewBusy) {
            C.rebuildPending = true;
            return;
        }
        clearTimeout(C.viewTimer);
        for (const el of page.querySelectorAll(".sp-leaving")) el.remove();
        const scrollBody = sameKey ? prev.querySelector(".sp-body")?.scrollTop || 0 : 0;
        // 모바일 목록은 떠날 때 기억해 둔 위치로, 그 밖에는 직전 화면의 목록 위치로 되돌린다.
        const scrollNav = view.dataset.view === "root" && !sameKey ? C.rootScroll : prev?.querySelector(".sp-nav")?.scrollTop || 0;
        if (anim) {
            // 얕아질 때 드러나는 화면은 떠날 때 보던 위치 그대로 나타난다.
            const back = anim === "pop" ? leftScroll.get(view.dataset.key) || 0 : 0;
            if (anim === "push") leftScroll.set(prev.dataset.key, prev.querySelector(".sp-body")?.scrollTop || 0);
            prev.classList.add("sp-leaving", anim === "push" ? "sp-out-left" : "sp-out-right");
            view.classList.add(anim === "push" ? "sp-in-right" : "sp-in-left");
            // 위에 놓이는 쪽이 뒤에 온다: 들어갈 때는 새 화면이, 나올 때는 옛 화면이 위다.
            if (anim === "push") page.append(view);
            else page.prepend(view);
            if (back) view.querySelector(".sp-body").scrollTop = back;
            C.viewBusy = true;
            C.viewTimer = setTimeout(() => {
                prev.remove();
                view.classList.remove("sp-in-right", "sp-in-left");
                settleView();
            }, VIEW_MS);
        } else {
            C.viewBusy = false;
            C.rebuildPending = false;
            page.replaceChildren(view);
        }
        if (scrollBody) view.querySelector(".sp-body").scrollTop = scrollBody;
        const nav = view.querySelector(".sp-nav");
        if (scrollNav) nav.scrollTop = scrollNav;
        // 데스크톱 목록에서 선택된 항목이 화면 밖에 있을 수 있으므로 보이게 스크롤한다.
        if (!isMobile()) nav.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    }

    // 더 깊은 화면으로 들어갈 때 떠난 화면의 스크롤 위치(화면 key → scrollTop).
    const leftScroll = new Map();

    // 데스크톱: 목록 · 상세 · 편집 폼을 바꿔 끼우지 않고 왼쪽부터 열로 나란히 놓는다.
    // 새 열이 생기면 그 열이 보이도록 앱의 가로 스크롤을 옮긴다.
    function buildColumns() {
        clearTimeout(C.viewTimer);
        C.viewBusy = false;
        C.rebuildPending = false;
        const live = [...page.querySelectorAll(".sp-view:not(.col-out)")];
        const old = new Map(live.map((v) => [v.dataset.key, v]));
        const views = [buildView("root", null, { tab: C.openTab, agentId: C.editingAgent })];
        if (C.openTab !== "root") {
            // 폼이 열려 있으면 폼을 먼저 그린다(지워진 대상의 폼은 그리는 중에 닫힌다).
            const top = buildView();
            if (top.dataset.level === "2") {
                // 폼을 잠깐 닫은 것으로 치고 그 밑의 상세 화면을 그린다.
                const saved = [C.folderEditing, C.skillEditing, C.mcpEditing, C.secretEditing];
                C.folderEditing = C.skillEditing = C.mcpEditing = C.secretEditing = null;
                views.push(buildView());
                [C.folderEditing, C.skillEditing, C.mcpEditing, C.secretEditing] = saved;
            }
            views.push(top);
        }
        // 같은 열을 다시 그릴 때는 스크롤 위치를 지킨다.
        const scrolls = views.map((v) => {
            const was = old.get(v.dataset.key);
            return was ? [was.querySelector(".sp-nav").scrollTop, was.querySelector(".sp-body").scrollTop] : null;
        });
        const added = views.filter((v) => !old.has(v.dataset.key));
        const gone = live.filter((v) => !views.some((n) => n.dataset.key === v.dataset.key));
        // 열고 닫는 움직임(app.css의 col-in / col-out): 새 열은 왼쪽 이웃 밑에서 미끄러져 나오고, 닫힌 열은 그 밑으로 들어간다.
        // 같은 자리의 열이 다른 것으로 바뀔 때(다른 항목을 고름)는 움직이지 않고 바로 바뀐다. 목록 열은 늘 있으므로 뺀다.
        const sameLevel = (list, v) => list.some((x) => x.dataset.level === v.dataset.level);
        for (const v of views) if (v.dataset.view !== "root") T.columnIn(v, `s:${v.dataset.key}`, added.includes(v) && !sameLevel(gone, v));
        // 아직 닫히는 중인 열과 이번에 닫힌 열은 맨 뒤(원래 있던 자리)에 남겨 두었다가 다 움직이면 치운다.
        const leaving = [...page.querySelectorAll(".sp-view.col-out"), ...gone.filter((v) => !sameLevel(added, v))].filter(
            (v) => !views.some((n) => n.dataset.key === v.dataset.key),
        );
        page.replaceChildren(...views, ...leaving);
        for (const v of leaving) T.columnOut(v);
        views.forEach((v, i) => {
            if (!scrolls[i]) return;
            v.querySelector(".sp-nav").scrollTop = scrolls[i][0];
            v.querySelector(".sp-body").scrollTop = scrolls[i][1];
        });
        // 목록 열의 선택 항목이 가려져 있으면 그 열 안에서만 세로로 맞춘다.
        // (scrollIntoView는 앱의 가로 스크롤까지 옮겨서, 오른쪽 열을 보고 있던 자리를 빼앗는다.)
        const nav = views[0].querySelector(".sp-nav");
        const act = nav.querySelector(".active");
        if (act) {
            const n = nav.getBoundingClientRect();
            const a = act.getBoundingClientRect();
            const top = n.top + (parseFloat(getComputedStyle(nav).paddingTop) || 0);
            if (a.top < top) nav.scrollTop -= top - a.top;
            else if (a.bottom > n.bottom) nav.scrollTop += a.bottom - n.bottom;
        }
        // 열이 새로 생겼으면 맨 오른쪽 열까지 보이게 한다.
        if (added.length) T.revealColumn(views[views.length - 1]);
    }

    // 화면이 다 움직였다. 그사이 미뤄 둔 다시 그리기가 있으면 지금 한다.
    function settleView() {
        C.viewBusy = false;
        if (!C.rebuildPending) return;
        C.rebuildPending = false;
        if (C.openTab && !page.hidden) build();
    }

    /* 뒤로 제스처(ui/gestures.js)가 위 화면을 손가락으로 밀어낼 때 쓴다.
       begin: 지금 화면 밑에 한 단계 얕은 화면(폼이면 상세, 상세면 목록)을 깔아 두고 두 화면을 돌려준다.
       end: 끝까지 밀었으면 그 화면으로 넘어가고, 아니면 깔아 둔 것을 치운다. */
    const gesture = {
        canPop: () => isMobile() && !!C.openTab && C.openTab !== "root" && !page.hidden,
        begin() {
            clearTimeout(C.viewTimer);
            // 지난 전환이나 제스처가 남긴 화면을 치우고, 지금 보이는 화면 하나만 남긴다.
            const views = [...page.querySelectorAll(".sp-view")];
            const top = views.find((v) => !v.classList.contains("sp-leaving") && v.dataset.view !== "root") || views[views.length - 1];
            for (const v of views) if (v !== top) v.remove();
            top.classList.remove("sp-in-right", "sp-in-left");
            const fromForm = top.dataset.level === "2";
            let under;
            if (fromForm) {
                // 폼을 잠깐 닫은 것으로 치고 상세 화면을 그린다.
                const saved = [C.folderEditing, C.skillEditing, C.mcpEditing, C.secretEditing];
                C.folderEditing = C.skillEditing = C.mcpEditing = C.secretEditing = null;
                under = buildView();
                [C.folderEditing, C.skillEditing, C.mcpEditing, C.secretEditing] = saved;
            } else {
                under = buildView("root", null);
            }
            page.prepend(under);
            if (fromForm) under.querySelector(".sp-body").scrollTop = leftScroll.get(under.dataset.key) || 0;
            else under.querySelector(".sp-nav").scrollTop = C.rootScroll;
            C.viewBusy = true;
            return { top, under, fromForm };
        },
        end(commit, { top, under, fromForm }) {
            if (!commit) {
                under.remove();
                settleView();
                return;
            }
            // 이미 손가락을 따라 다 넘어왔으므로 애니메이션 없이 상태만 바꾼다.
            top.remove();
            C.viewBusy = false;
            C.rebuildPending = false;
            if (fromForm) {
                // 깔아 둔 상세 화면이 그대로 지금 화면이 된다.
                C.folderEditing = C.skillEditing = C.mcpEditing = C.secretEditing = null;
                return;
            }
            C.openTab = "root";
            C.editingAgent = null;
            C.popToRoot();
        },
    };

    // 입력 중 재렌더 방지: 시트 내부에 포커스가 있으면 스킵
    function rebuildIfIdle() {
        if (C.openTab == null) return;
        const ae = document.activeElement;
        if (ae && page.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
        build();
    }

    C.build = build;
    C.gesture = gesture;
    C.rebuildIfIdle = rebuildIfIdle;
})(window.Taby);
