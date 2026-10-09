/* tabyBot 웹 클라이언트: 설정 > 계정 탭. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.credsEditing = null; // 계정 편집 중인 항목: "username" | "password" | null (편집 화면은 한 단계 더 들어간 폼이다)

    function buildAccount(body) {
        const acct = state.state.account || {};
        const sec = T.h("div", { class: "set-section" });
        const err = T.h("p", { class: "onb-error hidden", role: "alert" });
        const setErr = (msg) => {
            err.textContent = msg || "";
            err.classList.toggle("hidden", !msg);
        };
        body.append(sec);

        if (!acct.hasAccount) {
            // 아직 계정이 없다. 만들면 다음 접속부터 로그인이 필요해진다.
            const editor = T.h("div", { class: "agent-editor" });
            const u = C.accountInput("text", t("authUsername"), "username");
            const p = C.accountInput("password", t("authPassword"), "new-password");
            const c = C.accountInput("password", t("authPasswordConfirm"), "new-password");
            editor.append(
                T.h("p", { class: "set-desc", text: t("authNoAccountDesc") }),
                C.accountField(t("authUsername"), u),
                C.accountField(t("authPassword"), p),
                C.accountField(t("authPasswordConfirm"), c),
                err,
            );
            C.headAction(t("authCreate"), async () => {
                const username = u.value.trim();
                if (!username || !p.value) {
                    setErr(t("authRequired"));
                    return;
                }
                if (p.value !== c.value) {
                    setErr(t("authPasswordMismatch"));
                    return;
                }
                try {
                    const r = await T.api.accountSetup({ username, password: p.value });
                    T.api.setToken(r.token);
                    T.notifications?.syncAuth?.();
                    state.state.account = { ...state.state.account, hasAccount: true, authed: true, username: r.username };
                    T.toast.show("info", t("authCreated"));
                    C.build();
                } catch (e) {
                    setErr(T.onboarding.authErrorText(e));
                }
            });
            C.trackForm(editor);
            sec.append(editor);
            return;
        }

        if (C.credsEditing) {
            sec.append(credsForm(acct, err, setErr));
            return;
        }

        // 저장된 계정 정보: 바꿀 수 있는 항목은 누르면 편집 화면으로 들어가는 행이다.
        const loc = { ko: "ko-KR", ja: "ja-JP" }[T.i18n.getLang()] || "en-US";
        const edit = (which) => () =>
            C.openForm(() => {
                C.credsEditing = which;
            });
        sec.append(C.navRow(t("authUsername"), acct.username, edit("username")));
        if (acct.createdAt) {
            const d = new Date(acct.createdAt);
            if (!Number.isNaN(d))
                sec.append(C.valueRow(t("authCreatedAt"), d.toLocaleDateString(loc, { year: "numeric", month: "long", day: "numeric" })));
        }
        if (typeof acct.sessionCount === "number") sec.append(C.valueRow(t("authSessions"), t("authSessionCount", { n: acct.sessionCount })));
        sec.append(C.navRow(t("authPassword"), "••••••••", edit("password")));

        const logout = C.actionRow(
            t("authLogout"),
            async () => {
                logout.row.disabled = true;
                try {
                    await T.api.accountLogout();
                } catch {
                    // 로그아웃 요청이 실패해도 이 브라우저의 로그인 상태는 정리한다
                }
                T.api.setToken("");
                // 로그아웃한 브라우저에 대화 캐시를 남기지 않는다.
                state.clearSnapshot();
                T.notifications?.syncAuth?.();
                state.state.account = { hasAccount: true, authed: false, username: null };
                T.app?.handleUnauthorized?.();
            },
            { danger: true, own: true },
        );
        sec.append(logout);
    }

    // 이름·비밀번호 편집 화면. 둘 다 현재 비밀번호로 본인을 확인한다.
    function credsForm(acct, err, setErr) {
        const editor = T.h("div", { class: "agent-editor" });
        const cur = C.accountInput("password", t("authCurrentPassword"), "current-password");
        let validate, makePayload;
        if (C.credsEditing === "username") {
            const u = C.accountInput("text", t("authUsername"), "username");
            u.value = acct.username || "";
            editor.append(C.accountField(t("authUsername"), u), C.accountField(t("authCurrentPassword"), cur));
            validate = () => (!u.value.trim() || !cur.value ? t("authRequired") : null);
            makePayload = () => ({ currentPassword: cur.value, username: u.value.trim() });
        } else {
            const np = C.accountInput("password", t("authNewPassword"), "new-password");
            const nc = C.accountInput("password", t("authPasswordConfirm"), "new-password");
            editor.append(
                C.accountField(t("authCurrentPassword"), cur),
                C.accountField(t("authNewPassword"), np),
                C.accountField(t("authPasswordConfirm"), nc),
            );
            validate = () => (!cur.value || !np.value || !nc.value ? t("authRequired") : np.value !== nc.value ? t("authPasswordMismatch") : null);
            makePayload = () => ({ currentPassword: cur.value, password: np.value });
        }
        editor.append(err);
        C.headAction(t("save"), async () => {
            const v = validate();
            if (v) {
                setErr(v);
                return;
            }
            try {
                const r = await T.api.accountUpdate(makePayload());
                state.state.account = {
                    ...state.state.account,
                    hasAccount: true,
                    authed: true,
                    username: r.account?.username || acct.username,
                };
                C.credsEditing = null;
                T.toast.show("info", t("authSaved"));
                C.build();
            } catch (e) {
                setErr(T.onboarding.authErrorText(e));
            }
        });
        C.trackForm(editor);
        return editor;
    }

    C.buildAccount = buildAccount;
})(window.Taby);
