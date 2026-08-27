/* tabyBot 웹 클라이언트 — 설정 시트.
   우측 슬라이드 시트(420px, Esc 닫기). 탭: 일반/모델/에이전트.
   변경은 즉시 PUT(낙관적 반영 + 실패 시 롤백 + 토스트).
   provider.apiKey는 쓰기 전용 — 응답에 절대 포함되지 않는다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k) => T.i18n.t(k);

    const sheet = document.getElementById("sheet");
    const scrim = document.getElementById("sheetScrim");

    let openTab = null;
    let editingAgent = null; // 에이전트 탭에서 펼친 항목 id ('__new__' = 추가)
    let armDelete = null; // 삭제 확인 2단계 버튼 상태
    let modelsCache = null; // 마지막 models/fetch 결과
    let modelsLoading = false;
    let modelsError = false;
    let modelFilter = "";
    let lastFocused = null;
    let oauthPending = null; // 진행 중 OAuth 디바이스 플로우 { kind, userCode, deviceUrl }

    /* ── 열기/닫기 ──────────────────────────────────────────── */
    function open(opt) {
        // open({tab, agentId}) 또는 open("model") 형태 모두 지원
        const o = typeof opt === "object" && opt ? opt : { tab: opt };
        if (document.activeElement instanceof HTMLElement) lastFocused = document.activeElement;
        openTab = o.tab || "general";
        editingAgent = o.agentId != null && o.agentId !== "" ? o.agentId : null;
        armDelete = null;
        build();
        sheet.classList.add("open");
        sheet.focus();
        sheet.querySelector("input, textarea, select, button:not([disabled])")?.focus({ preventScroll: true });
        sheet.setAttribute("aria-hidden", "false");
        scrim.classList.add("open");
    }

    function close() {
        sheet.classList.remove("open");
        sheet.setAttribute("aria-hidden", "true");
        scrim.classList.remove("open");
        openTab = null;
        modelsCache = null;
        modelsError = false;
        modelsLoading = false;
        if (lastFocused instanceof HTMLElement) lastFocused.focus();
        lastFocused = null;
        sheet.replaceChildren();
    }

    /* ── 낙관적 PUT ─────────────────────────────────────────── */
    // 봇 라스터는 /api/agents 기준 — CRUD 후 갱신한다.
    async function refreshBots() {
        try {
            const r = await T.api.agents();
            state.setBots(r.agents || []);
        } catch (_) {}
    }

    async function put(patch) {
        const prev = state.state.settings;
        state.mergeSettingsLocal(patch);
        try {
            const s = await T.api.putSettings(patch);
            if (s) state.setSettings(s);
            return true;
        } catch (_) {
            if (prev) state.setSettings(prev);
            T.toast.show("error", t("saveFailed"));
            return false;
        }
    }

    /* ── 프레임 ─────────────────────────────────────────────── */
    function build() {
        sheet.replaceChildren();

        const head = T.h("div", { class: "sheet-head" }, [
            T.h("div", { class: "sheet-title", text: t("settings") }),
            T.h("button", { class: "btn-icon", "aria-label": t("cancel"), onclick: close }, [T.icon("x")]),
        ]);

        const tabs = T.h("div", { class: "tabs", role: "tablist", "aria-label": t("settings") }, [
            tabBtn("general", t("general")),
            tabBtn("model", t("model")),
            tabBtn("agents", t("agents")),
        ]);

        const body = T.h("div", { class: "sheet-body" });
        if (openTab === "general") buildGeneral(body);
        else if (openTab === "model") buildModel(body);
        else buildAgents(body);

        sheet.append(head, tabs, body);
    }

    function tabBtn(id, label) {
        return T.h("button", {
            class: "tab" + (openTab === id ? " active" : ""),
            role: "tab",
            "aria-selected": String(openTab === id),
            tabindex: openTab === id ? "0" : "-1",
            text: label,
            onclick() {
                openTab = id;
                editingAgent = null;
                armDelete = null;
                build();
            },
        });
    }

    // 입력 중 재렌더 방지: 시트 내부에 포커스가 있으면 스킵
    function rebuildIfIdle() {
        if (!openTab) return;
        const ae = document.activeElement;
        if (ae && sheet.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
        build();
    }

    /* ── 공통 컴포넌트 ──────────────────────────────────────── */
    function switchEl(checked, onChange) {
        const input = T.h("input", { type: "checkbox" });
        input.checked = !!checked;
        input.addEventListener("change", () => onChange(input.checked));
        return T.h("label", { class: "switch" }, [input, T.h("span", { class: "tr" }), T.h("span", { class: "kn" })]);
    }

    function segmented(options, current, onPick) {
        const box = T.h("div", { class: "segmented" });
        for (const o of options) {
            box.append(
                T.h("button", {
                    class: "seg-btn" + (o.value === current ? " active" : ""),
                    text: o.label,
                    onclick() {
                        if (o.value !== current) onPick(o.value);
                    },
                }),
            );
        }
        return box;
    }

    function fieldLabel(text) {
        return T.h("div", { class: "field-label", text });
    }

    /* ── 일반 탭 ────────────────────────────────────────────── */
    function buildGeneral(body) {
        const s = state.state.settings || {};
        const sec = T.h("div", { class: "set-section" });

        // 언어
        const langSel = T.h("select", {});
        [
            ["en", "English"],
            ["ko", "한국어"],
            ["ja", "日本語"],
        ].forEach(([v, label]) => {
            const o = T.h("option", { value: v, text: label });
            if (T.i18n.getLang() === v) o.selected = true;
            langSel.append(o);
        });
        langSel.addEventListener("change", () => {
            T.i18n.setLang(langSel.value); // 즉시 전환 + 저장
            put({ language: langSel.value });
        });
        if (state.state.settings?.language && T.i18n.getLang() !== state.state.settings.language) {
            T.i18n.setLang(state.state.settings.language, { persist: false });
            langSel.value = state.state.settings.language;
        } else {
            langSel.value = T.i18n.getLang();
        }
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", {}, [T.h("div", { class: "set-label", text: t("language") })]),
                T.h("div", { class: "select-wrap" }, [langSel, T.icon("chevron")]),
            ]),
        );

        // 테마 (클라이언트 전용)
        const curTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("theme") }),
                segmented(
                    [
                        { value: "dark", label: t("dark") },
                        { value: "light", label: t("light") },
                    ],
                    curTheme,
                    (v) => {
                        if (T.app) T.app.applyTheme(v);
                        build();
                    },
                ),
            ]),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 응답 통계 푸터
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", {}, [
                    T.h("div", { class: "set-label", text: t("statsFooter") }),
                    T.h("div", { class: "set-desc", text: t("statsFooterExample") }),
                ]),
                switchEl(s.showReplyFooter, (v) => put({ showReplyFooter: v })),
            ]),
        );

        // 업데이트 확인
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("updateCheck") }),
                switchEl(s.updateCheckEnabled, (v) => put({ updateCheckEnabled: v })),
            ]),
        );

        // 알림 (클라이언트 전용: OS 알림 + 웹 푸시)
        if (T.notifications && typeof Notification !== "undefined") {
            sec.append(
                T.h("div", { class: "set-row" }, [
                    T.h("div", {}, [
                        T.h("div", { class: "set-label", text: t("notifications") }),
                        T.h("div", { class: "set-desc", text: t("notificationsDesc") }),
                    ]),
                    switchEl(T.notifications.enabled(), (v) => {
                        T.notifications.setOn(v).then((ok) => {
                            if (v && !ok) T.toast.show("error", t("notificationsDenied"));
                            build();
                        });
                    }),
                ]),
            );
        }

        if (T.notifications && T.notifications.canInstall()) {
            sec.append(
                T.h("div", { class: "set-row" }, [
                    T.h("div", { class: "set-label", text: t("installApp") }),
                    T.h("button", {
                        class: "btn ghost",
                        text: t("install"),
                        onclick() {
                            T.notifications.promptInstall().then(() => build());
                        },
                    }),
                ]),
            );
        }

        sec.append(T.h("hr", { class: "divider" }));

        // NSFW 컨텐츠 제한
        const nsfwLabels = {
            strict: t("nsfwStrict"),
            moderate: t("nsfwModerate"),
            explicit: t("nsfwExplicit"),
        };
        sec.append(fieldLabel(t("nsfwLevel")));
        sec.append(
            segmented(
                (s.nsfwLevels || ["strict", "moderate", "explicit"]).map((v) => ({ value: v, label: nsfwLabels[v] || v })),
                s.nsfwLevel,
                (v) => put({ nsfwLevel: v }),
            ),
        );

        // 영구적 행위 승인 정책
        const approvalLabels = { user: t("approvalUser"), model: t("approvalModel"), always: t("approvalAlways") };
        sec.append(T.h("div", { class: "set-label", text: t("approvalLevel") }));
        sec.append(
            segmented(
                (s.approvalLevels || ["user", "model", "always"]).map((v) => ({ value: v, label: approvalLabels[v] || v })),
                s.approvalLevel,
                (v) => put({ approvalLevel: v }),
            ),
        );
        sec.append(T.h("div", { class: "set-desc", text: t("approvalDesc") }));

        body.append(sec);
    }

    /* ── 모델 탭 ────────────────────────────────────────────── */
    function buildModel(body) {
        const s = state.state.settings;
        if (!s) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }
        const sec = T.h("div", { class: "set-section" });
        const provider = s.provider || {};
        const providers = s.providers || [];

        // 프로바이더 카드 목록
        sec.append(fieldLabel(t("provider")));
        const plist = T.h("div", { class: "provider-list" });
        for (const p of providers) {
            const selected = provider.id === p.id;
            const card = T.h(
                "button",
                {
                    class: "provider-card" + (selected ? " selected" : ""),
                    onclick() {
                        if (selected) return;
                        modelsCache = null;
                        put({ provider: { id: p.id } }).then(() => build());
                    },
                },
                [
                    T.h("div", {}, [
                        T.h("div", { class: "provider-name", text: p.label || p.id }),
                        T.h("div", { class: "provider-type", text: p.type || "" }),
                    ]),
                    p.apiKeyOptional ? T.h("span", { class: "provider-badge", text: t("apiKeyOptional") }) : null,
                    selected ? T.icon("check") : null,
                ],
            );
            plist.append(card);
        }
        sec.append(plist);

        // 선택된 프로바이더 상세
        const meta = providers.find((p) => p.id === provider.id);
        if (meta) {
            sec.append(T.h("hr", { class: "divider" }));

            if (meta.needsBaseURL) {
                sec.append(fieldLabel(t("baseURL")));
                sec.append(baseURLInput(provider));
            }

            // OAuth 프로바이더(Codex/Grok)는 API 키 대신 디바이스 플로우 로그인을 쓴다.
            if (isOauthProvider(meta)) {
                sec.append(oauthSection(provider.id));
            } else {
                sec.append(fieldLabel(t("apiKey")));
                sec.append(apiKeyRow(provider, meta));
            }

            // 현재 모델 + 불러오기
            sec.append(fieldLabel(t("model")));
            sec.append(
                T.h("div", { class: "set-row" }, [
                    T.h("div", { class: "current-model", text: provider.model || "—" }),
                    T.h(
                        "button",
                        {
                            class: "btn ghost",
                            text: modelsLoading ? t("loadingModels") : t("loadModels"),
                            disabled: modelsLoading,
                            onclick() {
                                loadModels(provider, meta);
                            },
                        },
                        [],
                    ),
                ]),
            );

            if (modelsLoading) {
                sec.append(T.h("div", { class: "empty-note", text: t("loadingModels") }));
            } else if (modelsError) {
                sec.append(
                    T.h("button", {
                        class: "btn ghost",
                        text: t("retry"),
                        onclick() {
                            loadModels(provider, meta);
                        },
                    }),
                );
            } else if (modelsCache) {
                sec.append(modelsPanel(provider));
            }

            // 추론 깊이
            if (Array.isArray(s.thinkingLevels) && s.thinkingLevels.length) {
                sec.append(T.h("hr", { class: "divider" }));
                sec.append(fieldLabel(t("thinkingLevel")));
                sec.append(
                    segmented(
                        s.thinkingLevels.map((l) => ({ value: l.value, label: l.label || l.value })),
                        s.thinkingLevel,
                        (v) => put({ thinkingLevel: v }),
                    ),
                );
            }
        }

        body.append(sec);
    }

    function isOauthProvider(meta) {
        return Boolean(meta && /-oauth$/.test(String(meta.type || "")));
    }

    // OAuth 디바이스 플로우 섹션: 상태 표시 + 로그인 버튼 + 대기 중 안내(코드/링크).
    // rerender: 로그인 시작 후 화면을 다시 그릴 콜백(설정 시트는 build, 온보딩은 render).
    function oauthSection(kind, rerender) {
        const refresh = rerender || build;
        const box = T.h("div", {});

        if (oauthPending && oauthPending.kind === kind) {
            const codeBtn = T.h("button", {
                class: "btn ghost",
                text: oauthPending.userCode,
                onclick() {
                    T.copyText(oauthPending.userCode).then((ok) => {
                        if (ok) T.toast.show("info", t("copied"));
                    });
                },
            });
            box.append(
                T.h("div", { class: "set-section" }, [
                    T.h("div", { class: "set-desc", text: t("oauthEnterCode") }),
                    T.h("a", {
                        href: oauthPending.deviceUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        text: oauthPending.deviceUrl,
                    }),
                    codeBtn,
                    T.h("div", { class: "empty-note", text: t("oauthPending") }),
                    T.h("button", {
                        class: "btn ghost",
                        text: t("cancel"),
                        onclick() {
                            T.api.cancelOauth(kind).catch(() => {});
                            oauthPending = null;
                            refresh();
                        },
                    }),
                ]),
            );
            return box;
        }

        box.append(fieldLabel(t("oauthAccount")));
        const row = T.h("div", { class: "set-row" }, [T.h("div", { class: "set-desc", text: t("oauthChecking") })]);
        box.append(row);

        T.api
            .authStatus()
            .then((st) => {
                const loggedIn = Boolean(st && st[kind]);
                row.replaceChildren(
                    T.h("div", { class: "key-state" }, [
                        loggedIn ? T.icon("check", "icon-sm") : null,
                        T.h("span", { text: loggedIn ? t("oauthLoggedIn") : t("oauthNotLoggedIn") }),
                    ]),
                    T.h(
                        "button",
                        {
                            class: "btn ghost",
                            text: loggedIn ? t("oauthRelogin") : t("oauthLogin"),
                            onclick() {
                                T.api
                                    .startOauth(kind)
                                    .then((flow) => {
                                        if (!flow || !flow.userCode || !flow.deviceUrl) throw new Error(t("oauthFailed"));
                                        oauthPending = { kind, userCode: flow.userCode, deviceUrl: flow.deviceUrl };
                                        refresh();
                                    })
                                    .catch((err) => {
                                        const detail = (err && err.payload && err.payload.error) || (err && err.message) || t("oauthFailed");
                                        T.toast.show("error", t("errorPrefix") + ": " + detail);
                                    });
                            },
                        },
                        [],
                    ),
                );
            })
            .catch(() => {
                row.replaceChildren(T.h("div", { class: "set-desc", text: t("offlineNote") }));
            });
        return box;
    }

    function baseURLInput(provider) {
        const input = T.h("input", {
            class: "input",
            type: "text",
            value: provider.baseURL || "",
            placeholder: "https://api.example.com/v1",
            spellcheck: "false",
        });
        const commit = () => {
            const v = input.value.trim();
            if (v !== (provider.baseURL || "")) put({ provider: { baseURL: v } });
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
        });
        return input;
    }

    function apiKeyRow(provider, meta) {
        const input = T.h("input", {
            class: "input",
            type: "password",
            value: "",
            placeholder: provider.apiKeySet ? "••••••••" : meta.apiKeyOptional ? "" : "sk-…",
            autocomplete: "new-password",
        });
        const stateEl = T.h("span", {});
        if (provider.apiKeySet) {
            stateEl.className = "key-state";
            stateEl.append(T.icon("check", "icon-sm"), t("apiKeySaved"));
        }

        const eye = T.h(
            "button",
            {
                class: "btn-icon",
                "aria-label": t("showApiKey"),
                "aria-pressed": "false",
                onclick() {
                    const show = input.type === "password";
                    input.type = show ? "text" : "password";
                    eye.setAttribute("aria-label", t(show ? "hideApiKey" : "showApiKey"));
                    eye.setAttribute("aria-pressed", String(show));
                    eye.replaceChildren(T.icon(show ? "eye-off" : "eye"));
                },
            },
            [T.icon("eye")],
        );

        const commit = () => {
            const v = input.value.trim();
            if (!v) return;
            put({ provider: { apiKey: v } }).then((ok) => {
                if (ok) {
                    input.value = "";
                    stateEl.className = "key-state";
                    stateEl.replaceChildren(T.icon("check", "icon-sm"), t("apiKeySaved"));
                }
            });
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
        });

        return T.h("div", {}, [
            T.h("div", { class: "key-row" }, [input, eye]),
            T.h("div", { class: "set-desc" }, [stateEl, " ", t("setupApiKeyHint")]),
        ]);
    }

    async function loadModels(provider, meta) {
        modelsLoading = true;
        modelsError = false;
        build();
        const payload = { providerId: provider.id };
        if (provider.baseURL) payload.baseURL = provider.baseURL;
        try {
            const r = await T.api.models(payload);
            modelsCache = (r && r.models) || [];
            modelsLoading = false;
            build();
        } catch (_) {
            modelsLoading = false;
            modelsError = true;
            T.toast.show("error", t("modelsFailed"));
            build();
        }
    }

    function modelsPanel(provider) {
        const panel = T.h("div", { class: "models-panel" });
        const search = T.h("input", {
            type: "text",
            placeholder: t("searchModels"),
            value: modelFilter,
            spellcheck: "false",
        });
        search.addEventListener("input", () => {
            modelFilter = search.value.toLowerCase();
            renderList();
        });
        search.addEventListener("keydown", (e) => e.stopPropagation());
        panel.append(T.h("div", { class: "models-search" }, [T.icon("search", "icon-sm"), search]));

        const list = T.h("div", { class: "models-list" });
        panel.append(list);

        function renderList() {
            list.replaceChildren();
            const models = modelsCache.filter(
                (m) => !modelFilter || (m.id || "").toLowerCase().includes(modelFilter) || (m.label || "").toLowerCase().includes(modelFilter),
            );
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
                            class: "radio-row" + (selected ? " selected" : ""),
                            onclick() {
                                put({ provider: { model: m.id } }).then(() => {
                                    modelFilter = "";
                                    build();
                                });
                            },
                        },
                        [
                            T.h("span", { class: "radio-dot" }),
                            T.h("div", { class: "model-main" }, [
                                T.h("div", { class: "model-label", text: m.label || m.id }),
                                T.h("div", { class: "model-id", text: m.id }),
                            ]),
                            m.contextWindow ? T.h("span", { class: "model-ctx", text: Number(m.contextWindow).toLocaleString() }) : null,
                        ],
                    ),
                );
            }
        }
        renderList();
        return panel;
    }
    function buildAgents(body) {
        const s = state.state.settings;
        const agents = state.state.bots?.length ? state.state.bots : (s && s.agents) || [];
        const sec = T.h("div", { class: "set-section" });

        if (!agents.length) sec.append(T.h("div", { class: "empty-note", text: "—" }));

        for (const a of agents) {
            const expanded = editingAgent === a.id;
            const item = T.h("div", { class: "agent-item" + (expanded ? " selected" : "") });
            item.append(
                T.h(
                    "button",
                    {
                        class: "agent-head",
                        onclick() {
                            editingAgent = expanded ? null : a.id;
                            armDelete = null;
                            build();
                        },
                    },
                    [
                        T.h("span", {
                            class: "avatar",
                            style: "background:" + (a.color || "#0a84ff"),
                            text: (a.name || "?").trim().charAt(0).toUpperCase(),
                        }),
                        T.h("div", { style: "flex:1;min-width:0" }, [
                            T.h("div", { class: "set-label", text: a.name || "?" }),
                            T.h("div", { class: "agent-persona", text: a.persona || "" }),
                        ]),
                        T.icon("chevron"),
                    ],
                ),
            );
            if (expanded) item.append(agentEditor(a));
            sec.append(item);
        }

        if (editingAgent === "__new__") {
            const item = T.h("div", { class: "agent-item selected" });
            item.append(agentEditor(null));
            sec.append(item);
        }

        sec.append(
            T.h(
                "button",
                {
                    class: "btn ghost",
                    onclick() {
                        editingAgent = editingAgent === "__new__" ? null : "__new__";
                        armDelete = null;
                        build();
                    },
                },
                [T.icon("plus", "icon-sm"), t("addAgent")],
            ),
        );

        body.append(sec);
    }

    function agentEditor(agent) {
        const isNew = !agent;
        const editor = T.h("div", { class: "agent-editor" });

        editor.append(fieldLabel(t("agentName")));
        const name = T.h("input", { class: "input", type: "text", value: agent ? agent.name || "" : "" });
        name.addEventListener("keydown", (e) => e.stopPropagation());
        editor.append(name);

        editor.append(fieldLabel(t("persona")));
        const persona = T.h("textarea", { class: "textarea", placeholder: t("personaPlaceholder") });
        persona.value = agent ? agent.persona || "" : "";
        persona.addEventListener("keydown", (e) => e.stopPropagation());
        editor.append(persona);

        const actions = T.h("div", { class: "editor-actions" });
        const saveBtn = T.h("button", {
            class: "btn primary",
            text: t("save"),
            async onclick() {
                const n = name.value.trim();
                if (!n) {
                    name.focus();
                    return;
                }
                saveBtn.disabled = true;
                try {
                    let r;
                    if (isNew) r = await T.api.createAgent({ name: n, persona: persona.value });
                    else r = await T.api.updateAgent(agent.id, { name: n, persona: persona.value });
                    if (r && Array.isArray(r.agents)) {
                        state.mergeSettingsLocal({ agents: r.agents });
                        state.setBots(r.agents);
                    } else {
                        const s = await T.api.getSettings();
                        if (s) state.setSettings(s);
                        await refreshBots();
                    }
                    editingAgent = null;
                    armDelete = null;
                    build();
                } catch (err) {
                    saveBtn.disabled = false;
                    const reason = err?.payload?.error || "";
                    const detail =
                        reason === "name_required"
                            ? t("nameRequired")
                            : reason === "name_too_long"
                              ? t("nameTooLong")
                              : reason === "persona_required"
                                ? t("personaRequired")
                                : reason === "persona_too_long"
                                  ? t("personaTooLong")
                                  : reason === "too_many"
                                    ? t("lastBotTooltip")
                                    : "";
                    T.toast.show("error", detail ? `${t("saveFailed")}: ${detail}` : t("saveFailed"));
                }
            },
        });
        actions.append(saveBtn);

        // 마지막으로 남은 봇은 삭제할 수 없다.
        const botsCount = state.state.bots?.length || (state.state.settings?.agents?.length ?? 0);
        if (!isNew && botsCount > 1) {
            const delBtn = T.h("button", {
                type: "button",
                class: "btn ghost" + (armDelete === agent.id ? " danger" : ""),
                text: armDelete === agent.id ? t("deleteConfirm") : t("delete"),
                onclick() {
                    if (armDelete !== agent.id) {
                        armDelete = agent.id;
                        delBtn.classList.add("danger");
                        delBtn.textContent = t("deleteConfirm");
                        return;
                    }
                    delBtn.disabled = true;
                    const threadId = agent.threadId || `web-agent-${agent.id}`;
                    T.api
                        .deleteAgent(agent.id)
                        .then((r) => {
                            const agents = r && Array.isArray(r.agents) ? r.agents : [];
                            state.mergeSettingsLocal({ agents });
                            state.setBots(agents);
                            if (state.state.currentId === threadId) {
                                const next = agents[0];
                                if (next && T.chat) T.chat.open(next.threadId);
                                else if (T.chat) T.chat.open(null);
                            }
                            editingAgent = null;
                            armDelete = null;
                            build();
                        })
                        .catch((err) => {
                            delBtn.disabled = false;
                            T.toast.show("error", err?.status === 400 ? t("lastBotTooltip") : t("saveFailed"));
                        });
                },
            });
            actions.append(delBtn);
        } else if (!isNew) {
            actions.append(T.h("span", { class: "set-desc", text: t("lastBotTooltip") }));
        }

        actions.append(T.h("span", { class: "spacer" }));
        actions.append(
            T.h("button", {
                class: "btn ghost",
                text: t("cancel"),
                onclick() {
                    editingAgent = null;
                    armDelete = null;
                    build();
                },
            }),
        );
        editor.append(actions);
        return editor;
    }

    /* ── 전역 바인딩 ────────────────────────────────────────── */
    function init() {
        scrim.addEventListener("click", close);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && openTab) {
                close();
                e.stopPropagation();
            }
        });
        state.on("settings", rebuildIfIdle);
        state.on("bots", rebuildIfIdle);
        state.on("pwa", rebuildIfIdle);
        // OAuth 결과는 시트가 닫혀 있어도 반영한다(설정 갱신 + 토스트).
        state.on("oauth_done", (p) => {
            oauthPending = null;
            void T.api
                .getSettings()
                .then((s) => {
                    if (s) state.setSettings(s);
                })
                .catch(() => {});
            T.toast.show(p.ok ? "info" : "error", p.ok ? t("oauthSuccess") : t("errorPrefix") + ": " + (p.detail || t("oauthFailed")));
            if (openTab === "model") build();
        });
        T.i18n.onChange(() => {
            if (openTab) build();
        });
    }

    T.settingsUI = { init, open, close, isOpen: () => !!openTab, oauthSection };
})((window.Taby = window.Taby || {}));
