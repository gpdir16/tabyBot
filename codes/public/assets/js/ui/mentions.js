/* tabyBot 웹 클라이언트: 그룹 대화방 컴포저의 @멘션 자동 완성.
   커서 앞이 "@이름의 앞부분"이면 방 멤버를 골라 넣는 메뉴를 띄운다. */
((T) => {
    "use strict";

    const { state } = T;
    const box = document.getElementById("composer");
    const input = document.getElementById("composerInput");
    if (!box || !input) return;

    // 커서 바로 앞의 "@앞부분". 줄 처음이나 공백 뒤의 @만 본다(메일 주소의 @는 건드리지 않는다).
    const TRIGGER_RE = /(^|\s)@([^\s@]{0,32})$/u;

    let menu = null;
    let items = []; // [{ bot, el }]
    let active = 0;
    let range = null; // { start, end }: 고르면 바꿔 넣을 "@앞부분"의 자리

    function groupMembers() {
        const chat = state.currentChat();
        if (!chat?.isGroup || T.todosUI?.isOpen?.()) return [];
        return chat.members.map((uuid) => state.botByUuid(uuid)).filter(Boolean);
    }

    function close() {
        if (!menu) return;
        menu.remove();
        menu = null;
        items = [];
        range = null;
        document.removeEventListener("pointerdown", onPointer, true);
    }

    function onPointer(e) {
        if (menu && !menu.contains(e.target) && e.target !== input) close();
    }

    function setActive(i) {
        active = (i + items.length) % items.length;
        items.forEach((it, n) => {
            it.el.classList.toggle("on", n === active);
        });
        items[active]?.el.scrollIntoView({ block: "nearest" });
    }

    function pick(bot) {
        if (!range) return;
        const before = input.value.slice(0, range.start);
        const after = input.value.slice(range.end);
        const inserted = `@${bot.name} `;
        input.value = before + inserted + after.replace(/^ /, "");
        const caret = before.length + inserted.length;
        input.setSelectionRange(caret, caret);
        close();
        input.focus();
        // 컴포저의 높이와 전송 버튼 상태를 맞춘다.
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function place() {
        const r = box.getBoundingClientRect();
        const w = menu.offsetWidth;
        menu.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - w - 8)}px`;
        menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
    }

    function update() {
        const members = groupMembers();
        const caret = input.selectionStart;
        const m = members.length && caret === input.selectionEnd ? TRIGGER_RE.exec(input.value.slice(0, caret)) : null;
        if (!m) {
            close();
            return;
        }
        const query = m[2].toLowerCase();
        const found = members.filter((b) => String(b.name).toLowerCase().startsWith(query));
        if (!found.length) {
            close();
            return;
        }
        range = { start: caret - m[2].length - 1, end: caret };
        if (!menu) {
            menu = T.h("div", { class: "menu cm-hand-menu cm-mention-menu", role: "listbox" });
            document.body.append(menu);
            document.addEventListener("pointerdown", onPointer, true);
        }
        items = found.map((bot) => ({
            bot,
            el: T.h(
                "button",
                {
                    type: "button",
                    role: "option",
                    // 누르는 동안 입력창의 포커스를 뺏지 않는다(모바일 키보드가 내려가지 않게).
                    onpointerdown: (e) => e.preventDefault(),
                    onclick: () => pick(bot),
                },
                [T.h("span", { class: "td-dot", style: `background:${T.util.safeColor(bot.color)}` }), T.h("span", { text: bot.name })],
            ),
        }));
        menu.replaceChildren(...items.map((it) => it.el));
        setActive(Math.min(active, items.length - 1));
        place();
    }

    input.addEventListener("input", update);
    input.addEventListener("click", update);
    input.addEventListener("blur", () => setTimeout(close, 120));

    // 메뉴가 떠 있으면 방향키, Enter, Tab, Esc를 컴포저의 전송보다 먼저 받는다(캡처 단계).
    box.addEventListener(
        "keydown",
        (e) => {
            if (!menu || e.isComposing || e.keyCode === 229) return;
            const handled = { ArrowDown: 1, ArrowUp: -1, Enter: 0, Tab: 0, Escape: 0 };
            if (!(e.key in handled)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") close();
            else if (e.key === "Enter" || e.key === "Tab") pick(items[active].bot);
            else setActive(active + handled[e.key]);
        },
        true,
    );

    state.on("current", close);
})(window.Taby);
