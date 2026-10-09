/* tabyBot 웹 클라이언트: 설정 > 스킬 / MCP 탭. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    C.skillsCache = null; // GET /api/skills 응답의 skills 배열

    C.skillsLoading = false;

    C.skillsFailed = false;

    C.mcpCache = null; // GET /api/mcp 응답의 servers 배열

    C.mcpLoading = false;

    C.mcpFailed = false;

    C.skillEditing = null; // { mode:"new" } | { mode:"edit"|"view", name, source, builtin, content }

    C.mcpEditing = null; // { mode:"new" } | { mode:"edit", name }

    /* ── 스킬 / MCP 탭 ────────────────────────────────────── */
    async function loadSkillsList() {
        if (C.skillsLoading) return;
        C.skillsLoading = true;
        try {
            const r = await T.api.skills();
            C.skillsCache = r && Array.isArray(r.skills) ? r.skills : [];
            C.skillsFailed = false;
        } catch (err) {
            C.skillsCache = [];
            C.skillsFailed = true;
            T.toast.show("error", T.api.errorText(err, t("loadFailed")));
        } finally {
            C.skillsLoading = false;
            if (C.openTab === "skills") C.rebuildIfIdle();
        }
    }

    async function loadMcpList() {
        if (C.mcpLoading) return;
        C.mcpLoading = true;
        try {
            const r = await T.api.mcpServers();
            C.mcpCache = r && Array.isArray(r.servers) ? r.servers : [];
            C.mcpFailed = false;
        } catch (err) {
            C.mcpCache = [];
            C.mcpFailed = true;
            T.toast.show("error", T.api.errorText(err, t("loadFailed")));
        } finally {
            C.mcpLoading = false;
            if (C.openTab === "mcp") C.rebuildIfIdle();
        }
    }

    function skillSourceLabel(source) {
        if (source === "system") return t("skillBuiltin");
        if (source === "shared") return t("skillShared");
        return t("skillUser");
    }

    // 확인을 받고 지운다. 지운 스킬의 편집 화면이 열려 있었으면 같이 닫는다.
    async function deleteSkill(sk) {
        if (!(await C.confirmDelete(sk.name))) return;
        try {
            const r = await T.api.deleteSkill(sk.name, sk.source);
            C.skillsCache = r && Array.isArray(r.skills) ? r.skills : [];
            if (C.skillEditing?.name === sk.name && C.skillEditing.source === sk.source) C.skillEditing = null;
            C.build();
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function skillRow(sk) {
        return C.itemRow({
            name: sk.name,
            badge: skillSourceLabel(sk.source),
            sub: sk.summary,
            // 행을 누르면 내용을 받아 온 뒤 연다. 시스템 스킬은 읽기 전용으로만 열린다.
            onclick: () =>
                C.openForm(async () => {
                    try {
                        const r = await T.api.skill(sk.name, sk.source);
                        C.skillEditing = {
                            mode: r.builtin ? "view" : "edit",
                            name: r.name,
                            source: r.source,
                            builtin: !!r.builtin,
                            content: r.content || "",
                        };
                    } catch (err) {
                        T.toast.show("error", T.api.errorText(err, t("loadFailed")));
                    }
                }),
            menu: sk.builtin ? null : () => [{ label: t("delete"), danger: true, defer: true, onSelect: () => deleteSkill(sk) }],
        });
    }

    function skillForm() {
        const editing = C.skillEditing;
        const isNew = editing.mode === "new";
        const readonly = editing.mode === "view" || editing.builtin === true;
        const form = T.h("div", { class: "agent-editor" });

        const nameInput = T.h("input", {
            class: "input",
            type: "text",
            value: isNew ? "" : editing.name,
            placeholder: "my-skill",
            "aria-label": t("skillName"),
        });
        if (!isNew) nameInput.disabled = true;
        nameInput.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf(t("skillName"), nameInput, isNew ? t("skillNameDesc") : null));

        const content = T.h("textarea", {
            class: "textarea skill-md",
            placeholder: "---\ndescription: What this skill does\n---\n",
            "aria-label": t("skillContent"),
            spellcheck: "false",
        });
        content.value = isNew ? "" : editing.content || "";
        if (readonly) content.readOnly = true;
        content.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf("SKILL.md", content, readonly ? t("skillReadOnly") : null));

        // 읽기 전용 스킬에는 저장할 것이 없다. 뒤로 버튼으로 닫는다.
        if (readonly) return form;
        C.headAction(t("save"), async () => {
            const n = nameInput.value.trim();
            const c = content.value;
            if (!n || !c.trim()) {
                if (!n) nameInput.focus();
                else content.focus();
                return;
            }
            try {
                const r = isNew
                    ? await T.api.createSkill({ name: n, content: c })
                    : await T.api.updateSkill(editing.name, { source: editing.source, content: c });
                C.skillsCache = r && Array.isArray(r.skills) ? r.skills : [];
                C.skillEditing = null;
                C.build();
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteSkill(editing), { danger: true, own: true }));
        C.trackForm(form);
        return form;
    }

    function mcpStatusLabel(srv) {
        const st = srv.status || {};
        if (st.connected) return t("mcpConnected", { n: st.tools ?? 0 });
        if (st.failed) return t("mcpFailed");
        return t("mcpPending");
    }

    // 확인을 받고 지운다. 지운 서버의 편집 화면이 열려 있었으면 같이 닫는다.
    async function deleteMcp(srv) {
        if (!(await C.confirmDelete(srv.name))) return;
        try {
            const r = await T.api.deleteMcpServer(srv.name);
            C.mcpCache = r && Array.isArray(r.servers) ? r.servers : [];
            if (C.mcpEditing?.name === srv.name) C.mcpEditing = null;
            C.build();
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function mcpRow(srv) {
        const st = srv.status || {};
        return C.itemRow({
            name: srv.name,
            badge: mcpStatusLabel(srv),
            badgeClass: st.connected ? "ok" : st.failed ? "bad" : "",
            sub: [srv.command, ...(srv.args || [])].filter(Boolean).join(" "),
            subMono: true,
            onclick: () =>
                C.openForm(() => {
                    C.mcpEditing = { mode: "edit", name: srv.name };
                }),
            menu: () => [{ label: t("delete"), danger: true, defer: true, onSelect: () => deleteMcp(srv) }],
        });
    }

    function mcpForm() {
        const editing = C.mcpEditing;
        const isNew = editing.mode === "new";
        const srv = isNew ? null : (C.mcpCache || []).find((x) => x.name === editing.name) || { name: editing.name };
        const form = T.h("div", { class: "agent-editor" });

        const nameInput = T.h("input", {
            class: "input",
            type: "text",
            value: srv?.name || "",
            placeholder: "my-server",
            "aria-label": t("mcpName"),
        });
        if (!isNew) nameInput.disabled = true;
        nameInput.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf(t("mcpName"), nameInput, isNew ? t("mcpNameDesc") : null));

        const cmdInput = T.h("input", {
            class: "input",
            type: "text",
            value: srv?.command || "",
            placeholder: "npx / uvx / node …",
            "aria-label": t("mcpCommand"),
        });
        cmdInput.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf(t("mcpCommand"), cmdInput, t("mcpCommandDesc")));

        const argsInput = T.h("textarea", {
            class: "textarea mcp-args",
            "aria-label": t("mcpArgs"),
            placeholder: "-y\n@scope/mcp-server",
            spellcheck: "false",
        });
        argsInput.value = (srv?.args || []).join("\n");
        argsInput.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf(t("mcpArgs"), argsInput, t("mcpArgsDesc")));

        // env 값은 서버가 내려주지 않는다(비밀): 기존 키는 빈 값이면 유지, 새 값이면 교체, ✕면 삭제.
        const removedKeys = new Set();
        const envList = T.h("div", { class: "env-list" });
        function envRow(key, existing) {
            const keyInput = T.h("input", {
                class: "input env-key",
                type: "text",
                value: key || "",
                placeholder: t("mcpEnvKey"),
                "aria-label": t("mcpEnvKey"),
            });
            if (existing) keyInput.disabled = true;
            keyInput.addEventListener("keydown", (e) => e.stopPropagation());
            const valInput = T.h("input", {
                class: "input env-val",
                type: existing ? "password" : "text",
                value: "",
                placeholder: existing ? t("mcpEnvKeep") : t("mcpEnvValue"),
                "aria-label": t("mcpEnvValue"),
            });
            valInput.addEventListener("keydown", (e) => e.stopPropagation());
            const row = T.h("div", { class: "env-row", dataset: { key: key || "", existing: existing ? "1" : "" } }, [
                keyInput,
                valInput,
                T.h(
                    "button",
                    {
                        class: "btn-icon btn-xs danger",
                        type: "button",
                        "aria-label": t("mcpEnvDelete"),
                        onclick() {
                            row.remove();
                            if (existing && key) removedKeys.add(key);
                        },
                    },
                    [T.icon("x")],
                ),
            ]);
            return row;
        }
        for (const k of srv?.envKeys || []) envList.append(envRow(k, true));
        const envField = T.h("div", { class: "field" }, [
            C.fieldLabel(t("mcpEnv")),
            envList,
            C.actionRow(
                t("mcpAddEnv"),
                () => {
                    const row = envRow("", false);
                    envList.append(row);
                    row.querySelector(".env-key")?.focus();
                },
                { icon: "plus", own: true },
            ),
            T.h("div", { class: "set-desc", text: isNew ? t("mcpEnvDesc") : t("mcpEnvKeepDesc") }),
        ]);
        form.append(envField);

        C.headAction(t("save"), async () => {
            const n = nameInput.value.trim();
            const command = cmdInput.value.trim();
            if (!n || !command) {
                if (!n) nameInput.focus();
                else cmdInput.focus();
                return;
            }
            const args = argsInput.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
            const env = {};
            for (const k of removedKeys) env[k] = null;
            for (const row of envList.querySelectorAll(".env-row")) {
                const key = row.querySelector(".env-key").value.trim();
                const val = row.querySelector(".env-val").value;
                if (!key) continue;
                // 기존 키의 빈 값은 "유지"다. 새 키만 빈 값 그대로 저장한다.
                if (row.dataset.existing) {
                    if (val !== "") env[key] = val;
                } else env[key] = val;
            }
            try {
                const r = isNew
                    ? await T.api.createMcpServer({ name: n, command, args, env })
                    : await T.api.updateMcpServer(editing.name, { command, args, env });
                C.mcpCache = r && Array.isArray(r.servers) ? r.servers : [];
                C.mcpEditing = null;
                C.build();
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteMcp(srv), { danger: true, own: true }));
        // 환경 변수 행을 지운 것도 바뀐 것으로 친다(행 수가 처음과 달라진다).
        C.trackForm(form);
        return form;
    }

    function buildSkills(body) {
        if (C.skillsCache === null && !C.skillsLoading && !C.skillsFailed) void loadSkillsList();
        const ssec = T.h("div", { class: "set-section" });
        if (!C.skillEditing) ssec.append(T.h("div", { class: "set-desc", text: t("skillsDesc") }));
        if (C.skillEditing) {
            ssec.append(skillForm());
        } else {
            if (C.skillsCache === null) ssec.append(T.h("div", { class: "set-desc", text: t("loading") }));
            else if (!C.skillsCache.length) ssec.append(T.h("div", { class: "set-desc", text: t("skillsEmpty") }));
            else for (const sk of C.skillsCache) ssec.append(skillRow(sk));
            ssec.append(
                C.actionRow(
                    t("addSkill"),
                    () =>
                        C.openForm(() => {
                            C.skillEditing = { mode: "new" };
                        }),
                    { icon: "plus" },
                ),
            );
        }
        body.append(ssec);
    }

    function buildMcp(body) {
        if (C.mcpCache === null && !C.mcpLoading && !C.mcpFailed) void loadMcpList();
        const msec = T.h("div", { class: "set-section" });
        if (!C.mcpEditing) msec.append(T.h("div", { class: "set-desc", text: t("mcpDesc") }));
        if (C.mcpEditing) {
            msec.append(mcpForm());
        } else {
            if (C.mcpCache === null) msec.append(T.h("div", { class: "set-desc", text: t("loading") }));
            else if (!C.mcpCache.length) msec.append(T.h("div", { class: "set-desc", text: t("mcpEmpty") }));
            else for (const srv of C.mcpCache) msec.append(mcpRow(srv));
            msec.append(
                C.actionRow(
                    t("addMcpServer"),
                    () =>
                        C.openForm(() => {
                            C.mcpEditing = { mode: "new" };
                        }),
                    { icon: "plus" },
                ),
            );
        }
        body.append(msec);
    }

    C.buildSkills = buildSkills;
    C.buildMcp = buildMcp;
})(window.Taby);
