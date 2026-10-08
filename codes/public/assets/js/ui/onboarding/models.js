/* tabyBot 웹 클라이언트: 설정 마법사의 모델 선택 단계. */
((T) => {
    "use strict";

    T.onboardingCtx ??= {};
    const C = T.onboardingCtx;
    const t = (k, v) => T.i18n.t(k, v);

    // 모델 목록 로딩 상태
    let models = null;

    let modelsState = "idle"; // idle | loading | ready | failed

    let modelsReq = 0;

    let modelsTimer = 0;

    let modelQuery = "";

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
            if (C.authReady(C.providerOf(C.draft.providerId))) {
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
                            C.render();
                            fetchModels();
                        },
                    }),
                );
            }
            return wrap;
        }

        // ready: 검색 + 라디오 목록
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
                const on = C.draft.model === m.id;
                rows.append(
                    T.h(
                        "button",
                        {
                            class: `radio-row${on ? " selected" : ""}`,
                            role: "radio",
                            "aria-checked": String(on),
                            onclick() {
                                C.draft.model = m.id;
                                paint();
                                C.refreshGo();
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
        const el = C.typed(
            "text",
            C.draft.model,
            t("manualModelPlaceholder"),
            (v) => {
                C.draft.model = v.trim();
                C.refreshGo();
            },
            t("manualModel"),
        );
        return C.labeled(t("manualModel"), el);
    }

    async function fetchModels() {
        const req = ++modelsReq;
        const q = { providerId: C.draft.providerId };
        if (C.draft.baseURL.trim()) q.baseURL = C.draft.baseURL.trim();
        if (C.draft.apiKey.trim()) q.apiKey = C.draft.apiKey.trim();
        try {
            const r = await T.api.models(q);
            if (req !== modelsReq) return;
            models = Array.isArray(r?.models) ? r.models : [];
            modelsState = "ready";
        } catch (_) {
            if (req !== modelsReq) return;
            modelsState = "failed";
        }
        if (req === modelsReq && C.visible) C.render();
    }

    C.buildModelStep = buildModelStep;
    C.forgetModels = forgetModels;
})(window.Taby);
