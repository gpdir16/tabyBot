/* tabyBot 웹 클라이언트: 공용 DOM 유틸(엘리먼트 생성, 아이콘, 아바타, 클립보드).
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

    // 이름 첫 글자(아바타에 들어가는 글자).
    function initial(name) {
        return ([...String(name || "?").trim()][0] || "?").toUpperCase();
    }

    // 아바타 칸 하나를 채운다: 프로필 사진이 있으면 사진, 없으면 색 원 안의 이름 첫 글자.
    // who는 { uuid, name, color, avatar }(에이전트 또는 그룹 대화방). avatar는 사진 버전이고 주소에 붙는다.
    function avatarFace(el, who) {
        const photo = who?.avatar && who.uuid ? T.api.avatarHref(who.uuid, who.avatar) : "";
        el.classList.toggle("has-img", Boolean(photo));
        if (photo) {
            el.style.backgroundColor = "";
            el.replaceChildren(h("img", { class: "avatar-img", src: photo, alt: "", draggable: "false" }));
            return el;
        }
        el.textContent = initial(who?.name);
        el.style.backgroundColor = T.util.safeColor(who?.color);
        return el;
    }

    // 그룹 대화방 아바타: iOS 메시지처럼 멤버 아바타 몇 개를 겹쳐 놓는다.
    // members는 에이전트 목록(멤버 순서). 둘은 대각선, 셋은 삼각형, 넷부터는 2×2이고 다섯부터 마지막 칸은 +n이다.
    // 크기는 감싸는 요소가 정한다(목록은 .bot-avatar, 헤더는 .hdr-avatar 안에 꽉 차게).
    function groupAvatar(members, extraClass) {
        const list = (members || []).filter(Boolean);
        const n = Math.min(list.length, 4);
        const wrap = h("span", { class: `group-avatar ga-${Math.max(n, 2)}${extraClass ? ` ${extraClass}` : ""}`, "aria-hidden": "true" });
        if (!list.length) {
            // 멤버를 아직 못 받았으면 여러 사람 아이콘으로 둔다.
            wrap.classList.add("ga-empty");
            wrap.append(icon("users", "icon-sm"));
            return wrap;
        }
        const shown = list.length > 4 ? list.slice(0, 3) : list.slice(0, 4);
        for (const m of shown) wrap.append(avatarFace(h("span", { class: "ga-dot" }), m));
        if (list.length > 4) wrap.append(h("span", { class: "ga-dot ga-more", text: `+${list.length - 3}` }));
        return wrap;
    }

    // 목록 행의 아바타: 프로필 사진이 있으면 사진, 없으면 에이전트는 이름 첫 글자, 그룹 대화방은 멤버 아바타를 겹친 묶음.
    // chat은 state.chats()의 한 항목(에이전트 또는 그룹 대화방).
    function chatAvatar(chat, cls = "bot-avatar") {
        if (chat?.isGroup && !chat.avatar) return h("span", { class: `${cls} group-wrap` }, [groupAvatar(T.state.groupMembers(chat))]);
        return avatarFace(h("span", { class: cls }), chat);
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

    T.h = h;
    T.icon = icon;
    T.initial = initial;
    T.avatarFace = avatarFace;
    T.groupAvatar = groupAvatar;
    T.chatAvatar = chatAvatar;
    T.copyText = copyText;
    T.visibleHeight = visibleHeight;
})(window.Taby);
