/* tabyBot 웹 클라이언트: 대화 정보 패널.
   사이드바의 + 메뉴(새 에이전트, 새 그룹)와 대화 헤더를 누르면 열린다. 에이전트와 그룹 대화방을 설정 밖에서 만들고 고친다.
   데스크톱: 채팅 오른쪽에 열로 붙는다. 한 단계 더 들어간 화면(멤버 추가 등)은 그 오른쪽에 열이 하나 더 붙는다.
   모바일: 설정 화면처럼 오른쪽에서 밀려 들어오고, 뒤로 제스처로 밀어낼 수 있다.
   화면 모양(.sp-view, 머리, 묶음 목록)과 행, 에이전트 편집기는 설정의 것을 그대로 쓴다(settings/components.js, agents.js). */
((T) => {
    "use strict";

    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const VIEW_MS = 420; // 화면이 밀려 들어오고 나가는 시간(app.css의 --nav-dur와 같게)
    const mobileMq = window.matchMedia("(max-width: 860px)");
    const isMobile = () => mobileMq.matches;

    let host = null; // .ci-host: 화면(.sp-view)을 담는 층
    let stack = []; // [{ screen, view }]: 첫 화면부터 지금 화면까지
    let timer = 0;
    // 패널을 열 때 방문 기록에 한 칸을 넣는다. 휴대폰이나 브라우저의 뒤로 가기가 이전 채팅방으로 가지 않고 패널을 닫게 한다.
    let historyEntry = false;
    let skipPop = false;

    function agentByUuid(uuid) {
        return C.agentList().find((a) => a.uuid === uuid) || null;
    }

    function groupById(id) {
        return (state.state.groups || []).find((g) => g.id === id) || null;
    }

    function avatar(agent) {
        const name = String(agent?.name || "?").trim();
        return T.h("span", {
            class: "bot-avatar",
            text: ([...name][0] || "?").toUpperCase(),
            style: `background-color:${T.util.safeColor(agent?.color)}`,
        });
    }

    function addHistory() {
        if (historyEntry) return;
        try {
            history.pushState({ chatInfo: true }, "", location.href);
            historyEntry = true;
        } catch {
            // 주소 갱신이 막힌 환경에서는 기록 없이 연다(뒤로 가기는 패널 버튼으로만 닫힌다)
        }
    }

    // 패널 버튼이나 제스처로 닫을 때: 넣어 둔 기록 칸을 걷는다. 그 뒤로 가기는 화면을 다시 그리지 않는다.
    function dropHistory() {
        if (!historyEntry) return;
        historyEntry = false;
        if (!history.state?.chatInfo) return;
        skipPop = true;
        history.back();
    }

    // 패널을 닫고 다른 주소로 간다. 넣어 둔 기록 칸은 새 주소로 바꿔 쓴다(뒤로 가기가 닫힌 패널을 다시 거치지 않게).
    function closeAndGo(url) {
        const reuse = historyEntry && history.state?.chatInfo;
        historyEntry = false;
        close(true, false);
        if (reuse) T.util.replaceUrl(url);
        else T.util.pushUrl(url);
        T.app?.renderRoute();
    }

    // 만든 대화방이나 에이전트의 채팅으로 간다.
    function openChat(uuid) {
        if (!uuid) return;
        closeAndGo(`/a/${encodeURIComponent(uuid)}`);
        T.sidebar?.showChat?.();
    }

    /* ── 화면 그리기 ───────────────────────────────────────── */
    // 설정의 buildView와 같은 모양: 머리(뒤로, 제목, 저장 버튼)와 본문. 본문을 그리는 동안 화면이 C.viewSlot을 채운다.
    function buildView(screen, level) {
        const head = T.h("header", { class: "sp-head" }, [
            T.h(
                "div",
                { class: "pblur", "aria-hidden": "true" },
                Array.from({ length: 8 }, () => T.h("i")),
            ),
            T.h(
                "button",
                {
                    class: "btn-icon sp-back",
                    "aria-label": t("back"),
                    onclick: () => void backFrom(level),
                },
                [T.icon("chevron-left")],
            ),
            T.h("div", { class: "sp-title", text: screen.title() }),
        ]);
        const body = T.h("div", { class: "sp-body" });
        C.viewSlot = {};
        screen.build(body);
        C.groupRows(body);
        const { action, dirty } = C.viewSlot;
        C.viewSlot = {};
        if (action) {
            head.append(action);
            action.sync = () => {
                if (!action.busy) action.disabled = !!dirty && !dirty();
            };
            for (const type of ["input", "change", "click"]) body.addEventListener(type, action.sync);
            action.sync();
        }
        const view = T.h("div", { class: "sp-view", dataset: { level: String(level), key: screen.key } }, [head, body]);
        view.spDirty = dirty || null;
        return view;
    }

    function ensureHost() {
        if (!host) {
            host = T.h("div", { class: "ci-host", hidden: true });
            host.addEventListener("keydown", (e) => {
                // 패널 안의 입력이 전역 단축키(/ 등)로 새지 않게 한다.
                e.stopPropagation();
                if (e.key === "Escape" && !e.isComposing) {
                    e.preventDefault();
                    void backFrom(stack.length);
                }
            });
        }
        // 모바일은 문서 맨 위 층, 데스크톱은 채팅 오른쪽 열(#app 안)이다.
        const parent = isMobile() ? document.body : document.getElementById("app");
        if (host.parentNode !== parent) parent.append(host);
    }

    const isOpen = () => Boolean(host && !host.hidden && stack.length);

    // 다시 쓰는 화면(뒤로 와서 드러나는 앞 화면)에 남은 전환 표시를 걷어 낸다.
    function settle(view) {
        view.classList.remove("sp-leaving", "sp-in-right", "sp-in-left", "sp-out-left", "sp-out-right");
        return view;
    }

    function reduceMotion() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    // 지금 쌓인 화면을 그린다. motion: "push"(한 단계 들어감) | "pop"(나옴) | "open"(처음 엶) | null(그 자리에서 다시 그림).
    // gone: 이번에 닫힌 화면들.
    function show(motion, gone = []) {
        ensureHost();
        clearTimeout(timer);
        host.hidden = false;
        for (const el of host.querySelectorAll(".sp-leaving")) el.remove();
        const anim = reduceMotion() ? null : motion;
        if (!isMobile()) {
            showColumns(anim, gone);
            return;
        }
        document.body.classList.add("ci-open");
        const top = settle(stack[stack.length - 1].view);
        const prev = host.querySelector(".sp-view:not(.sp-leaving)");
        if (anim === "open") {
            host.replaceChildren(top);
            top.classList.add("sp-in-right");
        } else if ((anim === "push" || anim === "pop") && prev && prev !== top) {
            // 위에 놓이는 쪽이 뒤에 온다: 들어갈 때는 새 화면이, 나올 때는 옛 화면이 위다.
            prev.classList.add("sp-leaving", anim === "push" ? "sp-out-left" : "sp-out-right");
            top.classList.add(anim === "push" ? "sp-in-right" : "sp-in-left");
            if (anim === "push") host.append(top);
            else host.prepend(top);
        } else {
            host.replaceChildren(top);
        }
        timer = setTimeout(() => {
            for (const el of host.querySelectorAll(".sp-leaving")) el.remove();
            top.classList.remove("sp-in-right", "sp-in-left");
        }, VIEW_MS);
    }

    // 데스크톱: 쌓인 화면을 왼쪽부터 열로 놓는다. 새 열은 앞 열 밑에서 미끄러져 나오고, 닫힌 열은 그 밑으로 들어간다.
    function showColumns(anim, gone) {
        const views = stack.map((s) => s.view);
        const leaving = [...host.querySelectorAll(".sp-view.col-out"), ...gone];
        host.replaceChildren(...views, ...leaving);
        for (const v of gone) T.columnOut(v);
        if (anim === "push" || anim === "open") {
            const last = views[views.length - 1];
            T.columnIn(last, `ci:${last.dataset.level}:${last.dataset.key}`, true);
            T.revealColumn(last);
        }
    }

    // 패널을 닫는다. instant: 손가락으로 이미 밀어냈거나 다른 화면으로 떠날 때.
    // ownHistory: 패널이 넣어 둔 기록 칸도 걷는다. 다른 화면으로 옮겨 가며 닫을 때(false)는 주소를 건드리지 않는다.
    function close(instant = false, ownHistory = true) {
        if (ownHistory) dropHistory();
        else historyEntry = false;
        if (!host || host.hidden) {
            stack = [];
            return;
        }
        clearTimeout(timer);
        const views = [...host.querySelectorAll(".sp-view")];
        stack = [];
        document.body.classList.remove("ci-open");
        if (host.contains(document.activeElement)) document.activeElement.blur();
        const clear = () => {
            host.hidden = true;
            host.replaceChildren();
        };
        if (instant || reduceMotion() || !views.length) {
            clear();
            return;
        }
        if (isMobile()) {
            const top = views.find((v) => !v.classList.contains("sp-leaving")) || views[views.length - 1];
            for (const v of views) if (v !== top) v.remove();
            top.classList.remove("sp-in-right", "sp-in-left");
            top.classList.add("sp-leaving", "sp-out-right");
        } else {
            for (const v of views) T.columnOut(v);
        }
        timer = setTimeout(clear, VIEW_MS);
    }

    // 저장하지 않은 입력이 있는 화면을 버려도 되는지 묻는다. 떠나도 되면 true.
    async function confirmLeave(entries) {
        if (!entries.some((s) => s.view.spDirty?.())) return true;
        const ok = await T.confirm({ title: t("unsavedTitle"), text: t("unsavedText"), confirmLabel: t("unsavedDiscard"), danger: true });
        if (ok) for (const s of entries) s.view.spDirty = null;
        return ok;
    }

    // level 화면의 뒤로 버튼: 그 화면과 그 오른쪽 화면을 닫는다. 첫 화면이면 패널을 닫는다.
    async function backFrom(level) {
        const removed = stack.slice(level - 1);
        if (!removed.length || !(await confirmLeave(removed))) return;
        if (level <= 1) {
            close();
            return;
        }
        stack = stack.slice(0, level - 1);
        show(
            "pop",
            removed.map((s) => s.view),
        );
    }

    function push(screen) {
        stack.push({ screen, view: buildView(screen, stack.length + 1) });
        show("push");
    }

    function pop() {
        const removed = stack.pop();
        if (!stack.length) {
            close();
            return;
        }
        show("pop", removed ? [removed.view] : []);
    }

    // 처음 여는 화면. 이미 열려 있으면 그 자리에서 바꾼다.
    async function start(screen) {
        if (isOpen() && !(await confirmLeave(stack))) return;
        const was = isOpen();
        const gone = stack.map((s) => s.view);
        stack = [{ screen, view: buildView(screen, 1) }];
        addHistory();
        show(was ? null : "open", was && !isMobile() ? gone.slice(1) : []);
    }

    // 서버에서 바뀐 값이 오면 화면을 다시 그린다. 입력 중이거나 고친 것이 있는 화면은 건드리지 않는다.
    function refresh() {
        if (!isOpen()) return;
        const ae = document.activeElement;
        if (ae && host.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
        let changed = false;
        stack.forEach((s, i) => {
            if (s.view.spDirty?.() || s.view.classList.contains("sp-leaving")) return;
            const next = buildView(s.screen, i + 1);
            const top = s.view.querySelector(".sp-body")?.scrollTop || 0;
            if (s.view.isConnected) s.view.replaceWith(next);
            next.querySelector(".sp-body").scrollTop = top;
            s.view = next;
            changed = true;
        });
        if (changed && !isMobile()) host.replaceChildren(...stack.map((s) => s.view), ...host.querySelectorAll(".sp-view.col-out"));
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
                avatar(a),
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
        row.prepend(avatar(a));
        return row;
    }

    /* ── 새 에이전트, 에이전트 정보 ─────────────────────────── */
    function agentScreen(uuid) {
        return {
            key: `agent:${uuid || "new"}`,
            chat: uuid,
            title: () => (uuid ? agentByUuid(uuid)?.name || t("agentInfo") : t("newAgent")),
            build(body) {
                const agent = uuid ? agentByUuid(uuid) : null;
                if (uuid && !agent) {
                    // 다른 기기에서 지워졌다.
                    body.append(T.h("div", { class: "empty-note", text: t("agentGone") }));
                    return;
                }
                body.append(
                    C.agentEditor(agent, {
                        saveLabel: agent ? t("save") : t("create"),
                        onSaved(saved) {
                            if (!agent) {
                                openChat(saved?.uuid);
                                return;
                            }
                            T.toast.show("success", t("saved"));
                            for (const s of stack) s.view.spDirty = null;
                            refresh();
                        },
                        onDeleted: () => close(),
                    }),
                );
            },
        };
    }

    /* ── 새 그룹: 멤버 고르기 → 이름 ───────────────────────── */
    function newGroupScreen(preset = []) {
        const chosen = preset.filter((uuid) => agentByUuid(uuid));
        return {
            key: "group:new",
            title: () => t("groupNew"),
            build(body) {
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
                    push(groupNameScreen(chosen.slice()));
                });
                // 두 명 이상 골라야 다음으로 갈 수 있다.
                C.viewSlot.dirty = () => chosen.length >= 2;
            },
        };
    }

    function groupNameScreen(members) {
        return {
            key: "group:new:name",
            title: () => t("groupNew"),
            build(body) {
                const sec = T.h("div", { class: "set-section" });
                const name = T.h("input", {
                    class: "input",
                    type: "text",
                    maxlength: "32",
                    placeholder: t("groupNamePh"),
                    "aria-label": t("groupName"),
                });
                sec.append(C.fieldOf(t("groupName"), name));
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
                        const r = await T.api.createGroup({ name: n, members });
                        state.applyAgents(r);
                        openChat(r?.group?.id);
                    } catch (err) {
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    }
                });
                name.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && !e.isComposing && !create.disabled) create.click();
                });
                C.viewSlot.dirty = () => name.value.trim() !== "";
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
        if (await saveGroup(group, { members: group.members.filter((m) => m !== uuid) })) refresh();
    }

    async function deleteGroup(group) {
        if (!(await C.confirmDelete(group.name))) return;
        try {
            const r = await T.api.deleteGroup(group.id);
            state.applyAgents(r);
            if (state.state.currentId === group.id) closeAndGo("/");
            else close();
        } catch (err) {
            T.toast.show("error", T.api.errorText(err, t("saveFailed")));
        }
    }

    function groupScreen(id) {
        return {
            key: `group:${id}`,
            chat: id,
            title: () => t("groupInfo"),
            build(body) {
                const group = groupById(id);
                if (!group) {
                    body.append(T.h("div", { class: "empty-note", text: t("groupGone") }));
                    return;
                }
                const sec = T.h("div", { class: "set-section" });
                const form = T.h("div", { class: "agent-editor" });
                const name = T.h("input", { class: "input", type: "text", value: group.name, maxlength: "32", "aria-label": t("groupName") });
                form.append(C.labeledRow(t("groupName"), name));
                sec.append(form);
                const save = C.headAction(t("save"), async () => {
                    const n = name.value.trim();
                    if (!n) {
                        name.focus();
                        return;
                    }
                    if (await saveGroup(group, { name: n })) {
                        for (const s of stack) s.view.spDirty = null;
                        refresh();
                    }
                });
                name.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && !e.isComposing && !save.disabled) save.click();
                });
                C.trackForm(form);

                // 멤버: 누르면 그 에이전트 정보가 다음 화면에 열린다. 빼기는 길게 누르거나 우클릭한 메뉴에서 한다.
                sec.append(C.fieldLabel(t("groupMemberCount", { n: group.members.length })));
                for (const uuid of group.members) {
                    const a = agentByUuid(uuid);
                    if (!a) continue;
                    const canRemove = group.members.length > 2;
                    sec.append(
                        agentRow(a, {
                            onclick: () => push(agentScreen(uuid)),
                            menu: canRemove
                                ? () => [{ label: t("groupRemoveMember"), danger: true, onSelect: () => removeMember(group, uuid) }]
                                : null,
                        }),
                    );
                }
                const others = C.agentList().filter((a) => a.uuid && !group.members.includes(a.uuid));
                if (others.length) sec.append(C.actionRow(t("groupAddMembers"), () => push(addMembersScreen(id)), { icon: "plus" }));
                sec.append(T.h("div", { class: "set-desc", text: t("groupsDesc") }));
                sec.append(C.actionRow(t("groupDelete"), () => deleteGroup(group), { danger: true, own: true }));
                body.append(sec);
            },
        };
    }

    function addMembersScreen(id) {
        const chosen = [];
        return {
            key: `group:${id}:add`,
            title: () => t("groupAddMembers"),
            build(body) {
                const group = groupById(id);
                if (!group) {
                    body.append(T.h("div", { class: "empty-note", text: t("groupGone") }));
                    return;
                }
                const others = C.agentList().filter((a) => a.uuid && !group.members.includes(a.uuid));
                body.append(T.h("div", { class: "set-section" }, agentChecklist(others, chosen)));
                C.headAction(t("add"), async () => {
                    if (!chosen.length) return;
                    if (await saveGroup(group, { members: [...group.members, ...chosen] })) {
                        chosen.length = 0;
                        pop();
                        refresh();
                    }
                });
                C.viewSlot.dirty = () => chosen.length > 0;
            },
        };
    }

    // 첫 화면 밑에 깔린 화면: 채팅에서 열었으면 채팅(#main), 대화 목록에서 열었으면(+ 메뉴) 목록(#sidebar).
    function underLayer() {
        return document.getElementById(document.body.classList.contains("mobile-chat") ? "main" : "sidebar");
    }

    /* ── 뒤로 제스처(ui/gestures.js) ────────────────────────────
       할 일 상세 화면과 같은 약속: begin은 밀려 나갈 위 화면과 그 밑에서 드러날 화면을 돌려준다.
       첫 화면이면 밑은 패널을 연 화면(채팅이나 대화 목록)이다. */
    const gesture = {
        host: () => host,
        canPop: () => isMobile() && isOpen(),
        begin() {
            clearTimeout(timer);
            const top = stack[stack.length - 1].view;
            for (const v of [...host.querySelectorAll(".sp-view")]) if (v !== top) v.remove();
            top.classList.remove("sp-in-right", "sp-in-left");
            if (stack.length < 2) return { top, under: underLayer(), sub: false };
            const under = settle(stack[stack.length - 2].view);
            host.prepend(under);
            return { top, under, sub: true };
        },
        end(commit, { top, under, sub }) {
            if (!commit) {
                if (sub) under.remove();
                return;
            }
            if (!top.spDirty?.()) {
                // 이미 손가락을 따라 다 넘어왔으므로 애니메이션 없이 상태만 바꾼다.
                if (!sub) {
                    close(true);
                    return;
                }
                top.remove();
                stack.pop();
                return;
            }
            // 저장하지 않은 입력이 있다. 밀어낸 화면을 제자리에 두고 버릴지 묻는다.
            if (sub) under.remove();
            void confirmLeave([stack[stack.length - 1]]).then((ok) => {
                if (!ok) return;
                if (sub) pop();
                else close();
            });
        },
    };

    /* ── 진입점 ─────────────────────────────────────────────── */
    function screenFor(chat) {
        if (chat?.isGroup) return groupScreen(chat.uuid);
        return chat?.uuid ? agentScreen(chat.uuid) : null;
    }

    // 대화방(그룹이면 그룹 정보, 에이전트면 에이전트 정보)을 연다. 이미 그 대화방의 정보가 열려 있으면 닫는다.
    function openFor(chat) {
        const screen = screenFor(chat);
        if (!screen) return;
        if (isOpen() && stack[0].screen.key === screen.key) {
            void backFrom(1);
            return;
        }
        void start(screen);
    }

    // 사이드바 + 버튼: 무엇을 만들지 고르는 메뉴.
    // 사이드바 + 버튼 메뉴의 항목.
    function newMenuItems() {
        return [
            { label: t("newAgent"), icon: "person", defer: true, onSelect: () => void start(agentScreen(null)) },
            { label: t("groupNew"), icon: "users", defer: true, onSelect: () => void start(newGroupScreen()) },
        ];
    }

    // 다른 대화방으로 옮기면 데스크톱의 정보 열도 그 대화방 것으로 바꾼다(고친 것이 있으면 그대로 둔다).
    function followCurrent() {
        if (!isOpen() || isMobile() || !stack[0].screen.chat) return;
        const screen = screenFor(state.currentChat());
        if (!screen || screen.key === stack[0].screen.key || stack.some((s) => s.view.spDirty?.())) return;
        const gone = stack.slice(1).map((s) => s.view);
        stack = [{ screen, view: buildView(screen, 1) }];
        show(null, gone);
    }

    state.on("bots", refresh);
    state.on("settings", refresh);
    state.on("current", followCurrent);
    // 화면 폭이 모바일과 데스크톱 사이를 오가면 층의 자리가 달라진다. 닫고 새로 열게 한다.
    mobileMq.addEventListener?.("change", () => close(true, false));

    // 뒤로 가기: 패널이 열려 있으면 이전 주소로 가지 않고 패널을 닫는다. app.js의 라우터보다 먼저 받는다(스크립트 순서).
    window.addEventListener("popstate", (e) => {
        if (skipPop) {
            skipPop = false;
            e.stopImmediatePropagation();
            return;
        }
        if (!historyEntry) return;
        historyEntry = false;
        if (!isOpen()) return;
        e.stopImmediatePropagation();
        void confirmLeave(stack).then((ok) => {
            if (ok) close(false, false);
            // 버리지 않겠다면 패널을 그대로 두고 기록 칸을 다시 넣는다.
            else addHistory();
        });
    });

    T.chatInfo = {
        open: openFor,
        newAgent: () => void start(agentScreen(null)),
        newGroup: (preset) => void start(newGroupScreen(preset)),
        newMenuItems,
        // 다른 화면(설정, 할 일 등)으로 옮겨 가며 닫는다. 그 화면이 이미 주소를 바꿨으므로 기록은 건드리지 않는다.
        close: (instant) => close(instant, false),
        isOpen,
        gesture,
    };
})(window.Taby);
