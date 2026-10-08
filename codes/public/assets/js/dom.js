/* tabyBot 웹 클라이언트: 공용 DOM 유틸(엘리먼트 생성, 아이콘, 클립보드, 열 배치 애니메이션).
   전역 네임스페이스 Taby 아래에 부착된다(Chrome file:// 모듈 CORS 회피). */
((T) => {
    "use strict";

    // 속성 하나를 엘리먼트에 적용한다. on* 속성은 이벤트 리스너, 나머지는 키에 맞는 DOM 속성.
    function applyAttr(el, key, value) {
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key === "html") throw new Error("HTML 속성은 XSS 방지를 위해 지원하지 않는다. 마크다운 파이프라인을 사용한다.");
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else if (key === "dataset") Object.assign(el.dataset, value);
        else if (key === "style") el.style.cssText = value;
        else el.setAttribute(key, value === true ? "" : value);
    }

    // 엘리먼트 생성 헬퍼: h('div', {class:'x', onclick:fn, text:'...'}, [children])
    function h(tag, attrs, children) {
        const el = document.createElement(tag);
        for (const key in attrs) {
            const value = attrs[key];
            if (value != null && value !== false) applyAttr(el, key, value);
        }
        for (const child of children || []) {
            if (child != null && child !== false) el.append(child);
        }
        return el;
    }

    // 스프라이트 아이콘: icon('copy')는 <svg class="icon"><use href="#i-copy"/></svg>를 만든다.
    const SVG_NS = "http://www.w3.org/2000/svg";
    function icon(name, extraClass) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", `icon${extraClass ? ` ${extraClass}` : ""}`);
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(SVG_NS, "use");
        use.setAttribute("href", `#i-${name}`);
        svg.appendChild(use);
        return svg;
    }

    // 클립보드 복사(file:// 폴백 포함). 성공 여부 반환.
    function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext !== false) {
                return navigator.clipboard.writeText(text).then(
                    () => true,
                    () => fallbackCopy(text),
                );
            }
        } catch (_) {
            /* 폴백으로 진행 */
        }
        return Promise.resolve(fallbackCopy(text));
    }
    function fallbackCopy(text) {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;opacity:0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }

    // 키보드를 뺀 실제로 보이는 높이. iOS는 키보드가 열려도 innerHeight가 줄지 않으므로
    // 떠 있는 메뉴/팝오버를 화면 안으로 클램프할 때는 이 값을 기준으로 한다.
    function visibleHeight() {
        return Math.min(window.innerHeight, window.visualViewport?.height || Infinity);
    }

    // 데스크톱의 열 배치(app.css의 데스크톱 구획): 새로 열린 열이 창 밖에 걸쳐 있으면 앱의 가로 스크롤을 옮겨 다 보이게 한다.
    // 브라우저의 부드러운 스크롤은 그사이 포커스가 옮겨지거나 열을 다시 그리면 그 자리에서 멈추므로 직접 움직인다.
    let revealRaf = 0;
    function revealColumn(el) {
        const app = document.getElementById("app");
        if (!app || !el?.isConnected) return;
        cancelAnimationFrame(revealRaf);
        const a = app.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        // 열리는 중인 열은 아직 왼쪽 이웃 밑에 겹쳐 있다(app.css의 colIn). 다 열렸을 때의 자리를 기준으로 한다.
        const tucked = -Math.min(0, parseFloat(getComputedStyle(el).marginLeft) || 0);
        const right = r.right + tucked;
        const leftEdge = r.left + tucked;
        let delta = 0;
        if (right > a.right) delta = right - a.right;
        // 열이 창보다 넓으면 왼쪽 끝을 맞춘다.
        if (leftEdge - delta < a.left) delta = leftEdge - a.left;
        if (Math.abs(delta) < 1) return;
        const from = app.scrollLeft;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            app.scrollLeft = from + delta;
            return;
        }
        // 열이 열리는 시간과 같게 움직인다. 스크롤할 수 있는 폭도 그동안 같이 늘어난다.
        const DUR = COL_IN_MS;
        const t0 = performance.now();
        // 사용자가 직접 스크롤하기 시작하면 그만둔다.
        const stop = () => cancelAnimationFrame(revealRaf);
        app.addEventListener("wheel", stop, { once: true, passive: true });
        const step = (now) => {
            const p = Math.min(1, (now - t0) / DUR);
            app.scrollLeft = from + delta * (1 - (1 - p) ** 4);
            if (p < 1) revealRaf = requestAnimationFrame(step);
            else app.removeEventListener("wheel", stop);
        };
        revealRaf = requestAnimationFrame(step);
    }

    // 데스크톱의 새 열이 미끄러져 들어오는 애니메이션(app.css의 col-in)을 건다.
    // 열은 들어오는 도중에도 통째로 다시 그려질 수 있으므로(목록이 도착하는 등), 시작한 때를 key별로 기억해 두고
    // 다시 그려진 열에는 지난 시간만큼 앞당겨서 이어 붙인다. fresh: 이번에 새로 생긴 열인지.
    const COL_IN_MS = 420; // app.css의 --nav-dur와 같게
    const colInAt = new Map();
    function columnIn(el, key, fresh) {
        const now = performance.now();
        if (fresh) colInAt.set(key, now);
        const t0 = colInAt.get(key);
        if (t0 == null) return;
        const gone = now - t0;
        if (gone >= COL_IN_MS) {
            colInAt.delete(key);
            return;
        }
        el.classList.add("col-in");
        el.style.animationDelay = `${-gone}ms`;
    }

    // 닫히는 열: 왼쪽 이웃 열 밑으로 미끄러져 들어간 뒤 치워진다(app.css의 col-out).
    function columnOut(el) {
        if (el.classList.contains("col-out")) {
            // 닫히는 도중 화면이 다시 그려져 문서에 다시 붙었다. 애니메이션이 처음부터 돌지 않게 지난 만큼 앞당긴다.
            el.style.animationDelay = `${-(performance.now() - (colOutAt.get(el) || performance.now()))}ms`;
            return;
        }
        colOutAt.set(el, performance.now());
        el.classList.remove("col-in");
        el.style.animationDelay = "";
        el.classList.add("col-out");
        if (el.contains(document.activeElement)) document.activeElement.blur();
        setTimeout(() => el.remove(), COL_IN_MS);
    }
    const colOutAt = new WeakMap();

    T.h = h;
    T.icon = icon;
    T.copyText = copyText;
    T.visibleHeight = visibleHeight;
    T.revealColumn = revealColumn;
    T.columnIn = columnIn;
    T.columnOut = columnOut;
})(window.Taby);
