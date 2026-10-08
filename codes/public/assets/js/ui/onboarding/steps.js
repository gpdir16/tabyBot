/* tabyBot 웹 클라이언트: 설정 마법사의 언어·프로바이더·정책 단계. */
((T) => {
    "use strict";

    T.onboardingCtx ??= {};
    const C = T.onboardingCtx;
    const t = (k, v) => T.i18n.t(k, v);

    function providerList() {
        return T.state.state.settings?.providers || [];
    }

    function providerOf(id) {
        return providerList().find((p) => p.id === id) || null;
    }

    function oauthKind(meta) {
        return meta && /-oauth$/.test(String(meta.type || ""));
    }

    // 인증이 채워져 모델 목록을 요구할 수 있는 상태인지
    function authReady(meta) {
        if (!C.draft.providerId) return false;
        if (oauthKind(meta)) return true;
        const keyOk = !meta || meta.apiKeyOptional || C.draft.apiKey.trim().length > 0;
        const urlOk = !meta?.needsBaseURL || /^https?:\/\/.+/.test(C.draft.baseURL.trim());
        return keyOk && urlOk;
    }

    function providerPicked() {
        return Boolean(C.draft?.providerId && authReady(providerOf(C.draft.providerId)));
    }

    /* ── 단계 1: 언어 ───────────────────────────────────────── */
    function buildLangStep(box) {
        box.append(
            C.pick(
                [
                    { value: "en", label: "English" },
                    { value: "ko", label: "한국어" },
                    { value: "ja", label: "日本語" },
                ],
                C.draft.lang,
                (v) => {
                    C.draft.lang = v;
                    T.i18n.setLang(v, { persist: false });
                    C.render();
                },
                t("language"),
            ),
        );
    }

    /* ── 단계 2: 프로바이더 + 인증 ──────────────────────────── */
    function buildProviderStep(box) {
        const list = providerList();
        if (!list.length) {
            box.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            box.append(T.h("button", { class: "btn ghost", text: t("retry"), onclick: () => T.app?.retryBoot() }));
            return;
        }

        const cards = T.h("div", { class: "provider-list", role: "radiogroup", "aria-label": t("provider") });
        for (const p of list) {
            const on = C.draft.providerId === p.id;
            cards.append(
                T.h(
                    "button",
                    {
                        class: `provider-card${on ? " selected" : ""}`,
                        role: "radio",
                        "aria-checked": String(on),
                        onclick() {
                            if (on) return;
                            C.draft.providerId = p.id;
                            C.draft.baseURL = "";
                            C.draft.apiKey = "";
                            C.draft.model = p.id === "github-copilot" ? "auto" : "";
                            C.forgetModels();
                            C.render();
                        },
                    },
                    [T.h("div", { class: "provider-name", text: p.label || p.id }), on ? T.icon("check") : null],
                ),
            );
        }
        box.append(cards);

        const meta = providerOf(C.draft.providerId);
        if (!meta) return;
        if (meta.needsBaseURL) {
            box.append(
                C.labeled(
                    t("baseURL"),
                    C.typed("text", C.draft.baseURL, "https://api.example.com/v1", (v) => {
                        C.draft.baseURL = v;
                        C.forgetModels();
                        C.refreshGo();
                    }),
                ),
            );
        }
        if (oauthKind(meta)) {
            box.append(C.labeled(t("oauthAccount"), T.settingsUI.oauthSection(meta.id, C.render)));
        } else {
            box.append(
                C.labeled(
                    t("apiKey") + (meta.apiKeyOptional ? ` (${t("apiKeyOptional")})` : ""),
                    T.settingsUI.secretInput({
                        value: C.draft.apiKey,
                        placeholder: "sk-…",
                        aria: t("apiKey"),
                        onInput(v) {
                            C.draft.apiKey = v;
                            C.forgetModels();
                            C.refreshGo();
                        },
                    }),
                ),
            );
            if (meta.keysUrl) {
                box.append(
                    T.h("a", {
                        class: "key-hint",
                        href: meta.keysUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        text: `${t("getApiKey")} ↗`,
                    }),
                );
            }
        }
    }

    /* ── 단계 4: NSFW / 영구 행위 승인 ──────────────────────── */
    function buildPolicyStep(box) {
        const s = T.state.state.settings || {};
        const nsfwNames = { strict: t("nsfwStrict"), moderate: t("nsfwModerate"), explicit: t("nsfwExplicit") };
        const approvalNames = { user: t("approvalUser"), model: t("approvalModel"), always: t("approvalAlways") };

        box.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("nsfwLevel") }),
                C.pick(
                    (s.nsfwLevels || ["strict", "moderate", "explicit"]).map((v) => ({ value: v, label: nsfwNames[v] || v })),
                    C.draft.nsfw,
                    (v) => (C.draft.nsfw = v),
                    t("nsfwLevel"),
                ),
            ]),
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("approvalLevel") }),
                C.pick(
                    (s.approvalLevels || ["user", "model", "always"]).map((v) => ({ value: v, label: approvalNames[v] || v })),
                    C.draft.approval,
                    (v) => (C.draft.approval = v),
                    t("approvalLevel"),
                ),
            ]),
            T.h("p", { class: "set-desc", text: t("approvalDesc") }),
            T.h("p", { class: "set-desc", text: t("onbPolicyNote") }),
        );
    }

    C.providerOf = providerOf;
    C.authReady = authReady;
    C.providerPicked = providerPicked;
    C.buildLangStep = buildLangStep;
    C.buildProviderStep = buildProviderStep;
    C.buildPolicyStep = buildPolicyStep;
})(window.Taby);
