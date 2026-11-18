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

    /* ── 대화 활동 창 ───────────────────────────────────────── */
    // 헤더의 i 버튼으로 여는 창. 이 대화에서 모델이 한 일의 통계(턴별)를 보여 준다.
    // 행은 설정의 valueRow(.set-row)를 그대로 쓴다.
    function fmtNum(n, lang) {
        try {
            return Number(n).toLocaleString(lang);
        } catch {
            return String(n);
        }
    }

    function actStat(stats, lang) {
        const parts = [];
        if (stats.modelCallCount != null) parts.push(t("statModelCalls", { n: fmtNum(stats.modelCallCount, lang) }));
        if (stats.toolCallCount != null) parts.push(t("statToolCalls", { n: fmtNum(stats.toolCallCount, lang) }));
        if (stats.tokensUsed != null && stats.contextWindow) {
            parts.push(t("statTokens", { used: fmtNum(stats.tokensUsed, lang), window: fmtNum(stats.contextWindow, lang) }));
        }
        return parts.join(" · ");
    }

    // 턴 행의 시각: 오늘이면 시:분, 어제 이전이면 날짜. (사이드바 목록과 같은 dayDiff 순서)
    function actTime(at) {
        const d = new Date(at);
        if (!Number.isFinite(d.getTime())) return "";
        const days = T.time.dayDiff(new Date(), d);
        try {
            if (days <= 0) return T.time.format(d, { hour: "numeric", minute: "2-digit" });
            return T.time.format(d, { month: "numeric", day: "numeric" });
        } catch {
            return "";
        }
    }

    // 활동 창의 전체 섹션: 컨텍스트 윈도우가 얼마나 찼는지 링으로 보여 준다.
    function contextRing(stats, lang) {
        const used = Number(stats?.tokensUsed) || 0;
        const win = Number(stats?.contextWindow) || 0;
        const pct = win ? Math.min(1, used / win) : 0;
        const R = 26;
        const C = 2 * Math.PI * R;
        const wrap = T.h("div", { class: "ci-ring-wrap" });
        wrap.innerHTML = `<svg class="ci-ring" viewBox="0 0 64 64" aria-hidden="true">
            <circle class="ci-ring-track" cx="32" cy="32" r="${R}"></circle>
            <circle class="ci-ring-fill" cx="32" cy="32" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}"></circle>
        </svg>`;
        const pctText = win ? `${Math.round(pct * 100)}%` : "–";
        wrap.append(
            T.h("span", { class: "ci-ring-pct", text: pctText }),
            T.h("span", {
                class: "ci-ring-label",
                text: win ? t("statTokens", { used: fmtNum(used, lang), window: fmtNum(win, lang) }) : t("activityEmpty"),
            }),
        );
        return wrap;
    }

    // 턴 행: 누르면 그 턴의 상세 창(i.turn)을 연다. 활동 창 바로 오른쪽에 낀다(from 지정).
    function turnRow(uuid, index, turn) {
        return T.h(
            "button",
            {
                type: "button",
                class: "set-row nav-row",
                onclick: () => T.windows.open(`i.turn:${uuid}/${index}`, { from: `i.activity:${uuid}` }),
            },
            [
                T.h("span", { class: "set-label", text: t("turnLabel", { n: index + 1 }) }),
                T.h("span", { class: "nav-val", text: actTime(turn.at) }),
                T.icon("chevron", "nav-chev"),
            ],
        );
    }

    async function renderActivity(pane, convId) {
        pane.replaceChildren(T.h("div", { class: "empty-note", text: t("loading") }));
        let conv = state.conv(convId);
        if (!conv.fetchedAt) {
            try {
                await state.refreshTurns(convId);
            } catch {
                // 기록을 못 받으면 안내만 보여 준다
                pane.replaceChildren(T.h("div", { class: "empty-note", text: t("loadFailed") }));
                return;
            }
            conv = state.conv(convId);
        }
        const lang = T.i18n.getLang();
        const turns = conv.turns || [];
        const sec = T.h("div", { class: "set-section" });
        if (!turns.length) {
            sec.append(T.h("div", { class: "empty-note", text: t("activityEmpty") }));
            pane.replaceChildren(sec);
            return;
        }
        // 전체: 마지막 턴의 토큰 사용량으로 컨텍스트 채움률을 링으로 보여 준다.
        const lastStats = [...turns].reverse().find((turn) => turn.stats)?.stats || null;
        sec.append(T.h("div", { class: "field-label", text: t("activityContext") }));
        sec.append(T.h("div", { class: "set-group" }, [contextRing(lastStats, lang)]));
        // 모든 턴: 턴별 한 줄. 누르면 그 턴의 상세 창이 열린다.
        // 비동기로 채워도 창의 groupRows를 기다리지 않게 여기서 직접 한 카드로 묶는다.
        sec.append(C.fieldLabel(t("turnsAll")));
        const list = T.h("div", { class: "set-group" });
        for (let i = turns.length - 1; i >= 0; i--) list.append(turnRow(convId, i, turns[i]));
        sec.append(list);
        pane.replaceChildren(sec);
    }

    function activityScreen(uuid) {
        return {
            on: ON,
            gone: () => !state.chatByUuid(uuid),
            title: () => t("activityTitle"),
            build(body) {
                void renderActivity(body, uuid);
            },
        };
    }

    /* ── 턴 상세 창 ─────────────────────────────────────────── */
    // i.turn:<uuid>/<index>. 서버에서 받은 항목(user/say/assistant/ask)을 순서대로 보여 준다.
    // 도구 인자·결과의 값을 사람이 읽을 수 있는 한 줄로. 객체는 읽기 좋은 키(title/name/text 등)를 골라 붙인다.
    const FRIENDLY_KEYS = [
        "title",
        "name",
        "text",
        "question",
        "content",
        "message",
        "path",
        "command",
        "url",
        "status",
        "state",
        "agent",
        "session",
    ];
    const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

    function friendlyValue(v) {
        if (v == null) return "";
        if (typeof v !== "object") return String(v);
        const picked = [];
        for (const k of FRIENDLY_KEYS) {
            const val = v[k];
            if (typeof val === "string" && val.trim()) picked.push(val.trim());
            else if (typeof val === "number" || typeof val === "boolean") picked.push(String(val));
        }
        return clip(picked.length ? picked.join(" · ") : JSON.stringify(v), 200);
    }

    function isEmptyValue(v) {
        return Array.isArray(v) ? !v.length : typeof v === "object" && v !== null && !Object.keys(v).length;
    }

    function kvRows(obj) {
        // 도구 인자·결과를 행 목록으로. raw JSON 한 줄 대신: 배열은 요소별 행, 객체는 친화적 요약,
        // 빈 배열·객체는 소음이라 건너뛴다. 긴 값은 잘라 넣고 전문은 title에 둔다.
        if (obj == null) return [];
        if (typeof obj !== "object") return [{ v: clip(String(obj)) }];
        const rows = [];
        for (const [k, v] of Object.entries(obj)) {
            if (k === "ok") continue;
            if (isEmptyValue(v)) continue;
            if (Array.isArray(v)) {
                for (const el of v) rows.push({ k, v: clip(friendlyValue(el)), full: clip(JSON.stringify(el), 2000) });
                continue;
            }
            if (typeof v === "object") {
                rows.push({ k, v: clip(friendlyValue(v)), full: clip(JSON.stringify(v), 2000) });
                continue;
            }
            const s = String(v);
            if (!s) continue;
            rows.push({ k, v: clip(s), full: s });
        }
        return rows;
    }

    function textRow(text) {
        return T.h("div", { class: "set-row ci-turn-row" }, [T.h("span", { class: "set-label", text })]);
    }

    function kvRow(row, danger) {
        return T.h("div", { class: "set-row", title: row.full || row.v }, [
            T.h("span", { class: "set-label", text: row.k || "" }),
            T.h("span", { class: "nav-val", ...(danger ? { style: "color: var(--danger)" } : {}), text: row.v }),
        ]);
    }

    // 도구 호출 행: 누르면 그 호출의 상세 창(i.tool)을 연다.
    function argSummary(args) {
        if (!args || typeof args !== "object") return friendlyValue(args);
        const vals = [];
        for (const v of Object.values(args)) {
            if (typeof v === "string" && v.trim()) vals.push(v.trim());
            else if (typeof v === "number" || typeof v === "boolean") vals.push(String(v));
        }
        return clip(vals.join(" · "), 60);
    }

    function callRow(uuid, turnIndex, flatIndex, call) {
        const failed = call.result && typeof call.result === "object" && (call.result.error || call.result.ok === false);
        return T.h(
            "button",
            {
                type: "button",
                class: "set-row nav-row",
                // 턴 상세 창 바로 오른쪽에 끼워 넣는다(from 미지정 시 띠의 맨 왼쪽에 붙는다).
                onclick: () => T.windows.open(`i.tool:${uuid}/${turnIndex}/${flatIndex}`, { from: `i.turn:${uuid}/${turnIndex}` }),
            },
            [
                T.h("span", { class: "set-label", text: call.name }),
                T.h("span", {
                    class: "nav-val",
                    ...(failed ? { style: "color: var(--danger)" } : {}),
                    text: argSummary(call.args) || (failed ? t("dResultFail") : ""),
                }),
                T.icon("chevron", "nav-chev"),
            ],
        );
    }

    async function renderTurnDetail(pane, uuid, index) {
        pane.replaceChildren(T.h("div", { class: "empty-note", text: t("loading") }));
        let data;
        try {
            data = await T.api.turnDetail(uuid, index);
        } catch {
            pane.replaceChildren(T.h("div", { class: "empty-note", text: t("loadFailed") }));
            return;
        }
        const lang = T.i18n.getLang();
        const sec = T.h("div", { class: "set-section" });
        sec.append(
            T.h("div", { class: "set-desc", text: [actTime(data.at), data.stats ? actStat(data.stats, lang) : ""].filter(Boolean).join(" · ") }),
        );
        if (!data.items?.length) {
            sec.append(T.h("div", { class: "empty-note", text: t("turnEmpty") }));
            pane.replaceChildren(sec);
            return;
        }
        // 도구 호출의 전역 순번: 턴 상세 창의 행과 i.tool 창을 이어주는 인덱스다.
        let flatCallIndex = 0;
        for (const item of data.items) {
            if (item.kind === "user") {
                sec.append(C.fieldLabel(t("dUser")));
                sec.append(T.h("div", { class: "set-group" }, [textRow(item.text)]));
                continue;
            }
            if (item.kind === "say" || item.kind === "assistant") {
                if (item.text) {
                    sec.append(C.fieldLabel(item.kind === "say" ? t("dSay") : t("dAssistant")));
                    sec.append(T.h("div", { class: "set-group" }, [textRow(item.text)]));
                }
                // 도구 호출은 인자·결과를 여기 쓰지 않는다. 한 줄 행으로만 두고, 누르면 새 창에서 본다.
                if (item.calls?.length) {
                    sec.append(C.fieldLabel(t("dTool")));
                    const group = T.h("div", { class: "set-group" });
                    for (const call of item.calls) group.append(callRow(uuid, index, flatCallIndex++, call));
                    sec.append(group);
                }
                continue;
            }
            if (item.kind === "ask") {
                sec.append(C.fieldLabel(item.secret ? t("dSecret") : t("dAsk")));
                sec.append(T.h("div", { class: "set-group" }, [textRow(item.question)]));
            }
        }
        pane.replaceChildren(sec);
    }

    function turnScreen(arg) {
        const slash = String(arg || "").lastIndexOf("/");
        if (slash < 0) return null;
        const uuid = arg.slice(0, slash);
        const index = Number(arg.slice(slash + 1));
        if (!uuid || !Number.isInteger(index) || index < 0) return null;
        return {
            on: ON,
            gone: () => !state.chatByUuid(uuid),
            title: () => t("turnDetailTitle"),
            build(body) {
                void renderTurnDetail(body, uuid, index);
            },
        };
    }

    /* ── 도구 호출 상세 창 ──────────────────────────────────── */
    // i.tool:<uuid>/<턴 인덱스>/<호출 순번>. 턴 상세의 도구 행을 눌렀을 때 열린다.
    async function renderToolDetail(pane, uuid, turnIndex, callIndex) {
        pane.replaceChildren(T.h("div", { class: "empty-note", text: t("loading") }));
        let data;
        try {
            data = await T.api.turnDetail(uuid, turnIndex);
        } catch {
            pane.replaceChildren(T.h("div", { class: "empty-note", text: t("loadFailed") }));
            return;
        }
        const call = (data.items || []).flatMap((it) => it.calls || [])[callIndex];
        if (!call) {
            pane.replaceChildren(T.h("div", { class: "empty-note", text: t("turnEmpty") }));
            return;
        }
        const sec = T.h("div", { class: "set-section" });
        const argRows = kvRows(call.args);
        const resRows = kvRows(call.result);
        const failed = call.result && typeof call.result === "object" && (call.result.error || call.result.ok === false);
        if (argRows.length) {
            sec.append(C.fieldLabel(t("dArgs")));
            const group = T.h("div", { class: "set-group" });
            for (const row of argRows) group.append(kvRow(row));
            sec.append(group);
        }
        if (resRows.length) {
            sec.append(C.fieldLabel(failed ? t("dResultFail") : t("dResult")));
            const group = T.h("div", { class: "set-group" });
            for (const row of resRows) group.append(kvRow(row, failed));
            sec.append(group);
        }
        if (!argRows.length && !resRows.length) sec.append(T.h("div", { class: "empty-note", text: "—" }));
        pane.replaceChildren(sec);
    }

    function toolScreen(arg) {
        const parts = String(arg || "").split("/");
        if (parts.length !== 3) return null;
        const [uuid, turnIndex, callIndex] = parts;
        const ti = Number(turnIndex);
        const ci = Number(callIndex);
        if (!uuid || !Number.isInteger(ti) || ti < 0 || !Number.isInteger(ci) || ci < 0) return null;
        return {
            on: ON,
            gone: () => !state.chatByUuid(uuid),
            title: () => t("dTool"),
            build(body) {
                void renderToolDetail(body, uuid, ti, ci);
            },
        };
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
    T.windows.define("i.activity", (arg) => (arg ? activityScreen(arg) : null));
    T.windows.define("i.turn", (arg) => (arg ? turnScreen(arg) : null));
    T.windows.define("i.tool", (arg) => (arg ? toolScreen(arg) : null));

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

    // 헤더의 i 버튼: 지금 보고 있는 대화의 활동 창을 연다. 이미 열려 있으면 닫는다.
    function openActivity(chat) {
        if (!chat?.uuid) return;
        const id = `i.activity:${chat.uuid}`;
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

    T.chatInfo = { open: openFor, openActivity, newAgent, newGroup, newMenuItems };
})(window.Taby);
