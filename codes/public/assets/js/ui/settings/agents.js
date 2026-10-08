/* tabyBot 웹 클라이언트: 설정 > 에이전트 편집. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.advOpen = null; // 에이전트 편집기의 고급 설정 펼침. null이면 페르소나 유무로 초기화

    function buildAgents(body) {
        if (C.editingAgent === "__new__") {
            body.append(agentEditor(null));
            return;
        }
        const agent = C.agentList().find((a) => a.id === C.editingAgent);
        if (!agent) {
            body.append(T.h("div", { class: "empty-note", text: "-" }));
            return;
        }
        body.append(agentEditor(agent));
    }

    // 저장 실패 사유 코드 → 사용자에게 보일 문구 키.
    const SAVE_ERROR_KEYS = {
        name_required: "nameRequired",
        name_too_long: "nameTooLong",
        persona_too_long: "personaTooLong",
        model_too_long: "modelTooLong",
        invalid_thinking_level: "invalidThinkingLevel",
        invalid_color: "invalidColor",
        too_many: "lastBotTooltip",
    };

    const DEFAULT_PALETTE = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#32d74b", "#64d2ff"];

    // "비워 두면 전역 값을 쓴다"는 선택 상자: 첫 항목이 전역 값을 보여 준다.
    function inheritSelect({ label, options, globalLabel, current }) {
        const opts = [{ value: "", label: t("agentInherit") + (globalLabel ? ` (${globalLabel})` : "") }, ...options];
        const select = C.editorSelect(C.presetOptions(opts, current, current), current, label);
        return { select, row: C.labeledRow(label, C.selectWrap(select)) };
    }

    // 모델 선택. 목록은 모델 탭과 같은 캐시(modelsCache)를 쓴다.
    function buildModelPicker(agent, provider) {
        const key = C.modelsKey(provider);
        const cacheReady = C.modelsCache && C.modelsCache.key === key;
        if (!cacheReady && !C.modelsLoading && C.modelsFailedKey !== key) void C.loadModels(provider);
        const models = cacheReady ? C.modelsCache.models : [];
        const globalLabel = models.find((m) => m.id === provider.model)?.label || provider.model;
        return inheritSelect({
            label: t("model"),
            options: models.map((m) => ({ value: m.id, label: m.label || m.id })),
            globalLabel,
            current: agent?.model || "",
        });
    }

    // 사고 수준 선택. 서버가 수준 목록을 주지 않으면 null.
    function buildThinkingPicker(agent, settings) {
        const levels = settings.thinkingLevels;
        if (!Array.isArray(levels) || !levels.length) return null;
        const globalLabel = levels.find((l) => l.value === settings.thinkingLevel)?.label || settings.thinkingLevel;
        return inheritSelect({
            label: t("thinkingLevel"),
            options: levels.map((l) => ({ value: l.value, label: l.label || l.value })),
            globalLabel,
            current: agent?.thinkingLevel || "",
        });
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

    // 고급 설정(페르소나)을 접고 펼치는 영역. 페르소나는 선택 사항이다.
    function buildPersonaSection(agent) {
        if (C.advOpen === null) C.advOpen = Boolean(agent?.persona?.trim());
        const persona = T.h("textarea", { class: "textarea", placeholder: t("personaPlaceholder"), "aria-label": t("persona") });
        persona.value = agent ? agent.persona || "" : "";
        persona.addEventListener("keydown", (e) => e.stopPropagation());
        const panel = T.h("div", { class: "adv-panel" }, [
            C.fieldLabel(t("persona")),
            persona,
            T.h("div", { class: "set-desc", text: t("personaDesc") }),
        ]);
        panel.hidden = !C.advOpen;
        const toggle = T.h(
            "button",
            {
                type: "button",
                class: "adv-toggle",
                "aria-expanded": String(C.advOpen),
                onclick() {
                    C.advOpen = !C.advOpen;
                    toggle.setAttribute("aria-expanded", String(C.advOpen));
                    panel.hidden = !C.advOpen;
                },
            },
            [T.icon("chevron", "icon-sm"), T.h("span", { text: t("advanced") })],
        );
        return { persona, nodes: [T.h("hr", { class: "divider" }), toggle, panel] };
    }

    function saveErrorMessage(err) {
        const key = SAVE_ERROR_KEYS[err?.payload?.error || ""];
        return key ? `${t("saveFailed")}: ${t(key)}` : T.api.errorText(err, t("saveFailed"));
    }

    // 저장하고 화면을 맞춘다. 새 에이전트는 설정에 머물지 않고 그 에이전트의 채팅으로 바로 이동한다.
    async function saveAgent({ agent, body, saveBtn }) {
        saveBtn.disabled = true;
        try {
            const r = agent ? await T.api.updateAgent(agent.id, body) : await T.api.createAgent(body);
            if (r && Array.isArray(r.agents)) {
                state.mergeSettingsLocal({ agents: r.agents });
                state.applyAgents(r);
            } else {
                const settings = await T.api.getSettings();
                if (settings) state.setSettings(settings);
                await C.refreshBots();
            }
            if (!agent && r?.agent?.uuid) {
                T.util.pushUrl(`/a/${encodeURIComponent(r.agent.uuid)}`);
                T.app?.renderRoute();
                return;
            }
            C.editingAgent = agent?.id || C.firstAgentId();
            C.syncPath();
            C.build();
        } catch (err) {
            saveBtn.disabled = false;
            T.toast.show("error", saveErrorMessage(err));
        }
    }

    function deleteAgent(agent, delBtn) {
        delBtn.disabled = true;
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
                C.editingAgent = agents[0]?.id || "__new__";
                C.syncPath();
                C.build();
            })
            .catch((err) => {
                delBtn.disabled = false;
                T.toast.show("error", err?.status === 400 ? t("lastBotTooltip") : T.api.errorText(err, t("saveFailed")));
            });
    }

    function agentEditor(agent) {
        const isNew = !agent;
        const settings = state.state.settings || {};
        const editor = T.h("div", { class: "agent-editor" });

        const name = T.h("input", { class: "input", type: "text", value: agent ? agent.name || "" : "", "aria-label": t("agentName") });
        name.addEventListener("keydown", (e) => e.stopPropagation());
        editor.append(C.labeledRow(t("agentName"), name));

        const modelPicker = buildModelPicker(agent, settings.provider || {});
        editor.append(modelPicker.row);
        const thinkingPicker = buildThinkingPicker(agent, settings);
        if (thinkingPicker) editor.append(thinkingPicker.row);
        const colorPicker = buildColorPicker(agent, settings);
        editor.append(colorPicker.row);
        const personaSection = buildPersonaSection(agent);
        editor.append(...personaSection.nodes);

        const actions = T.h("div", { class: "editor-actions" });
        const saveBtn = T.h("button", {
            class: "btn primary",
            text: t("save"),
            onclick() {
                const n = name.value.trim();
                if (!n) {
                    name.focus();
                    return;
                }
                const body = { name: n, persona: personaSection.persona.value, model: modelPicker.select.value, color: colorPicker.value() };
                if (thinkingPicker) body.thinkingLevel = thinkingPicker.select.value;
                void saveAgent({ agent, body, saveBtn });
            },
        });
        actions.append(saveBtn);

        // 마지막으로 남은 봇은 삭제할 수 없다.
        const botsCount = state.state.bots?.length || (state.state.settings?.agents?.length ?? 0);
        if (!isNew && botsCount > 1) {
            const delBtn = T.h("button", {
                type: "button",
                class: "btn ghost",
                text: t("delete"),
                async onclick() {
                    if (await C.confirmDelete(agent.name)) deleteAgent(agent, delBtn);
                },
            });
            actions.append(delBtn);
        } else if (!isNew) {
            actions.append(T.h("span", { class: "set-desc", text: t("lastBotTooltip") }));
        }

        editor.append(actions);
        return editor;
    }

    C.buildAgents = buildAgents;
})(window.Taby);
