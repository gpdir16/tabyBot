/* tabyBot 웹 클라이언트: 설정 > 폴더 탭. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.folderEditing = null; // { mode:"new" } | { mode:"edit", id }

    /* ── 폴더 탭 ────────────────────────────────────────────
       폴더 만들기·이름 변경·순서·삭제·소속 에이전트 지정은 전부 여기서 한다.
       사이드바의 폴더 탭은 보기 전환만 담당한다. */
    function folderList() {
        return state.state.folders || [];
    }

    function folderMembers(folderId) {
        return C.agentList().filter((a) => (a.folder || "") === folderId);
    }

    function applyFolderResult(r) {
        state.applyAgents(r);
    }

    function folderRow(f, idx, total) {
        const members = folderMembers(f.id);
        const move = (dir) => {
            const ids = folderList().map((x) => x.id);
            const to = idx + dir;
            if (to < 0 || to >= ids.length) return;
            [ids[idx], ids[to]] = [ids[to], ids[idx]];
            T.api
                .orderFolders(ids)
                .then(applyFolderResult)
                .catch((err) => T.toast.show("error", T.api.errorText(err, t("saveFailed"))));
        };
        const arrow = (dir, label, disabled) => {
            const btn = T.h(
                "button",
                {
                    class: `btn-icon btn-xs folder-move${dir < 0 ? " up" : ""}`,
                    type: "button",
                    "aria-label": label,
                    "data-tip": label,
                    onclick: () => move(dir),
                },
                [T.icon("chevron", "icon-sm")],
            );
            btn.disabled = disabled;
            return btn;
        };
        const delBtn = T.h("button", {
            class: "btn ghost",
            text: t("delete"),
            async onclick() {
                if (!(await C.confirmDelete(f.name))) return;
                delBtn.disabled = true;
                T.api
                    .deleteFolder(f.id)
                    .then((r) => {
                        applyFolderResult(r);
                    })
                    .catch((err) => {
                        delBtn.disabled = false;
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    });
            },
        });
        return T.h("div", { class: "ext-row" }, [
            T.h("div", { class: "ext-main" }, [
                T.h("div", { class: "ext-name" }, [T.h("span", { class: "ext-nm", text: f.name })]),
                T.h("div", {
                    class: "ext-sub",
                    text: members.length ? members.map((a) => a.name).join(", ") : t("folderNoAgents"),
                }),
            ]),
            T.h("div", { class: "ext-actions" }, [
                arrow(-1, t("folderMoveUp"), idx === 0),
                arrow(1, t("folderMoveDown"), idx === total - 1),
                T.h("button", {
                    class: "btn ghost",
                    text: t("edit"),
                    onclick() {
                        C.folderEditing = { mode: "edit", id: f.id };
                        C.build();
                    },
                }),
                delBtn,
            ]),
        ]);
    }

    function folderForm() {
        const editing = C.folderEditing;
        const isNew = editing.mode === "new";
        const folder = isNew ? null : folderList().find((f) => f.id === editing.id);
        const close = () => {
            C.folderEditing = null;
            C.build();
        };
        if (!isNew && !folder) {
            // 다른 기기에서 지워진 폴더면 목록으로 돌아간다.
            C.folderEditing = null;
            return T.h("div", { class: "set-desc", text: t("foldersEmpty") });
        }
        const form = T.h("div", { class: "agent-editor ext-form" });
        form.append(C.formHead(isNew ? t("folderNew") : folder.name));

        const nameInput = T.h("input", {
            class: "input",
            type: "text",
            value: folder?.name || "",
            placeholder: t("folderNamePh"),
            maxlength: "32",
            "aria-label": t("folderName"),
        });
        nameInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.isComposing) saveBtn.click();
        });
        form.append(C.fieldOf(t("folderName"), nameInput));

        // 소속 에이전트: 에이전트는 폴더 하나에만 들어간다. 다른 폴더 소속이면 그 이름을 보여 준다.
        const names = new Map(folderList().map((f) => [f.id, f.name]));
        const picks = new Map();
        const list = T.h("div", { class: "folder-agents" });
        for (const a of C.agentList()) {
            const inThis = !isNew && (a.folder || "") === folder.id;
            const other = !inThis && a.folder && names.has(a.folder) ? names.get(a.folder) : "";
            const box = T.h("input", { type: "checkbox", "aria-label": a.name });
            box.checked = inThis || (isNew && editing.agentId === a.id);
            picks.set(a.id, { box, was: inThis });
            list.append(
                T.h("label", { class: "folder-agent" }, [
                    T.h("span", {
                        class: "bot-avatar",
                        text: ([...String(a.name || "?").trim()][0] || "?").toUpperCase(),
                        style: /^#[0-9a-f]{6}$/i.test(String(a.color || "")) ? `background-color:${a.color}` : null,
                    }),
                    T.h("span", { class: "folder-agent-meta" }, [
                        T.h("span", { class: "folder-agent-name", text: a.name || "?" }),
                        other ? T.h("span", { class: "ext-sub", text: t("folderAgentIn", { name: other }) }) : null,
                    ]),
                    box,
                    T.h("span", { class: "folder-check", "aria-hidden": "true" }, [T.icon("check", "icon-sm")]),
                ]),
            );
        }
        form.append(C.fieldOf(t("folderAgents"), list, t("folderAgentsDesc")));

        const actions = T.h("div", { class: "editor-actions" });
        const saveBtn = T.h("button", {
            class: "btn primary",
            text: t("save"),
            async onclick() {
                const name = nameInput.value.trim();
                if (!name) {
                    nameInput.focus();
                    return;
                }
                saveBtn.disabled = true;
                // 응답마다 전체 스냅샷이 오므로 마지막 것만 반영한다. 중간 반영은 폼을 다시 그려 깜빡인다.
                let last = null;
                try {
                    let id = folder?.id;
                    if (isNew) {
                        last = await T.api.createFolder({ name });
                        id = last?.folder?.id;
                    } else if (name !== folder.name) {
                        last = await T.api.updateFolder(id, { name });
                    }
                    if (id) {
                        for (const [agentId, { box, was }] of picks) {
                            if (box.checked === was) continue;
                            last = await T.api.updateAgent(agentId, { folder: box.checked ? id : "" });
                        }
                    }
                    C.folderEditing = null;
                    if (last) applyFolderResult(last);
                    C.build();
                } catch (err) {
                    // 일부만 저장됐을 수 있다. 거기까지의 상태를 반영하고 폼은 열어 둔다.
                    if (last) applyFolderResult(last);
                    saveBtn.disabled = false;
                    T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                }
            },
        });
        actions.append(saveBtn, T.h("button", { class: "btn ghost", text: t("cancel"), onclick: close }));
        form.append(actions);
        // 모바일에서는 자동 포커스를 하지 않는다. 설정 패널이 미끄러져 들어오는 중에 포커스하면
        // iOS가 입력을 보이게 하려고 화면을 밀어 전환이 깨지고 패널이 반쯤 잘린다.
        if (isNew && !window.matchMedia("(max-width: 860px)").matches) requestAnimationFrame(() => nameInput.focus());
        return form;
    }

    function buildFolders(body) {
        const s = state.state.settings || {};
        const sec = T.h("div", { class: "set-section" });
        if (!C.folderEditing) sec.append(T.h("div", { class: "set-desc", text: t("foldersDesc") }));
        if (C.folderEditing) {
            sec.append(folderForm());
            body.append(sec);
            return;
        }
        const folders = folderList();
        if (!folders.length) sec.append(T.h("div", { class: "set-desc", text: t("foldersEmpty") }));
        else {
            folders.forEach((f, i) => {
                sec.append(folderRow(f, i, folders.length));
            });
        }
        sec.append(
            T.h("div", { class: "ext-add" }, [
                T.h(
                    "button",
                    {
                        class: "btn ghost",
                        onclick() {
                            C.folderEditing = { mode: "new" };
                            C.build();
                        },
                    },
                    [T.icon("plus"), document.createTextNode(t("folderNew"))],
                ),
            ]),
        );
        sec.append(T.h("hr", { class: "divider" }));
        // 전체 탭에서 폴더 소속 에이전트 제외
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("allTabExcludesFoldered") }),
                C.switchEl(s.allTabExcludesFoldered, (v) => C.put({ allTabExcludesFoldered: v }), t("allTabExcludesFoldered")),
            ]),
        );
        body.append(sec);
    }

    C.folderList = folderList;
    C.buildFolders = buildFolders;
})(window.Taby);
