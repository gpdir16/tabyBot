/* tabyBot 웹 클라이언트: 설정 > 계정 탭. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.credsEditing = null; // 계정 편집 중인 항목: "username" | "password" | null

    function buildAccount(body) {
        const acct = state.state.account || {};
        const sec = T.h("div", { class: "set-section" });
        const err = T.h("p", { class: "onb-error hidden", role: "alert" });
        const setErr = (msg) => {
            err.textContent = msg || "";
            err.classList.toggle("hidden", !msg);
        };
        const editor = T.h("div", { class: "agent-editor" });
        sec.append(editor);

        if (!acct.hasAccount) {
            // 아직 계정이 없다. 만들면 다음 접속부터 로그인이 필요해진다.
            editor.append(T.h("p", { class: "set-desc", text: t("authNoAccountDesc") }));
            const u = C.accountInput("text", t("authUsername"), "username");
            const p = C.accountInput("password", t("authPassword"), "new-password");
            const c = C.accountInput("password", t("authPasswordConfirm"), "new-password");
            editor.append(
                C.accountField(t("authUsername"), u),
                C.accountField(t("authPassword"), p),
                C.accountField(t("authPasswordConfirm"), c),
                err,
                T.h("div", { class: "editor-actions" }, [
                    T.h("button", {
                        class: "btn primary",
                        text: t("authCreate"),
                        async onclick() {
                            const username = u.value.trim();
                            if (!username || !p.value) {
                                setErr(t("authRequired"));
                                return;
                            }
                            if (p.value !== c.value) {
                                setErr(t("authPasswordMismatch"));
                                return;
                            }
                            this.disabled = true;
                            try {
                                const r = await T.api.accountSetup({ username, password: p.value });
                                T.api.setToken(r.token);
                                T.notifications?.syncAuth?.();
                                state.state.account = { ...state.state.account, hasAccount: true, authed: true, username: r.username };
                                T.toast.show("info", t("authCreated"));
                                C.build();
                            } catch (e) {
                                this.disabled = false;
                                setErr(T.onboarding.authErrorText(e));
                            }
                        },
                    }),
                ]),
            );
            body.append(sec);
            return;
        }

        const cancelBtn = T.h("button", {
            class: "btn ghost",
            text: t("cancel"),
            onclick() {
                C.credsEditing = null;
                C.build();
            },
        });
        const saveBtn = (validate, makePayload) =>
            T.h("button", {
                class: "btn primary",
                text: t("save"),
                async onclick() {
                    const v = validate();
                    if (v) {
                        setErr(v);
                        return;
                    }
                    this.disabled = true;
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
                        this.disabled = false;
                        setErr(T.onboarding.authErrorText(e));
                    }
                },
            });

        if (C.credsEditing === "username") {
            // 이름 변경: 현재 비밀번호로 본인 확인.
            const u = C.accountInput("text", t("authUsername"), "username");
            u.value = acct.username || "";
            const cur = C.accountInput("password", t("authCurrentPassword"), "current-password");
            editor.append(
                C.accountField(t("authUsername"), u),
                C.accountField(t("authCurrentPassword"), cur),
                err,
                T.h("div", { class: "editor-actions" }, [
                    saveBtn(
                        () => (!u.value.trim() || !cur.value ? t("authRequired") : null),
                        () => ({ currentPassword: cur.value, username: u.value.trim() }),
                    ),
                    cancelBtn,
                ]),
            );
        } else if (C.credsEditing === "password") {
            // 비밀번호 변경: 현재 비밀번호 + 새 비밀번호 확인.
            const cur = C.accountInput("password", t("authCurrentPassword"), "current-password");
            const np = C.accountInput("password", t("authNewPassword"), "new-password");
            const nc = C.accountInput("password", t("authPasswordConfirm"), "new-password");
            editor.append(
                C.accountField(t("authCurrentPassword"), cur),
                C.accountField(t("authNewPassword"), np),
                C.accountField(t("authPasswordConfirm"), nc),
                err,
                T.h("div", { class: "editor-actions" }, [
                    saveBtn(
                        () => (!cur.value || !np.value || !nc.value ? t("authRequired") : np.value !== nc.value ? t("authPasswordMismatch") : null),
                        () => ({ currentPassword: cur.value, password: np.value }),
                    ),
                    cancelBtn,
                ]),
            );
        } else {
            // 저장된 계정 정보: 라벨 아래 읽기 전용 입력칸, 변경할 항목마다 별도의 변경 버튼.
            const loc = { ko: "ko-KR", ja: "ja-JP" }[T.i18n.getLang()] || "en-US";
            const ro = (label, value, type = "text") => {
                const el = C.accountInput(type, label, "off");
                el.readOnly = true;
                el.tabIndex = -1;
                el.value = value || "";
                return el;
            };
            const editBtn = (which) =>
                T.h("button", {
                    class: "btn ghost",
                    text: t("authEdit"),
                    onclick() {
                        C.credsEditing = which;
                        C.build();
                    },
                });
            editor.append(
                C.accountField(t("authUsername"), T.h("div", { class: "key-row" }, [ro(t("authUsername"), acct.username), editBtn("username")])),
            );
            if (acct.createdAt) {
                const d = new Date(acct.createdAt);
                if (!Number.isNaN(d))
                    editor.append(
                        C.accountField(
                            t("authCreatedAt"),
                            ro(t("authCreatedAt"), d.toLocaleDateString(loc, { year: "numeric", month: "long", day: "numeric" })),
                        ),
                    );
            }
            if (typeof acct.sessionCount === "number") {
                editor.append(C.accountField(t("authSessions"), ro(t("authSessions"), t("authSessionCount", { n: acct.sessionCount }))));
            }
            editor.append(
                C.accountField(
                    t("authPassword"),
                    T.h("div", { class: "key-row" }, [ro(t("authPassword"), "********", "password"), editBtn("password")]),
                ),
                T.h("hr", { class: "divider" }),
                T.h("div", { class: "editor-actions" }, [
                    T.h("button", {
                        class: "btn ghost",
                        text: t("authLogout"),
                        async onclick() {
                            this.disabled = true;
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
                    }),
                ]),
            );
        }
        body.append(sec);
    }

    C.buildAccount = buildAccount;
})(window.Taby);
