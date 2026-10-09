/* tabyBot 웹 클라이언트: 설정 탭들이 같이 쓰는 입력 컴포넌트. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    // 이름이 붙은 항목의 삭제 확인. 확인하면 true.
    function confirmDelete(name) {
        return T.confirm({
            title: t("confirmDeleteTitle", { name }),
            text: t("confirmDeleteText"),
            confirmLabel: t("delete"),
            danger: true,
        });
    }

    /* ── 공통 컴포넌트 ──────────────────────────────────────── */
    function switchEl(checked, onChange, label) {
        const input = T.h("input", { type: "checkbox", "aria-label": label || "" });
        input.checked = !!checked;
        input.addEventListener("change", () => onChange(input.checked));
        return T.h("label", { class: "switch" }, [input, T.h("span", { class: "tr" }), T.h("span", { class: "kn" })]);
    }

    function settingSelect(options, current, onPick, label) {
        const select = T.h("select", { "aria-label": label || "" });
        for (const o of options) {
            const option = T.h("option", { value: o.value, text: o.label });
            option.selected = o.value === current;
            select.append(option);
        }
        select.addEventListener("change", () => onPick(select.value));
        return T.h("div", { class: "select-wrap" }, [select, T.icon("chevron")]);
    }

    function fieldLabel(text) {
        return T.h("div", { class: "field-label", text });
    }

    /* ── 계정 탭 ─────────────────────────────────────────── */
    function accountField(labelText, ...kids) {
        return T.h("div", { class: "field" }, [fieldLabel(labelText), ...kids]);
    }

    function accountInput(type, label, autocomplete) {
        const el = T.h("input", { class: "input", type, "aria-label": label, autocomplete, spellcheck: "false" });
        el.addEventListener("keydown", (e) => e.stopPropagation());
        return el;
    }

    /* 비밀 입력(API 키 등): 입력칸 + 보기 토글. 설정과 온보딩에서 공용으로 쓴다.
       onCommit: blur/Enter 시 확정값, onInput: 입력마다 값 전달(온보딩 draft 동기화용). */
    function secretInput({ value = "", placeholder = "", aria = "", onInput, onCommit }) {
        const input = T.h("input", {
            class: "input",
            type: "password",
            value,
            placeholder,
            "aria-label": aria,
            autocomplete: "new-password",
            spellcheck: "false",
        });
        const eye = T.h(
            "button",
            {
                class: "btn-icon",
                "aria-label": t("showApiKey"),
                "aria-pressed": "false",
                onclick() {
                    const show = input.type === "password";
                    input.type = show ? "text" : "password";
                    eye.setAttribute("aria-label", t(show ? "hideApiKey" : "showApiKey"));
                    eye.setAttribute("aria-pressed", String(show));
                    eye.replaceChildren(T.icon(show ? "eye-off" : "eye"));
                },
            },
            [T.icon("eye")],
        );
        input.addEventListener("input", () => onInput?.(input.value));
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
        });
        if (onCommit) input.addEventListener("blur", () => onCommit(input.value));
        return T.h("div", { class: "key-row" }, [input, eye]);
    }

    // 이름표(왼쪽)와 컨트롤(오른쪽)이 한 줄에 놓이는 설정 행.
    function labeledRow(label, control) {
        return T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: label }), T.h("div", { class: "set-control" }, [control])]);
    }

    // 현재 값이 프리셋에 없으면 그대로 보여주는 임시 옵션을 뒤에 붙인다.
    function presetOptions(presets, currentValue, currentLabel) {
        const opts = presets.slice();
        if (currentValue !== undefined && currentValue !== "" && !opts.some((o) => o.value === currentValue)) {
            opts.push({ value: currentValue, label: currentLabel });
        }
        return opts;
    }

    /* ── 묶음 목록의 행 ──────────────────────────────────────
       설정의 누를 수 있는 것은 모두 행이다: 들어가는 행(꺾쇠)과 동작 행(강조색·빨간색 글자). */
    // 값만 보여 주는 행.
    function valueRow(label, value) {
        return T.h("div", { class: "set-row" }, [T.h("span", { class: "set-label", text: label }), T.h("span", { class: "nav-val", text: value })]);
    }

    // 누르면 한 단계 더 들어가는 행: 이름 · 오른쪽 값 · 꺾쇠.
    function navRow(label, value, onclick) {
        return T.h("button", { type: "button", class: "set-row nav-row", onclick }, [
            T.h("span", { class: "set-label", text: label }),
            T.h("span", { class: "nav-val", text: value || "" }),
            T.icon("chevron", "nav-chev"),
        ]);
    }

    // 목록의 항목 행: 이름(+배지) · 설명 한 줄 · 꺾쇠. 누르면 그 항목의 화면으로 들어간다.
    // trailing: 꺾쇠 앞에 놓을 것(순서 손잡이 등). menu: 길게 누르기·우클릭 메뉴의 항목을 돌려주는 함수.
    function itemRow({ name, badge, badgeClass, sub, subMono, trailing, onclick, menu }) {
        const row = T.h("button", { type: "button", class: "ext-row nav-row", onclick }, [
            T.h("span", { class: "ext-main" }, [
                T.h("span", { class: "ext-name" }, [
                    T.h("span", { class: "ext-nm", text: name }),
                    badge ? T.h("span", { class: `ext-badge${badgeClass ? ` ${badgeClass}` : ""}`, text: badge }) : null,
                ]),
                sub ? T.h("span", { class: `ext-sub${subMono ? " mono" : ""}`, text: sub }) : null,
            ]),
            trailing || null,
            T.icon("chevron", "nav-chev"),
        ]);
        if (menu) T.ctxmenu.attach(row, menu);
        return row;
    }

    // 동작 행: 강조색(danger면 빨간색) 글자의 한 줄. icon을 주면 글자 앞에 붙는다("추가" 행).
    // own이면 제 묶음에 담겨 나온다(삭제·로그아웃처럼 다른 행과 떨어져 있어야 하는 동작). 아이콘이 없으면 가운데에 놓인다.
    function actionRow(label, onclick, { danger = false, icon = null, own = false, href = null } = {}) {
        const cls = `set-row act-row${danger ? " danger" : ""}${own && !icon ? " center" : ""}`;
        const kids = [icon ? T.icon(icon) : null, T.h("span", { class: "act-label", text: label })];
        const row = href
            ? T.h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, kids)
            : T.h("button", { type: "button", class: cls, onclick }, kids);
        if (!own) return row;
        const group = T.h("div", { class: "set-group act-group" }, [row]);
        group.row = row;
        return group;
    }

    /* ── 편집 화면의 저장과 떠나기 ────────────────────────────
       화면을 그리는 동안(layout.js의 buildView) 탭이 C.viewSlot에 채워 넣는다.
       action: 탐색 바 오른쪽의 버튼, dirty: 입력이 처음과 달라졌는지 알려 주는 함수. */
    C.viewSlot = {};

    // 탐색 바 오른쪽의 동작 버튼(저장). run이 끝날 때까지 꺼져 있어 두 번 눌리지 않는다.
    // 저장에 성공하면 화면이 다시 그려지고, 실패하면 run이 알린 뒤 버튼이 다시 켜진다.
    function headAction(label, run) {
        const btn = T.h("button", {
            type: "button",
            class: "sp-action",
            text: label,
            async onclick() {
                if (btn.busy) return;
                btn.busy = true;
                btn.disabled = true;
                try {
                    await run();
                } finally {
                    btn.busy = false;
                    btn.sync?.();
                }
            },
        });
        C.viewSlot.action = btn;
        return btn;
    }

    // 폼의 입력값을 처음과 견준다. 달라지기 전에는 저장 버튼이 꺼져 있고, 달라진 채로 떠나려 하면 묻는다(layout.js의 confirmLeave).
    // 폼을 다 채운 뒤에 부른다. extra: 입력 요소가 아닌 값(색상 선택 등)을 문자열로 돌려주는 함수.
    function trackForm(root, extra) {
        const read = () =>
            JSON.stringify([
                [...root.querySelectorAll("input, textarea, select")].map((el) => (el.type === "checkbox" ? el.checked : el.value)),
                extra ? extra() : null,
            ]);
        const initial = read();
        C.viewSlot.dirty = () => root.isConnected && read() !== initial;
    }

    function fieldOf(label, control, desc) {
        return T.h("div", { class: "field" }, [fieldLabel(label), control, desc ? T.h("div", { class: "set-desc", text: desc }) : null]);
    }

    // 저장 시점에 값을 읽는 셀렉트. 즉시 PUT하는 settingSelect와 달리 ref를 돌려준다.
    function editorSelect(options, current, aria) {
        const sel = T.h("select", { "aria-label": aria });
        for (const o of options) {
            const opt = T.h("option", { value: o.value, text: o.label });
            if (o.value === current) opt.selected = true;
            sel.append(opt);
        }
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        return sel;
    }

    function selectWrap(sel) {
        return T.h("div", { class: "select-wrap" }, [sel, T.icon("chevron")]);
    }

    C.confirmDelete = confirmDelete;
    C.switchEl = switchEl;
    C.settingSelect = settingSelect;
    C.fieldLabel = fieldLabel;
    C.accountField = accountField;
    C.accountInput = accountInput;
    C.secretInput = secretInput;
    C.labeledRow = labeledRow;
    C.presetOptions = presetOptions;
    C.valueRow = valueRow;
    C.navRow = navRow;
    C.itemRow = itemRow;
    C.actionRow = actionRow;
    C.headAction = headAction;
    C.trackForm = trackForm;
    C.fieldOf = fieldOf;
    C.editorSelect = editorSelect;
    C.selectWrap = selectWrap;
})(window.Taby);
