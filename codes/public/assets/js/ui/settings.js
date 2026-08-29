/* tabyBot 웹 클라이언트 — 설정 팝업.
   동적 URL(?settings=1&tab=&bot=)로 현재 화면을 공유/복원한다.
   변경은 즉시 PUT(낙관적 반영 + 실패 시 롤백 + 토스트).
   provider.apiKey는 쓰기 전용 — 응답에 절대 포함되지 않는다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k) => T.i18n.t(k);

    const sheet = document.getElementById("sheet");
    const scrim = document.getElementById("sheetScrim");

    let openTab = null;
    let editingAgent = null; // 에이전트 페이지 id ('__new__' = 추가)
    let armDelete = null; // 삭제 확인 2단계 버튼 상태
    let modelsCache = null; // { key, models }
    let modelsLoading = false;
    let modelsFailedKey = null;
    let modelsReq = 0;
    let modelFilter = "";
    let providerChoice = null;
    let lastFocused = null;
    let oauthPending = null; // 진행 중 OAuth 디바이스 플로우 { kind, userCode, deviceUrl }
    let putChain = Promise.resolve();

    /* ── URL / 열기 / 닫기 ──────────────────────────────────── */
    function syncUrl({ open: isOpen, tab, agentId, replace = false }) {
        try {
            const url = new URL(location.href);
            if (isOpen) {
                url.searchParams.set("settings", "1");
                url.searchParams.set("tab", tab || "general");
                if (agentId && agentId !== "__new__") url.searchParams.set("bot", agentId);
                else url.searchParams.delete("bot");
            } else {
                url.searchParams.delete("settings");
                url.searchParams.delete("tab");
                url.searchParams.delete("bot");
            }
            const next = url.pathname + (url.search ? url.search : "") + (url.hash ? url.hash : "");
            history[replace ? "replaceState" : "pushState"](null, "", next);
        } catch (_) {}
    }

    function open(opt) {
        // open({tab, agentId}) 또는 open("model") 형태 모두 지원
        const o = typeof opt === "object" && opt ? opt : { tab: opt };
        if (document.activeElement instanceof HTMLElement) lastFocused = document.activeElement;
        providerChoice = null;
        if (o.agentId != null && o.agentId !== "" && (!o.tab || o.tab === "agents")) {
            openTab = "agents";
            editingAgent = o.agentId;
        } else if (["general", "provider", "model", "agents"].includes(o.tab)) {
            openTab = o.tab;
            editingAgent = o.tab === "agents" ? firstAgentId() || "__new__" : null;
        } else {
            openTab = "general";
            editingAgent = null;
        }
        armDelete = null;
        syncUrl({ open: true, tab: openTab, agentId: editingAgent, replace: !!o.fromUrl });
        build();
        sheet.classList.add("open");
        sheet.setAttribute("aria-hidden", "false");
        scrim.classList.add("open");
        sheet.focus();
        sheet.querySelector("input, textarea, select, button:not([disabled])")?.focus({ preventScroll: true });
    }

    function close(options) {
        if (!options || options.updateUrl !== false) syncUrl({ open: false, replace: true });
        sheet.classList.remove("open");
        sheet.setAttribute("aria-hidden", "true");
        scrim.classList.remove("open");
        openTab = null;
        modelsCache = null;
        modelsLoading = false;
        modelsFailedKey = null;
        modelsReq++;
        providerChoice = null;
        if (lastFocused instanceof HTMLElement && document.contains(lastFocused)) lastFocused.focus();
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

    function put(patch) {
        const run = async () => {
            const prev = state.state.settings;
            const localPatch = patch && patch.provider && patch.provider.apiKey !== undefined ? { ...patch, provider: { ...patch.provider } } : patch;
            if (localPatch?.provider && localPatch.provider.apiKey !== undefined) {
                delete localPatch.provider.apiKey;
                localPatch.provider.apiKeySet = true;
            }
            state.mergeSettingsLocal(localPatch);
            try {
                const s = await T.api.putSettings(patch);
                if (s) state.setSettings(s);
                return true;
            } catch (_) {
                if (prev) state.setSettings(prev);
                T.toast.show("error", t("saveFailed"));
                return false;
            }
        };
        const result = putChain.then(run, run);
        putChain = result.catch(() => {});
        return result;
    }

    /* ── 프레임 ─────────────────────────────────────────────── */
    function build() {
        sheet.replaceChildren();

        const head = T.h("div", { class: "sheet-head" }, [
            T.h("div", { id: "settingsTitle", class: "sheet-title", text: t("settings") }),
            T.h("button", { class: "btn-icon", "aria-label": t("cancel"), onclick: close }, [T.icon("x")]),
        ]);

        const agents = agentList();
        const nav = T.h("nav", { class: "sheet-nav", role: "tablist", "aria-label": t("settings") }, [
            tabBtn("general", t("general")),
            tabBtn("provider", t("provider")),
            tabBtn("model", t("model")),
            T.h("hr", { class: "divider" }),
            ...agents.map(agentNavBtn),
            T.h("button", {
                class: "sb-row" + (openTab === "agents" && editingAgent === "__new__" ? " active" : ""),
                role: "tab",
                "aria-selected": String(openTab === "agents" && editingAgent === "__new__"),
                tabindex: openTab === "agents" && editingAgent === "__new__" ? "0" : "-1",
                text: t("addAgent"),
                onclick() {
                    openTab = "agents";
                    editingAgent = "__new__";
                    armDelete = null;
                    syncUrl({ open: true, tab: "agents", agentId: null, replace: true });
                    build();
                },
            }),
        ]);

        const body = T.h("div", { class: "sheet-body" });
        if (openTab === "general") buildGeneral(body);
        else if (openTab === "provider") buildProvider(body);
        else if (openTab === "model") buildModel(body);
        else buildAgents(body);

        sheet.append(head, T.h("div", { class: "sheet-main" }, [nav, body]));
    }

    function tabBtn(id, label) {
        return T.h("button", {
            class: "sb-row" + (openTab === id ? " active" : ""),
            role: "tab",
            "aria-selected": String(openTab === id),
            tabindex: openTab === id ? "0" : "-1",
            text: label,
            onclick() {
                openTab = id;
                editingAgent = null;
                armDelete = null;
                syncUrl({ open: true, tab: openTab, agentId: null, replace: true });
                build();
            },
        });
    }

    function agentList() {
        const s = state.state.settings;
        return state.state.bots?.length ? state.state.bots : (s && s.agents) || [];
    }

    function firstAgentId() {
        return agentList()[0]?.id || null;
    }

    function agentNavBtn(agent) {
        const active = openTab === "agents" && editingAgent === agent.id;
        return T.h("button", {
            class: "sb-row" + (active ? " active" : ""),
            role: "tab",
            "aria-selected": String(active),
            tabindex: active ? "0" : "-1",
            text: agent.name || "?",
            onclick() {
                openTab = "agents";
                editingAgent = agent.id;
                armDelete = null;
                syncUrl({ open: true, tab: "agents", agentId: agent.id, replace: true });
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
    function switchEl(checked, onChange, label) {
        const input = T.h("input", { type: "checkbox", "aria-label": label || "" });
        input.checked = !!checked;
        input.addEventListener("change", () => onChange(input.checked));
        return T.h("label", { class: "switch" }, [input, T.h("span", { class: "tr" }), T.h("span", { class: "kn" })]);
    }

    function settingSelect(options, current, onPick, label) {
        const select = T.h("select", { "aria-label": label || "" });
        for (const o of options) {
            const option = T.h("option", { value: o.value, text: o.label });
            option.selected = o.value === current;
            select.append(option);
        }
        select.addEventListener("change", () => onPick(select.value));
        return T.h("div", { class: "select-wrap" }, [select, T.icon("chevron")]);
    }

    function fieldLabel(text) {
        return T.h("div", { class: "field-label", text });
    }

    /* ── 일반 탭 ────────────────────────────────────────────── */
    function buildGeneral(body) {
        const s = state.state.settings || {};
        const sec = T.h("div", { class: "set-section" });

        // 언어
        const langSel = T.h("select", { "aria-label": t("language") });
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
                settingSelect(
                    [
                        { value: "dark", label: t("dark") },
                        { value: "light", label: t("light") },
                    ],
                    curTheme,
                    (v) => {
                        if (T.app) T.app.applyTheme(v);
                    },
                    t("theme"),
                ),
            ]),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 응답 통계 푸터
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("statsFooter") }),
                switchEl(s.showReplyFooter, (v) => put({ showReplyFooter: v }), t("statsFooter")),
            ]),
        );

        // 업데이트 확인
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("updateCheck") }),
                switchEl(s.updateCheckEnabled, (v) => put({ updateCheckEnabled: v }), t("updateCheck")),
            ]),
        );

        // 알림 (클라이언트 전용: OS 알림 + 웹 푸시)
        if (T.notifications && typeof Notification !== "undefined") {
            sec.append(
                T.h("div", { class: "set-row" }, [
                    T.h("div", { class: "set-label", text: t("notifications") }),
                    switchEl(
                        T.notifications.enabled(),
                        (v) => {
                            T.notifications.setOn(v).then((ok) => {
                                if (v && !ok) T.toast.show("error", t("notificationsDenied"));
                                build();
                            });
                        },
                        t("notifications"),
                    ),
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

        const nsfwLabels = {
            strict: t("nsfwStrict"),
            moderate: t("nsfwModerate"),
            explicit: t("nsfwExplicit"),
        };
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("nsfwLevel") }),
                settingSelect(
                    (s.nsfwLevels || ["strict", "moderate", "explicit"]).map((v) => ({ value: v, label: nsfwLabels[v] || v })),
                    s.nsfwLevel,
                    (v) => put({ nsfwLevel: v }),
                    t("nsfwLevel"),
                ),
            ]),
        );

        const approvalLabels = { user: t("approvalUser"), model: t("approvalModel"), always: t("approvalAlways") };
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("approvalLevel") }),
                settingSelect(
                    (s.approvalLevels || ["user", "model", "always"]).map((v) => ({ value: v, label: approvalLabels[v] || v })),
                    s.approvalLevel,
                    (v) => put({ approvalLevel: v }),
                    t("approvalLevel"),
                ),
            ]),
        );

        body.append(sec);
    }

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
            providerChoice === "custom" || (provider.id === "default" && defaultPreset && provider.baseURL !== defaultPreset.baseURL);
        const selectedProviderId = customActive ? "custom" : provider.id;
        if (!providers.length) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }

        const meta = providers.find((p) => p.id === (customActive ? "default" : provider.id) && !p.custom);
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
                        class: "provider-card" + (selected ? " selected" : ""),
                        role: "radio",
                        "aria-checked": String(selected),
                        onclick() {
                            if (selected) return;
                            providerChoice = p.id;
                            modelsReq++;
                            modelsLoading = false;
                            modelsCache = null;
                            modelsFailedKey = null;
                            const patch = p.id === "custom" || p.id === "default" ? { id: p.id, baseURL: "", model: "" } : { id: p.id, model: "" };
                            put({ provider: patch }).then(() => build());
                        },
                    },
                    [T.h("div", { class: "provider-name", text: p.label || p.id }), selected ? T.icon("check") : null],
                ),
            );
        }
        sec.append(plist);

        body.append(sec);
    }

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
        const ready = modelsCache && modelsCache.key === key;
        if (!ready && !modelsLoading && modelsFailedKey !== key) void loadModels(provider);

        if (ready) {
            sec.append(modelsPanel(provider));
            if (!modelsCache.models.length) sec.append(manualModelInput(provider));
        } else if (modelsFailedKey === key) {
            sec.append(manualModelInput(provider));
            sec.append(
                T.h("button", {
                    class: "btn ghost",
                    text: t("retry"),
                    onclick() {
                        modelsFailedKey = null;
                        build();
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
                    settingSelect(
                        s.thinkingLevels.map((l) => ({ value: l.value, label: l.label || l.value })),
                        s.thinkingLevel,
                        (v) => put({ thinkingLevel: v }),
                        t("thinkingLevel"),
                    ),
                ]),
            );
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

        const account = T.h("div", { class: "set-control" }, [T.h("div", { class: "set-desc", text: t("oauthChecking") })]);
        const row = T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: t("oauthAccount") }), account]);
        box.append(row);

        T.api
            .authStatus()
            .then((st) => {
                const loggedIn = Boolean(st && st[kind]);
                account.replaceChildren(
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
                modelsReq++;
                modelsLoading = false;
                modelsCache = null;
                modelsFailedKey = null;
                put({ provider: { baseURL: v } });
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
        const input = T.h("input", {
            class: "input",
            type: "password",
            value: "",
            placeholder: provider.apiKeySet ? "••••••••" : meta.apiKeyOptional ? "" : "sk-…",
            "aria-label": t("apiKey"),
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
                    modelsReq++;
                    modelsLoading = false;
                    modelsCache = null;
                    modelsFailedKey = null;
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

        return T.h("div", { class: "key-row" }, [input, eye, stateEl]);
    }

    function modelsKey(provider) {
        return String(provider.id || "") + "\n" + String(provider.baseURL || "");
    }

    async function loadModels(provider) {
        const req = ++modelsReq;
        const key = modelsKey(provider);
        modelsLoading = true;
        const payload = { providerId: provider.id };
        if (provider.baseURL) payload.baseURL = provider.baseURL;
        try {
            const r = await T.api.models(payload);
            if (req !== modelsReq) return;
            modelsCache = { key, models: Array.isArray(r?.models) ? r.models : [] };
            modelsLoading = false;
            modelsFailedKey = null;
            if (openTab === "model") build();
        } catch (_) {
            if (req !== modelsReq) return;
            modelsLoading = false;
            modelsFailedKey = key;
            if (openTab === "model") {
                T.toast.show("error", t("modelsFailed"));
                build();
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
            const models = (modelsCache.models || []).filter((m) => {
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
                            class: "radio-row" + (selected ? " selected" : ""),
                            role: "radio",
                            "aria-checked": String(selected),
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
            if (model !== provider.model) put({ provider: { model } }).then(() => build());
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

    function buildAgents(body) {
        if (editingAgent === "__new__") {
            body.append(agentEditor(null));
            return;
        }
        const agent = agentList().find((a) => a.id === editingAgent);
        if (!agent) {
            body.append(T.h("div", { class: "empty-note", text: "—" }));
            return;
        }
        body.append(agentEditor(agent));
    }

    function agentEditor(agent) {
        const isNew = !agent;
        const editor = T.h("div", { class: "agent-editor" });

        const name = T.h("input", {
            class: "input",
            type: "text",
            value: agent ? agent.name || "" : "",
            "aria-label": t("agentName"),
        });
        name.addEventListener("keydown", (e) => e.stopPropagation());
        editor.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("agentName") }),
                T.h("div", { class: "set-control" }, [name]),
            ]),
        );

        editor.append(fieldLabel(t("persona")));
        const persona = T.h("textarea", { class: "textarea", placeholder: t("personaPlaceholder"), "aria-label": t("persona") });
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
                    editingAgent = isNew && r?.agent?.id ? r.agent.id : agent?.id || firstAgentId();
                    armDelete = null;
                    syncUrl({ open: true, tab: "agents", agentId: editingAgent, replace: true });
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
                            editingAgent = agents[0]?.id || "__new__";
                            armDelete = null;
                            syncUrl({ open: true, tab: "agents", agentId: editingAgent === "__new__" ? null : editingAgent, replace: true });
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

        editor.append(actions);
        return editor;
    }

    /* ── 전역 바인딩 ────────────────────────────────────────── */
    function trapFocus(e) {
        if (e.key !== "Tab" || !openTab) return;
        const focusable = [...sheet.querySelectorAll("button, input, textarea, select, a[href]")].filter(
            (el) => !el.disabled && el.getAttribute("aria-hidden") !== "true",
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    function init() {
        scrim.addEventListener("click", close);
        sheet.addEventListener("keydown", trapFocus);
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
            modelsReq++;
            modelsLoading = false;
            modelsCache = null;
            modelsFailedKey = null;
            if (openTab === "model" || openTab === "provider") build();
        });
        T.i18n.onChange(() => {
            if (openTab) build();
        });
    }

    T.settingsUI = { init, open, close, isOpen: () => !!openTab, oauthSection };
})((window.Taby = window.Taby || {}));
