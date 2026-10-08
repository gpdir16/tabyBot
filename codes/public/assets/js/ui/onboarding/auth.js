/* tabyBot 웹 클라이언트: 계정 게이트(로그인·첫 계정 만들기). */
((T) => {
    "use strict";

    T.onboardingCtx ??= {};
    const C = T.onboardingCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("onboardingPage");

    // 계정 게이트. mode "login"(401/로그아웃) | "setup"(첫 방문, 계정 생성).
    // 성공하면 세션 토큰을 저장하고 onSuccess로 부트를 다시 시도한다.
    const SETUP_SKIP_KEY = "tabybot.auth.setupSkipped";

    function setupSkipped() {
        try {
            return localStorage.getItem(SETUP_SKIP_KEY) === "1";
        } catch (_) {
            return false;
        }
    }

    function authErrorText(err) {
        const code = err?.payload?.error;
        if (code === "invalid_credentials") return t("authFailed");
        if (code === "too_many_attempts") return t("authTooMany", { s: Number(err.payload?.retryAfter) || 60 });
        if (code === "wrong_password") return t("authWrongPassword");
        if (code === "username_required") return t("authUsernameRequired");
        if (code === "username_too_long") return t("authUsernameLong");
        if (code === "password_too_short") return t("authPasswordShort");
        if (code === "account_exists") return t("authAccountExists");
        return T.api.errorText(err, t("authFailed"));
    }

    function showAuth(mode, onSuccess) {
        C.draft = null;
        const isSetup = mode === "setup";
        const errLine = T.h("p", { class: "onb-error", role: "alert" });
        const username = T.h("input", {
            class: "input onb-auth-input",
            type: "text",
            name: "username",
            placeholder: t("authUsername"),
            "aria-label": t("authUsername"),
            autocomplete: "username",
            autocapitalize: "none",
            autocorrect: "off",
            spellcheck: "false",
            required: true,
        });
        const password = T.h("input", {
            class: "input onb-auth-input",
            type: "password",
            name: "password",
            placeholder: t("authPassword"),
            "aria-label": t("authPassword"),
            autocomplete: isSetup ? "new-password" : "current-password",
            required: true,
        });
        const confirm = isSetup
            ? T.h("input", {
                  class: "input onb-auth-input",
                  type: "password",
                  name: "confirm",
                  placeholder: t("authPasswordConfirm"),
                  "aria-label": t("authPasswordConfirm"),
                  autocomplete: "new-password",
                  required: true,
              })
            : null;
        for (const el of [username, password, confirm]) {
            if (!el) continue;
            el.addEventListener("keydown", (e) => e.stopPropagation());
        }

        const submitBtn = T.h("button", { class: "btn primary", type: "submit", text: t(isSetup ? "authCreate" : "authSignIn") });
        const skipBtn = isSetup
            ? T.h("button", {
                  class: "btn ghost warn",
                  type: "button",
                  text: t("authSkip"),
                  onclick: () => showSkipConfirm(),
              })
            : null;
        const box = T.h(
            "form",
            {
                class: "onb-auth",
                novalidate: true,
                onsubmit(e) {
                    e.preventDefault();
                    submit();
                },
            },
            [
                T.h("h1", { id: "onbTitle", class: "onb-title", text: t(isSetup ? "authSetupTitle" : "authLoginTitle") }),
                T.h("p", { class: "onb-desc", text: t(isSetup ? "authSetupDesc" : "authLoginDesc") }),
                username,
                password,
                confirm,
                errLine,
                submitBtn,
                skipBtn,
            ],
        );

        // "인증 없이 사용"은 위험한 선택이라 모달로 한 번 더 확인한다.
        function showSkipConfirm() {
            const cancelBtn = T.h("button", { class: "btn ghost", type: "button", text: t("cancel"), onclick: close });
            const scrim = T.h(
                "div",
                {
                    class: "onb-modal",
                    role: "alertdialog",
                    "aria-modal": "true",
                    onclick(e) {
                        if (e.target === scrim) close();
                    },
                },
                [
                    T.h("div", { class: "onb-modal-card" }, [
                        T.h("h2", { class: "onb-modal-title" }, [T.icon("warn"), T.h("span", { text: t("authSkipModalTitle") })]),
                        T.h("p", { class: "onb-modal-text", text: t("authSkipWarn") }),
                        T.h("div", { class: "onb-modal-actions" }, [
                            T.h("button", { class: "btn danger", type: "button", text: t("authSkipConfirm"), onclick: doSkip }),
                            cancelBtn,
                        ]),
                    ]),
                ],
            );
            // 모달에 포커스가 있을 때는 전역 단축키(/ 등)가 뒤 UI를 건드리지 않게 한다.
            scrim.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Escape") close();
            });
            page.append(scrim);
            cancelBtn.focus();
            function close() {
                scrim.remove();
                skipBtn?.focus();
            }
            function doSkip() {
                try {
                    localStorage.setItem(SETUP_SKIP_KEY, "1");
                } catch {
                    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
                }
                C.dismiss();
                if (onSuccess) onSuccess();
            }
        }

        C.visible = true;
        page.hidden = false;
        page.replaceChildren(T.h("div", { class: "onb-wrap" }, [box]));
        setTimeout(() => username.focus(), 50);

        let busy = false;
        async function submit() {
            if (busy) return;
            const u = username.value.trim();
            const p = password.value;
            errLine.textContent = "";
            if (!u || !p) {
                errLine.textContent = t("authRequired");
                (u ? password : username).focus();
                return;
            }
            if (isSetup && p !== confirm.value) {
                errLine.textContent = t("authPasswordMismatch");
                return;
            }
            busy = true;
            submitBtn.disabled = true;
            try {
                const r = isSetup ? await T.api.accountSetup({ username: u, password: p }) : await T.api.accountLogin({ username: u, password: p });
                T.api.setToken(r.token);
                T.notifications?.syncAuth?.();
                C.dismiss();
                if (onSuccess) onSuccess();
            } catch (err) {
                busy = false;
                submitBtn.disabled = false;
                errLine.textContent = authErrorText(err);
            }
        }
    }

    C.setupSkipped = setupSkipped;
    C.authErrorText = authErrorText;
    C.showAuth = showAuth;
})(window.Taby);
