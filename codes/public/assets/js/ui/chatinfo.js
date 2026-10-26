/* tabyBot 웹 클라이언트: 대화 정보 창.
   사이드바의 + 메뉴(새 에이전트, 새 그룹)와 대화 헤더를 누르면 열린다. 에이전트와 그룹 대화방을 설정 밖에서 만들고 고친다.
   창은 windows.js가 띄운다. 각 창은 자기 대화방(또는 만들기 단계) 하나에 딸리고, 상태는 창마다 따로 지닌다.
   창 id: i.agent:<uuid>, i.agent:new, i.group:<id>, i.group-add:<id>, i.group-new, i.group-name(되살릴 수 없는 단계).
   행과 에이전트 편집기는 설정의 것을 그대로 쓴다(settings/components.js, agents.js). */
((T) => {
    "use strict";

    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const ON = ["bots", "settings"];

    function agentByUuid(uuid) {
        return C.agentList().find((a) => a.uuid === uuid) || null;
    }

    function groupById(id) {
        return (state.state.groups || []).find((g) => g.id === id) || null;
    }

    // 창을 닫고 다른 주소로 간다. 남은 창들은 주소에 그대로 둔다.
    function closeAndGo(win, url) {
        void win?.close({ force: true, instant: true });
        T.util.pushUrl(T.windows.urlWith(url));
        T.app?.renderRoute();
    }

    // 만든 대화방이나 에이전트의 채팅으로 간다.
    function openChat(win, uuid) {
        if (!uuid) return;
        closeAndGo(win, `/a/${encodeURIComponent(uuid)}`);
        T.sidebar?.showChat?.();
    }

    /* ── 에이전트 고르기(체크 목록과 검색) ───────────────────── */
    // chosen: 고른 순서를 지키는 uuid 배열. 바뀌면 그 배열을 그대로 고친다. 설정의 폴더 편집과 같은 행을 쓴다.
    function agentChecklist(agents, chosen) {
        const search = T.h("input", { class: "input", type: "search", placeholder: t("searchPlaceholder"), "aria-label": t("searchPlaceholder") });
        const list = T.h("div", { class: "folder-agents" });
        const rows = [];
        for (const a of agents) {
            const box = T.h("input", { type: "checkbox", "aria-label": a.name });
            box.checked = chosen.includes(a.uuid);
            box.addEventListener("change", () => {
                const at = chosen.indexOf(a.uuid);
                if (box.checked && at < 0) chosen.push(a.uuid);
                if (!box.checked && at >= 0) chosen.splice(at, 1);
            });
            const row = T.h("label", { class: "folder-agent" }, [
                T.chatAvatar(a),
                T.h("span", { class: "folder-agent-meta" }, [T.h("span", { class: "folder-agent-name", text: a.name || "?" })]),
                box,
                T.h("span", { class: "folder-check", "aria-hidden": "true" }, [T.icon("check", "icon-sm")]),
            ]);
            rows.push({ row, name: String(a.name || "").toLowerCase() });
            list.append(row);
        }
        const empty = T.h("div", { class: "empty-note", text: t("agentSearchEmpty"), hidden: true });
        search.addEventListener("input", () => {
            const q = search.value.trim().toLowerCase();
            let shown = 0;
            for (const r of rows) {
                const on = !q || r.name.includes(q);
                r.row.hidden = !on;
                if (on) shown += 1;
            }
            empty.hidden = shown > 0;
        });
        return [T.h("div", { class: "field" }, [search]), list, empty];
    }

    // 에이전트 한 줄: 아바타, 이름, 쓰는 모델 프리셋.
    function agentRow(a, opts = {}) {
        const preset = C.modelPresetByUid(a.modelPreset) || C.defaultModelPreset();
        const row = C.itemRow({ name: a.name, sub: C.modelPresetName(preset), ...opts });
        row.classList.add("ci-agent-row");
        row.prepend(T.chatAvatar(a));
        return row;
    }

    /* ── 새 에이전트, 에이전트 정보 ─────────────────────────── */
    // uuid가 "new"면 새 에이전트다.
    function agentScreen(uuid) {
        const isNew = uuid === "new";
        return {
            on: ON,
            gone: () => !isNew && !agentByUuid(uuid),
            title: () => (isNew ? t("newAgent") : agentByUuid(uuid)?.name || t("agentInfo")),
            build(body, win) {
                const agent = isNew ? null : agentByUuid(uuid);
                const editor = C.agentEditor(
                    agent,
                    {
                        saveLabel: agent ? t("save") : t("create"),
                        onSaved(saved) {
                            if (!agent) {
                                openChat(win, saved?.uuid);
                                return;
                            }
                            T.toast.show("success", t("saved"));
                            win.rebuild();
                        },
                        onDeleted: () => void win.close({ force: true }),
                    },
                    win,
                );
                body.append(editor);
                // 사진 창이 따로 열려 있어도 고친 것을 지킨다(다시 그리지 않고, 닫을 때 묻는다).
                T.windows.slot.dirty = editor.changed;
            },
        };
    }

    /* ── 새 그룹: 멤버 고르기 → 이름 ───────────────────────── */
    // preset: 처음부터 골라 둘 uuid 목록(주소로 되살릴 때는 없다).
    function newGroupScreen(preset) {
        const chosen = (preset || []).filter((uuid) => agentByUuid(uuid));
        return {
            title: () => t("groupNew"),
            build(body, win) {
                body.append(
                    T.h("div", { class: "set-section" }, [
                        T.h("div", { class: "set-desc", text: t("groupMembersDesc") }),
                        ...agentChecklist(
                            C.agentList().filter((a) => a.uuid),
                            chosen,
                        ),
                    ]),
                );
                C.headAction(t("next"), () => {
                    if (chosen.length < 2) {
                        T.toast.show("error", t("groupNeedTwo"));
                        return;
                    }
                    // 고른 멤버를 들고 이름 단계로 넘어간다(이 창은 그 자리를 내준다).
                    win.replace("i.group-name", { data: { members: chosen.slice() } });
                });
                // 두 명 이상 골라야 다음으로 갈 수 있다.
                T.windows.slot.dirty = () => chosen.length >= 2;
            },
        };
    }

    // 멤버 목록은 앞 단계가 넘겨준다. 주소만으로는 되살리지 못한다.
    function groupNameScreen(data) {
        const members = data?.members;
        if (!members?.length) return null;
        return {
            title: () => t("groupNew"),
            build(body, win) {
                const sec = T.h("div", { class: "set-section" });
                const name = T.h("input", {
                    class: "input",
                    type: "text",
                    maxlength: "32",
                    placeholder: t("groupNamePh"),
                    "aria-label": t("groupName"),
                });
                sec.append(C.fieldOf(t("groupName"), name));
                // 사진을 고르지 않으면 멤버 아바타를 겹쳐 보인다. 고른 사진은 방을 만든 뒤에 올린다.
                const photo = C.avatarPicker({ isGroup: true, members, name: "" }, () => win.open(`photo:${win.id}`));
                win.photoPicker = photo;
                sec.append(photo.row);
                sec.append(C.fieldLabel(t("groupMemberCount", { n: members.length })));
                for (const uuid of members) {
                    const a = agentByUuid(uuid);
                    if (a) sec.append(agentRow(a));
                }
                body.append(sec);
                const create = C.headAction(t("create"), async () => {
                    const n = name.value.trim();
                    if (!n) {
                        name.focus();
                        return;
                    }
                    try {
                        let r = await T.api.createGroup({ name: n, members });
                        const groupId = r?.group?.id;
                        // 사진만 실패하면 알리고 방으로는 그대로 간다(방을 두 번 만들지 않게).
                        try {
                            r = (await photo.commit(groupId)) || r;
                        } catch (err) {
                            T.toast.show("error", T.api.errorText(err, t("avatarSaveFailed")));
                        }
                        state.applyAgents(r);
                        openChat(win, groupId);
                    } catch (err) {
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    }
                });
                name.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && !e.isComposing && !create.disabled) create.click();
                });
                T.windows.slot.dirty = () => name.value.trim() !== "" || photo.value() !== "";
            },
        };
    }

    /* ── 그룹 정보 ──────────────────────────────────────────── */
    async function saveGroup(group, patch) {
        try {
            const r = await T.api.updateGroup(group.id, { name: group.name, members: group.members, ...patch });
            state.applyAgents(r);
            return true;
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            return false;
        }
    }

    async function removeMember(group, uuid) {
        if (group.members.length <= 2) {
            T.toast.show("error", t("groupNeedTwo"));
            return;
        }
        await saveGroup(group, { members: group.members.filter((m) => m !== uuid) });
    }

    async function deleteGroup(win, group) {
        if (!(await C.confirmDelete(group.name))) return;
        try {
            const r = await T.api.deleteGroup(group.id);
            state.applyAgents(r);
            const mine = (w) => w.id === `i.group:${group.id}` || w.id === `i.group-add:${group.id}`;
            if (state.state.currentId === group.id) closeAndGo(win, "/");
            T.windows.closeWhere(mine);
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function groupScreen(id) {
        return {
            on: ON,
            gone: () => !groupById(id),
            title: () => t("groupInfo"),
            build(body, win) {
                const group = groupById(id);
                if (!group) return;
                const sec = T.h("div", { class: "set-section" });
                const form = T.h("div", { class: "agent-editor" });
                const name = T.h("input", { class: "input", type: "text", value: group.name, maxlength: "32", "aria-label": t("groupName") });
                form.append(C.labeledRow(t("groupName"), name));
                sec.append(form);
                // 사진은 이름과 따로 한 묶음이다. 사진 창에서 고른 것은 저장 버튼을 누를 때 올린다.
                const photo = C.avatarPicker(state.chatByUuid(id), () => win.open(`photo:${win.id}`));
                win.photoPicker = photo;
                sec.append(photo.row);
                const save = C.headAction(t("save"), async () => {
                    const n = name.value.trim();
                    if (!n) {
                        name.focus();
                        return;
                    }
                    if (n !== group.name && !(await saveGroup(group, { name: n }))) return;
                    try {
                        const r = await photo.commit(id);
                        if (r) state.applyAgents(r);
                    } catch (err) {
                        T.toast.show("error", T.api.errorText(err, t("avatarSaveFailed")));
                        return;
                    }
                    T.toast.show("success", t("saved"));
                    win.rebuild();
                });
                name.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && !e.isComposing && !save.disabled) save.click();
                });
                // 사진 창이 따로 열려 있어도 고친 것을 지킨다.
                C.trackForm(form, photo.value);

                // 멤버: 누르면 그 에이전트 정보 창이 열린다. 빼기는 길게 누르거나 우클릭한 메뉴에서 한다.
                sec.append(C.fieldLabel(t("groupMemberCount", { n: group.members.length })));
                for (const uuid of group.members) {
                    const a = agentByUuid(uuid);
                    if (!a) continue;
                    const canRemove = group.members.length > 2;
                    sec.append(
                        agentRow(a, {
                            onclick: () => win.open(`i.agent:${uuid}`),
                            menu: canRemove
                                ? () => [{ label: t("groupRemoveMember"), danger: true, onSelect: () => removeMember(group, uuid) }]
                                : null,
                        }),
                    );
                }
                const others = C.agentList().filter((a) => a.uuid && !group.members.includes(a.uuid));
                if (others.length) sec.append(C.actionRow(t("groupAddMembers"), () => win.open(`i.group-add:${id}`), { icon: "plus" }));
                sec.append(T.h("div", { class: "set-desc", text: t("groupsDesc") }));
                sec.append(C.actionRow(t("groupDelete"), () => deleteGroup(win, group), { danger: true, own: true }));
                body.append(sec);
            },
        };
    }

    function addMembersScreen(id) {
        const chosen = [];
        return {
            on: ON,
            gone: () => !groupById(id),
            title: () => t("groupAddMembers"),
            build(body, win) {
                const group = groupById(id);
                if (!group) return;
                const others = C.agentList().filter((a) => a.uuid && !group.members.includes(a.uuid));
                // 다시 그릴 때 이미 멤버가 된 에이전트는 고른 것에서 뺀다.
                for (let i = chosen.length - 1; i >= 0; i--) if (!others.some((a) => a.uuid === chosen[i])) chosen.splice(i, 1);
                body.append(T.h("div", { class: "set-section" }, agentChecklist(others, chosen)));
                C.headAction(t("add"), async () => {
                    if (!chosen.length) return;
                    if (await saveGroup(group, { members: [...group.members, ...chosen] })) {
                        chosen.length = 0;
                        void win.close({ force: true });
                    }
                });
                T.windows.slot.dirty = () => chosen.length > 0;
            },
        };
    }

    T.windows.define("i.agent", (arg) => (arg ? agentScreen(arg) : null));
    T.windows.define("i.group", (arg) => (arg ? groupScreen(arg) : null));
    T.windows.define("i.group-add", (arg) => (arg ? addMembersScreen(arg) : null));
    T.windows.define("i.group-new", (_arg, data) => newGroupScreen(data?.preset));
    T.windows.define("i.group-name", (_arg, data) => groupNameScreen(data));

    /* ── 진입점 ─────────────────────────────────────────────── */
    function idFor(chat) {
        if (!chat?.uuid) return null;
        return chat.isGroup ? `i.group:${chat.uuid}` : `i.agent:${chat.uuid}`;
    }

    // 대화방(그룹이면 그룹 정보, 에이전트면 에이전트 정보) 창을 연다. 이미 열려 있으면 닫는다.
    function openFor(chat) {
        const id = idFor(chat);
        if (!id) return;
        const have = T.windows.get(id);
        if (have) void have.close();
        else T.windows.open(id);
    }

    const newAgent = () => void T.windows.open("i.agent:new");
    const newGroup = (preset) => void T.windows.open("i.group-new", { data: { preset } });

    // 사이드바 + 버튼 메뉴의 항목.
    function newMenuItems() {
        return [
            { label: t("newAgent"), icon: "person", defer: true, onSelect: newAgent },
            { label: t("groupNew"), icon: "users", defer: true, onSelect: () => newGroup() },
        ];
    }

    T.chatInfo = { open: openFor, newAgent, newGroup, newMenuItems };
})(window.Taby);
