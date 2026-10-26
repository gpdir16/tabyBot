/* tabyBot 웹 클라이언트: 설정 > 스킬 / MCP 탭.
   창: "s.skills"(목록), "s.skill:new", "s.skill:<source>/<name>"(편집, 시스템 스킬은 읽기 전용),
       "s.mcp"(목록), "s.mcp:new", "s.mcp:<name>"(편집). */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    const SKILL_SOURCES = ["system", "user", "shared"];

    let skillsCache = null; // GET /api/skills 응답의 skills 배열
    let skillsLoading = false;
    let skillsFailed = false;
    let mcpCache = null; // GET /api/mcp 응답의 servers 배열
    let mcpLoading = false;
    let mcpFailed = false;

    const isSkillWin = (w) => w.kind === "s.skills" || w.kind === "s.skill";
    const isMcpWin = (w) => w.kind === "s.mcp";

    // 그 무리의 창이 모두 닫히면 받아 둔 목록을 버린다(다시 열면 새로 받는다).
    function leaveSkills() {
        if (!C.noneOpen(isSkillWin)) return;
        skillsCache = null;
        skillsLoading = false;
        skillsFailed = false;
    }

    function leaveMcp() {
        if (!C.noneOpen(isMcpWin)) return;
        mcpCache = null;
        mcpLoading = false;
        mcpFailed = false;
    }

    /* ── 목록 받기 ──────────────────────────────────────────── */
    async function loadSkillsList() {
        if (skillsLoading) return;
        skillsLoading = true;
        try {
            const r = await T.api.skills();
            skillsCache = r && Array.isArray(r.skills) ? r.skills : [];
            skillsFailed = false;
        } catch (err) {
            skillsCache = [];
            skillsFailed = true;
            T.toast.show("error", T.api.errorText(err, t("loadFailed")));
        } finally {
            skillsLoading = false;
            T.windows.refresh((w) => w.kind === "s.skills");
        }
    }

    async function loadMcpList() {
        if (mcpLoading) return;
        mcpLoading = true;
        try {
            const r = await T.api.mcpServers();
            mcpCache = r && Array.isArray(r.servers) ? r.servers : [];
            mcpFailed = false;
        } catch (err) {
            mcpCache = [];
            mcpFailed = true;
            T.toast.show("error", T.api.errorText(err, t("loadFailed")));
        } finally {
            mcpLoading = false;
            T.windows.refresh(isMcpWin);
        }
    }

    // 저장·삭제 응답의 새 목록을 반영하고 목록 창을 다시 그린다.
    function setSkills(r) {
        skillsCache = r && Array.isArray(r.skills) ? r.skills : [];
        T.windows.refresh((w) => w.kind === "s.skills");
    }

    function setMcp(r) {
        mcpCache = r && Array.isArray(r.servers) ? r.servers : [];
        T.windows.refresh((w) => w.id === "s.mcp");
    }

    /* ── 스킬 ───────────────────────────────────────────────── */
    function skillSourceLabel(source) {
        if (source === "system") return t("skillBuiltin");
        if (source === "shared") return t("skillShared");
        return t("skillUser");
    }

    const skillWinId = (sk) => `s.skill:${sk.source}/${sk.name}`;

    // 확인을 받고 지운다. 지운 스킬의 편집 창이 열려 있었으면 같이 닫는다.
    async function deleteSkill(sk) {
        if (!(await C.confirmDelete(sk.name))) return;
        try {
            setSkills(await T.api.deleteSkill(sk.name, sk.source));
            void T.windows.close(skillWinId(sk), { force: true });
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function skillRow(sk, win) {
        return C.itemRow({
            name: sk.name,
            badge: skillSourceLabel(sk.source),
            sub: sk.summary,
            onclick: () => win.open(skillWinId(sk)),
            menu: sk.builtin ? null : () => [{ label: t("delete"), danger: true, defer: true, onSelect: () => deleteSkill(sk) }],
        });
    }

    C.defineTab("skills", {
        on: [],
        onClose: leaveSkills,
        build(body, win) {
            if (skillsCache === null && !skillsLoading && !skillsFailed) void loadSkillsList();
            const sec = T.h("div", { class: "set-section" });
            sec.append(T.h("div", { class: "set-desc", text: t("skillsDesc") }));
            if (skillsCache === null) sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
            else if (!skillsCache.length) sec.append(T.h("div", { class: "set-desc", text: t("skillsEmpty") }));
            else for (const sk of skillsCache) sec.append(skillRow(sk, win));
            sec.append(C.actionRow(t("addSkill"), () => win.open("s.skill:new"), { icon: "plus" }));
            body.append(sec);
        },
    });

    // 스킬 편집 창. 있는 스킬은 열 때 내용을 받아 온다. 시스템 스킬은 읽기 전용으로만 열린다.
    T.windows.define("s.skill", (arg) => {
        if (!arg) return null;
        const isNew = arg === "new";
        let source = null;
        let name = null;
        if (!isNew) {
            const i = arg.indexOf("/");
            source = arg.slice(0, i);
            name = arg.slice(i + 1);
            if (i < 0 || !SKILL_SOURCES.includes(source) || !name) return null;
        }
        // 받아 온 스킬 { name, source, builtin, content } | 받는 중(null) | 못 받음(false)
        let skill = isNew ? { name: "", source: "user", builtin: false, content: "" } : null;
        let loading = false;
        const load = async (win) => {
            loading = true;
            try {
                const r = await T.api.skill(name, source);
                skill = { name: r.name, source: r.source, builtin: !!r.builtin, content: r.content || "" };
            } catch (err) {
                skill = false;
                T.toast.show("error", T.api.errorText(err, t("loadFailed")));
            }
            loading = false;
            win.rebuild();
        };
        return {
            title: () => (isNew ? t("addSkill") : name),
            onClose: leaveSkills,
            build(body, win) {
                const sec = T.h("div", { class: "set-section" });
                body.append(sec);
                if (skill === null) {
                    if (!loading) void load(win);
                    sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
                    return;
                }
                if (skill === false) {
                    sec.append(T.h("div", { class: "empty-note", text: "-" }));
                    return;
                }
                sec.append(skillForm(win, isNew, skill));
            },
        };
    });

    function skillForm(win, isNew, skill) {
        const readonly = skill.builtin === true;
        const form = T.h("div", { class: "agent-editor" });

        const nameInput = T.h("input", {
            class: "input",
            type: "text",
            value: skill.name,
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
        content.value = skill.content;
        if (readonly) content.readOnly = true;
        content.addEventListener("keydown", (e) => e.stopPropagation());
        form.append(C.fieldOf("SKILL.md", content, readonly ? t("skillReadOnly") : null));

        // 읽기 전용 스킬에는 저장할 것이 없다. 닫기 버튼으로 닫는다.
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
                setSkills(
                    isNew
                        ? await T.api.createSkill({ name: n, content: c })
                        : await T.api.updateSkill(skill.name, { source: skill.source, content: c }),
                );
                void win.close({ force: true });
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteSkill(skill), { danger: true, own: true }));
        C.trackForm(form);
        return form;
    }

    /* ── MCP ────────────────────────────────────────────────── */
    function mcpStatusLabel(srv) {
        const st = srv.status || {};
        if (st.connected) return t("mcpConnected", { n: st.tools ?? 0 });
        if (st.failed) return t("mcpFailed");
        return t("mcpPending");
    }

    // 확인을 받고 지운다. 지운 서버의 편집 창이 열려 있었으면 같이 닫는다.
    async function deleteMcp(srv) {
        if (!(await C.confirmDelete(srv.name))) return;
        try {
            setMcp(await T.api.deleteMcpServer(srv.name));
            void T.windows.close(`s.mcp:${srv.name}`, { force: true });
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function mcpRow(srv, win) {
        const st = srv.status || {};
        return C.itemRow({
            name: srv.name,
            badge: mcpStatusLabel(srv),
            badgeClass: st.connected ? "ok" : st.failed ? "bad" : "",
            sub: [srv.command, ...(srv.args || [])].filter(Boolean).join(" "),
            subMono: true,
            onclick: () => win.open(`s.mcp:${srv.name}`),
            menu: () => [{ label: t("delete"), danger: true, defer: true, onSelect: () => deleteMcp(srv) }],
        });
    }

    C.defineTab("mcp", {
        on: [],
        onClose: leaveMcp,
        build(body, win) {
            if (mcpCache === null && !mcpLoading && !mcpFailed) void loadMcpList();
            const sec = T.h("div", { class: "set-section" });
            sec.append(T.h("div", { class: "set-desc", text: t("mcpDesc") }));
            if (mcpCache === null) sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
            else if (!mcpCache.length) sec.append(T.h("div", { class: "set-desc", text: t("mcpEmpty") }));
            else for (const srv of mcpCache) sec.append(mcpRow(srv, win));
            sec.append(C.actionRow(t("addMcpServer"), () => win.open("s.mcp:new"), { icon: "plus" }));
            body.append(sec);
        },
        // MCP 서버 편집 창("s.mcp:new", "s.mcp:<name>"). 설정 값은 받아 둔 목록에서 읽는다(주소로 되살리면 목록을 먼저 받는다).
        item(arg) {
            if (!arg) return null;
            const isNew = arg === "new";
            return {
                title: () => (isNew ? t("addMcpServer") : arg),
                onClose: leaveMcp,
                // 목록에서 사라졌다(다른 기기에서 지움).
                gone: () => !isNew && Array.isArray(mcpCache) && !mcpFailed && !mcpCache.some((x) => x.name === arg),
                build(body, win) {
                    const sec = T.h("div", { class: "set-section" });
                    body.append(sec);
                    if (!isNew && mcpCache === null) {
                        if (!mcpLoading && !mcpFailed) void loadMcpList();
                        sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
                        return;
                    }
                    const srv = isNew ? null : (mcpCache || []).find((x) => x.name === arg) || { name: arg };
                    sec.append(mcpForm(win, srv));
                },
            };
        },
    });

    function mcpForm(win, srv) {
        const isNew = !srv;
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
                setMcp(
                    isNew
                        ? await T.api.createMcpServer({ name: n, command, args, env })
                        : await T.api.updateMcpServer(srv.name, { command, args, env }),
                );
                void win.close({ force: true });
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteMcp(srv), { danger: true, own: true }));
        // 환경 변수 행을 지운 것도 바뀐 것으로 친다(행 수가 처음과 달라진다).
        C.trackForm(form);
        return form;
    }
})(window.Taby);
