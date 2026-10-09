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

    // 확인을 받고 지운다. 지운 폴더의 편집 화면이 열려 있었으면 같이 닫는다.
    async function deleteFolder(f) {
        if (!(await C.confirmDelete(f.name))) return;
        try {
            const r = await T.api.deleteFolder(f.id);
            if (C.folderEditing?.id === f.id) C.folderEditing = null;
            applyFolderResult(r);
            C.build();
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    // 폴더 하나를 from번째에서 to번째로 옮긴다.
    function reorder(from, to) {
        const ids = folderList().map((x) => x.id);
        if (to < 0 || to >= ids.length || to === from) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        T.api
            .orderFolders(ids)
            .then(applyFolderResult)
            .catch((err) => {
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                C.build();
            });
    }

    // 손잡이를 잡고 끌어 순서를 바꾼다. 끄는 행은 포인터를 따라가고, 지나친 행들은 한 칸씩 비켜난다.
    function startDrag(e, row) {
        if (e.button) return;
        e.preventDefault();
        // 길게 누르기 메뉴가 이 누름을 가져가지 않게 한다.
        e.stopPropagation();
        const handle = e.currentTarget;
        const rows = [...row.parentElement.querySelectorAll(".folder-row")];
        const from = rows.indexOf(row);
        const rects = rows.map((r) => r.getBoundingClientRect());
        const step = rects[from].height;
        const minY = rects[0].top - rects[from].top;
        const maxY = rects[rects.length - 1].bottom - rects[from].bottom;
        let to = from;
        handle.setPointerCapture(e.pointerId);
        row.classList.add("dragging");
        const move = (ev) => {
            const dy = Math.max(minY, Math.min(maxY, ev.clientY - e.clientY));
            // 끄는 행의 앞쪽 가장자리가 다른 행의 가운데를 넘으면 그 행이 비켜난다.
            const top = rects[from].top + dy;
            to = from;
            rows.forEach((r, i) => {
                if (i === from) return;
                const center = rects[i].top + rects[i].height / 2;
                const shift = i > from && top + step > center ? -step : i < from && top < center ? step : 0;
                if (shift) to += shift < 0 ? 1 : -1;
                r.style.transform = shift ? `translateY(${shift}px)` : "";
            });
            row.style.transform = `translateY(${dy}px)`;
        };
        const end = (ev) => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", end);
            handle.removeEventListener("pointercancel", end);
            row.classList.remove("dragging");
            for (const r of rows) r.style.transform = "";
            if (ev.type === "pointercancel" || to === from) return;
            // 응답이 오기 전에도 놓은 자리에 그대로 있게 행을 먼저 옮겨 둔다.
            if (to > from) rows[to].after(row);
            else rows[to].before(row);
            reorder(from, to);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }

    function folderRow(f, idx, total) {
        const members = folderMembers(f.id);
        // 순서 손잡이: 폴더가 둘 이상일 때만 둔다. 키보드로는 행의 메뉴(위로·아래로 이동)로 옮긴다.
        const grip = total > 1 ? T.h("span", { class: "drag-handle", "aria-hidden": "true" }, [T.icon("grip")]) : null;
        const row = C.itemRow({
            name: f.name,
            sub: members.length ? members.map((a) => a.name).join(", ") : t("folderNoAgents"),
            trailing: grip,
            onclick: () =>
                C.openForm(() => {
                    C.folderEditing = { mode: "edit", id: f.id };
                }),
            menu: () =>
                [
                    idx > 0 ? { label: t("folderMoveUp"), onSelect: () => reorder(idx, idx - 1) } : null,
                    idx < total - 1 ? { label: t("folderMoveDown"), onSelect: () => reorder(idx, idx + 1) } : null,
                    { label: t("delete"), danger: true, defer: true, onSelect: () => deleteFolder(f) },
                ].filter(Boolean),
        });
        row.classList.add("folder-row");
        if (grip) {
            grip.addEventListener("pointerdown", (e) => startDrag(e, row));
            // 손잡이를 끌고 난 뒤의 클릭이 편집 화면을 열지 않게 한다.
            grip.addEventListener("click", (e) => e.stopPropagation());
        }
        return row;
    }

    function folderForm() {
        const editing = C.folderEditing;
        const isNew = editing.mode === "new";
        const folder = isNew ? null : folderList().find((f) => f.id === editing.id);
        if (!isNew && !folder) {
            // 다른 기기에서 지워진 폴더면 목록으로 돌아간다.
            C.folderEditing = null;
            return T.h("div", { class: "set-desc", text: t("foldersEmpty") });
        }
        const form = T.h("div", { class: "agent-editor" });

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

        const saveBtn = C.headAction(t("save"), async () => {
            const name = nameInput.value.trim();
            if (!name) {
                nameInput.focus();
                return;
            }
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
                T.toast.show("error", T.api.errorText(err, t("saveFailed")));
            }
        });
        if (!isNew) form.append(C.actionRow(t("delete"), () => deleteFolder(folder), { danger: true, own: true }));
        C.trackForm(form);
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
            C.actionRow(
                t("folderNew"),
                () =>
                    C.openForm(() => {
                        C.folderEditing = { mode: "new" };
                    }),
                { icon: "plus" },
            ),
        );
        sec.append(T.h("hr", { class: "divider" }));
        // 전체 탭에서 폴더 소속 에이전트 제외
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("allTabExcludesFoldered") }),
                C.switchEl(s.allTabExcludesFoldered, (v) => C.put({ allTabExcludesFoldered: v }), t("allTabExcludesFoldered")),
            ]),
            T.h("div", { class: "set-desc", text: t("allTabExcludesFolderedDesc") }),
        );
        body.append(sec);
    }

    C.folderList = folderList;
    C.buildFolders = buildFolders;
})(window.Taby);
