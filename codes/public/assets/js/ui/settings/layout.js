/* tabyBot 웹 클라이언트: 설정 목록 창("s")과 탭 창("s.<탭>")의 등록.
   목록은 탭과 에이전트를 늘어놓은 창이고, 항목을 누르면 그 오른쪽에 그 탭의 창이 열린다.
   탭의 본문은 그 탭의 모듈(general.js, models.js, …)이 defineTab으로 넘긴 함수가 그린다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    const NAV = [
        [
            { id: "general", label: "general", icon: "settings", color: "#8e8e93" },
            { id: "folders", label: "folders", icon: "folder", color: "#0a84ff" },
            { id: "notices", label: "notices", icon: "bell", color: "#ff453a" },
        ],
        [
            { id: "model", label: "modelsTab", icon: "cpu", color: "#bf5af2" },
            { id: "account", label: "account", icon: "person", color: "#30d158" },
            { id: "efficiency", label: "efficiency", icon: "gauge", color: "#32ade6" },
        ],
        [
            { id: "selfimprovement", label: "selfImprovement", icon: "sparkles", color: "#ff9f0a" },
            { id: "skills", label: "skills", icon: "book", color: "#40c8e0" },
            { id: "mcp", label: "mcpTab", icon: "plug", color: "#636366" },
            { id: "secrets", label: "secretsTab", icon: "lock", color: "#ff375f" },
        ],
    ];

    // 목록의 한 행: 색 타일(또는 에이전트 아바타) + 이름 + 꺾쇠.
    function navItem({ label, tile, onclick }) {
        return T.h("button", { type: "button", class: "sp-item", onclick }, [
            tile,
            T.h("span", { class: "sp-item-label", text: label }),
            T.icon("chevron", "sp-item-chev"),
        ]);
    }

    function buildNav(body, win) {
        const groups = NAV.map((items) =>
            T.h(
                "div",
                { class: "sp-nav-group" },
                items.map((x) =>
                    navItem({
                        label: t(x.label),
                        tile: T.h("span", { class: "sp-tile sym", style: `--tile:${x.color}` }, [T.icon(x.icon)]),
                        onclick: () => win.open(`s.${x.id}`),
                    }),
                ),
            ),
        );
        const agents = C.agentList().map((a) =>
            navItem({
                label: a.name || "?",
                tile: T.avatarFace(T.h("span", { class: "sp-tile round" }), a),
                onclick: () => win.open(`s.agent:${a.id}`),
            }),
        );
        body.append(
            T.h("nav", { class: "sp-nav", "aria-label": t("settings") }, [
                ...groups,
                T.h("div", { class: "sp-nav-head", text: t("agents") }),
                T.h("div", { class: "sp-nav-group" }, agents),
            ]),
        );
    }

    T.windows.define("s", () => ({
        title: () => t("settings"),
        on: ["bots", "settings"],
        build: buildNav,
    }));

    // 탭 창을 등록한다. spec: { build(body, win), on?: 상태 이벤트(기본 settings), onClose?(win),
    //   item?(arg, data): 같은 종류에 인자가 붙은 창("s.<tab>:<arg>", 예: MCP 서버 편집)의 화면 }
    function defineTab(tab, spec) {
        const item = NAV.flat().find((x) => x.id === tab);
        T.windows.define(`s.${tab}`, (arg, data) => {
            if (arg != null) return spec.item ? spec.item(arg, data) : null;
            return { title: () => t(item.label), on: spec.on || ["settings"], build: spec.build, onClose: spec.onClose };
        });
    }

    // 이 조건에 맞는 창이 더는 열려 있지 않은지. 창을 닫은 뒤(onClose)에 그 무리의 캐시를 버릴 때 쓴다.
    function noneOpen(pred) {
        return !T.windows.list().some(pred);
    }

    // 창 안의 입력칸에 포커스가 있는지(그 창을 다시 그리면 입력 중인 글자를 잃는다).
    function typingIn(win) {
        const ae = document.activeElement;
        return !!ae && win.el.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    }

    C.defineTab = defineTab;
    C.noneOpen = noneOpen;
    C.typingIn = typingIn;
})(window.Taby);
