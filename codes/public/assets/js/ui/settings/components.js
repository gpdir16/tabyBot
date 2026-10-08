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

    // 스킬/MCP/폴더 편집 폼 공통 머리글. 닫기는 아래 버튼 줄(취소/닫기)이 맡는다.
    function formHead(title) {
        return T.h("div", { class: "form-head" }, [T.h("div", { class: "form-title", text: title })]);
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
    C.formHead = formHead;
    C.fieldOf = fieldOf;
    C.editorSelect = editorSelect;
    C.selectWrap = selectWrap;
})(window.Taby);
