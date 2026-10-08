/* tabyBot 웹 클라이언트: 설정 > 프로바이더·모델 탭과 OAuth·API 키·모델 목록 조각. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.modelsCache = null; // { key, models }

    C.modelsLoading = false;

    C.modelsFailedKey = null;

    C.modelsReq = 0;

    let modelFilter = "";

    C.providerChoice = null;

    C.keyEditing = false; // 저장된 API 키를 다시 입력하는 중인지

    C.oauthPending = null; // 진행 중 OAuth 디바이스 플로우 { kind, userCode, deviceUrl }

    /* ── 프로바이더 페이지 ──────────────────────────────────── */
    function buildProvider(body) {
        const s = state.state.settings;
        if (!s) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }
        const sec = T.h("div", { class: "set-section" });
        const provider = s.provider || {};
        const providers = s.providers || [];
        const defaultPreset = providers.find((p) => p.id === "default");
        const customActive =
            C.providerChoice === "custom" || (provider.id === "default" && defaultPreset && provider.baseURL !== defaultPreset.baseURL);
        const selectedProviderId = customActive ? "custom" : provider.id;
        if (!providers.length) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }

        const meta = providers.find((p) => p.id === (customActive ? "custom" : provider.id));
        if (meta) {
            if (customActive || meta.needsBaseURL) {
                sec.append(
                    T.h("div", { class: "set-row" }, [
                        T.h("div", { class: "set-label", text: t("baseURL") }),
                        T.h("div", { class: "set-control" }, [baseURLInput(provider, customActive && provider.baseURL === defaultPreset?.baseURL)]),
                    ]),
                );
            }
            if (isOauthProvider(meta)) {
                sec.append(oauthSection(provider.id));
            } else {
                sec.append(
                    T.h("div", { class: "set-row" }, [
                        T.h("div", { class: "set-label", text: t("apiKey") }),
                        T.h("div", { class: "set-control" }, [apiKeyRow(provider, meta)]),
                    ]),
                );
            }
            sec.append(T.h("hr", { class: "divider" }));
        }

        const plist = T.h("div", { class: "provider-list", role: "radiogroup", "aria-label": t("provider") });
        for (const p of providers) {
            const selected = selectedProviderId === p.id;
            plist.append(
                T.h(
                    "button",
                    {
                        class: `provider-card${selected ? " selected" : ""}`,
                        role: "radio",
                        "aria-checked": String(selected),
                        onclick() {
                            if (selected) return;
                            C.providerChoice = p.id;
                            C.keyEditing = false;
                            C.modelsReq++;
                            C.modelsLoading = false;
                            C.modelsCache = null;
                            C.modelsFailedKey = null;
                            const patch =
                                p.id === "github-copilot"
                                    ? { id: p.id, model: "auto", autoMode: true }
                                    : p.id === "custom" || p.id === "default"
                                      ? { id: p.id, baseURL: "", model: "" }
                                      : { id: p.id, model: "" };
                            C.put({ provider: patch }).then(() => C.build());
                        },
                    },
                    [T.h("div", { class: "provider-name", text: p.label || p.id }), selected ? T.icon("check") : null],
                ),
            );
        }
        sec.append(plist);

        body.append(sec);
    }

    function autoSessionSettings(provider) {
        const box = T.h("div", { class: "set-section" });
        const enabled = provider.autoMode === true;
        const toggle = C.switchEl(
            enabled,
            (value) => {
                C.put({ provider: { autoMode: value, model: value ? "auto" : "" } }).then(() => C.build());
            },
            t("autoModelUse"),
        );
        box.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("autoModelUse") }),
                T.h("div", { class: "set-control" }, [toggle]),
            ]),
            T.h("div", { class: "set-desc", text: t("autoModelUseDesc") }),
        );
        if (!enabled) return box;

        box.append(C.fieldLabel(t("autoModelRouting")), T.h("div", { class: "set-desc", text: t("autoModelRoutingDesc") }));
        const key = modelsKey(provider);
        const routingModels = C.modelsCache?.key === key ? C.modelsCache.routingModels || [] : [];
        const selected = new Set(Array.isArray(provider.autoModelCandidates) ? provider.autoModelCandidates : []);
        if (!routingModels.length) {
            box.append(T.h("div", { class: "empty-note", text: C.modelsLoading ? t("loadingModels") : t("autoModelNoRouting") }));
            return box;
        }
        const list = T.h("div", { class: "models-list" });
        for (const model of routingModels) {
            const input = T.h("input", { type: "checkbox", "aria-label": model.label || model.id });
            input.checked = selected.has(model.id);
            input.addEventListener("change", () => {
                const next = new Set(selected);
                if (input.checked) next.add(model.id);
                else next.delete(model.id);
                C.put({ provider: { autoModelCandidates: [...next] } }).then(() => C.build());
            });
            list.append(T.h("label", { class: "set-row" }, [T.h("span", { text: model.label || model.id }), input]));
        }
        box.append(list);
        return box;
    }

    function isOauthProvider(meta) {
        return Boolean(meta && /-oauth$/.test(String(meta.type || "")));
    }

    // 모델 목록 캐시 무효화: 키/URL 변경 후 공통으로 쓴다.
    function resetModels() {
        C.modelsReq++;
        C.modelsLoading = false;
        C.modelsCache = null;
        C.modelsFailedKey = null;
    }

    // OAuth 디바이스 플로우 섹션: 상태 표시 + 로그인 버튼 + 대기 중 안내(코드/링크).
    // rerender: 로그인 시작 후 화면을 다시 그릴 콜백(설정 시트는 build, 온보딩은 render).

    // 대기 박스가 떠 있는 동안 서버 폴링 주기(최대 ~8초)에만 의존하지 않고
    // 클라이언트가 직접 로그인 완료를 확인한다. SSE oauth_done 유실에도 동작한다.
    let oauthPollTimer = 0;

    let oauthPollTries = 0;

    function stopOauthPoll() {
        clearTimeout(oauthPollTimer);
        oauthPollTimer = 0;
    }

    function startOauthPoll(kind, refresh) {
        stopOauthPoll();
        oauthPollTries = 0;
        const tick = () => {
            // pending이 사라졌으면(다른 경로에서 완료/취소) 종료.
            if (!C.oauthPending || C.oauthPending.kind !== kind) return;
            oauthPollTries++;
            // 5분 후 포기: 디바이스 코드 만료와 맞춘다.
            if (oauthPollTries > 100) return;
            T.api
                .authStatus()
                .then((st) => {
                    if (!C.oauthPending || C.oauthPending.kind !== kind) return;
                    if (st?.[kind]) {
                        C.oauthPending = null;
                        stopOauthPoll();
                        refresh();
                    } else {
                        oauthPollTimer = setTimeout(tick, 3000);
                    }
                })
                .catch(() => {
                    if (C.oauthPending && C.oauthPending.kind === kind) oauthPollTimer = setTimeout(tick, 3000);
                });
        };
        oauthPollTimer = setTimeout(tick, 3000);
    }

    function oauthSection(kind, rerender) {
        const refresh = rerender || C.build;
        const box = T.h("div", { class: "set-section" });

        if (C.oauthPending && C.oauthPending.kind === kind) {
            // 완료 감지: SSE 이벤트 + 상태 폴링 병행
            startOauthPoll(kind, refresh);
            // 디바이스 코드 카드: 코드 크게 표시 + 복사 + 페이지 열기
            box.append(
                T.h("div", { class: "oauth-pending" }, [
                    T.h("div", { class: "set-desc", text: t("oauthEnterCode") }),
                    T.h("div", { class: "oauth-code-row" }, [
                        T.h("span", { class: "oauth-code", text: C.oauthPending.userCode }),
                        T.h(
                            "button",
                            {
                                class: "btn-icon",
                                "aria-label": t("copy"),
                                onclick() {
                                    T.copyText(C.oauthPending.userCode).then((ok) => {
                                        if (ok) T.toast.show("info", t("copied"));
                                    });
                                },
                            },
                            [T.icon("copy")],
                        ),
                    ]),
                    T.h("a", {
                        class: "btn primary oauth-open",
                        href: C.oauthPending.deviceUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        text: t("oauthOpenPage"),
                    }),
                    T.h("div", { class: "oauth-foot" }, [
                        T.h("div", { class: "oauth-wait" }, [T.h("span", { class: "spin quiet" }), T.h("span", { text: t("oauthPending") })]),
                        T.h("button", {
                            class: "btn ghost",
                            text: t("cancel"),
                            onclick() {
                                T.api.cancelOauth(kind).catch(() => {
                                    /* 취소 요청이 실패해도 대기 중인 로그인은 만료되면 사라진다 */
                                });
                                C.oauthPending = null;
                                stopOauthPoll();
                                refresh();
                            },
                        }),
                    ]),
                ]),
            );
            return box;
        }

        const account = T.h("div", { class: "set-control" }, [T.h("div", { class: "set-desc", text: t("oauthChecking") })]);
        const row = T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: t("oauthAccount") }), account]);
        box.append(row);

        T.api
            .authStatus()
            .then((st) => {
                const loggedIn = Boolean(st?.[kind]);
                account.replaceChildren(
                    T.h("div", { class: `key-state${loggedIn ? "" : " off"}` }, [
                        T.h("span", { class: "key-dot" }),
                        T.h("span", { text: loggedIn ? t("oauthLoggedIn") : t("oauthNotLoggedIn") }),
                    ]),
                    T.h(
                        "button",
                        {
                            class: `btn${loggedIn ? " ghost" : " primary"}`,
                            text: loggedIn ? t("oauthRelogin") : t("oauthLogin"),
                            onclick() {
                                T.api
                                    .startOauth(kind)
                                    .then((flow) => {
                                        if (!flow?.userCode || !flow.deviceUrl) throw new Error(t("oauthFailed"));
                                        C.oauthPending = { kind, userCode: flow.userCode, deviceUrl: flow.deviceUrl };
                                        refresh();
                                    })
                                    .catch((err) => {
                                        T.toast.show("error", T.api.errorText(err, t("oauthFailed")));
                                    });
                            },
                        },
                        [],
                    ),
                );
            })
            .catch(() => {
                account.replaceChildren(T.h("div", { class: "set-desc", text: t("offlineNote") }));
            });
        return box;
    }

    function baseURLInput(provider, blank = false) {
        const input = T.h("input", {
            value: blank ? "" : provider.baseURL || "",
            class: "input",
            "aria-label": t("baseURL"),
            type: "text",
            placeholder: "https://api.example.com/v1",
            spellcheck: "false",
        });
        const commit = () => {
            const v = input.value.trim();
            if (v !== (provider.baseURL || "")) {
                C.modelsReq++;
                C.modelsLoading = false;
                C.modelsCache = null;
                C.modelsFailedKey = null;
                C.put({ provider: { baseURL: v } });
            }
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
        });
        return input;
    }

    function apiKeyRow(provider, meta) {
        const wrap = T.h("div", { class: "key-wrap" });

        if (provider.apiKeySet && !C.keyEditing) {
            // 저장된 키가 있으면 마스킹 상태로 보여주고, "교체"를 눌렀을 때만 입력칸을 연다.
            wrap.append(
                T.h("div", { class: "key-saved-row" }, [
                    T.h("div", { class: "key-state" }, [T.icon("check", "icon-sm"), t("apiKeySaved")]),
                    T.h("button", {
                        class: "btn ghost",
                        text: t("apiKeyReplace"),
                        onclick() {
                            C.keyEditing = true;
                            C.build();
                        },
                    }),
                ]),
            );
        } else {
            const row = C.secretInput({
                placeholder: provider.apiKeySet ? "••••••••" : meta.apiKeyOptional ? "" : "sk-…",
                aria: t("apiKey"),
                onCommit(input) {
                    const v = input.trim();
                    if (!v) return;
                    C.put({ provider: { apiKey: v } }).then((ok) => {
                        if (ok) {
                            C.keyEditing = false;
                            resetModels();
                            C.build();
                        }
                    });
                },
            });
            if (provider.apiKeySet) {
                // 교체 취소: 입력칸과 같은 줄에 둔다.
                row.append(
                    T.h("button", {
                        class: "btn ghost",
                        text: t("cancel"),
                        onclick() {
                            C.keyEditing = false;
                            C.build();
                        },
                    }),
                );
            }
            wrap.append(row);
        }
        if (meta.keysUrl) {
            wrap.append(
                T.h("a", {
                    class: "key-hint",
                    href: meta.keysUrl,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    text: `${t("getApiKey")} ↗`,
                }),
            );
        }
        return wrap;
    }

    function modelsKey(provider) {
        return `${String(provider.id || "")}\n${String(provider.baseURL || "")}`;
    }

    async function loadModels(provider) {
        const req = ++C.modelsReq;
        const key = modelsKey(provider);
        C.modelsLoading = true;
        const payload = { providerId: provider.id };
        if (provider.baseURL) payload.baseURL = provider.baseURL;
        try {
            const r = await T.api.models(payload);
            if (req !== C.modelsReq) return;
            C.modelsCache = {
                key,
                models: Array.isArray(r?.models) ? r.models : [],
                routingModels: Array.isArray(r?.routingModels) ? r.routingModels : [],
            };
            C.modelsLoading = false;
            C.modelsFailedKey = null;
            if (C.openTab === "model") C.build();
            else if (C.openTab === "agents") C.rebuildIfIdle();
        } catch (err) {
            if (req !== C.modelsReq) return;
            C.modelsLoading = false;
            C.modelsFailedKey = key;
            if (C.openTab === "model") {
                T.toast.show("error", T.api.errorText(err, t("modelsFailed")));
                C.build();
            }
        }
    }

    function modelsPanel(provider) {
        const panel = T.h("div", { class: "models-panel" });
        const search = T.h("input", {
            class: "input",
            type: "text",
            placeholder: t("searchModels"),
            "aria-label": t("searchModels"),
            value: modelFilter,
            spellcheck: "false",
        });
        search.addEventListener("input", () => {
            modelFilter = search.value.toLowerCase();
            renderList();
        });
        search.addEventListener("keydown", (e) => e.stopPropagation());
        panel.append(search);

        const list = T.h("div", {
            class: "models-list",
            role: "radiogroup",
            "aria-label": t("model"),
        });
        panel.append(list);

        function renderList() {
            list.replaceChildren();
            const models = (C.modelsCache.models || []).filter((m) => {
                const id = String(m.id || "").toLowerCase();
                const label = String(m.label || "").toLowerCase();
                return !modelFilter || id.includes(modelFilter) || label.includes(modelFilter);
            });
            if (!models.length) {
                list.append(T.h("div", { class: "empty-note", text: t("noModels") }));
                return;
            }
            for (const m of models) {
                const selected = provider.model === m.id;
                list.append(
                    T.h(
                        "button",
                        {
                            class: `radio-row${selected ? " selected" : ""}`,
                            role: "radio",
                            "aria-checked": String(selected),
                            disabled: provider.autoMode === true,
                            onclick() {
                                C.put({ provider: { model: m.id } }).then(() => {
                                    modelFilter = "";
                                    C.build();
                                });
                            },
                        },
                        [
                            T.h("span", { class: "radio-dot" }),
                            T.h("div", { class: "model-main" }, [
                                T.h("div", { class: "model-label", text: m.label || m.id }),
                                T.h("div", { class: "model-id", text: m.id }),
                            ]),
                            // 비전 지원 모델만 배지를 표시: 없으면 텍스트 전용
                            m.supportsVision === true
                                ? T.h("span", { class: "model-vision", "data-tip": t("visionSupported") }, [
                                      T.icon("eye"),
                                      T.h("span", { text: t("vision") }),
                                  ])
                                : T.h("span", { class: "model-vision off", "data-tip": t("visionUnsupported") }, [T.icon("eye-off")]),
                            Number.isFinite(Number(m.contextWindow)) && Number(m.contextWindow) > 0
                                ? T.h("span", { class: "model-ctx", text: Number(m.contextWindow).toLocaleString() })
                                : null,
                        ],
                    ),
                );
            }
        }
        renderList();
        return panel;
    }

    function manualModelInput(provider) {
        const input = T.h("input", {
            class: "input",
            type: "text",
            value: provider.model || "",
            placeholder: t("manualModelPlaceholder"),
            "aria-label": t("manualModel"),
            spellcheck: "false",
        });
        const commit = () => {
            const model = input.value.trim();
            if (model !== provider.model) C.put({ provider: { model } }).then(() => C.build());
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
        });
        return T.h("div", { class: "set-row" }, [
            T.h("div", { class: "set-label", text: t("manualModel") }),
            T.h("div", { class: "set-control" }, [input]),
        ]);
    }

    C.modelAdvOpen = false; // 모델 탭의 고급 설정 펼침

    /* ── 모델 페이지 ────────────────────────────────────────── */
    function buildModel(body) {
        const s = state.state.settings;
        if (!s) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }
        const sec = T.h("div", { class: "set-section" });
        const provider = s.provider || {};
        const key = modelsKey(provider);
        if (provider.id === "github-copilot") {
            sec.append(autoSessionSettings(provider), T.h("hr", { class: "divider" }));
        }
        const ready = C.modelsCache && C.modelsCache.key === key;
        if (!ready && !C.modelsLoading && C.modelsFailedKey !== key) void loadModels(provider);

        if (ready) {
            sec.append(modelsPanel(provider));
            if (!C.modelsCache.models.length) sec.append(manualModelInput(provider));
        } else if (C.modelsFailedKey === key) {
            sec.append(manualModelInput(provider));
            sec.append(
                T.h("button", {
                    class: "btn ghost",
                    text: t("retry"),
                    onclick() {
                        C.modelsFailedKey = null;
                        C.build();
                    },
                }),
            );
        } else {
            sec.append(T.h("div", { class: "empty-note", text: t("loadingModels") }));
        }

        if (Array.isArray(s.thinkingLevels) && s.thinkingLevels.length) {
            sec.append(T.h("hr", { class: "divider" }));
            sec.append(
                T.h("div", { class: "set-row" }, [
                    T.h("div", { class: "set-label", text: t("thinkingLevel") }),
                    C.settingSelect(
                        s.thinkingLevels.map((l) => ({ value: l.value, label: l.label || l.value })),
                        s.thinkingLevel,
                        (v) => C.put({ thinkingLevel: v }),
                        t("thinkingLevel"),
                    ),
                ]),
            );
        }

        sec.append(T.h("hr", { class: "divider" }));

        // 고급: 컨텍스트 한도와 모델 전환 시 오염 방지 옵션
        const mAdvPanel = T.h("div", { class: "adv-panel" });
        mAdvPanel.hidden = !C.modelAdvOpen;
        const mAdvBtn = T.h(
            "button",
            {
                type: "button",
                class: "adv-toggle",
                "aria-expanded": String(C.modelAdvOpen),
                onclick() {
                    C.modelAdvOpen = !C.modelAdvOpen;
                    mAdvBtn.setAttribute("aria-expanded", String(C.modelAdvOpen));
                    mAdvPanel.hidden = !C.modelAdvOpen;
                },
            },
            [T.icon("chevron", "icon-sm"), T.h("span", { text: t("advanced") })],
        );

        // 컨텍스트 채움 한도: 이 비율부터 오래된 대화를 요약으로 압축한다.
        // 옵션에는 현재 모델 윈도우 기준 실제 압축 시작 토큰 수를 함께 표시한다.
        const ctxPct = Number(s.contextTriggerPercent) || 75;
        const ctxWindow = Number(s.contextWindow) || 128000;
        const ctxLabel = (n) => `${n}% (~${Math.round((ctxWindow * Number(n)) / 100).toLocaleString()})`;
        mAdvPanel.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("ctxFillLimit") }),
                C.settingSelect(
                    C.presetOptions(
                        (Array.isArray(s.contextTriggerOptions) && s.contextTriggerOptions.length
                            ? s.contextTriggerOptions
                            : [50, 60, 70, 75, 80, 85, 90]
                        ).map((n) => ({ value: String(n), label: ctxLabel(n) })),
                        String(ctxPct),
                        ctxLabel(ctxPct),
                    ),
                    String(ctxPct),
                    (v) => C.put({ contextTriggerPercent: Number(v) }),
                    t("ctxFillLimit"),
                ),
            ]),
            T.h("div", { class: "set-desc", text: t("ctxFillLimitDesc") }),
        );

        // 모델이 바뀌면 모든 봇의 세션 압축 여부를 물어본다(실행은 사용자 확인 후).
        mAdvPanel.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("compressOnModelChange") }),
                C.switchEl(s.compressOnModelChange, (v) => C.put({ compressOnModelChange: v }), t("compressOnModelChange")),
            ]),
            T.h("div", { class: "set-desc", text: t("compressOnModelChangeDesc") }),
        );

        // 모든 봇의 세션 즉시 압축: 모델 전환 전 컨텍스트 오염 방지.
        // 기록 재작성 + LLM 호출이 드는 작업이므로 확인 대화상자를 거친다.
        // 진행 상태(sessionsCompressing)는 서버가 SSE로 알려 새로고침해도 유지된다.
        const compressing = Boolean(s.sessionsCompressing);
        const compressAllBtn = T.h("button", {
            class: "btn ghost",
            text: compressing ? t("compressing") : t("compressAllNow"),
            disabled: compressing,
            async onclick() {
                if (compressing) return;
                const ok = await T.confirm({
                    title: t("compressAllConfirmTitle"),
                    text: t("compressAllNowDesc"),
                    confirmLabel: t("compressAllConfirmButton"),
                });
                if (!ok) return;
                compressAllBtn.disabled = true;
                compressAllBtn.textContent = t("compressing");
                T.api
                    .compressAllSessions()
                    .then((r) => {
                        const n = Number(r?.compressed) || 0;
                        const f = Number(r?.failed) || 0;
                        if (f) T.toast.show("warn", t("compressAllPartial", { n, f }));
                        else if (!n) T.toast.show("info", t("compressAllNone"));
                        else T.toast.show("info", t("compressAllDone", { n }));
                    })
                    .catch((err) => {
                        T.toast.show("error", T.api.errorText(err, t("compressAllFailed")));
                    });
            },
        });
        mAdvPanel.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("compressAllNow") }),
                T.h("div", { class: "set-control" }, [compressAllBtn]),
            ]),
            T.h("div", { class: "set-desc", text: t("compressAllNowDesc") }),
        );

        sec.append(mAdvBtn, mAdvPanel);

        body.append(sec);
    }

    C.buildProvider = buildProvider;
    C.stopOauthPoll = stopOauthPoll;
    C.oauthSection = oauthSection;
    C.modelsKey = modelsKey;
    C.loadModels = loadModels;
    C.buildModel = buildModel;
})(window.Taby);
