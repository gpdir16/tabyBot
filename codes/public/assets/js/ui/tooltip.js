/* tabyBot 웹 클라이언트 — 전역 툴팁.
   overflow 컨테이너 안에서 의사 요소 툴팁이 잘리지 않도록 fixed 레이어로 표시한다. */
(function (T) {
    "use strict";

    const TOOLTIP_ID = "globalTooltip";
    let tooltipEl = null;
    let currentTarget = null;

    function ensureTooltip() {
        if (tooltipEl) return tooltipEl;
        tooltipEl = T.h("div", { id: TOOLTIP_ID, role: "tooltip" });
        document.body.append(tooltipEl);
        return tooltipEl;
    }

    function place(target) {
        if (!target || !target.isConnected) return;
        ensureTooltip();
        const rect = target.getBoundingClientRect();
        const text = target.getAttribute("data-tip") || "";
        tooltipEl.textContent = text;

        const above = rect.top >= 42;
        const left = Math.min(Math.max(rect.left + rect.width / 2, 12), window.innerWidth - 12);
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = above ? `${rect.top - 7}px` : `${rect.bottom + 7}px`;
        tooltipEl.style.transform = `translate(-50%, ${above ? "-100%" : "0"}) translateY(${above ? "-2px" : "2px"})`;
        tooltipEl.classList.add("visible");
    }

    function hide() {
        currentTarget = null;
        tooltipEl?.classList.remove("visible");
        if (tooltipEl) tooltipEl.textContent = "";
    }

    function isTipVisible(el) {
        if (!el || !el.isConnected || el.disabled) return false;
        if (el.classList.contains("hidden")) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function handleOver(event) {
        // 터치 탭에는 툴팁을 띄우지 않는다 (네이티브 앱에는 호버 툴팁이 없음)
        if (event.pointerType === "touch") return;
        const target = event.target.closest("[data-tip]");
        if (!isTipVisible(target)) {
            hide();
            return;
        }
        currentTarget = target;
        place(target);
    }

    function init() {
        document.addEventListener("pointerover", handleOver);
        document.addEventListener("pointerout", (event) => {
            if (!currentTarget) return;
            if (event.target === currentTarget && !event.relatedTarget?.closest?.("[data-tip]")) hide();
        });
        document.addEventListener("pointerdown", hide, true);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") hide();
        });
        document.addEventListener("scroll", hide, { passive: true, capture: true });
        window.addEventListener("resize", hide);
        window.addEventListener("blur", hide);
        if (T.i18n && T.i18n.onChange) T.i18n.onChange(hide);
    }

    T.tooltip = { init, hide };
})((window.Taby = window.Taby || {}));
