/* tabyBot 웹 클라이언트: 설정 > 시크릿 탭("s.secrets")과 편집 창("s.secret:new", "s.secret:<id>").
   값은 쓰기 전용이라 서버가 id와 이름만 내려준다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    let secretsCache = null; // GET /api/secrets 응답의 secrets 배열
    let secretsLoading = false;
    let secretsFailed = false;

    const isSecretWin = (w) => w.kind === "s.secrets" || w.kind === "s.secret";

    // 시크릿 창이 모두 닫히면 받아 둔 목록을 버린다(다시 열면 새로 받는다).
    function leaveSecrets() {
        if (!C.noneOpen(isSecretWin)) return;
        secretsCache = null;
        secretsLoading = false;
        secretsFailed = false;
    }

    // 저장 실패 사유 코드 → 문구 키.
    const ERROR_KEYS = {
        invalid_name: "secretInvalidName",
        name_exists: "secretExists",
        invalid_value: "secretInvalidValue",
        value_too_long: "secretValueTooLong",
    };

    async function loadSecretsList() {
        if (secretsLoading) return;
        secretsLoading = true;
        try {
            const r = await T.api.secrets();
            secretsCache = r && Array.isArray(r.secrets) ? r.secrets : [];
            secretsFailed = false;
        } catch (err) {
            secretsCache = [];
            secretsFailed = true;
            T.toast.show("error", T.api.errorText(err, t("loadFailed")));
        } finally {
            secretsLoading = false;
            T.windows.refresh(isSecretWin);
        }
    }

    // 저장·삭제 응답의 새 목록을 반영하고 목록 창을 다시 그린다.
    function setSecrets(r) {
        secretsCache = r && Array.isArray(r.secrets) ? r.secrets : [];
        T.windows.refresh((w) => w.kind === "s.secrets");
    }

    function saveErrorText(err) {
        const key = ERROR_KEYS[err?.payload?.error || ""];
        return key ? `${t("saveFailed")}: ${t(key)}` : T.api.errorText(err, t("saveFailed"));
    }

    // 확인을 받고 지운다. 지운 시크릿의 편집 창이 열려 있었으면 같이 닫는다.
    async function deleteSecret(sec) {
        if (!(await C.confirmDelete(sec.name))) return;
        try {
            setSecrets(await T.api.deleteSecret(sec.id));
            void T.windows.close(`s.secret:${sec.id}`, { force: true });
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function secretRow(sec, win) {
        return C.itemRow({
            name: sec.name,
            badge: "••••••",
            badgeClass: "ok",
            onclick: () => win.open(`s.secret:${sec.id}`),
            menu: () => [{ label: t("delete"), danger: true, defer: true, onSelect: () => deleteSecret(sec) }],
        });
    }

    C.defineTab("secrets", {
        on: [],
        onClose: leaveSecrets,
        build(body, win) {
            if (secretsCache === null && !secretsLoading && !secretsFailed) void loadSecretsList();
            const sec = T.h("div", { class: "set-section" });
            sec.append(T.h("div", { class: "set-desc", text: t("secretsDesc") }));
            if (secretsCache === null) sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
            else if (!secretsCache.length) sec.append(T.h("div", { class: "set-desc", text: t("secretsEmpty") }));
            else for (const s of secretsCache) sec.append(secretRow(s, win));
            sec.append(C.actionRow(t("addSecret"), () => win.open("s.secret:new"), { icon: "plus" }));
            body.append(sec);
        },
    });

    // 편집 창. 이름은 받아 둔 목록에서 읽는다(주소로 되살리면 목록을 먼저 받는다).
    T.windows.define("s.secret", (arg) => {
        if (!arg) return null;
        const isNew = arg === "new";
        const find = () => (secretsCache || []).find((x) => x.id === arg) || null;
        return {
            title: () => (isNew ? t("addSecret") : find()?.name || t("secretsTab")),
            onClose: leaveSecrets,
            // 목록에서 사라졌다(다른 기기에서 지움).
            gone: () => !isNew && Array.isArray(secretsCache) && !secretsFailed && !find(),
            build(body, win) {
                const sec = T.h("div", { class: "set-section" });
                body.append(sec);
                if (!isNew && secretsCache === null) {
                    if (!secretsLoading && !secretsFailed) void loadSecretsList();
                    sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
                    return;
                }
                const found = isNew ? null : find();
                if (!isNew && !found) {
                    sec.append(T.h("div", { class: "empty-note", text: "-" }));
                    return;
                }
                sec.append(secretForm(win, found));
            },
        };
    });

    function secretForm(win, sec) {
        const isNew = !sec;
        const form = T.h("div", { class: "agent-editor" });

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

        C.headAction(t("save"), async () => {
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
            // 새 값을 입력하지 않았으면 value를 보내지 않아 기존 값이 유지된다.
            const body = { name, ...(value ? { value } : {}) };
            try {
                setSecrets(isNew ? await T.api.createSecret(body) : await T.api.updateSecret(sec.id, body));
                void win.close({ force: true });
            } catch (err) {
                T.toast.show("error", saveErrorText(err));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteSecret(sec), { danger: true, own: true }));
        C.trackForm(form);
        return form;
    }
})(window.Taby);
