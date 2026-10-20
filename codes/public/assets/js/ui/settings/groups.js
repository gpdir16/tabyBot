/* tabyBot 웹 클라이언트: 설정 > 그룹 탭(여러 에이전트와 함께 쓰는 대화방). */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.groupEditing = null; // { mode:"new" } | { mode:"edit", id }

    function groupList() {
        return state.state.groups || [];
    }

    function memberNames(g) {
        return g.members.map((uuid) => state.botByUuid(uuid)?.name).filter(Boolean);
    }

    // 확인을 받고 지운다. 대화 기록은 서버에 남는다.
    async function deleteGroup(g) {
        if (!(await C.confirmDelete(g.name))) return;
        try {
            const r = await T.api.deleteGroup(g.id);
            if (C.groupEditing?.id === g.id) C.groupEditing = null;
            state.applyAgents(r);
            // 지운 방을 보고 있었으면 대화 화면을 비운다.
            if (state.state.currentId === g.id) state.setCurrent(null);
            C.build();
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function groupRow(g) {
        return C.itemRow({
            name: g.name,
            sub: memberNames(g).join(", "),
            onclick: () =>
                C.openForm(() => {
                    C.groupEditing = { mode: "edit", id: g.id };
                }),
            menu: () => [{ label: t("delete"), danger: true, defer: true, onSelect: () => deleteGroup(g) }],
        });
    }

    // 고른 멤버의 순서: 원래 있던 멤버는 그 순서를 지키고, 새로 고른 에이전트는 뒤에 붙는다.
    // 멘션이 없을 때 이 순서대로 답한다.
    function orderedMembers(before, picks) {
        const chosen = [...picks].filter(([, box]) => box.checked).map(([uuid]) => uuid);
        return [...before.filter((uuid) => chosen.includes(uuid)), ...chosen.filter((uuid) => !before.includes(uuid))];
    }

    function memberPicker(group) {
        const picks = new Map();
        const list = T.h("div", { class: "folder-agents" });
        for (const a of C.agentList()) {
            if (!a.uuid) continue;
            const box = T.h("input", { type: "checkbox", "aria-label": a.name });
            box.checked = Boolean(group?.members.includes(a.uuid));
            picks.set(a.uuid, box);
            list.append(
                T.h("label", { class: "folder-agent" }, [
                    T.h("span", {
                        class: "bot-avatar",
                        text: ([...String(a.name || "?").trim()][0] || "?").toUpperCase(),
                        style: /^#[0-9a-f]{6}$/i.test(String(a.color || "")) ? `background-color:${a.color}` : null,
                    }),
                    T.h("span", { class: "folder-agent-meta" }, [T.h("span", { class: "folder-agent-name", text: a.name || "?" })]),
                    box,
                    T.h("span", { class: "folder-check", "aria-hidden": "true" }, [T.icon("check", "icon-sm")]),
                ]),
            );
        }
        return { list, picks };
    }

    function groupForm() {
        const editing = C.groupEditing;
        const isNew = editing.mode === "new";
        const group = isNew ? null : groupList().find((g) => g.id === editing.id);
        if (!isNew && !group) {
            // 다른 기기에서 지워진 방이면 목록으로 돌아간다.
            C.groupEditing = null;
            return T.h("div", { class: "set-desc", text: t("groupsEmpty") });
        }
        const form = T.h("div", { class: "agent-editor" });

        const nameInput = T.h("input", {
            class: "input",
            type: "text",
            value: group?.name || "",
            placeholder: t("groupNamePh"),
            maxlength: "32",
            "aria-label": t("groupName"),
        });
        nameInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.isComposing) saveBtn.click();
        });
        form.append(C.fieldOf(t("groupName"), nameInput));

        const { list, picks } = memberPicker(group);
        form.append(C.fieldOf(t("groupMembers"), list, t("groupMembersDesc")));

        const saveBtn = C.headAction(t("save"), async () => {
            const name = nameInput.value.trim();
            if (!name) {
                nameInput.focus();
                return;
            }
            const members = orderedMembers(group?.members || [], picks);
            if (members.length < 2) {
                T.toast.show("error", t("groupNeedTwo"));
                return;
            }
            try {
                const r = isNew ? await T.api.createGroup({ name, members }) : await T.api.updateGroup(group.id, { name, members });
                C.groupEditing = null;
                state.applyAgents(r);
                C.build();
                // 새로 만든 방은 바로 연다.
                if (isNew && r?.group?.id) {
                    T.settingsUI.hide();
                    T.util.pushUrl(`/a/${r.group.id}`);
                    T.app?.renderRoute();
                }
            } catch (err) {
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteGroup(group), { danger: true, own: true }));
        C.trackForm(form);
        // 모바일에서는 자동 포커스를 하지 않는다(folders.js와 같은 이유).
        if (isNew && !window.matchMedia("(max-width: 860px)").matches) requestAnimationFrame(() => nameInput.focus());
        return form;
    }

    function buildGroups(body) {
        const sec = T.h("div", { class: "set-section" });
        if (C.groupEditing) {
            sec.append(groupForm());
            body.append(sec);
            return;
        }
        sec.append(T.h("div", { class: "set-desc", text: t("groupsDesc") }));
        const groups = groupList();
        if (!groups.length) sec.append(T.h("div", { class: "set-desc", text: t("groupsEmpty") }));
        else for (const g of groups) sec.append(groupRow(g));
        sec.append(
            C.actionRow(
                t("groupNew"),
                () =>
                    C.openForm(() => {
                        C.groupEditing = { mode: "new" };
                    }),
                { icon: "plus" },
            ),
        );
        body.append(sec);
    }

    C.groupList = groupList;
    C.buildGroups = buildGroups;
})(window.Taby);
