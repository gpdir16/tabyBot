/* tabyBot 웹 클라이언트: 설정 마법사 뼈대(진입·종료·단계 표시·저장)와 공개 인터페이스. */
((T) => {
    "use strict";

    T.onboardingCtx ??= {};
    const C = T.onboardingCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("onboardingPage");

    const STEP_TOTAL = 4;

    C.draft = null; // 각 단계에서 수집한 값

    let idx = 0; // 현재 단계(0 기반)

    C.visible = false;

    let saving = false;

    // 온보딩 건너뛰기 상태는 브라우저가 아니라 서버 설정에서 읽는다.
    function isSkipped() {
        return T.state.state.settings?.onboardingDismissed === true;
    }

    /* ── 단계 정의 ──────────────────────────────────────────── */
    const STEPS = [
        { title: "onbLangTitle", desc: "onbLangDesc", build: C.buildLangStep, done: () => true },
        { title: "onbProvTitle", desc: "onbProvDesc", build: C.buildProviderStep, done: C.providerPicked },
        { title: "onbModelTitle", desc: "onbModelDesc", build: C.buildModelStep, done: () => Boolean(C.draft?.model) },
        { title: "onbPolicyTitle", desc: "onbPolicyDesc", build: C.buildPolicyStep, done: () => true },
    ];

    /* ── 진입 / 종료 (app.js가 호출하는 공개 인터페이스) ────── */
    function wizard() {
        const s = T.state.state.settings || {};
        C.draft = {
            lang: T.i18n.getLang(),
            providerId: "",
            baseURL: "",
            apiKey: "",
            model: "",
            nsfw: s.nsfwLevel || "strict",
            approval: s.approvalLevel || "user",
        };
        idx = 0;
        saving = false;
        C.forgetModels();
        reveal();
    }

    function dismiss() {
        C.visible = false;
        page.hidden = true;
        page.replaceChildren();
        C.forgetModels();
    }

    /* ── 공통 프레임: 진행바 + 제목 + 본문 + 버튼 ───────────── */
    function reveal() {
        C.visible = true;
        page.hidden = false;
        render();
        page.focus({ preventScroll: true });
    }

    function render() {
        if (!C.visible || !C.draft) return;
        const def = STEPS[idx];
        const content = T.h("div", { class: "onb-content" });
        def.build(content);

        const actions = T.h("div", { class: "onb-actions" });
        actions.append(
            T.h("button", {
                class: "btn ghost onb-skip",
                text: t("onbSkip"),
                async onclick() {
                    this.disabled = true;
                    try {
                        const s = await T.api.putSettings({ onboardingDismissed: true });
                        if (s) T.state.setSettings(s);
                        dismiss();
                    } catch (err) {
                        this.disabled = false;
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    }
                },
            }),
        );
        if (idx > 0) {
            actions.append(
                T.h(
                    "button",
                    {
                        class: "btn ghost onb-prev",
                        "aria-label": t("onbPrev"),
                        onclick() {
                            idx--;
                            render();
                        },
                    },
                    // 모바일에서는 왼쪽 위의 둥근 뒤로 버튼(꺾쇠)으로, 데스크톱에서는 글자 버튼으로 보인다.
                    [T.icon("chevron-left"), T.h("span", { text: t("onbPrev") })],
                ),
            );
        }
        actions.append(T.h("span", { class: "spacer" }));
        const last = idx === STEP_TOTAL - 1;
        const go = T.h("button", {
            class: "btn primary onb-go",
            text: last ? t("onbFinish") : t("onbNext"),
            onclick() {
                if (last) save();
                else {
                    idx++;
                    render();
                }
            },
        });
        if (!def.done()) go.disabled = true;
        actions.append(go);

        page.replaceChildren(
            T.h("div", { class: "onb-wrap" }, [
                T.h("div", { class: "onb-top" }, [
                    T.h("div", { class: "onb-track" }, [T.h("span", { style: `width:${((idx + 1) / STEP_TOTAL) * 100}%` })]),
                    T.h("span", { class: "onb-count", text: `${idx + 1} / ${STEP_TOTAL}` }),
                ]),
                T.h("h1", { id: "onbTitle", class: "onb-title", text: t(def.title) }),
                T.h("p", { class: "onb-desc", text: t(def.desc) }),
                content,
                actions,
            ]),
        );
    }

    // 다음 버튼 활성화 갱신(입력 변화 시 호출)
    function refreshGo() {
        if (!C.visible) return;
        const b = page.querySelector(".onb-actions .btn.primary");
        if (b) b.disabled = !STEPS[idx].done();
    }

    /* ── 공통 컨트롤 ────────────────────────────────────────── */
    function labeled(label, control) {
        return T.h("div", { class: "field" }, [T.h("div", { class: "field-label", text: label }), control]);
    }

    function pick(options, value, onChange, aria) {
        const sel = T.h("select", { "aria-label": aria || "" });
        for (const o of options) {
            const el = T.h("option", { value: o.value, text: o.label });
            if (o.value === value) el.selected = true;
            sel.append(el);
        }
        sel.addEventListener("change", () => onChange(sel.value));
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        return T.h("div", { class: "select-wrap" }, [sel, T.icon("chevron")]);
    }

    function typed(type, value, placeholder, onInput, aria) {
        const el = T.h("input", {
            class: "input",
            type,
            value,
            placeholder,
            "aria-label": aria || placeholder,
            autocomplete: "off",
            spellcheck: "false",
        });
        el.addEventListener("input", () => onInput(el.value));
        el.addEventListener("keydown", (e) => e.stopPropagation());
        return el;
    }

    /* ── 저장 ───────────────────────────────────────────────── */
    async function save() {
        if (saving || !STEPS[idx].done()) return;
        saving = true;
        const meta = C.providerOf(C.draft.providerId);
        const provider = { id: C.draft.providerId, model: C.draft.model };
        if (C.draft.providerId === "github-copilot") provider.autoMode = true;
        if (meta?.needsBaseURL) provider.baseURL = C.draft.baseURL.trim();
        if (C.draft.apiKey.trim()) provider.apiKey = C.draft.apiKey.trim();

        try {
            await T.api.putSettings({
                language: C.draft.lang,
                provider,
                onboardingDismissed: false,
                nsfwLevel: C.draft.nsfw,
                approvalLevel: C.draft.approval,
            });
            const bs = await T.api.bootstrap();
            T.state.state.bootstrap = bs;
            T.state.emit("bootstrap");
            try {
                const s = await T.api.getSettings();
                if (s) T.state.setSettings(s);
            } catch {
                // 설정 조회에 실패해도 온보딩은 계속 진행한다
            }
            dismiss();
            try {
                const r = await T.api.agents();
                T.state.applyAgents(r);
            } catch {
                // 실패해도 다음 이벤트나 재접속 때 다시 받는다
            }
            const first = T.state.state.bots[0];
            if (first) T.chat.open(first.uuid);
            T.events.connect();
        } catch (err) {
            saving = false;
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    /* ── 외부 변화 반영 ─────────────────────────────────────── */
    T.i18n.onChange(() => {
        if (C.visible) render();
    });

    T.state.on("oauth_done", () => {
        if (C.visible && C.draft && idx === 1) {
            // 이 핸들러가 ui/settings/ 모듈보다 먼저 등록되므로, pending이 비워지기 전에
            // 다시 그리는 것을 막기 위해 직접 비운다.
            T.settingsUI.resetOauth();
            render();
        }
    });

    T.onboarding = { wizard, showAuth: C.showAuth, authErrorText: C.authErrorText, setupSkipped: C.setupSkipped, dismiss, isSkipped };

    C.dismiss = dismiss;
    C.render = render;
    C.refreshGo = refreshGo;
    C.labeled = labeled;
    C.pick = pick;
    C.typed = typed;
})(window.Taby);
