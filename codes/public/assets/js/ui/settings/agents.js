/* tabyBot 웹 클라이언트: 설정 > 에이전트 편집 창("s.agent:<id>", 새 에이전트는 "s.agent:new"). */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    function agentById(id) {
        return C.agentList().find((a) => a.id === id) || null;
    }

    // "new"는 새 에이전트다. 만들면 그 에이전트의 채팅으로 가고, 지우면 창을 닫는다.
    T.windows.define("s.agent", (arg) => {
        if (!arg) return null;
        const id = arg === "new" ? null : arg;
        return {
            title: () => (id == null ? t("addAgent") : agentById(id)?.name || t("agents")),
            on: ["bots", "settings"],
            gone: () => id != null && !agentById(id),
            build(body, win) {
                const agent = id == null ? null : agentById(id);
                if (id != null && !agent) return;
                const editor = agentEditor(
                    agent,
                    {
                        saveLabel: agent ? t("save") : t("create"),
                        onSaved(saved) {
                            if (!agent && saved?.uuid) {
                                void win.close({ force: true, instant: true });
                                T.util.pushUrl(`/a/${encodeURIComponent(saved.uuid)}`);
                                T.app?.renderRoute();
                                return;
                            }
                            win.rebuild();
                        },
                        onDeleted: () => void win.close({ force: true }),
                    },
                    win,
                );
                body.append(editor);
            },
        };
    });

    // 저장 실패 사유 코드 → 사용자에게 보일 문구 키.
    const SAVE_ERROR_KEYS = {
        name_required: "nameRequired",
        name_too_long: "nameTooLong",
        persona_too_long: "personaTooLong",
        model_too_long: "modelTooLong",
        invalid_thinking_level: "invalidThinkingLevel",
        invalid_color: "invalidColor",
        invalid_model_preset: "invalidModelPreset",
        too_many: "lastBotTooltip",
    };

    const DEFAULT_PALETTE = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#32d74b", "#64d2ff"];

    // 예전 모델 오버라이드를 그대로 두는 선택지(프리셋이 생기기 전에 모델을 따로 고른 에이전트).
    const LEGACY = "__legacy__";

    // 모델 프리셋 고르기. 비워 두면 기본 프리셋을 쓴다.
    function buildPresetPicker(agent) {
        const def = C.defaultModelPreset();
        const options = [
            { value: "", label: t("agentInherit") + (def ? ` (${C.modelPresetName(def)})` : "") },
            ...C.modelPresets().map((p) => ({ value: p.uid, label: C.modelPresetName(p) })),
        ];
        let current = agent?.modelPreset && C.modelPresetByUid(agent.modelPreset) ? agent.modelPreset : "";
        const legacy = !current && (agent?.model || agent?.thinkingLevel);
        if (legacy) {
            options.push({ value: LEGACY, label: t("agentLegacyModel", { model: agent.model || agent.thinkingLevel }) });
            current = LEGACY;
        }
        const select = C.editorSelect(options, current, t("modelPreset"));
        return {
            rows: [C.labeledRow(t("modelPreset"), C.selectWrap(select)), T.h("div", { class: "set-desc", text: t("agentPresetDesc") })],
            // 프리셋을 고르면 예전 모델 오버라이드는 지운다.
            values: () => (select.value === LEGACY ? {} : { modelPreset: select.value, model: "", thinkingLevel: "" }),
        };
    }

    // 아바타 색상 고르기. "자동"이면 id 해시로 정한다. value()는 고른 색(자동이면 "").
    function buildColorPicker(agent, settings) {
        let choice = agent?.colorChoice || "";
        const palette = Array.isArray(settings.agentColors) && settings.agentColors.length ? settings.agentColors : DEFAULT_PALETTE;
        const swatches = T.h("div", { class: "agent-colors" });
        const sync = () => {
            for (const el of swatches.querySelectorAll(".color-swatch")) {
                const on = (el.dataset.color || "") === choice;
                el.classList.toggle("selected", on);
                el.setAttribute("aria-pressed", String(on));
            }
        };
        const swatch = (color, attrs) =>
            T.h("button", {
                type: "button",
                dataset: { color },
                "aria-pressed": "false",
                onclick() {
                    choice = color;
                    sync();
                },
                ...attrs,
            });
        swatches.append(swatch("", { class: "color-swatch auto", text: t("agentColorAuto") }));
        for (const color of palette) swatches.append(swatch(color, { class: "color-swatch", style: `background:${color}`, "aria-label": color }));
        sync();
        return { row: C.labeledRow(t("agentColor"), swatches), value: () => choice };
    }

    // 페르소나 칸: 머리말이 붙은 입력란 하나. 선택 사항이다.
    function buildPersonaSection(agent) {
        const persona = T.h("textarea", { class: "textarea", placeholder: t("personaPlaceholder"), "aria-label": t("persona") });
        persona.value = agent ? agent.persona || "" : "";
        persona.addEventListener("keydown", (e) => e.stopPropagation());
        return { persona, nodes: [T.h("hr", { class: "divider" }), C.fieldOf(t("persona"), persona, t("personaDesc"))] };
    }

    // 백그라운드 작업(자동 체크인, 세션 리뷰, 드림 스윕) 한 번에 끄기. 저장할 때 값을 읽는다.
    function buildBackgroundSwitch(agent) {
        const sw = C.switchEl(
            agent ? agent.backgroundTasks !== false : true,
            () => {
                // 저장 버튼을 누를 때 읽는다
            },
            t("agentBackground"),
        );
        const input = sw.querySelector("input");
        return {
            nodes: [
                T.h("hr", { class: "divider" }),
                C.labeledRow(t("agentBackground"), sw),
                T.h("div", { class: "set-desc", text: t("agentBackgroundDesc") }),
            ],
            value: () => input.checked,
        };
    }

    function saveErrorMessage(err) {
        const key = SAVE_ERROR_KEYS[err?.payload?.error || ""];
        return key ? `${t("saveFailed")}: ${t(key)}` : T.api.errorText(err, t("saveFailed"));
    }

    // 저장하고 받은 목록을 반영한 뒤 host.onSaved(저장된 에이전트)로 다음 화면을 정한다. photo: 프로필 사진 고르기(C.avatarPicker).
    async function saveAgent(agent, body, host, photo) {
        try {
            let r = agent ? await T.api.updateAgent(agent.id, body) : await T.api.createAgent(body);
            const saved = r?.agent || agent;
            // 사진은 에이전트가 생긴 뒤에 uuid로 올린다. 응답은 사진 버전이 실린 같은 모양의 스냅샷이다.
            // 사진만 실패하면 알리고 나머지 저장은 그대로 이어 간다(새 에이전트를 두 번 만들지 않게).
            try {
                const withPhoto = await photo.commit(saved?.uuid);
                if (withPhoto) r = { ...withPhoto, agent: withPhoto.agents?.find((a) => a.uuid === saved.uuid) || saved };
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("avatarSaveFailed")));
            }
            // 저장한 상태로 다시 그린다.
            if (r && Array.isArray(r.agents)) {
                state.mergeSettingsLocal({ agents: r.agents });
                state.applyAgents(r);
            } else {
                const settings = await T.api.getSettings();
                if (settings) state.setSettings(settings);
                await C.refreshBots();
            }
            host.onSaved(r?.agent || agent);
        } catch (err) {
            T.toast.show("error", saveErrorMessage(err));
        }
    }

    function deleteAgent(agent, host) {
        T.api
            .deleteAgent(agent.id)
            .then((r) => {
                const agents = r && Array.isArray(r.agents) ? r.agents : [];
                state.mergeSettingsLocal({ agents });
                state.applyAgents(r || {});
                if (state.state.currentId === agent.uuid) {
                    const next = agents[0];
                    if (next && T.chat) T.chat.open(next.uuid);
                    else if (T.chat) T.chat.open(null);
                }
                host.onDeleted();
            })
            .catch((err) => {
                T.toast.show("error", err?.status === 400 ? t("lastBotTooltip") : T.api.errorText(err, t("saveFailed")));
            });
    }

    // host: 저장, 삭제 뒤의 동작. { saveLabel, onSaved(agent), onDeleted() }
    // win: 이 편집 화면을 담은 창. 사진 행을 누르면 그 오른쪽에 사진 창("photo:<win.id>")이 열린다.
    // 돌려주는 편집 화면에는 photo(사진 고르기)와 changed(고친 것이 있는지)가 달려 있다.
    function agentEditor(agent, host, win) {
        const isNew = !agent;
        const settings = state.state.settings || {};
        const editor = T.h("div", { class: "agent-editor" });

        const name = T.h("input", { class: "input", type: "text", value: agent ? agent.name || "" : "", "aria-label": t("agentName") });
        name.addEventListener("keydown", (e) => e.stopPropagation());
        editor.append(C.labeledRow(t("agentName"), name));

        const presetPicker = buildPresetPicker(agent);
        editor.append(...presetPicker.rows);
        // 사진과 색상은 아바타를 정하는 한 묶음이다. 사진 행을 누르면 사진 창이 열린다.
        const photo = C.avatarPicker(agent, () => win.open(`photo:${win.id}`));
        win.photoPicker = photo;
        editor.append(photo.row);
        const colorPicker = buildColorPicker(agent, settings);
        editor.append(colorPicker.row);
        const personaSection = buildPersonaSection(agent);
        editor.append(...personaSection.nodes);
        const backgroundSwitch = buildBackgroundSwitch(agent);
        editor.append(...backgroundSwitch.nodes);
        const label = host.saveLabel || t("save");
        const save = async () => {
            const n = name.value.trim();
            if (!n) {
                name.focus();
                return;
            }
            const body = {
                name: n,
                persona: personaSection.persona.value,
                color: colorPicker.value(),
                backgroundTasks: backgroundSwitch.value(),
                ...presetPicker.values(),
            };
            await saveAgent(agent, body, host, photo);
        };
        C.headAction(label, save);

        // 마지막으로 남은 봇은 삭제할 수 없다.
        const botsCount = state.state.bots?.length || (state.state.settings?.agents?.length ?? 0);
        if (!isNew) {
            const del = C.actionRow(
                t("delete"),
                async () => {
                    if (await C.confirmDelete(agent.name)) deleteAgent(agent, host);
                },
                { danger: true, own: true },
            );
            editor.append(del);
            if (botsCount <= 1) {
                del.row.disabled = true;
                editor.append(T.h("div", { class: "set-desc", text: t("lastBotTooltip") }));
            }
        }

        const changed = C.trackForm(editor, () => `${colorPicker.value()}|${photo.value()}`);
        editor.photo = photo;
        editor.changed = changed;
        return editor;
    }

    C.agentEditor = agentEditor;
})(window.Taby);
