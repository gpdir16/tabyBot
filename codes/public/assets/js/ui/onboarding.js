/* tabyBot 웹 클라이언트 — 온보딩.
   bootstrap.configured === false → 전체화면 마법사.
   단계: 언어 → 프로바이더 → API 키(+Custom baseURL) → 모델 → 완료.
   401이면 먼저 토큰 입력 화면. 각 단계 뒤로 가기 + 진행 점 인디케이터. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    const root = document.getElementById("overlayRoot");
    let wizardEl = null; // 열려 있는 오버레이 엘리먼트
    let data = null; // 마법사 수집 상태
    let step = 0;
    const STEP_COUNT = 5;
    let models = null; // 3단계 모델 목록
    let modelsState = "idle"; // idle | loading | error | done
    let modelsReq = 0;
    let modelFilter = "";
    let finishing = false;

    /* ── 토큰 입력 화면(401) ────────────────────────────────── */
    function showToken(onSuccess) {
        dismiss();
        let submitting = false;
        const err = T.h("div", { class: "set-desc", style: "color:var(--danger);min-height:16px" });
        const input = T.h("input", {
            class: "input",
            type: "password",
            placeholder: "TABYBOT_WEB_TOKEN",
            "aria-label": "TABYBOT_WEB_TOKEN",
            autocomplete: "off",
        });
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
        });

        const card = T.h("div", { class: "card narrow" }, [
            T.h("div", { class: "ob-logo" }, [T.icon("logo", "logo-mark")]),
            T.h("div", { class: "ob-title", text: t("tokenTitle") }),
            T.h("div", { class: "ob-sub", text: t("tokenDesc") }),
            T.h("div", { style: "display:flex;flex-direction:column;gap:10px;margin-top:20px" }, [
                input,
                err,
                T.h("button", { class: "btn primary", text: t("tokenSubmit"), onclick: submit }),
            ]),
        ]);

        const overlay = T.h("div", { class: "overlay", role: "dialog", "aria-modal": "true" }, [card]);
        root.append(overlay);
        wizardEl = overlay;
        setTimeout(() => input.focus(), 50);

        async function submit() {
            if (submitting) return;
            const v = input.value.trim();
            if (!v) {
                input.focus();
                return;
            }
            submitting = true;
            T.api.setToken(v);
            try {
                await T.api.bootstrap(); // 토큰 검증
                overlay.remove();
                wizardEl = null;
                if (onSuccess) onSuccess();
            } catch (_) {
                submitting = false;
                err.textContent = t("tokenFailed");
            }
        }
    }

    /* ── 마법사 ─────────────────────────────────────────────── */
    function wizard() {
        dismiss();
        data = {
            lang: T.i18n.getLang(),
            providerId: null,
            baseURL: "",
            apiKey: "",
            model: null,
        };
        step = 0;
        models = null;
        modelsState = "idle";
        modelsReq++;
        modelFilter = "";
        finishing = false;
        render();
    }

    function dismiss() {
        if (wizardEl) {
            wizardEl.remove();
            wizardEl = null;
        }
    }

    function providers() {
        return (state.state.settings && state.state.settings.providers) || [];
    }
    function providerMeta() {
        return providers().find((p) => p.id === data.providerId) || null;
    }

    function render() {
        dismiss();
        const body = T.h("div", { class: "ob-body" });

        const dots = T.h("div", { class: "dots" });
        for (let i = 0; i < STEP_COUNT; i++) {
            dots.append(T.h("span", { class: "dot-i" + (i === step ? " on" : "") }));
        }

        const foot = T.h("div", { class: "ob-foot" }, [T.h("span", { class: "spacer" })]);
        if (step > 0) {
            foot.append(
                T.h("button", {
                    class: "btn ghost",
                    text: t("back"),
                    onclick: () => {
                        step--;
                        render();
                    },
                }),
            );
        }

        const card = T.h("div", { class: "card" }, [
            T.h("div", { class: "ob-logo" }, [T.icon("logo", "logo-mark")]),
            T.h("div", { class: "ob-title", text: t("setupTitle") }),
            T.h("div", { class: "ob-sub", text: t("setupSubtitle") }),
            dots,
            body,
            foot,
        ]);

        // 오프라인: 서버 연결 불가 안내 + 재시도
        if (state.state.offline) {
            card.prepend(
                T.h("div", { class: "offline-note" }, [
                    T.icon("warn", "icon-sm"),
                    T.h("span", { text: t("offlineNote") }),
                    T.h("button", {
                        class: "btn ghost",
                        text: t("retry"),
                        onclick: () => {
                            if (T.app) T.app.retryBoot();
                        },
                    }),
                ]),
            );
        }

        wizardEl = T.h("div", { class: "overlay", role: "dialog", "aria-modal": "true" }, [card]);
        root.append(wizardEl);

        // 구조(body/foot/wizardEl) 확정 후 단계 콘텐츠를 채운다.
        // 단계 함수의 nextBtn→footAppend가 .ob-foot을 찾을 수 있어야 하므로 순서가 중요.
        if (step === 0) stepLanguage(body);
        else if (step === 1) stepProvider(body);
        else if (step === 2) stepApiKey(body);
        else if (step === 3) stepModel(body);
        else stepDone(body);
    }

    function nextBtn(label, disabled, onclick) {
        const b = T.h("button", { class: "btn primary", text: label || t("next"), onclick });
        if (disabled) b.disabled = true;
        footAppend(b);
        return b;
    }
    function footAppend(btn) {
        const foot = wizardEl && wizardEl.querySelector(".ob-foot");
        if (foot) foot.append(btn);
    }

    /* 0. 언어 — 선택 즉시 UI 전환 + 다음 단계로 */
    function stepLanguage(body) {
        body.setAttribute("role", "radiogroup");
        body.setAttribute("aria-label", t("language"));
        body.append(T.h("div", { class: "step-label", text: t("setupLanguage") }));
        [
            ["en", "English", "Default"],
            ["ko", "한국어", "Korean"],
            ["ja", "日本語", "Japanese"],
        ].forEach(([v, name, sub]) => {
            body.append(
                T.h(
                    "button",
                    {
                        class: "opt" + (data.lang === v ? " selected" : ""),
                        role: "radio",
                        "aria-checked": String(data.lang === v),
                        onclick() {
                            data.lang = v;
                            T.i18n.setLang(v, { persist: false });
                            step++;
                            render();
                        },
                    },
                    [
                        T.h("div", {}, [T.h("div", { class: "opt-name", text: name }), T.h("div", { class: "opt-sub", text: sub })]),
                        data.lang === v ? T.icon("check") : null,
                    ],
                ),
            );
        });
    }

    /* 1. 프로바이더 */
    function stepProvider(body) {
        body.setAttribute("role", "radiogroup");
        body.setAttribute("aria-label", t("provider"));
        body.append(T.h("div", { class: "step-label", text: t("setupProvider") }));
        const list = providers();
        if (!list.length) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            nextBtn(t("retry"), false, () => T.app?.retryBoot());
            return;
        }
        for (const p of list) {
            body.append(
                T.h(
                    "button",
                    {
                        class: "opt" + (data.providerId === p.id ? " selected" : ""),
                        role: "radio",
                        "aria-checked": String(data.providerId === p.id),
                        onclick() {
                            data.providerId = p.id;
                            data.baseURL = "";
                            data.apiKey = "";
                            data.model = null;
                            models = null;
                            modelsState = "idle";
                            modelsReq++;
                            modelFilter = "";
                            step++;
                            render();
                        },
                    },
                    [T.h("div", { class: "opt-name", text: p.label || p.id })],
                ),
            );
        }
    }

    /* 2. API 키 (+Custom baseURL) */
    function stepApiKey(body) {
        const meta = providerMeta();
        const isOauth = Boolean(meta && /-oauth$/.test(String(meta.type || "")));
        body.append(T.h("div", { class: "step-label", text: t("setupApiKey") }));

        if (isOauth) {
            // OAuth 프로바이더(Codex/Grok): API 키 대신 디바이스 플로우 로그인
            body.append(T.settingsUI.oauthSection(data.providerId, render));
            const next = nextBtn(t("next"), true, () => {
                step++;
                render();
            });
            T.api
                .authStatus()
                .then((st) => {
                    if (next && st && st[data.providerId]) next.disabled = false;
                })
                .catch(() => {});
            return;
        }

        if (meta && meta.needsBaseURL) {
            body.append(
                T.h("div", { class: "field" }, [
                    fieldLabel(t("baseURL")),
                    mkInput(
                        "text",
                        data.baseURL,
                        "https://api.example.com/v1",
                        (v) => {
                            if (data.baseURL !== v) {
                                data.baseURL = v;
                                models = null;
                                modelsState = "idle";
                                modelsReq++;
                                modelFilter = "";
                            }
                        },
                        t("baseURL"),
                    ),
                ]),
            );
        }
        if (!isOauth) {
            body.append(
                T.h("div", { class: "field" }, [
                    fieldLabel(t("apiKey")),
                    mkInput(
                        "password",
                        data.apiKey,
                        "sk-…",
                        (v) => {
                            if (data.apiKey !== v) {
                                data.apiKey = v;
                                models = null;
                                modelsState = "idle";
                                modelsReq++;
                                modelFilter = "";
                            }
                        },
                        t("apiKey"),
                    ),
                ]),
            );
        }
        body.append(T.h("div", { class: "set-desc", text: t("setupApiKeyHint") }));

        const valid = () => {
            const keyOk = !meta || meta.apiKeyOptional || data.apiKey.trim().length > 0;
            const urlOk = !meta || !meta.needsBaseURL || /^https?:\/\/.+/.test(data.baseURL.trim());
            return keyOk && urlOk;
        };
        nextBtn(t("next"), !valid(), () => {
            step++;
            render();
        });
        // 입력 변화 시 버튼 상태 갱신
        body.addEventListener("input", () => {
            const b = wizardEl.querySelector(".ob-foot .btn.primary");
            if (b) b.disabled = !valid();
        });
    }

    function mkInput(type, value, placeholder, onInput, label) {
        const el = T.h("input", {
            class: "input",
            type,
            value,
            placeholder,
            "aria-label": label || placeholder,
            autocomplete: "off",
            spellcheck: "false",
        });
        el.addEventListener("input", () => onInput(el.value));
        el.addEventListener("keydown", (e) => e.stopPropagation());
        return el;
    }
    function fieldLabel(text) {
        return T.h("div", { class: "field-label", text });
    }

    /* 3. 모델 — 진입 시 자동 로드 */
    function stepModel(body) {
        body.append(T.h("div", { class: "step-label", text: t("setupModel") }));

        if (modelsState === "idle") {
            modelsState = "loading";
            loadModels();
        }
        if (modelsState === "loading") {
            body.append(T.h("div", { class: "gen-label" }, [T.h("span", { class: "shimmer", text: t("loadingModels") })]));
            return;
        }
        if (modelsState === "error") {
            const input = manualModelInput(body);
            body.append(
                T.h("button", {
                    class: "btn ghost",
                    text: t("retry"),
                    onclick: () => {
                        modelsState = "idle";
                        render();
                    },
                }),
            );
            const next = nextBtn(t("next"), !data.model, () => {
                step++;
                render();
            });
            input.addEventListener("input", () => {
                next.disabled = !data.model;
            });
            return;
        }

        if (!models.length) {
            const input = manualModelInput(body);
            const next = nextBtn(t("next"), !data.model, () => {
                step++;
                render();
            });
            input.addEventListener("input", () => {
                next.disabled = !data.model;
            });
            return;
        }

        const search = T.h("input", {
            class: "input",
            type: "text",
            placeholder: t("searchModels"),
            "aria-label": t("searchModels"),
            value: modelFilter,
        });
        search.addEventListener("input", () => {
            modelFilter = search.value.toLowerCase();
            renderList();
        });
        search.addEventListener("keydown", (e) => e.stopPropagation());
        body.append(search);

        const list = T.h("div", {
            class: "models-list",
            role: "radiogroup",
            "aria-label": t("model"),
        });
        body.append(list);

        function renderList() {
            list.replaceChildren();
            const filtered = (models || []).filter((m) => {
                const id = String(m.id || "").toLowerCase();
                const label = String(m.label || "").toLowerCase();
                return !modelFilter || id.includes(modelFilter) || label.includes(modelFilter);
            });
            if (!filtered.length) {
                list.append(T.h("div", { class: "empty-note", text: t("noModels") }));
                return;
            }
            for (const m of filtered) {
                list.append(
                    T.h(
                        "button",
                        {
                            class: "radio-row" + (data.model === m.id ? " selected" : ""),
                            role: "radio",
                            "aria-checked": String(data.model === m.id),
                            onclick() {
                                data.model = m.id;
                                renderList();
                                const b = wizardEl.querySelector(".ob-foot .btn.primary");
                                if (b) b.disabled = false;
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
        renderList();
        nextBtn(t("next"), !data.model, () => {
            step++;
            render();
        });
    }

    function manualModelInput(body) {
        const input = T.h("input", {
            class: "input",
            type: "text",
            value: data.model || "",
            placeholder: t("manualModelPlaceholder"),
            "aria-label": t("manualModel"),
            spellcheck: "false",
        });
        input.addEventListener("input", () => {
            data.model = input.value.trim();
        });
        input.addEventListener("keydown", (e) => e.stopPropagation());
        body.append(T.h("div", { class: "field" }, [fieldLabel(t("manualModel")), input]));
        return input;
    }

    async function loadModels() {
        const req = ++modelsReq;
        const payload = { providerId: data.providerId };
        if (data.baseURL.trim()) payload.baseURL = data.baseURL.trim();
        if (data.apiKey.trim()) payload.apiKey = data.apiKey.trim();
        try {
            const r = await T.api.models(payload);
            if (req !== modelsReq) return;
            models = Array.isArray(r?.models) ? r.models : [];
            modelsState = "done";
        } catch (_) {
            if (req !== modelsReq) return;
            modelsState = "error";
        }
        if (req === modelsReq && wizardEl) render();
    }

    /* 4. 완료 */
    function stepDone(body) {
        body.style.justifyContent = "center";
        body.append(
            T.h("div", { style: "text-align:center" }, [
                T.h("svg", { class: "done-check", viewBox: "0 0 52 52" }, [
                    (function () {
                        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                        c.setAttribute("cx", "26");
                        c.setAttribute("cy", "26");
                        c.setAttribute("r", "25");
                        c.setAttribute("fill", "none");
                        c.setAttribute("stroke", "currentColor");
                        c.setAttribute("stroke-width", "2");
                        return c;
                    })(),
                    (function () {
                        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
                        p.setAttribute("d", "M14 27l8 8 16-16");
                        p.setAttribute("fill", "none");
                        p.setAttribute("stroke", "currentColor");
                        p.setAttribute("stroke-width", "3");
                        p.setAttribute("stroke-linecap", "round");
                        p.setAttribute("stroke-linejoin", "round");
                        return p;
                    })(),
                ]),
                T.h("div", { class: "ob-title", text: t("setupDoneTitle") }),
                T.h("div", { class: "ob-sub", text: t("setupDone") }),
            ]),
        );

        const btn = T.h("button", { class: "btn primary", text: t("start"), onclick: finish });
        footAppend(btn);
    }

    async function finish() {
        if (finishing) return;
        finishing = true;
        const meta = providerMeta();
        const provider = { id: data.providerId, model: data.model };
        if (meta && meta.needsBaseURL) provider.baseURL = data.baseURL.trim();
        if (data.apiKey.trim()) provider.apiKey = data.apiKey.trim();

        try {
            await T.api.putSettings({ language: data.lang, provider });
            // 부트 데이터 재확인 후 마법사 해제
            const bs = await T.api.bootstrap();
            state.state.bootstrap = bs;
            state.emit("bootstrap");
            try {
                const s = await T.api.getSettings();
                if (s) state.setSettings(s);
            } catch (_) {}
            state.state.offline = false;
            dismiss();
            // 설정 저장 후 봇 목록을 새로 읽어 첫 봇 스레드를 연다
            try {
                const r = await T.api.agents();
                state.setBots(r.agents || []);
            } catch (_) {}
            const bot = state.state.bots[0];
            if (bot) T.chat.open(bot.threadId);
            T.events.connect();
        } catch (_) {
            finishing = false;
            T.toast.show("error", t("saveFailed"));
        }
    }

    T.i18n.onChange(() => {
        if (wizardEl) render();
    });

    // OAuth 로그인 완료/실패 시 마법사가 열려 있으면 다시 그린다.
    state.on("oauth_done", () => {
        if (wizardEl && data && data.providerId && /-oauth$/.test(String(providerMeta()?.type || ""))) render();
    });

    T.onboarding = { wizard, showToken, dismiss };
})((window.Taby = window.Taby || {}));
