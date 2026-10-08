/* tabyBot 웹 클라이언트: 설정 > 시크릿 탭. 값은 쓰기 전용이라 서버가 id와 이름만 내려준다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    C.secretsCache = null; // GET /api/secrets 응답의 secrets 배열

    C.secretsLoading = false;

    C.secretsFailed = false;

    C.secretEditing = null; // { mode:"new" } | { mode:"edit", id, name }

    // 저장 실패 사유 코드 → 문구 키.
    const ERROR_KEYS = {
        invalid_name: "secretInvalidName",
        name_exists: "secretExists",
        invalid_value: "secretInvalidValue",
        value_too_long: "secretValueTooLong",
    };

    async function loadSecretsList() {
        if (C.secretsLoading) return;
        C.secretsLoading = true;
        try {
            const r = await T.api.secrets();
            C.secretsCache = r && Array.isArray(r.secrets) ? r.secrets : [];
            C.secretsFailed = false;
        } catch (err) {
            C.secretsCache = [];
            C.secretsFailed = true;
            T.toast.show("error", T.api.errorText(err, t("loadFailed")));
        } finally {
            C.secretsLoading = false;
            if (C.openTab === "secrets") C.rebuildIfIdle();
        }
    }

    function saveErrorText(err) {
        const key = ERROR_KEYS[err?.payload?.error || ""];
        return key ? `${t("saveFailed")}: ${t(key)}` : T.api.errorText(err, t("saveFailed"));
    }

    function secretRow(sec) {
        const delBtn = T.h("button", {
            class: "btn ghost",
            text: t("delete"),
            async onclick() {
                if (!(await C.confirmDelete(sec.name))) return;
                delBtn.disabled = true;
                T.api
                    .deleteSecret(sec.id)
                    .then((r) => {
                        C.secretsCache = r && Array.isArray(r.secrets) ? r.secrets : [];
                        C.build();
                    })
                    .catch((err) => {
                        delBtn.disabled = false;
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    });
            },
        });
        const editBtn = T.h("button", {
            class: "btn ghost",
            text: t("edit"),
            onclick() {
                C.secretEditing = { mode: "edit", id: sec.id, name: sec.name };
                C.build();
            },
        });
        return T.h("div", { class: "ext-row" }, [
            T.h("div", { class: "ext-main" }, [
                T.h("div", { class: "ext-name" }, [
                    T.h("span", { class: "ext-nm", text: sec.name }),
                    T.h("span", { class: "ext-badge ok", text: "••••••" }),
                ]),
            ]),
            T.h("div", { class: "ext-actions" }, [editBtn, delBtn]),
        ]);
    }

    function secretForm() {
        const editing = C.secretEditing;
        const isNew = editing.mode === "new";
        const sec = isNew ? null : (C.secretsCache || []).find((x) => x.id === editing.id) || { id: editing.id, name: editing.name };
        const close = () => {
            C.secretEditing = null;
            C.build();
        };
        const form = T.h("div", { class: "agent-editor ext-form" });
        form.append(C.formHead(isNew ? t("addSecret") : sec.name));

        const nameInput = T.h("input", {
            class: "input",
            type: "text",
            value: sec?.name || "",
            placeholder: t("secretNamePlaceholder"),
            "aria-label": t("secretName"),
            autocomplete: "off",
            maxlength: "60",
        });
        nameInput.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf(t("secretName"), nameInput, t("secretNameDesc")));

        const valueRow = C.secretInput({ placeholder: isNew ? t("secretValue") : t("mcpEnvKeep"), aria: t("secretValue") });
        const valueInput = valueRow.querySelector("input");
        form.append(C.fieldOf(t("secretValue"), valueRow, isNew ? t("secretValueDesc") : t("secretValueKeepDesc")));

        const actions = T.h("div", { class: "editor-actions" });
        const saveBtn = T.h("button", {
            class: "btn primary",
            text: t("save"),
            async onclick() {
                const name = nameInput.value.trim();
                const value = valueInput.value;
                if (!name) {
                    nameInput.focus();
                    return;
                }
                if (isNew && !value) {
                    valueInput.focus();
                    return;
                }
                saveBtn.disabled = true;
                // 새 값을 입력하지 않았으면 value를 보내지 않아 기존 값이 유지된다.
                const body = { name, ...(value ? { value } : {}) };
                try {
                    const r = isNew ? await T.api.createSecret(body) : await T.api.updateSecret(editing.id, body);
                    C.secretsCache = r && Array.isArray(r.secrets) ? r.secrets : [];
                    C.secretEditing = null;
                    C.build();
                } catch (err) {
                    saveBtn.disabled = false;
                    T.toast.show("error", saveErrorText(err));
                }
            },
        });
        actions.append(saveBtn, T.h("button", { class: "btn ghost", text: t("cancel"), onclick: close }));
        form.append(actions);
        return form;
    }

    function buildSecrets(body) {
        if (C.secretsCache === null && !C.secretsLoading && !C.secretsFailed) void loadSecretsList();
        const sec = T.h("div", { class: "set-section" });
        if (!C.secretEditing) sec.append(T.h("div", { class: "set-desc", text: t("secretsDesc") }));
        if (C.secretEditing) {
            sec.append(secretForm());
        } else {
            if (C.secretsCache === null) sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
            else if (!C.secretsCache.length) sec.append(T.h("div", { class: "set-desc", text: t("secretsEmpty") }));
            else for (const s of C.secretsCache) sec.append(secretRow(s));
            sec.append(
                T.h("div", { class: "ext-add" }, [
                    T.h(
                        "button",
                        {
                            class: "btn ghost",
                            onclick() {
                                C.secretEditing = { mode: "new" };
                                C.build();
                            },
                        },
                        [T.icon("plus"), document.createTextNode(t("addSecret"))],
                    ),
                ]),
            );
        }
        body.append(sec);
    }

    C.buildSecrets = buildSecrets;
})(window.Taby);
