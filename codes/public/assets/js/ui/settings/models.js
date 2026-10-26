/* tabyBot 웹 클라이언트: 설정 > 모델과 프로바이더 탭.
   모델 프리셋: 프로바이더, 모델, 추론 깊이, OpenRouter 고정을 묶어 이름을 붙여 둔 것. 에이전트와 그 밖의 모든 곳은 프리셋을 고른다.
   프로바이더: 로그인과 API 키(접속 정보)만 담는다. 프리셋이 그중 하나를 가리킨다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    /* 창 종류:
       s.model          탭 첫 화면(프리셋과 프로바이더 목록)
       s.preset:<uid>   프리셋 편집("new"면 새 프리셋). 초안은 창이 들고 있다(win.draft). 저장 버튼을 눌러야 저장한다.
       s.pick:<what>:<프리셋 창 id>  프리셋 편집 안의 고르기(profile, model, pin, thinking, ctx). 고르면 그 창의 초안에 담고 닫힌다.
       s.profile:<uid>  프로바이더(로그인, 키) 편집
       s.profile-add    프로바이더 추가
       s.adv            고급 설정 */
    const MODEL_KINDS = ["s.model", "s.preset", "s.pick", "s.profile", "s.profile-add"];

    // 모델에 관한 창이 모두 닫히면 로그인 확인을 멈추고 받아 둔 모델 목록을 버린다(다시 열면 새로 받는다).
    // OAuth 대기 상태(oauthPending)는 남겨 둔다. 다시 열면 oauthSection이 확인을 다시 시작한다.
    function leaveModels() {
        if (!C.noneOpen((w) => MODEL_KINDS.includes(w.kind))) return;
        C.stopOauthPoll();
        forgetModelLists();
    }

    function settings() {
        return state.state.settings || {};
    }

    function profiles() {
        return Array.isArray(settings().profiles) ? settings().profiles : [];
    }

    function profileByUid(uid) {
        return profiles().find((p) => p.uid === uid) || null;
    }

    function presets() {
        return Array.isArray(settings().modelPresets) ? settings().modelPresets : [];
    }

    function presetByUid(uid) {
        return presets().find((p) => p.uid === uid) || null;
    }

    function defaultPreset() {
        return presets().find((p) => p.isDefault) || presets()[0] || null;
    }

    function providerMeta(profile) {
        const providers = settings().providers || [];
        return providers.find((p) => p.id === (profile?.providerId === "custom" ? "custom" : profile?.id)) || null;
    }

    function isOauthProfile(profile) {
        return /-oauth$/.test(String(profile?.type || ""));
    }

    function isCliProfile(profile) {
        return profile?.type === "claude-agent-sdk";
    }

    // 요청을 보내고 돌아온 설정을 반영한다. 성공하면 돌아온 설정, 실패하면 null.
    async function request(run) {
        try {
            const s = await run();
            if (s) state.setSettings(s);
            return s || {};
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            return null;
        }
    }

    /* ── 모델 목록(프로바이더마다) ──────────────────────────── */
    const modelLists = new Map(); // key → { models, routingModels } | { loading } | { failed, error }
    const modelLoads = new Map(); // key → 받는 중인 Promise

    // 주소나 키가 바뀌면 키가 달라져 목록을 다시 받는다.
    function listKey(profile) {
        return `${profile.uid}\n${profile.id}\n${profile.baseURL}\n${profile.apiKeySet}`;
    }

    async function fetchModels(profile, key) {
        modelLists.set(key, { loading: true });
        try {
            const r = await T.api.models({ profile: profile.uid });
            // 입력한 주소에 /v1을 붙여야 목록이 나왔다: 그 주소로 저장해 대화 요청도 같은 곳으로 가게 한다.
            if (r?.suggestedBaseURL && profile.baseURL && r.suggestedBaseURL !== profile.baseURL) {
                await request(() => T.api.updateProviderProfile(profile.uid, { provider: { baseURL: r.suggestedBaseURL } }));
                T.toast.show("info", t("baseURLAdjusted", { url: r.suggestedBaseURL }));
            }
            modelLists.set(key, {
                models: Array.isArray(r?.models) ? r.models : [],
                routingModels: Array.isArray(r?.routingModels) ? r.routingModels : [],
            });
        } catch (err) {
            modelLists.set(key, { failed: true, error: T.api.errorText(err, t("modelsFailed")) });
        }
        refreshView();
    }

    // 목록이 도착하면 그 목록을 보이는 창들을 다시 그린다. 프리셋 편집과 고르기 창은 입력을 초안(창이 들고 있다)에
    // 모아 두므로 고친 것이 있어도 다시 그린다(그냥 refresh는 고친 창을 건너뛰어 고르기 창이 "받는 중"에 머문다).
    // 입력 중이면 건드리지 않는다.
    function refreshView() {
        T.windows.refresh((w) => (w.kind === "s.preset" || w.kind === "s.pick") && !C.typingIn(w), { force: true });
        T.windows.refresh((w) => w.kind === "s.model" || w.kind === "s.efficiency" || w.kind === "s.agent");
    }

    // 프로필의 모델 목록 상태. 아직 받지 않았으면 받기 시작한다. { models, routingModels, loading, failed, error }
    function modelsOf(profile) {
        if (!profile) return { models: [], routingModels: [], loading: false };
        const key = listKey(profile);
        if (!modelLists.has(key)) {
            const run = fetchModels(profile, key).finally(() => modelLoads.delete(key));
            modelLoads.set(key, run);
        }
        return { models: [], routingModels: [], ...(modelLists.get(key) || { loading: true }) };
    }

    // 목록이 준비되면 그 상태로 풀리는 Promise. 설정 밖의 화면(에이전트 정보 창)이 기다린다.
    function modelsReady(profile) {
        const now = modelsOf(profile);
        const run = profile ? modelLoads.get(listKey(profile)) : null;
        return run ? run.then(() => modelsOf(profile)) : Promise.resolve(now);
    }

    function retryModels(profile, win) {
        modelLists.delete(listKey(profile));
        win.rebuild();
    }

    function forgetModelLists() {
        modelLists.clear();
        pinLists.clear();
    }

    function modelLabel(profile, modelId) {
        if (!modelId) return "";
        if (modelId === "auto" && profile?.id === "github-copilot") return t("autoModel");
        return modelsOf(profile).models.find((m) => m.id === modelId)?.label || modelId;
    }

    // 프리셋 이름. 이름을 비워 두면 모델 이름이 이름이 된다.
    function presetName(preset) {
        if (!preset) return "";
        if (preset.name) return preset.name;
        return modelLabel(profileByUid(preset.profile), preset.model) || t("modelNotChosen");
    }

    function thinkingLevelsFor(providerId) {
        const all = settings().thinkingLevelsByProvider || {};
        return all[providerId] || settings().thinkingLevels || [];
    }

    function thinkingLabel(providerId, level) {
        return thinkingLevelsFor(providerId).find((l) => l.value === level)?.label || level || "";
    }

    /* ── 압축 시점: 프리셋마다 고르고, 고르지 않으면 기본값을 쓴다 ── */
    function globalCtxPercent() {
        return Number(settings().contextTriggerPercent) || 75;
    }

    function ctxOptions() {
        const list = settings().contextTriggerOptions;
        return Array.isArray(list) && list.length ? list : [50, 60, 70, 75, 80, 85, 90];
    }

    function ctxLabel(pct) {
        return pct ? `${pct}%` : t("presetCtxDefault", { pct: globalCtxPercent() });
    }

    // 모델의 컨텍스트 크기를 알면 실제로 압축을 시작하는 토큰 수를 함께 보여 준다.
    function ctxTokens(profile, modelId, pct) {
        const size = Number(modelsOf(profile).models.find((m) => m.id === modelId)?.contextWindow) || 0;
        return size ? `~${Math.round((size * pct) / 100).toLocaleString()}` : "";
    }

    // 프리셋 한 줄 설명: 프로바이더, 추론 깊이(이름이 따로 있으면 모델도).
    function presetSummary(preset) {
        const profile = profileByUid(preset.profile);
        const parts = [profile?.name || ""];
        if (preset.name && preset.model) parts.push(modelLabel(profile, preset.model));
        if (preset.thinkingLevel) parts.push(thinkingLabel(preset.providerId, preset.thinkingLevel));
        return parts.filter(Boolean).join(", ");
    }

    /* ── OpenRouter 업스트림 프로바이더 고정(모델마다) ────────── */
    const pinLists = new Map(); // `${uid}\n${model}` → { providers, alias, resolved } | { loading } | { failed, error }

    function pinsOf(profile, model) {
        const key = `${profile.uid}\n${model}`;
        if (!pinLists.has(key)) {
            pinLists.set(key, { loading: true });
            T.api
                .openRouterProviders(model, profile.uid)
                .then((r) => {
                    pinLists.set(key, {
                        providers: Array.isArray(r?.providers) ? r.providers : [],
                        alias: Boolean(r?.alias),
                        resolved: r?.resolved || "",
                    });
                })
                .catch((err) => {
                    pinLists.set(key, { failed: true, error: T.api.errorDetail(err) });
                })
                .finally(refreshView);
        }
        return { providers: [], ...pinLists.get(key) };
    }

    function pinLabel(profile, model, tag) {
        if (!tag) return t("openRouterPinAuto");
        return pinsOf(profile, model).providers?.find((p) => p.tag === tag)?.name || tag;
    }

    /* ── 검색할 수 있는 고르기 목록 ──────────────────────────
       모델과 업스트림 프로바이더는 수백 개일 수 있다. 검색창 아래에 걸러 낸 항목만 그린다.
       filter: 검색어를 담아 두는 칸({ q }). 고르기 창이 들고 있어 다시 그려도 검색어가 남는다. */
    function searchList({ items, current, placeholder, onPick, emptyText, filter = { q: "" }, search: withSearch = true }) {
        const panel = T.h("div", { class: "models-panel" });
        const search = T.h("input", {
            class: "input",
            type: "search",
            placeholder,
            "aria-label": placeholder,
            value: filter.q,
            spellcheck: "false",
        });
        const list = T.h("div", { class: "models-list", role: "radiogroup", "aria-label": placeholder });
        const render = () => {
            const q = search.value.trim().toLowerCase();
            const shown = items.filter((it) => !q || it.value.toLowerCase().includes(q) || String(it.label).toLowerCase().includes(q));
            list.replaceChildren();
            if (!shown.length) {
                list.append(T.h("div", { class: "empty-note", text: emptyText }));
                return;
            }
            for (const it of shown) {
                const selected = it.value === current;
                list.append(
                    T.h(
                        "button",
                        {
                            type: "button",
                            class: `radio-row${selected ? " selected" : ""}`,
                            role: "radio",
                            "aria-checked": String(selected),
                            onclick: () => onPick(it.value),
                        },
                        [
                            T.h("div", { class: "model-main" }, [
                                T.h("div", { class: "model-label", text: it.label }),
                                it.sub
                                    ? T.h("div", { class: "model-sub" }, [T.h("span", { class: "model-id", text: it.sub }), it.extra || null])
                                    : null,
                            ]),
                            selected ? T.icon("check", "sel-check") : null,
                        ],
                    ),
                );
            }
        };
        search.addEventListener("input", () => {
            filter.q = search.value;
            render();
        });
        search.addEventListener("keydown", (e) => e.stopPropagation());
        render();
        if (withSearch) panel.append(search);
        panel.append(list);
        return panel;
    }

    function modelItems(profile, models) {
        const items = models.map((m) => ({
            value: m.id,
            label: m.label || m.id,
            // 이름 아래 한 줄에 id와 컨텍스트 크기를 적는다. 비전 지원 모델은 그 줄 끝에 눈 아이콘이 붙는다.
            sub: Number(m.contextWindow) > 0 ? `${m.id}, ${Number(m.contextWindow).toLocaleString()}` : m.id,
            extra:
                m.supportsVision === true
                    ? T.h("span", { class: "model-vision", "data-tip": t("visionSupported"), "aria-label": t("vision") }, [T.icon("eye")])
                    : null,
        }));
        // GitHub Copilot은 요청마다 모델을 골라 주는 자동 모델이 있다.
        if (profile?.id === "github-copilot" && !items.some((it) => it.value === "auto")) {
            items.unshift({ value: "auto", label: t("autoModel"), sub: t("autoModelUseDesc") });
        }
        return items;
    }

    // 목록을 받지 못한 프로바이더: 모델 id를 직접 적는다.
    function manualModelInput(current, onSave) {
        const input = T.h("input", {
            class: "input",
            type: "text",
            value: current || "",
            placeholder: t("manualModelPlaceholder"),
            "aria-label": t("manualModel"),
            spellcheck: "false",
        });
        const commit = () => {
            const v = input.value.trim();
            if (v) onSave(v);
        };
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.isComposing) commit();
        });
        return [C.labeledRow(t("manualModel"), input), C.actionRow(t("save"), commit)];
    }

    /* ── 프리셋 편집 ─────────────────────────────────────────
       편집은 초안(draft)에 모았다가 저장 버튼으로 한 번에 보낸다. 모델과 고정은 다음 화면에서 고르고 돌아온다. */
    function draftOf(preset) {
        const fallbackProfile = defaultPreset()?.profile || profiles()[0]?.uid || "";
        return {
            name: preset?.name || "",
            profile: preset?.profile || fallbackProfile,
            model: preset?.model || "",
            // 새 프리셋은 기본 프리셋의 추론 깊이에서 시작한다.
            thinkingLevel: preset ? preset.thinkingLevel || "" : defaultPreset()?.thinkingLevel || "",
            openRouterPin: preset?.openRouterPin || "",
            autoModelCandidates: preset?.autoModelCandidates ? [...preset.autoModelCandidates] : [],
            // 0이면 기본 압축 시점을 쓴다.
            contextTriggerPercent: Number(preset?.contextTriggerPercent) || 0,
        };
    }

    // 프리셋 편집 창 "s.preset:<uid>"("new"면 새 프리셋). 초안은 이 창이 들고 있어 다시 그려도 남는다.
    // 고르기 창이 그 초안을 읽고 고칠 수 있게 win.draft에 걸어 둔다.
    T.windows.define("s.preset", (arg) => {
        if (!arg) return null;
        const uid = arg === "new" ? null : arg;
        let draft = null;
        let orig = "";
        return {
            title: () => (uid ? presetName(presetByUid(uid)) || t("modelsTab") : t("addPreset")),
            on: ["settings"],
            // 다른 기기에서 지워졌다.
            gone: () => Boolean(uid && state.state.settings && !presetByUid(uid)),
            onClose: leaveModels,
            build(body, win) {
                const preset = uid ? presetByUid(uid) : null;
                if (!state.state.settings || (uid && !preset)) {
                    body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
                    return;
                }
                if (!draft) {
                    draft = draftOf(preset);
                    orig = JSON.stringify(draft);
                }
                win.draft = draft;
                const sec = T.h("div", { class: "set-section" });
                body.append(sec);
                buildPresetEditor(sec, win, preset, draft, orig);
            },
        };
    });

    function buildPresetEditor(sec, win, preset, draft, orig) {
        const profile = profileByUid(draft.profile);
        // 고르기 창은 이 창 오른쪽에 열린다. 초안은 그대로 두고 간다(묻지 않는다).
        const pick = (what) => () => win.open(`s.pick:${what}:${win.id}`);

        const name = T.h("input", {
            class: "input",
            type: "text",
            value: draft.name,
            maxlength: "60",
            placeholder: modelLabel(profile, draft.model) || t("presetName"),
            "aria-label": t("presetName"),
        });
        name.addEventListener("input", () => {
            draft.name = name.value;
        });
        name.addEventListener("keydown", (e) => e.stopPropagation());
        sec.append(C.labeledRow(t("presetName"), name));

        // 프로바이더, 모델, 고정, 추론 깊이는 모두 행을 눌러 다음 창에서 고른다.
        sec.append(C.navRow(t("provider"), profile?.name || "", pick("profile")));
        if (profile && !profileReady(profile)) sec.append(T.h("div", { class: "set-desc", text: t("presetProviderNotReady") }));
        sec.append(C.navRow(t("model"), modelLabel(profile, draft.model) || t("modelNotChosen"), pick("model")));
        if (profile?.id === "openrouter" && draft.model) {
            sec.append(C.navRow(t("openRouterPin"), pinLabel(profile, draft.model, draft.openRouterPin), pick("pin")));
        }
        const levels = thinkingLevelsFor(profile?.id);
        if (levels.length) {
            // 이 프로바이더에 없는 단계면 중간(없으면 첫 단계)으로 맞춘다.
            if (!levels.some((l) => l.value === draft.thinkingLevel)) {
                draft.thinkingLevel = levels.find((l) => l.value === "medium")?.value || levels[0].value;
            }
            sec.append(C.navRow(t("thinkingLevel"), thinkingLabel(profile?.id, draft.thinkingLevel), pick("thinking")));
        }
        sec.append(C.navRow(t("ctxFillLimit"), ctxLabel(draft.contextTriggerPercent), pick("ctx")));

        if (profile?.id === "github-copilot" && draft.model === "auto") autoCandidateRows(sec, profile, draft);

        if (preset) {
            sec.append(T.h("hr", { class: "divider" }));
            if (preset.isDefault) sec.append(T.h("div", { class: "set-desc", text: t("presetIsDefault") }));
            else sec.append(C.actionRow(t("presetMakeDefault"), () => makeDefault(win, preset), { own: true }));
            if (presets().length > 1) sec.append(C.actionRow(t("delete"), () => deletePreset(win, preset), { danger: true, own: true }));
        }

        C.headAction(preset ? t("save") : t("create"), () => savePreset(win, preset?.uid || null, draft));
        // 모델을 골라야 저장할 수 있다. 고친 프리셋은 바뀐 것도 있어야 한다.
        T.windows.slot.dirty = () => Boolean(draft.model) && (!preset || JSON.stringify(draft) !== orig);
    }

    // GitHub Copilot 자동 모델: 자동으로 고를 후보 모델.
    function autoCandidateRows(sec, profile, draft) {
        sec.append(C.fieldLabel(t("autoModelRouting")), T.h("div", { class: "set-desc", text: t("autoModelRoutingDesc") }));
        const list = modelsOf(profile);
        if (!list.routingModels.length) {
            sec.append(T.h("div", { class: "empty-note", text: list.loading ? t("loadingModels") : t("autoModelNoRouting") }));
            return;
        }
        for (const model of list.routingModels) {
            const label = model.label || model.id;
            sec.append(
                C.labeledRow(
                    label,
                    C.switchEl(
                        draft.autoModelCandidates.includes(model.id),
                        (on) => {
                            const next = new Set(draft.autoModelCandidates);
                            if (on) next.add(model.id);
                            else next.delete(model.id);
                            draft.autoModelCandidates = [...next];
                        },
                        label,
                    ),
                ),
            );
        }
    }

    // 저장하면 편집 창을 닫는다. 탭 창은 설정 이벤트로 다시 그려진다.
    async function savePreset(win, uid, draft) {
        if (!draft.model) {
            T.toast.show("error", t("modelNotChosen"));
            return;
        }
        const body = { ...draft, name: draft.name.trim() };
        const s = await request(() => (uid ? T.api.updateModelPreset(uid, body) : T.api.createModelPreset(body)));
        if (!s) return;
        void win.close({ force: true });
    }

    async function makeDefault(win, preset) {
        if (await request(() => T.api.defaultModelPreset(preset.uid))) win.rebuild();
    }

    async function deletePreset(win, preset) {
        if (!(await C.confirmDelete(presetName(preset)))) return;
        if (!(await request(() => T.api.deleteModelPreset(preset.uid)))) return;
        void win.close({ force: true });
    }

    /* ── 고르기 창 "s.pick:<what>:<프리셋 창 id>" ─────────────
       프리셋 편집 창의 초안(win.draft)에서 하나를 고른다. 고르면 그 초안에 담고, 편집 창을 다시 그린 뒤 이 창을 닫는다.
       편집 창이 닫히면 같이 닫힌다. */
    const PICK_TITLES = { model: "model", pin: "openRouterPin", profile: "provider", thinking: "thinkingLevel", ctx: "ctxFillLimit" };

    T.windows.define("s.pick", (arg) => {
        const i = (arg || "").indexOf(":");
        if (i < 0) return null;
        const what = arg.slice(0, i);
        const parentId = arg.slice(i + 1);
        if (!PICK_TITLES[what]) return null;
        const parent = () => T.windows.get(parentId);
        // 주소로 되살릴 때 편집 창이 없으면 열지 않는다.
        if (!parent()) return null;
        const filter = { q: "" };
        return {
            title: () => t(PICK_TITLES[what]),
            on: ["settings"],
            gone: () => !parent()?.draft,
            build(body, win) {
                const host = parent();
                if (!host?.draft) return;
                const done = () => {
                    host.rebuild();
                    void win.close({ force: true });
                };
                const sec = T.h("div", { class: "set-section" });
                body.append(sec);
                buildPick(sec, { what, draft: host.draft, filter, done, win });
            },
        };
    });

    // 모델, 고정, 추론 깊이, 압축 시점, 프로바이더 고르기. p: { what, draft, filter, done, win }
    function buildPick(sec, p) {
        const { draft, filter, done } = p;
        if (p.what === "profile") {
            buildProfilePick(sec, draft, done);
            return;
        }
        const profile = profileByUid(draft.profile);
        if (!profile) {
            sec.append(T.h("div", { class: "empty-note", text: "-" }));
            return;
        }
        if (p.what === "pin") {
            buildPinPick(sec, p, profile);
            return;
        }
        if (p.what === "thinking") {
            const levels = thinkingLevelsFor(profile.id);
            sec.append(
                searchList({
                    items: levels.map((l) => ({ value: l.value, label: l.label || l.value })),
                    current: draft.thinkingLevel,
                    placeholder: t("thinkingLevel"),
                    search: false,
                    emptyText: "-",
                    onPick(v) {
                        draft.thinkingLevel = v;
                        done();
                    },
                }),
            );
            return;
        }
        if (p.what === "ctx") {
            const items = [
                { value: "0", label: ctxLabel(0), sub: ctxTokens(profile, draft.model, globalCtxPercent()) },
                ...ctxOptions().map((n) => ({ value: String(n), label: `${n}%`, sub: ctxTokens(profile, draft.model, n) })),
            ];
            sec.append(
                searchList({
                    items,
                    current: String(draft.contextTriggerPercent || 0),
                    placeholder: t("ctxFillLimit"),
                    search: false,
                    emptyText: "-",
                    onPick(v) {
                        draft.contextTriggerPercent = Number(v) || 0;
                        done();
                    },
                }),
                T.h("div", { class: "set-desc", text: t("presetCtxDesc") }),
            );
            return;
        }
        const pick = (id) => {
            if (id !== draft.model) {
                draft.model = id;
                draft.openRouterPin = "";
            }
            done();
        };
        const list = modelsOf(profile);
        if (list.loading) {
            sec.append(T.h("div", { class: "empty-note", text: t("loadingModels") }));
            return;
        }
        if (list.failed) {
            sec.append(
                T.h("div", { class: "set-desc", text: list.error }),
                ...manualModelInput(draft.model, pick),
                C.actionRow(t("retry"), () => retryModels(profile, p.win)),
            );
            return;
        }
        sec.append(
            searchList({
                items: modelItems(profile, list.models),
                current: draft.model,
                placeholder: t("searchModels"),
                emptyText: t("noModels"),
                filter,
                onPick: pick,
            }),
        );
        if (!list.models.length) sec.append(...manualModelInput(draft.model, pick));
    }

    // 프리셋의 프로바이더 고르기. 바꾸면 그 프로바이더에서 쓸 수 없는 모델, 고정, 추론 깊이는 비운다.
    function buildProfilePick(sec, draft, done) {
        sec.append(
            searchList({
                items: profiles().map((p) => ({ value: p.uid, label: p.name, sub: profileStatus(p) })),
                current: draft.profile,
                placeholder: t("provider"),
                search: false,
                emptyText: "-",
                onPick(uid) {
                    if (uid !== draft.profile) {
                        draft.profile = uid;
                        const next = profileByUid(uid);
                        draft.model = next?.id === "github-copilot" ? "auto" : "";
                        draft.openRouterPin = "";
                        draft.autoModelCandidates = [];
                        if (!thinkingLevelsFor(next?.id).some((l) => l.value === draft.thinkingLevel)) draft.thinkingLevel = "";
                    }
                    done();
                },
            }),
        );
    }

    // 업스트림 프로바이더 고정. 별칭 모델(~…-latest)은 실제로 넘겨 받은 모델의 목록을 보여 준다.
    function buildPinPick(sec, { draft, filter, done, win }, profile) {
        sec.append(T.h("div", { class: "set-desc", text: t("openRouterPinDesc") }));
        const pins = pinsOf(profile, draft.model);
        if (pins.loading) {
            sec.append(T.h("div", { class: "empty-note", text: t("openRouterPinLoading") }));
            return;
        }
        if (pins.failed) {
            sec.append(
                T.h("div", { class: "empty-note", text: t("openRouterPinFailed") }),
                pins.error ? T.h("div", { class: "set-desc", text: pins.error }) : null,
                C.actionRow(t("openRouterPinRetry"), () => {
                    pinLists.delete(`${profile.uid}\n${draft.model}`);
                    win.rebuild();
                }),
            );
            return;
        }
        if (pins.alias) {
            sec.append(
                T.h("div", {
                    class: "set-desc",
                    text: pins.resolved ? t("openRouterPinAlias", { model: pins.resolved }) : t("openRouterPinAliasUnknown"),
                }),
            );
        }
        const items = [{ value: "", label: t("openRouterPinAuto"), sub: t("openRouterPinAutoDesc") }];
        if (draft.openRouterPin && !pins.providers.some((p) => p.tag === draft.openRouterPin)) {
            items.push({ value: draft.openRouterPin, label: draft.openRouterPin, sub: t("openRouterPinUnavailable") });
        }
        for (const p of pins.providers) items.push({ value: p.tag, label: p.name || p.tag, sub: p.tag });
        sec.append(
            searchList({
                items,
                current: draft.openRouterPin,
                placeholder: t("openRouterPinSearch"),
                emptyText: t("openRouterPinEmpty"),
                filter,
                onPick(tag) {
                    draft.openRouterPin = tag;
                    done();
                },
            }),
        );
    }

    /* ── 프로바이더(로그인과 키) ───────────────────────────── */
    // 키나 로그인이 없어 아직 쓸 수 없는지. 로그인 상태는 서버에 따로 물어야 해서 여기서는 키만 본다.
    function profileReady(profile) {
        return profile.apiKeySet || isOauthProfile(profile) || isCliProfile(profile);
    }

    // 목록에 적을 상태: 키가 필요한 프로바이더는 키 여부, 로그인하는 프로바이더는 종류.
    function profileStatus(profile) {
        let where = profile.label;
        if (profile.providerId === "custom" && profile.baseURL) {
            try {
                where = new URL(profile.baseURL).host;
            } catch {
                where = profile.baseURL;
            }
        }
        const parts = [where === profile.name ? "" : where];
        if (!isOauthProfile(profile) && !isCliProfile(profile)) parts.push(profile.apiKeySet ? t("apiKeyPresent") : t("apiKeyMissing"));
        return parts.filter(Boolean).join(", ");
    }

    function textInput(value, aria, placeholder = "") {
        const input = T.h("input", { class: "input", type: "text", value, placeholder, "aria-label": aria, spellcheck: "false" });
        input.addEventListener("keydown", (e) => e.stopPropagation());
        return input;
    }

    // API 키 행. 저장된 키가 있으면 값은 보여 주지 않고, 행을 눌렀을 때만 입력칸을 연다(editKey).
    // keyOpen: 저장된 키를 다시 입력하는 중인지(창이 들고 있다). 입력칸이 있으면 그 input을 같이 돌려준다(저장 버튼이 읽는다).
    function apiKeyRows(profile, meta, { keyOpen, editKey, onEnter }) {
        const rows = [];
        let input = null;
        if (profile.apiKeySet && !keyOpen) {
            rows.push(C.navRow(t("apiKey"), t("apiKeySaved"), editKey));
        } else {
            const keyRow = C.secretInput({
                placeholder: profile.apiKeySet ? "••••••••" : meta?.apiKeyOptional ? "" : "sk-…",
                aria: t("apiKey"),
                onEnter,
            });
            input = keyRow.querySelector("input");
            rows.push(C.labeledRow(t("apiKey"), keyRow));
        }
        if (meta?.keysUrl) {
            rows.push(T.h("a", { class: "key-hint", href: meta.keysUrl, target: "_blank", rel: "noopener noreferrer", text: `${t("getApiKey")} ↗` }));
        }
        return { rows, input };
    }

    // 프로바이더 편집 창 "s.profile:<uid>". 프리셋 편집과 같이 고친 것을 모았다가 위쪽 저장 버튼으로 한 번에 저장한다.
    // 로그인(OAuth, CLI)은 저장할 값이 아니라 바로 하는 동작이라 그 자리에서 진행한다.
    T.windows.define("s.profile", (uid) => {
        if (!uid) return null;
        let keyOpen = false; // 저장된 API 키를 다시 입력하는 중
        return {
            title: () => profileByUid(uid)?.name || t("provider"),
            on: ["settings"],
            // 다른 기기에서 지워졌다.
            gone: () => Boolean(state.state.settings && !profileByUid(uid)),
            onClose: leaveModels,
            build(body, win) {
                const profile = profileByUid(uid);
                if (!profile) {
                    body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
                    return;
                }
                const sec = T.h("div", { class: "set-section" });
                body.append(sec);
                buildProfileEditor(sec, win, profile, {
                    keyOpen,
                    editKey() {
                        keyOpen = true;
                        win.rebuild();
                    },
                });
            },
        };
    });

    function buildProfileEditor(sec, win, profile, key) {
        const meta = providerMeta(profile);
        const form = T.h("div", { class: "agent-editor" });
        const name = textInput(profile.name, t("profileName"));
        name.maxLength = 60;
        form.append(C.labeledRow(t("profileName"), name));
        const url =
            profile.providerId === "custom" || meta?.needsBaseURL
                ? textInput(profile.baseURL || "", t("baseURL"), "https://api.example.com/v1")
                : null;
        if (url) form.append(C.labeledRow(t("baseURL"), url));

        let keyRows = null;
        const save = () => saveProfile(win, profile, { name, url, key: keyRows?.input });
        if (isOauthProfile(profile)) form.append(T.h("hr", { class: "divider" }), C.oauthSection(profile.id));
        else if (isCliProfile(profile)) form.append(T.h("hr", { class: "divider" }), C.cliLoginSection());
        else {
            keyRows = apiKeyRows(profile, meta, { ...key, onEnter: save });
            form.append(...keyRows.rows);
        }
        for (const el of [name, url]) {
            el?.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) void save();
            });
        }
        sec.append(form);

        sec.append(T.h("hr", { class: "divider" }));
        if (profile.presets) sec.append(T.h("div", { class: "set-desc", text: t("profileUsedBy", { n: profile.presets }) }));
        const del = C.actionRow(t("delete"), () => deleteProfile(win, profile), { danger: true, own: true });
        // 이 프로바이더를 쓰는 프리셋이 있으면 지울 수 없다.
        del.row.disabled = profile.presets > 0 || profiles().length <= 1;
        sec.append(del);

        C.headAction(t("save"), save);
        C.trackForm(form);
    }

    async function saveProfile(win, profile, { name, url, key }) {
        const body = {};
        const n = name.value.trim();
        // 비우면 서버가 프로바이더 이름으로 되돌린다.
        if (n !== profile.name) body.name = n;
        const provider = {};
        if (url && url.value.trim() !== (profile.baseURL || "")) provider.baseURL = url.value.trim();
        const apiKey = key?.value.trim() || "";
        if (apiKey) provider.apiKey = apiKey;
        if (Object.keys(provider).length) body.provider = provider;
        if (!Object.keys(body).length) return;
        if (!(await request(() => T.api.updateProviderProfile(profile.uid, body)))) return;
        // 프리셋 편집과 같이 저장하면 창을 닫는다.
        if (apiKey) T.toast.show("info", t("apiKeySavedToast"));
        void win.close({ force: true });
    }

    async function deleteProfile(win, profile) {
        if (!(await C.confirmDelete(profile.name))) return;
        if (!(await request(() => T.api.deleteProviderProfile(profile.uid)))) return;
        void win.close({ force: true });
    }

    // 프로바이더 추가 창: 고르면 그 프로바이더를 만들고 이 창 자리에 그 편집 창(로그인이나 키)을 연다.
    T.windows.define("s.profile-add", (arg) =>
        arg == null
            ? {
                  title: () => t("addProvider"),
                  on: ["settings"],
                  onClose: leaveModels,
                  build(body, win) {
                      const sec = T.h("div", { class: "set-section" });
                      body.append(sec);
                      sec.append(T.h("div", { class: "set-desc", text: t("addProviderDesc") }));
                      let busy = false;
                      for (const p of settings().providers || []) {
                          sec.append(
                              C.navRow(p.label || p.id, "", async () => {
                                  if (busy) return;
                                  busy = true;
                                  const s = await request(() => T.api.addProviderProfile(p.id));
                                  busy = false;
                                  if (s?.createdProfile) win.replace(`s.profile:${s.createdProfile}`);
                              }),
                          );
                      }
                  },
              }
            : null,
    );

    // 고급 설정 창.
    T.windows.define("s.adv", (arg) =>
        arg == null
            ? {
                  title: () => t("advanced"),
                  on: ["settings"],
                  build(body) {
                      const s = state.state.settings;
                      if (!s) {
                          body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
                          return;
                      }
                      const sec = T.h("div", { class: "set-section" });
                      body.append(sec);
                      C.buildModelAdvanced(sec, s);
                  },
              }
            : null,
    );

    /* ── 탭 첫 화면 ───────────────────────────────────────── */
    function presetRows(sec, win) {
        sec.append(C.fieldLabel(t("modelPresets")), T.h("div", { class: "set-desc", text: t("modelPresetsDesc") }));
        for (const p of presets()) {
            sec.append(
                C.itemRow({
                    name: presetName(p),
                    badge: p.isDefault ? t("presetDefaultBadge") : "",
                    sub: presetSummary(p),
                    onclick: () => win.open(`s.preset:${p.uid}`),
                }),
            );
        }
        sec.append(C.actionRow(t("addPreset"), () => win.open("s.preset:new"), { icon: "plus" }));
    }

    function profileRows(sec, win) {
        sec.append(C.fieldLabel(t("providers")), T.h("div", { class: "set-desc", text: t("providersDesc") }));
        for (const p of profiles()) {
            sec.append(
                C.itemRow({
                    name: p.name,
                    sub: profileStatus(p),
                    onclick: () => win.open(`s.profile:${p.uid}`),
                }),
            );
        }
        sec.append(C.actionRow(t("addProvider"), () => win.open("s.profile-add"), { icon: "plus" }));
    }

    C.defineTab("model", {
        onClose: leaveModels,
        build(body, win) {
            const s = state.state.settings;
            if (!s || !(s.providers || []).length) {
                body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
                return;
            }
            const sec = T.h("div", { class: "set-section" });
            body.append(sec);
            presetRows(sec, win);
            sec.append(T.h("hr", { class: "divider" }));
            profileRows(sec, win);
            sec.append(
                T.h("hr", { class: "divider" }),
                C.navRow(t("advanced"), "", () => win.open("s.adv")),
            );
        },
    });

    C.modelPresets = presets;
    C.modelPresetByUid = presetByUid;
    C.defaultModelPreset = defaultPreset;
    C.modelPresetName = presetName;
    C.modelPresetSummary = presetSummary;
    C.modelsOf = modelsOf;
    C.modelsReady = modelsReady;
    C.forgetModelLists = forgetModelLists;
})(window.Taby);
