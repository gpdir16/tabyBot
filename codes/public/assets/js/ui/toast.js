/* tabyBot 웹 클라이언트 — 토스트.
   상단 중앙, 3초 자동 소멸. level(info/warn/error)별 아이콘 색.
   SSE notice 이벤트와 API 실패 안내에 사용된다. */
(function (T) {
    "use strict";

    const root = document.getElementById("toasts");
    const ICONS = { info: "info", warn: "warn", error: "error" };

    function show(level, text, onTap) {
        if (!root) return;
        const el = T.h("div", { class: "toast " + (ICONS[level] ? level : "info") + (onTap ? " tap" : "") }, [
            T.icon(ICONS[level] || "info"),
            T.h("span", { text: String(text == null ? "" : text) }),
        ]);
        if (onTap) {
            el.setAttribute("role", "button");
            el.setAttribute("tabindex", "0");
            const go = () => {
                el.remove();
                onTap();
            };
            el.addEventListener("click", go);
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    go();
                }
            });
        }
        root.appendChild(el);
        // 표시 트랜지션용 더블 rAF
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
        setTimeout(() => {
            el.classList.remove("in");
            el.classList.add("out");
            setTimeout(() => el.remove(), 260);
        }, 3000);
        while (root.children.length > 4) root.firstChild.remove();
    }

    T.toast = { show };
})((window.Taby = window.Taby || {}));
