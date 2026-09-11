/* tabyBot 웹 클라이언트 — 온보딩.
   앱 전체를 덮는 전용 풀페이지(#onboardingPage). 서버가
   bootstrap.configured === false일 때만 연다(오프라인/401과는 별개).
   진행 구조: STEPS 배열 + draft 한 덩어리. 단계마다 title/desc/build/done.
   1 언어 → 2 프로바이더+인증 → 3 모델 → 4 NSFW·승인 정책.
   컨트롤은 설정과 같은 공통 요소(select, provider-card, radio-row, input)를 쓴다. */
(function (T) {
    "use strict";

    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("onboardingPage");

    const STEP_TOTAL = 4;
    let draft = null; // 각 단계에서 수집한 값
    let idx = 0; // 현재 단계(0 기반)
    let visible = false;
    let saving = false;

    // 모델 목록 로딩 상태
    let models = null;
    let modelsState = "idle"; // idle | loading | ready | failed
    let modelsReq = 0;
    let modelsTimer = 0;
    let modelQuery = "";

    // 온보딩 건너뛰기 상태는 브라우저가 아니라 서버 설정에서 읽는다.
    function isSkipped() {
        return T.state.state.settings?.onboardingDismissed === true;
    }

    /* ── 단계 정의 ──────────────────────────────────────────── */
    const STEPS = [
        { title: "onbLangTitle", desc: "onbLangDesc", build: buildLangStep, done: () => true },
        { title: "onbProvTitle", desc: "onbProvDesc", build: buildProviderStep, done: providerPicked },
        { title: "onbModelTitle", desc: "onbModelDesc", build: buildModelStep, done: () => Boolean(draft && draft.model) },
        { title: "onbPolicyTitle", desc: "onbPolicyDesc", build: buildPolicyStep, done: () => true },
    ];

    /* ── 진입 / 종료 (app.js가 호출하는 공개 인터페이스) ────── */
    function wizard() {
        const s = T.state.state.settings || {};
        draft = {
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
        forgetModels();
        reveal();
    }

    function dismiss() {
        visible = false;
        page.hidden = true;
        page.replaceChildren();
        forgetModels();
    }

    // 401 — 서버 접속 토큰. 성공하면 onSuccess로 부트를 다시 시도한다.
    function showToken(onSuccess) {
        draft = null;
        const errLine = T.h("p", { class: "onb-error", role: "alert" });
        const token = T.h("input", {
            class: "input onb-token-input",
            type: "password",
            placeholder: "TABYBOT_WEB_TOKEN",
            "aria-label": "TABYBOT_WEB_TOKEN",
            autocomplete: "off",
        });
        token.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") connect();
        });

        const box = T.h("div", { class: "onb-token" }, [
            T.h("h1", { class: "onb-title", text: t("onbTokenTitle") }),
            T.h("p", { class: "onb-desc", text: t("onbTokenDesc") }),
            token,
            errLine,
            T.h("button", { class: "btn primary", text: t("onbConnect"), onclick: connect }),
        ]);

        visible = true;
        page.hidden = false;
        page.replaceChildren(T.h("div", { class: "onb-wrap" }, [box]));
        setTimeout(() => token.focus(), 50);

        let busy = false;
        async function connect() {
            if (busy) return;
            const v = token.value.trim();
            if (!v) {
                token.focus();
                return;
            }
            busy = true;
            T.api.setToken(v);
            try {
                await T.api.bootstrap(); // 토큰 검증 겸 부트
                if (onSuccess) onSuccess();
            } catch (err) {
                busy = false;
                errLine.textContent = T.api.errorText(err, t("onbTokenFailed"));
            }
        }
    }

    /* ── 공통 프레임: 진행바 + 제목 + 본문 + 버튼 ───────────── */
    function reveal() {
        visible = true;
        page.hidden = false;
        render();
        page.focus({ preventScroll: true });
    }

    function render() {
        if (!visible || !draft) return;
        const def = STEPS[idx];
        const content = T.h("div", { class: "onb-content" });
        def.build(content);

        const actions = T.h("div", { class: "onb-actions" });
        actions.append(
            T.h("button", {
                class: "btn ghost",
                text: t("onbSkip"),
                async onclick() {
                    const button = this;
                    button.disabled = true;
                    try {
                        const s = await T.api.putSettings({ onboardingDismissed: true });
                        if (s) T.state.setSettings(s);
                        dismiss();
                    } catch (err) {
                        button.disabled = false;
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    }
                },
            }),
        );
        if (idx > 0) {
            actions.append(
                T.h("button", {
                    class: "btn ghost",
                    text: t("onbPrev"),
                    onclick() {
                        idx--;
                        render();
                    },
                }),
            );
        }
        actions.append(T.h("span", { class: "spacer" }));
        const last = idx === STEP_TOTAL - 1;
        const go = T.h("button", {
            class: "btn primary",
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
        if (!visible) return;
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
    function providerList() {
        return (T.state.state.settings && T.state.state.settings.providers) || [];
    }
    function providerOf(id) {
        return providerList().find((p) => p.id === id) || null;
    }
    function oauthKind(meta) {
        return meta && /-oauth$/.test(String(meta.type || ""));
    }
    // 인증이 채워져 모델 목록을 요구할 수 있는 상태인지
    function authReady(meta) {
        if (!draft.providerId) return false;
        if (oauthKind(meta)) return true;
        const keyOk = !meta || meta.apiKeyOptional || draft.apiKey.trim().length > 0;
        const urlOk = !meta || !meta.needsBaseURL || /^https?:\/\/.+/.test(draft.baseURL.trim());
        return keyOk && urlOk;
    }
    function providerPicked() {
        return Boolean(draft && draft.providerId && authReady(providerOf(draft.providerId)));
    }

    /* ── 단계 1: 언어 ───────────────────────────────────────── */
    function buildLangStep(box) {
        box.append(
            pick(
                [
                    { value: "en", label: "English" },
                    { value: "ko", label: "한국어" },
                    { value: "ja", label: "日本語" },
                ],
                draft.lang,
                (v) => {
                    draft.lang = v;
                    T.i18n.setLang(v, { persist: false });
                    render();
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
            const on = draft.providerId === p.id;
            cards.append(
                T.h(
                    "button",
                    {
                        class: "provider-card" + (on ? " selected" : ""),
                        role: "radio",
                        "aria-checked": String(on),
                        onclick() {
                            if (on) return;
                            draft.providerId = p.id;
                            draft.baseURL = "";
                            draft.apiKey = "";
                            draft.model = p.id === "github-copilot" ? "auto" : "";
                            forgetModels();
                            render();
                        },
                    },
                    [T.h("div", { class: "provider-name", text: p.label || p.id }), on ? T.icon("check") : null],
                ),
            );
        }
        box.append(cards);

        const meta = providerOf(draft.providerId);
        if (!meta) return;
        if (meta.needsBaseURL) {
            box.append(
                labeled(
                    t("baseURL"),
                    typed("text", draft.baseURL, "https://api.example.com/v1", (v) => {
                        draft.baseURL = v;
                        forgetModels();
                        refreshGo();
                    }),
                ),
            );
        }
        if (oauthKind(meta)) {
            box.append(labeled(t("oauthAccount"), T.settingsUI.oauthSection(meta.id, render)));
        } else {
            box.append(
                labeled(
                    t("apiKey") + (meta.apiKeyOptional ? ` (${t("apiKeyOptional")})` : ""),
                    T.settingsUI.secretInput({
                        value: draft.apiKey,
                        placeholder: "sk-…",
                        aria: t("apiKey"),
                        onInput(v) {
                            draft.apiKey = v;
                            forgetModels();
                            refreshGo();
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
                        text: t("getApiKey") + " ↗",
                    }),
                );
            }
        }
    }

    /* ── 단계 3: 모델 ───────────────────────────────────────── */
    function buildModelStep(box) {
        box.append(modelArea());
    }

    function forgetModels() {
        models = null;
        modelsState = "idle";
        modelsReq++;
        clearTimeout(modelsTimer);
        modelsTimer = 0;
        modelQuery = "";
    }

    function modelArea() {
        const wrap = T.h("div", { class: "onb-models" });

        // 목록이 아직 없으면: 입력이 유효한 순간 자동으로 불러온다(디바운스).
        if (modelsState === "idle") {
            if (authReady(providerOf(draft.providerId))) {
                modelsState = "loading";
                fetchModels();
            } else {
                wrap.append(manualModel());
                return wrap;
            }
        }

        if (modelsState === "loading") {
            wrap.append(T.h("div", { class: "empty-note", text: t("loadingModels") }));
            return wrap;
        }

        if (modelsState === "failed" || (modelsState === "ready" && !models.length)) {
            wrap.append(manualModel());
            if (modelsState === "failed") {
                wrap.append(
                    T.h("button", {
                        class: "btn ghost",
                        text: t("retry"),
                        onclick() {
                            modelsState = "loading";
                            render();
                            fetchModels();
                        },
                    }),
                );
            }
            return wrap;
        }

        // ready — 검색 + 라디오 목록
        const filter = T.h("input", {
            class: "input",
            type: "text",
            placeholder: t("searchModels"),
            "aria-label": t("searchModels"),
            value: modelQuery,
        });
        filter.addEventListener("input", () => {
            modelQuery = filter.value.toLowerCase();
            paint();
        });
        filter.addEventListener("keydown", (e) => e.stopPropagation());
        wrap.append(filter);

        const rows = T.h("div", { class: "models-list", role: "radiogroup", "aria-label": t("model") });
        wrap.append(rows);

        function paint() {
            rows.replaceChildren();
            const q = modelQuery;
            const hits = models.filter((m) => {
                const id = String(m.id || "").toLowerCase();
                const label = String(m.label || "").toLowerCase();
                return !q || id.includes(q) || label.includes(q);
            });
            if (!hits.length) {
                rows.append(T.h("div", { class: "empty-note", text: t("noModels") }));
                return;
            }
            for (const m of hits) {
                const on = draft.model === m.id;
                rows.append(
                    T.h(
                        "button",
                        {
                            class: "radio-row" + (on ? " selected" : ""),
                            role: "radio",
                            "aria-checked": String(on),
                            onclick() {
                                draft.model = m.id;
                                paint();
                                refreshGo();
                            },
                        },
                        [
                            T.h("span", { class: "radio-dot" }),
                            T.h("div", { class: "model-main" }, [
                                T.h("div", { class: "model-label", text: m.label || m.id }),
                                T.h("div", { class: "model-id", text: m.id }),
                            ]),
                            Number.isFinite(Number(m.contextWindow)) && Number(m.contextWindow) > 0
                                ? T.h("span", { class: "model-ctx", text: Number(m.contextWindow).toLocaleString() })
                                : null,
                        ],
                    ),
                );
            }
        }
        paint();
        return wrap;
    }

    function manualModel() {
        const el = typed(
            "text",
            draft.model,
            t("manualModelPlaceholder"),
            (v) => {
                draft.model = v.trim();
                refreshGo();
            },
            t("manualModel"),
        );
        return labeled(t("manualModel"), el);
    }

    async function fetchModels() {
        const req = ++modelsReq;
        const q = { providerId: draft.providerId };
        if (draft.baseURL.trim()) q.baseURL = draft.baseURL.trim();
        if (draft.apiKey.trim()) q.apiKey = draft.apiKey.trim();
        try {
            const r = await T.api.models(q);
            if (req !== modelsReq) return;
            models = Array.isArray(r?.models) ? r.models : [];
            modelsState = "ready";
        } catch (_) {
            if (req !== modelsReq) return;
            modelsState = "failed";
        }
        if (req === modelsReq && visible) render();
    }

    /* ── 단계 4: NSFW / 영구 행위 승인 ──────────────────────── */
    function buildPolicyStep(box) {
        const s = T.state.state.settings || {};
        const nsfwNames = { strict: t("nsfwStrict"), moderate: t("nsfwModerate"), explicit: t("nsfwExplicit") };
        const approvalNames = { user: t("approvalUser"), model: t("approvalModel"), always: t("approvalAlways") };

        box.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("nsfwLevel") }),
                pick(
                    (s.nsfwLevels || ["strict", "moderate", "explicit"]).map((v) => ({ value: v, label: nsfwNames[v] || v })),
                    draft.nsfw,
                    (v) => (draft.nsfw = v),
                    t("nsfwLevel"),
                ),
            ]),
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("approvalLevel") }),
                pick(
                    (s.approvalLevels || ["user", "model", "always"]).map((v) => ({ value: v, label: approvalNames[v] || v })),
                    draft.approval,
                    (v) => (draft.approval = v),
                    t("approvalLevel"),
                ),
            ]),
            T.h("p", { class: "set-desc", text: t("approvalDesc") }),
            T.h("p", { class: "set-desc", text: t("onbPolicyNote") }),
        );
    }

    /* ── 저장 ───────────────────────────────────────────────── */
    async function save() {
        if (saving || !STEPS[idx].done()) return;
        saving = true;
        const meta = providerOf(draft.providerId);
        const provider = { id: draft.providerId, model: draft.model };
        if (draft.providerId === "github-copilot") provider.autoMode = true;
        if (meta && meta.needsBaseURL) provider.baseURL = draft.baseURL.trim();
        if (draft.apiKey.trim()) provider.apiKey = draft.apiKey.trim();

        try {
            await T.api.putSettings({
                language: draft.lang,
                provider,
                onboardingDismissed: false,
                nsfwLevel: draft.nsfw,
                approvalLevel: draft.approval,
            });
            const bs = await T.api.bootstrap();
            T.state.state.bootstrap = bs;
            T.state.emit("bootstrap");
            try {
                const s = await T.api.getSettings();
                if (s) T.state.setSettings(s);
            } catch (_) {}
            dismiss();
            try {
                const r = await T.api.agents();
                T.state.setBots(r.agents || []);
            } catch (_) {}
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
        if (visible) render();
    });
    T.state.on("oauth_done", () => {
        if (visible && draft && idx === 1) {
            // 이 핸들러가 settings.js보다 먼저 등록되므로, pending이 비워지기 전에
            // 다시 그리는 것을 막기 위해 직접 비운다.
            T.settingsUI.resetOauth();
            render();
        }
    });

    T.onboarding = { wizard, showToken, dismiss, isSkipped };
})((window.Taby = window.Taby || {}));
