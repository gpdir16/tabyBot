/* tabyBot 웹 클라이언트 — 설정 페이지.
   경로 기반 라우팅(/s/<탭>, /s/agents/<id>)으로 현재 화면을 공유/복원한다.
   변경은 즉시 PUT(낙관적 반영 + 실패 시 롤백 + 토스트).
   provider.apiKey는 쓰기 전용 — 응답에 절대 포함되지 않는다. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    const page = document.getElementById("settingsPage");

    let openTab = null;
    let returnPath = null; // 설정 진입 전 경로(닫을 때 돌아갈 페이지)
    let pushed = false; // open()에서 히스토리 항목을 push했는지
    let mobileFromList = false; // 모바일 목록 화면에서 열었는지
    let editingAgent = null; // 에이전트 페이지 id ('__new__' = 추가)
    let armDelete = null; // 삭제 확인 2단계 버튼 상태
    let armCompressAll = false; // 전체 세션 압축 확인 2단계 버튼 상태
    let modelsCache = null; // { key, models }
    let modelsLoading = false;
    let modelsFailedKey = null;
    let modelsReq = 0;
    let modelFilter = "";
    let providerChoice = null;
    let keyEditing = false; // 저장된 API 키를 다시 입력하는 중인지
    let credsEditing = null; // 계정 편집 중인 항목 — "username" | "password" | null
    let oauthPending = null; // 진행 중 OAuth 디바이스 플로우 { kind, userCode, deviceUrl }
    let advOpen = null; // 에이전트 편집기의 고급 설정 펼침. null이면 페르소나 유무로 초기화
    let modelAdvOpen = false; // 모델 탭의 고급 설정 펼침
    let putChain = Promise.resolve();

    /* ── 경로 라우팅(/s/<탭>, /s/agents/<id>) ───────────── */
    const TABS = ["general", "provider", "model", "account", "selfimprovement", "agents"];

    // 현재 경로를 설정 라우트로 해석한다. /s/가 아니면 null.
    function routeFromPath() {
        const m = /^\/s\/(general|provider|model|account|selfimprovement|agents)(?:\/([^/]+))?$/.exec(location.pathname || "");
        if (!m) return null;
        const tab = m[1];
        let agentId = null;
        if (tab === "agents") {
            if (m[2] === "new") agentId = "__new__";
            else if (m[2]) agentId = agentList().some((a) => a.id === m[2]) ? m[2] : firstAgentId() || "__new__";
            else agentId = firstAgentId() || "__new__";
        }
        return { tab, agentId };
    }

    // 탭/에이전트를 /s/ 경로로 만든다.
    function pathFor(tab, agent) {
        if (tab === "agents") return "/s/agents/" + (agent === "__new__" ? "new" : agent);
        return "/s/" + (tab || "general");
    }

    // 탭/에이전트 전환: 현재 설정 페이지의 경로만 교체한다.
    function syncPath() {
        try {
            history.replaceState(null, "", pathFor(openTab, editingAgent) + location.search + location.hash);
        } catch (_) {}
    }

    /* ── 렌더링(뷰 레이어) — 히스토리는 호출자/라우터가 담당한다 ──
       채팅의 T.chat.open과 동일한 역할: 경로에 맞게 화면을 그린다. */
    function open(opt) {
        // open({tab, agentId}) 또는 open("model") 형태 모두 지원
        const o = typeof opt === "object" && opt ? opt : { tab: opt };
        providerChoice = null;
        let tab, agent;
        if (o.agentId != null && o.agentId !== "" && (!o.tab || o.tab === "agents")) {
            tab = "agents";
            agent = o.agentId;
        } else if (TABS.includes(o.tab)) {
            tab = o.tab;
            agent = o.tab === "agents" ? o.agentId || firstAgentId() || "__new__" : null;
        } else {
            tab = "general";
            agent = null;
        }
        openTab = tab;
        editingAgent = agent;
        armDelete = null;
        armCompressAll = false;
        advOpen = null;
        modelAdvOpen = false;
        keyEditing = false;
        credsEditing = null;
        returnPath = o.returnPath != null ? o.returnPath : /^\/s\//.test(location.pathname) ? returnPath || "/" : location.pathname;
        const wasChatOpen = document.body.classList.contains("mobile-chat");
        T.todosUI?.hide?.();
        T.sidebar?.showChat();
        mobileFromList = !wasChatOpen && document.body.classList.contains("mobile-chat");
        pushed = false;
        if (!o.fromUrl) {
            try {
                history.pushState(null, "", pathFor(openTab, editingAgent));
                pushed = true;
            } catch (_) {}
        }
        build();
        page.hidden = false;
        document.body.classList.add("settings-route");
        T.sidebar?.syncRoute?.();
        page.focus({ preventScroll: true });
    }

    function close(options) {
        const o = options || {};
        if (o.updateUrl !== false) {
            if (pushed) {
                pushed = false;
                history.back();
                return;
            }
            try {
                history.replaceState(null, "", (returnPath || "/") + location.hash);
            } catch (_) {}
        }
        pushed = false;
        returnPath = null;
        page.hidden = true;
        document.body.classList.remove("settings-route");
        // OAuth 대기 중 페이지를 닫아도 폴링이 백그라운드로 계속 도는 걸 막는다.
        // oauthPending은 유지 — 다시 열면 oauthSection이 폴링을 재개한다.
        stopOauthPoll();
        openTab = null;
        modelsCache = null;
        modelsLoading = false;
        modelsFailedKey = null;
        modelsReq++;
        providerChoice = null;
        page.replaceChildren();
        if (mobileFromList) {
            mobileFromList = false;
            T.sidebar?.showList();
        }
        T.sidebar?.syncRoute?.();
    }

    /* 채팅의 openBot과 동일한 패턴: pushState 후 공용 라우터가 렌더링한다. */
    function navigate(tab, agentId) {
        try {
            history.pushState(null, "", pathFor(tab, agentId));
        } catch (_) {}
        T.app?.renderRoute();
    }

    /* 페이지를 내린다 — 히스토리/모바일 전환은 라우터가 담당한다. */
    function hide() {
        close({ updateUrl: false });
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
            } catch (err) {
                if (prev) state.setSettings(prev);
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                return false;
            }
        };
        const result = putChain.then(run, run);
        putChain = result.catch(() => {});
        return result;
    }

    /* ── 프레임: 채팅 헤더와 같은 구조(뒤로 버튼 + 제목) ── */
    function build() {
        page.replaceChildren();

        const head = T.h("header", { class: "sp-head" }, [
            // 채팅 헤더의 뒤로 버튼과 동일: 목록 화면으로 돌아간 뒤 라우터가 화면을 맞춘다.
            T.h(
                "button",
                {
                    class: "btn-icon sp-back",
                    "aria-label": t("back"),
                    onclick() {
                        T.sidebar?.showList();
                        T.app?.renderRoute();
                    },
                },
                [T.icon("arrow-left")],
            ),
            T.h("div", { id: "settingsTitle", class: "sp-title", text: t("settings") }),
        ]);

        const agents = agentList();
        const nav = T.h("nav", { class: "sp-nav", role: "tablist", "aria-label": t("settings") }, [
            tabBtn("general", t("general")),
            tabBtn("provider", t("provider")),
            tabBtn("model", t("model")),
            tabBtn("account", t("account")),
            tabBtn("selfimprovement", t("selfImprovement")),
            T.h("hr", { class: "divider" }),
            ...agents.map(agentNavBtn),
            T.h("button", {
                class: "sb-row" + (openTab === "agents" && editingAgent === "__new__" ? " active" : ""),
                role: "tab",
                "aria-selected": String(openTab === "agents" && editingAgent === "__new__"),
                tabindex: openTab === "agents" && editingAgent === "__new__" ? "0" : "-1",
                text: t("addAgent"),
                onclick() {
                    navigate("agents", "__new__");
                },
            }),
        ]);

        const body = T.h("div", { class: "sp-body" });
        if (openTab === "general") buildGeneral(body);
        else if (openTab === "provider") buildProvider(body);
        else if (openTab === "model") buildModel(body);
        else if (openTab === "account") buildAccount(body);
        else if (openTab === "selfimprovement") buildSelfImprovement(body);
        else buildAgents(body);

        page.append(head, T.h("div", { class: "sp-main" }, [nav, body]));
    }

    function tabBtn(id, label) {
        return T.h("button", {
            class: "sb-row" + (openTab === id ? " active" : ""),
            role: "tab",
            "aria-selected": String(openTab === id),
            tabindex: openTab === id ? "0" : "-1",
            text: label,
            onclick() {
                navigate(id, null);
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
                navigate("agents", agent.id);
            },
        });
    }

    // 입력 중 재렌더 방지: 시트 내부에 포커스가 있으면 스킵
    function rebuildIfIdle() {
        if (openTab == null) return;
        const ae = document.activeElement;
        if (ae && page.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
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

        // 시간대 — 스케줄(체크인·스윕·투두) 기준. 비우면 서버 시간대(도커는 UTC).
        const tzs =
            typeof Intl.supportedValuesOf === "function"
                ? Intl.supportedValuesOf("timeZone")
                : ["Asia/Seoul", "Asia/Tokyo", "UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin"];
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("timezone") }),
                settingSelect(
                    presetOptions(
                        [{ value: "", label: t("tzServerDefault") }, ...tzs.map((z) => ({ value: z, label: z }))],
                        s.timezone || "",
                        s.timezone || "",
                    ),
                    s.timezone || "",
                    (v) => put({ timezone: v }),
                    t("timezone"),
                ),
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

    /* ── 계정 탭 ─────────────────────────────────────────── */
    function accountField(labelText, ...kids) {
        return T.h("div", { class: "field" }, [fieldLabel(labelText), ...kids]);
    }

    function accountInput(type, label, autocomplete) {
        const el = T.h("input", { class: "input", type, "aria-label": label, autocomplete, spellcheck: "false" });
        el.addEventListener("keydown", (e) => e.stopPropagation());
        return el;
    }

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
            // 아직 계정이 없다 — 만들면 다음 접속부터 로그인이 필요해진다.
            editor.append(T.h("p", { class: "set-desc", text: t("authNoAccountDesc") }));
            const u = accountInput("text", t("authUsername"), "username");
            const p = accountInput("password", t("authPassword"), "new-password");
            const c = accountInput("password", t("authPasswordConfirm"), "new-password");
            editor.append(
                accountField(t("authUsername"), u),
                accountField(t("authPassword"), p),
                accountField(t("authPasswordConfirm"), c),
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
                                build();
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
                credsEditing = null;
                build();
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
                        credsEditing = null;
                        T.toast.show("info", t("authSaved"));
                        build();
                    } catch (e) {
                        this.disabled = false;
                        setErr(T.onboarding.authErrorText(e));
                    }
                },
            });

        if (credsEditing === "username") {
            // 이름 변경 — 현재 비밀번호로 본인 확인.
            const u = accountInput("text", t("authUsername"), "username");
            u.value = acct.username || "";
            const cur = accountInput("password", t("authCurrentPassword"), "current-password");
            editor.append(
                accountField(t("authUsername"), u),
                accountField(t("authCurrentPassword"), cur),
                err,
                T.h("div", { class: "editor-actions" }, [
                    saveBtn(
                        () => (!u.value.trim() || !cur.value ? t("authRequired") : null),
                        () => ({ currentPassword: cur.value, username: u.value.trim() }),
                    ),
                    cancelBtn,
                ]),
            );
        } else if (credsEditing === "password") {
            // 비밀번호 변경 — 현재 비밀번호 + 새 비밀번호 확인.
            const cur = accountInput("password", t("authCurrentPassword"), "current-password");
            const np = accountInput("password", t("authNewPassword"), "new-password");
            const nc = accountInput("password", t("authPasswordConfirm"), "new-password");
            editor.append(
                accountField(t("authCurrentPassword"), cur),
                accountField(t("authNewPassword"), np),
                accountField(t("authPasswordConfirm"), nc),
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
            // 저장된 계정 정보 — 라벨 아래 읽기 전용 입력칸, 변경할 항목마다 별도의 변경 버튼.
            const loc = { ko: "ko-KR", ja: "ja-JP" }[T.i18n.getLang()] || "en-US";
            const ro = (label, value, type = "text") => {
                const el = accountInput(type, label, "off");
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
                        credsEditing = which;
                        build();
                    },
                });
            editor.append(
                accountField(t("authUsername"), T.h("div", { class: "key-row" }, [ro(t("authUsername"), acct.username), editBtn("username")])),
            );
            if (acct.createdAt) {
                const d = new Date(acct.createdAt);
                if (!isNaN(d))
                    editor.append(
                        accountField(
                            t("authCreatedAt"),
                            ro(t("authCreatedAt"), d.toLocaleDateString(loc, { year: "numeric", month: "long", day: "numeric" })),
                        ),
                    );
            }
            if (typeof acct.sessionCount === "number") {
                editor.append(accountField(t("authSessions"), ro(t("authSessions"), t("authSessionCount", { n: acct.sessionCount }))));
            }
            editor.append(
                accountField(
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
                            } catch (_) {}
                            T.api.setToken("");
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
                        class: "provider-card" + (selected ? " selected" : ""),
                        role: "radio",
                        "aria-checked": String(selected),
                        onclick() {
                            if (selected) return;
                            providerChoice = p.id;
                            keyEditing = false;
                            modelsReq++;
                            modelsLoading = false;
                            modelsCache = null;
                            modelsFailedKey = null;
                            const patch =
                                p.id === "github-copilot"
                                    ? { id: p.id, model: "auto", autoMode: true }
                                    : p.id === "custom" || p.id === "default"
                                      ? { id: p.id, baseURL: "", model: "" }
                                      : { id: p.id, model: "" };
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

    function autoSessionSettings(provider) {
        const box = T.h("div", { class: "set-section" });
        const enabled = provider.autoMode === true;
        const toggle = switchEl(
            enabled,
            (value) => {
                put({ provider: { autoMode: value, model: value ? "auto" : "" } }).then(() => build());
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

        box.append(
            T.h("div", { class: "set-label", text: t("autoModelRouting") }),
            T.h("div", { class: "set-desc", text: t("autoModelRoutingDesc") }),
        );
        const key = modelsKey(provider);
        const routingModels = modelsCache?.key === key ? modelsCache.routingModels || [] : [];
        const selected = new Set(Array.isArray(provider.autoModelCandidates) ? provider.autoModelCandidates : []);
        if (!routingModels.length) {
            box.append(T.h("div", { class: "empty-note", text: modelsLoading ? t("loadingModels") : t("autoModelNoRouting") }));
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
                put({ provider: { autoModelCandidates: [...next] } }).then(() => build());
            });
            list.append(T.h("label", { class: "set-row" }, [T.h("span", { text: model.label || model.id }), input]));
        }
        box.append(list);
        return box;
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
        if (provider.id === "github-copilot") {
            sec.append(autoSessionSettings(provider), T.h("hr", { class: "divider" }));
        }
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

        sec.append(T.h("hr", { class: "divider" }));

        // 고급 — 컨텍스트 한도와 모델 전환 시 오염 방지 옵션
        const mAdvPanel = T.h("div", { class: "adv-panel" });
        mAdvPanel.hidden = !modelAdvOpen;
        const mAdvBtn = T.h(
            "button",
            {
                type: "button",
                class: "adv-toggle",
                "aria-expanded": String(modelAdvOpen),
                onclick() {
                    modelAdvOpen = !modelAdvOpen;
                    mAdvBtn.setAttribute("aria-expanded", String(modelAdvOpen));
                    mAdvPanel.hidden = !modelAdvOpen;
                },
            },
            [T.icon("chevron", "icon-sm"), T.h("span", { text: t("advanced") })],
        );

        // 컨텍스트 채움 한도 — 이 비율부터 오래된 대화를 요약으로 압축한다.
        // 옵션에는 현재 모델 윈도우 기준 실제 압축 시작 토큰 수를 함께 표시한다.
        const ctxPct = Number(s.contextTriggerPercent) || 75;
        const ctxWindow = Number(s.contextWindow) || 128000;
        const ctxLabel = (n) => `${n}% (~${Math.round((ctxWindow * Number(n)) / 100).toLocaleString()})`;
        mAdvPanel.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("ctxFillLimit") }),
                settingSelect(
                    presetOptions(
                        (Array.isArray(s.contextTriggerOptions) && s.contextTriggerOptions.length
                            ? s.contextTriggerOptions
                            : [50, 60, 70, 75, 80, 85, 90]
                        ).map((n) => ({ value: String(n), label: ctxLabel(n) })),
                        String(ctxPct),
                        ctxLabel(ctxPct),
                    ),
                    String(ctxPct),
                    (v) => put({ contextTriggerPercent: Number(v) }),
                    t("ctxFillLimit"),
                ),
            ]),
            T.h("div", { class: "set-desc", text: t("ctxFillLimitDesc") }),
        );

        // 모델이 바뀌면 모든 봇의 세션 압축 여부를 물어본다(실행은 사용자 확인 후).
        mAdvPanel.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("compressOnModelChange") }),
                switchEl(s.compressOnModelChange, (v) => put({ compressOnModelChange: v }), t("compressOnModelChange")),
            ]),
            T.h("div", { class: "set-desc", text: t("compressOnModelChangeDesc") }),
        );

        // 모든 봇의 세션 즉시 압축 — 모델 전환 전 컨텍스트 오염 방지.
        // 기록 재작성 + LLM 호출이 드는 작업이므로 2단계 확인을 거친다.
        // 진행 상태(sessionsCompressing)는 서버가 SSE로 알려 새로고침해도 유지된다.
        const compressing = Boolean(s.sessionsCompressing);
        const compressAllBtn = T.h("button", {
            class: "btn ghost" + (armCompressAll ? " danger" : ""),
            text: compressing ? t("compressing") : armCompressAll ? t("compressAllConfirm") : t("compressAllNow"),
            disabled: compressing,
            onclick() {
                if (compressing) return;
                if (!armCompressAll) {
                    armCompressAll = true;
                    compressAllBtn.classList.add("danger");
                    compressAllBtn.textContent = t("compressAllConfirm");
                    return;
                }
                armCompressAll = false;
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

    function isOauthProvider(meta) {
        return Boolean(meta && /-oauth$/.test(String(meta.type || "")));
    }

    // 모델 목록 캐시 무효화 — 키/URL 변경 후 공통으로 쓴다.
    function resetModels() {
        modelsReq++;
        modelsLoading = false;
        modelsCache = null;
        modelsFailedKey = null;
    }

    /* 비밀 입력(API 키 등): 입력칸 + 보기 토글. 설정과 온보딩에서 공용으로 쓴다.
       onCommit: blur/Enter 시 확정값, onInput: 입력마다 값 전달(온보딩 draft 동기화용). */
    function secretInput({ value = "", placeholder = "", aria = "", onInput, onCommit }) {
        const input = T.h("input", {
            class: "input",
            type: "password",
            value,
            placeholder,
            "aria-label": aria,
            autocomplete: "new-password",
            spellcheck: "false",
        });
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
        input.addEventListener("input", () => onInput && onInput(input.value));
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") input.blur();
        });
        if (onCommit) input.addEventListener("blur", () => onCommit(input.value));
        return T.h("div", { class: "key-row" }, [input, eye]);
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
            if (!oauthPending || oauthPending.kind !== kind) return;
            oauthPollTries++;
            // 5분 후 포기 — 디바이스 코드 만료와 맞춘다.
            if (oauthPollTries > 100) return;
            T.api
                .authStatus()
                .then((st) => {
                    if (!oauthPending || oauthPending.kind !== kind) return;
                    if (st && st[kind]) {
                        oauthPending = null;
                        stopOauthPoll();
                        refresh();
                    } else {
                        oauthPollTimer = setTimeout(tick, 3000);
                    }
                })
                .catch(() => {
                    if (oauthPending && oauthPending.kind === kind) oauthPollTimer = setTimeout(tick, 3000);
                });
        };
        oauthPollTimer = setTimeout(tick, 3000);
    }

    function oauthSection(kind, rerender) {
        const refresh = rerender || build;
        const box = T.h("div", {});

        if (oauthPending && oauthPending.kind === kind) {
            // 완료 감지: SSE 이벤트 + 상태 폴링 병행
            startOauthPoll(kind, refresh);
            // 디바이스 코드 카드: 코드 크게 표시 + 복사 + 페이지 열기
            box.append(
                T.h("div", { class: "oauth-pending" }, [
                    T.h("div", { class: "set-desc", text: t("oauthEnterCode") }),
                    T.h("div", { class: "oauth-code-row" }, [
                        T.h("span", { class: "oauth-code", text: oauthPending.userCode }),
                        T.h(
                            "button",
                            {
                                class: "btn-icon",
                                "aria-label": t("copy"),
                                onclick() {
                                    T.copyText(oauthPending.userCode).then((ok) => {
                                        if (ok) T.toast.show("info", t("copied"));
                                    });
                                },
                            },
                            [T.icon("copy")],
                        ),
                    ]),
                    T.h("a", {
                        class: "btn primary oauth-open",
                        href: oauthPending.deviceUrl,
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
                                T.api.cancelOauth(kind).catch(() => {});
                                oauthPending = null;
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
                const loggedIn = Boolean(st && st[kind]);
                account.replaceChildren(
                    T.h("div", { class: "key-state" + (loggedIn ? "" : " off") }, [
                        T.h("span", { class: "key-dot" }),
                        T.h("span", { text: loggedIn ? t("oauthLoggedIn") : t("oauthNotLoggedIn") }),
                    ]),
                    T.h(
                        "button",
                        {
                            class: "btn" + (loggedIn ? " ghost" : " primary"),
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
        const wrap = T.h("div", { class: "key-wrap" });

        if (provider.apiKeySet && !keyEditing) {
            // 저장된 키가 있으면 마스킹 상태로 보여주고, "교체"를 눌렀을 때만 입력칸을 연다.
            wrap.append(
                T.h("div", { class: "key-saved-row" }, [
                    T.h("div", { class: "key-state" }, [T.icon("check", "icon-sm"), t("apiKeySaved")]),
                    T.h("button", {
                        class: "btn ghost",
                        text: t("apiKeyReplace"),
                        onclick() {
                            keyEditing = true;
                            build();
                        },
                    }),
                ]),
            );
        } else {
            const row = secretInput({
                placeholder: provider.apiKeySet ? "••••••••" : meta.apiKeyOptional ? "" : "sk-…",
                aria: t("apiKey"),
                onCommit(v) {
                    v = v.trim();
                    if (!v) return;
                    put({ provider: { apiKey: v } }).then((ok) => {
                        if (ok) {
                            keyEditing = false;
                            resetModels();
                            build();
                        }
                    });
                },
            });
            if (provider.apiKeySet) {
                // 교체 취소 — 입력칸과 같은 줄에 둔다.
                row.append(
                    T.h("button", {
                        class: "btn ghost",
                        text: t("cancel"),
                        onclick() {
                            keyEditing = false;
                            build();
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
                    text: t("getApiKey") + " ↗",
                }),
            );
        }
        return wrap;
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
            modelsCache = {
                key,
                models: Array.isArray(r?.models) ? r.models : [],
                routingModels: Array.isArray(r?.routingModels) ? r.routingModels : [],
            };
            modelsLoading = false;
            modelsFailedKey = null;
            if (openTab === "model") build();
            else if (openTab === "agents") rebuildIfIdle();
        } catch (err) {
            if (req !== modelsReq) return;
            modelsLoading = false;
            modelsFailedKey = key;
            if (openTab === "model") {
                T.toast.show("error", T.api.errorText(err, t("modelsFailed")));
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
                            disabled: provider.autoMode === true,
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

    /* ── 자기 개선 탭: 백그라운드 자동화(체크인·드림 스윕·세션 리뷰) ──
       전부 선택형 — cron 문법이나 숫자 단위를 사용자에게 요구하지 않는다.
       세부 값(idleMin·maxOpsPerRun·timezone 등)은 config 파일로만 조정한다. */
    function siRow(label, control) {
        return T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: label }), T.h("div", { class: "set-control" }, [control])]);
    }

    // 현재 값이 프리셋에 없으면 그대로 보여주는 임시 옵션을 뒤에 붙인다.
    function presetOptions(presets, currentValue, currentLabel) {
        const opts = presets.slice();
        if (currentValue !== undefined && currentValue !== "" && !opts.some((o) => o.value === currentValue)) {
            opts.push({ value: currentValue, label: currentLabel });
        }
        return opts;
    }

    function buildSelfImprovement(body) {
        const s = state.state.settings;
        if (!s) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }
        const si = s.selfImprovement || {};
        const d = si.dreaming || {};
        const r = si.review || {};
        const p = si.proactive || {};
        const putSi = (section, patch) => put({ selfImprovement: { [section]: patch } });

        const sec = T.h("div", { class: "set-section" });
        sec.append(T.h("div", { class: "set-warn", text: t("siUsageWarn") }));

        // 자동 체크인
        sec.append(fieldLabel(t("siProactive")));
        sec.append(T.h("div", { class: "set-desc", text: t("siProactiveDesc") }));
        sec.append(
            siRow(
                t("siEnabled"),
                switchEl(p.enabled, (v) => putSi("proactive", { enabled: v }), t("siEnabled")),
            ),
        );
        sec.append(
            siRow(
                t("siInterval"),
                settingSelect(
                    presetOptions(
                        [
                            { value: "60", label: t("siEvery1h") },
                            { value: "180", label: t("siEvery3h") },
                            { value: "360", label: t("siEvery6h") },
                            { value: "720", label: t("siEvery12h") },
                        ],
                        String(p.intervalMin ?? 360),
                        `${p.intervalMin}min`,
                    ),
                    String(p.intervalMin ?? 360),
                    (v) => putSi("proactive", { intervalMin: Number(v) }),
                    t("siInterval"),
                ),
            ),
        );
        sec.append(
            siRow(
                t("siActiveHours"),
                settingSelect(
                    presetOptions(
                        [
                            { value: "0-24", label: t("siHoursAll") },
                            { value: "8-23", label: t("siHoursFull") },
                            { value: "9-18", label: t("siHoursDay") },
                            { value: "18-23", label: t("siHoursEvening") },
                        ],
                        `${p.activeStartHour ?? 8}-${p.activeEndHour ?? 23}`,
                        `${p.activeStartHour ?? 8}–${p.activeEndHour ?? 23}h`,
                    ),
                    `${p.activeStartHour ?? 8}-${p.activeEndHour ?? 23}`,
                    (v) => {
                        const [sh, eh] = v.split("-").map(Number);
                        putSi("proactive", { activeStartHour: sh, activeEndHour: eh });
                    },
                    t("siActiveHours"),
                ),
            ),
        );
        sec.append(
            siRow(
                t("siIdle"),
                settingSelect(
                    presetOptions(
                        [
                            { value: "15", label: t("siIdle15") },
                            { value: "30", label: t("siIdle30") },
                            { value: "60", label: t("siIdle60") },
                        ],
                        String(p.idleMin ?? 30),
                        `${p.idleMin}min`,
                    ),
                    String(p.idleMin ?? 30),
                    (v) => putSi("proactive", { idleMin: Number(v) }),
                    t("siIdle"),
                ),
            ),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 드림 스윕
        sec.append(fieldLabel(t("siDreaming")));
        sec.append(T.h("div", { class: "set-desc", text: t("siDreamingDesc") }));
        sec.append(
            siRow(
                t("siEnabled"),
                switchEl(d.enabled, (v) => putSi("dreaming", { enabled: v }), t("siEnabled")),
            ),
        );
        sec.append(
            siRow(
                t("siSchedule"),
                settingSelect(
                    presetOptions(
                        [
                            { value: "0 */6 * * *", label: t("siSched6h") },
                            { value: "0 4 * * *", label: t("siSchedDaily") },
                            { value: "0 4 * * 0", label: t("siSchedWeekly") },
                        ],
                        d.cron || "0 4 * * *",
                        String(d.cron || ""),
                    ),
                    d.cron || "0 4 * * *",
                    (v) => putSi("dreaming", { cron: v }),
                    t("siSchedule"),
                ),
            ),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 세션 리뷰
        sec.append(fieldLabel(t("siReview")));
        sec.append(T.h("div", { class: "set-desc", text: t("siReviewDesc") }));
        sec.append(
            siRow(
                t("siEnabled"),
                switchEl(r.enabled, (v) => putSi("review", { enabled: v }), t("siEnabled")),
            ),
        );
        sec.append(
            siRow(
                t("siReviewLevel"),
                settingSelect(
                    presetOptions(
                        [
                            { value: "3", label: t("siRevSmall") },
                            { value: "5", label: t("siRevMid") },
                            { value: "10", label: t("siRevLarge") },
                        ],
                        String(r.minToolCalls ?? 5),
                        String(r.minToolCalls ?? 5),
                    ),
                    String(r.minToolCalls ?? 5),
                    (v) => putSi("review", { minToolCalls: Number(v) }),
                    t("siReviewLevel"),
                ),
            ),
        );

        body.append(sec);
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

    // 저장 시점에 값을 읽는 셀렉트. 즉시 PUT하는 settingSelect와 달리 ref를 돌려준다.
    function editorSelect(options, current, aria) {
        const sel = T.h("select", { "aria-label": aria });
        for (const o of options) {
            const opt = T.h("option", { value: o.value, text: o.label });
            if (o.value === current) opt.selected = true;
            sel.append(opt);
        }
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        return sel;
    }

    function selectWrap(sel) {
        return T.h("div", { class: "select-wrap" }, [sel, T.icon("chevron")]);
    }

    function agentEditor(agent) {
        const isNew = !agent;
        const s = state.state.settings || {};
        const provider = s.provider || {};
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

        // 모델. 비워 두면 전역 모델. 목록은 모델 탭과 같은 캐시(modelsCache)를 쓴다.
        const mKey = modelsKey(provider);
        const cacheReady = modelsCache && modelsCache.key === mKey;
        if (!cacheReady && !modelsLoading && modelsFailedKey !== mKey) void loadModels(provider);
        const globalModelLabel = (cacheReady && modelsCache.models.find((m) => m.id === provider.model)?.label) || provider.model;
        const modelOpts = [{ value: "", label: t("agentInherit") + (globalModelLabel ? ` (${globalModelLabel})` : "") }];
        if (cacheReady) for (const m of modelsCache.models) modelOpts.push({ value: m.id, label: m.label || m.id });
        const modelSel = editorSelect(presetOptions(modelOpts, agent?.model || "", agent?.model || ""), agent?.model || "", t("model"));
        editor.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("model") }),
                T.h("div", { class: "set-control" }, [selectWrap(modelSel)]),
            ]),
        );

        // 사고 수준. 비워 두면 전역 값.
        let thinkingSel = null;
        if (Array.isArray(s.thinkingLevels) && s.thinkingLevels.length) {
            const globalThinkingLabel = s.thinkingLevels.find((l) => l.value === s.thinkingLevel)?.label || s.thinkingLevel;
            const opts = [
                { value: "", label: t("agentInherit") + (globalThinkingLabel ? ` (${globalThinkingLabel})` : "") },
                ...s.thinkingLevels.map((l) => ({ value: l.value, label: l.label || l.value })),
            ];
            thinkingSel = editorSelect(
                presetOptions(opts, agent?.thinkingLevel || "", agent?.thinkingLevel || ""),
                agent?.thinkingLevel || "",
                t("thinkingLevel"),
            );
            editor.append(
                T.h("div", { class: "set-row" }, [
                    T.h("div", { class: "set-label", text: t("thinkingLevel") }),
                    T.h("div", { class: "set-control" }, [selectWrap(thinkingSel)]),
                ]),
            );
        }

        // 아바타 색상. "자동"이면 id 해시로 정한다.
        let colorChoice = agent?.colorChoice || "";
        const palette =
            Array.isArray(s.agentColors) && s.agentColors.length
                ? s.agentColors
                : ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#32d74b", "#64d2ff"];
        const swatches = T.h("div", { class: "agent-colors" });
        const syncSwatches = () => {
            swatches.querySelectorAll(".color-swatch").forEach((el) => {
                const on = (el.dataset.color || "") === colorChoice;
                el.classList.toggle("selected", on);
                el.setAttribute("aria-pressed", String(on));
            });
        };
        swatches.append(
            T.h("button", {
                type: "button",
                class: "color-swatch auto",
                dataset: { color: "" },
                text: t("agentColorAuto"),
                "aria-pressed": "false",
                onclick() {
                    colorChoice = "";
                    syncSwatches();
                },
            }),
        );
        for (const c of palette) {
            swatches.append(
                T.h("button", {
                    type: "button",
                    class: "color-swatch",
                    dataset: { color: c },
                    style: `background:${c}`,
                    "aria-label": c,
                    "aria-pressed": "false",
                    onclick() {
                        colorChoice = c;
                        syncSwatches();
                    },
                }),
            );
        }
        syncSwatches();
        editor.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("agentColor") }),
                T.h("div", { class: "set-control" }, [swatches]),
            ]),
        );

        // 고급 설정. 페르소나는 선택 사항이므로 여기 접어둔다.
        if (advOpen === null) advOpen = Boolean(agent?.persona?.trim());
        const persona = T.h("textarea", { class: "textarea", placeholder: t("personaPlaceholder"), "aria-label": t("persona") });
        persona.value = agent ? agent.persona || "" : "";
        persona.addEventListener("keydown", (e) => e.stopPropagation());
        const advPanel = T.h("div", { class: "adv-panel" }, [
            fieldLabel(t("persona")),
            persona,
            T.h("div", { class: "set-desc", text: t("personaDesc") }),
        ]);
        advPanel.hidden = !advOpen;
        const advBtn = T.h(
            "button",
            {
                type: "button",
                class: "adv-toggle",
                "aria-expanded": String(advOpen),
                onclick() {
                    advOpen = !advOpen;
                    advBtn.setAttribute("aria-expanded", String(advOpen));
                    advPanel.hidden = !advOpen;
                },
            },
            [T.icon("chevron", "icon-sm"), T.h("span", { text: t("advanced") })],
        );
        editor.append(T.h("hr", { class: "divider" }), advBtn, advPanel);

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
                const body = {
                    name: n,
                    persona: persona.value,
                    model: modelSel.value,
                    color: colorChoice,
                };
                if (thinkingSel) body.thinkingLevel = thinkingSel.value;
                try {
                    let r;
                    if (isNew) r = await T.api.createAgent(body);
                    else r = await T.api.updateAgent(agent.id, body);
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
                    syncPath();
                    build();
                } catch (err) {
                    saveBtn.disabled = false;
                    const reason = err?.payload?.error || "";
                    const detail =
                        reason === "name_required"
                            ? t("nameRequired")
                            : reason === "name_too_long"
                              ? t("nameTooLong")
                              : reason === "persona_too_long"
                                ? t("personaTooLong")
                                : reason === "model_too_long"
                                  ? t("modelTooLong")
                                  : reason === "invalid_thinking_level"
                                    ? t("invalidThinkingLevel")
                                    : reason === "invalid_color"
                                      ? t("invalidColor")
                                      : reason === "too_many"
                                        ? t("lastBotTooltip")
                                        : "";
                    T.toast.show("error", detail ? `${t("saveFailed")}: ${detail}` : T.api.errorText(err, t("saveFailed")));
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
                    T.api
                        .deleteAgent(agent.id)
                        .then((r) => {
                            const agents = r && Array.isArray(r.agents) ? r.agents : [];
                            state.mergeSettingsLocal({ agents });
                            state.setBots(agents);
                            if (state.state.currentId === agent.uuid) {
                                const next = agents[0];
                                if (next && T.chat) T.chat.open(next.uuid);
                                else if (T.chat) T.chat.open(null);
                            }
                            editingAgent = agents[0]?.id || "__new__";
                            armDelete = null;
                            syncPath();
                            build();
                        })
                        .catch((err) => {
                            delBtn.disabled = false;
                            T.toast.show("error", err?.status === 400 ? t("lastBotTooltip") : T.api.errorText(err, t("saveFailed")));
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
    function init() {
        state.on("settings", rebuildIfIdle);
        state.on("bots", rebuildIfIdle);
        state.on("pwa", rebuildIfIdle);
        // OAuth 결과는 시트가 닫혀 있어도 반영한다(설정 갱신 + 토스트).
        state.on("oauth_done", (p) => {
            oauthPending = null;
            stopOauthPoll();
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

    T.settingsUI = {
        init,
        open,
        close,
        hide,
        isOpen: () => !!openTab && !page.hidden,
        routeFromPath,
        oauthSection,
        secretInput,
        resetOauth: () => (oauthPending = null),
    };
})((window.Taby = window.Taby || {}));
