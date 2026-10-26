/* tabyBot 웹 클라이언트: 편집 부품(일정·담당·넘기기·제목·지시·동작 버튼). 창(detail.js)이 이것들을 모아 그린다. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    C.handPopFor = null;

    const MODE_LABEL = {
        none: "todosWhenNone",
        today: "todosToday",
        tomorrow: "todosTomorrow",
        custom: "todosPickDate",
        daily: "todosWhenDaily",
        weekly: "todosWhenWeekly",
        monthly: "todosWhenMonthly",
        every: "todosWhenEvery",
        cron: "todosWhenCron",
    };

    // 초안의 일정 모드 이름(세부사항 창의 "일정" 행에 보인다).
    function modeLabel(d) {
        if (d.mode === "everyKeep") return C.everyLabel(d.every || "-");
        if (d.mode === "cronKeep") return C.cronLabel(d.cron) || d.cron || "-";
        return t(MODE_LABEL[d.mode] || "todosWhenNone");
    }

    /* ── 일정 편집(일정 창) ─────────────────────────────────── */
    // ed: 할 일의 편집 상태(draft.js), win: 일정 창. 고른 값은 초안에 들어가고, 저장은 창을 닫을 때 한다.
    function whenEditor(ed, win) {
        const d = C.draftOf(ed);
        // 모드를 바꾸면 이 할 일의 창들(일정 칸, 세부사항의 "일정" 값)을 다시 그린다.
        const setMode = (id) => {
            C.pullFields(ed);
            d.mode = id;
            d.schedTouched = true;
            if (id === "today") d.at = C.todayDefault(d.atTz);
            if (id === "tomorrow") d.at = C.localAt(1, 9, 0, d.atTz);
            if (id === "custom" && !d.at) d.at = C.todayDefault(d.atTz);
            if (id === "today" || id === "tomorrow" || id === "custom") d.atSeed = d.at;
            if (id === "daily" && !d.dailyTime) d.dailyTime = "09:00";
            if (id === "cron" && !String(d.cronText || "").trim()) d.cronText = "0 9 * * *";
            C.redrawTodo(ed.id);
        };
        const chip = (id, label, forceOn) =>
            T.h("button", {
                type: "button",
                class: `td-chip${forceOn || d.mode === id ? " on" : ""}`,
                "aria-pressed": String(Boolean(forceOn || d.mode === id)),
                text: label,
                onclick() {
                    if (d.mode !== id) setMode(id);
                },
            });

        // Enter: 다 골랐다. 일정 창을 닫는다(Esc는 창이 받아 닫는다).
        function whenInputKeys(e) {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                void win.close();
            }
        }

        const chips = Object.keys(MODE_LABEL).map((id) => chip(id, t(MODE_LABEL[id])));
        if (d.keepMode) chips.push(chip(d.keepMode, modeLabel({ ...d, mode: d.keepMode }), d.mode === d.keepMode));

        const wrap = T.h("div", { class: "td-when-editor" }, [T.h("div", { class: "td-chips" }, chips)]);

        function timeInput(value, apply, ariaLabel) {
            const tm = T.h("input", { type: "time", class: "td-input td-time", "aria-label": ariaLabel, value });
            tm.addEventListener("change", () => {
                apply(tm.value);
                d.schedTouched = true;
            });
            tm.addEventListener("keydown", whenInputKeys);
            return tm;
        }
        function numInput(value, apply, ariaLabel, min, max) {
            const n = T.h("input", {
                type: "number",
                class: "td-input td-num",
                "aria-label": ariaLabel,
                min,
                ...(max ? { max } : {}),
                inputmode: "numeric",
                value,
            });
            n.addEventListener("change", () => {
                apply(n.value);
                d.schedTouched = true;
            });
            n.addEventListener("keydown", whenInputKeys);
            return n;
        }
        const row = (kids) => T.h("div", { class: "td-when-row" }, kids);

        if (d.mode === "daily") {
            wrap.append(
                timeInput(
                    d.dailyTime,
                    (v) => {
                        d.dailyTime = v;
                    },
                    t("todosRepeatTime"),
                ),
            );
        } else if (d.mode === "weekly") {
            const days = t("todosWeekdays").split(",");
            const sel = T.h(
                "select",
                { class: "td-input td-sel", "aria-label": t("todosWeeklyDay") },
                days.map((name, i) =>
                    T.h("option", {
                        value: String(i),
                        text: C.lang() === "ja" ? `${name}曜` : name,
                        ...(i === d.weeklyDow ? { selected: true } : {}),
                    }),
                ),
            );
            sel.addEventListener("change", () => {
                d.weeklyDow = Number(sel.value) || 0;
                d.schedTouched = true;
            });
            wrap.append(
                row([
                    sel,
                    timeInput(
                        d.weeklyTime,
                        (v) => {
                            d.weeklyTime = v;
                        },
                        t("todosRepeatTime"),
                    ),
                ]),
            );
        } else if (d.mode === "monthly") {
            wrap.append(
                row([
                    numInput(
                        d.monthlyDom,
                        (v) => {
                            d.monthlyDom = v;
                        },
                        t("todosMonthlyDay"),
                        1,
                        31,
                    ),
                    T.h("span", { class: "td-when-suffix", text: t("todosMonthlyDaySuffix") }),
                    timeInput(
                        d.monthlyTime,
                        (v) => {
                            d.monthlyTime = v;
                        },
                        t("todosRepeatTime"),
                    ),
                ]),
            );
        } else if (d.mode === "every") {
            const units = t("todosEveryUnits").split(",");
            const sel = T.h(
                "select",
                { class: "td-input td-sel", "aria-label": t("todosEveryUnit") },
                ["m", "h", "d"].map((u, i) => T.h("option", { value: u, text: units[i] || u, ...(u === d.everyUnit ? { selected: true } : {}) })),
            );
            sel.addEventListener("change", () => {
                d.everyUnit = sel.value;
                d.schedTouched = true;
            });
            wrap.append(
                row([
                    numInput(
                        d.everyN,
                        (v) => {
                            d.everyN = v;
                        },
                        t("todosEveryN"),
                        1,
                    ),
                    sel,
                ]),
            );
        } else if (d.mode === "everyKeep") {
            wrap.append(row([T.h("span", { class: "td-when-suffix", text: C.everyLabel(d.every) })]));
        } else if (d.mode === "cron") {
            const inp = T.h("input", {
                type: "text",
                class: "td-input td-cron",
                "aria-label": t("todosCronExpr"),
                placeholder: "0 9 * * 1-5",
                value: d.cronText,
                spellcheck: "false",
                autocomplete: "off",
            });
            const hint = T.h("div", { class: "td-cron-hint" });
            const showHint = () => {
                hint.textContent = C.cronLabel(inp.value) || "";
            };
            inp.addEventListener("input", () => {
                d.cronText = inp.value;
                d.schedTouched = true;
                showHint();
            });
            inp.addEventListener("keydown", whenInputKeys);
            showHint();
            wrap.append(inp, hint);
        } else if (d.mode === "today" || d.mode === "tomorrow" || d.mode === "custom") {
            const date = T.h("input", {
                type: "datetime-local",
                class: "td-input td-date",
                "aria-label": t("todosDate"),
                value: d.at,
                min: C.nowLocalInput(d.atTz),
            });
            date.addEventListener("keydown", whenInputKeys);
            date.addEventListener("change", () => {
                d.schedTouched = true;
                if (!date.value) return;
                d.at = date.value;
                // 오늘/내일로 고른 뒤 날짜를 직접 바꿨으면 "날짜 선택"으로 옮겨 보인다.
                if (d.mode !== "custom" && date.value !== d.atSeed) {
                    d.mode = "custom";
                    C.pullFields(ed);
                    setTimeout(() => C.redrawTodo(ed.id), 0);
                }
            });
            wrap.append(date);
            if (d.atTz && d.atTz !== C.browserTz()) wrap.append(T.h("span", { class: "td-tz-note", text: `(${d.atTz})` }));
        }
        return wrap;
    }

    /* ── 담당 바꾸기 ─────────────────────────────────────────── */
    // 담당을 바로 바꾼다(fn). 그 할 일의 창에 고친 것이 있으면 같이 저장한다(담당을 바꾸면 서버의 수정 시각이 바뀌어 나중 저장이 부딪히므로).
    async function assignFor(item, fn, toastMsg) {
        await C.lock();
        const ed = C.eds.get(item.id);
        C.pullFields(ed);
        const parsed = ed?.draft ? C.draftToPatch(ed.draft) : null;
        const changed = parsed && !parsed.error && Object.keys(parsed.body).length > 0;
        if (parsed?.error) C.toastPatchError(parsed.error);
        try {
            await fn();
            if (changed) {
                await state.fetchTodos();
                await T.api.updateTodo(item.id, { ...parsed.body, baseUpdatedAt: C.item(item.id)?.updatedAt ?? ed.draft?.base });
            }
            if (ed && parsed && !parsed.error) ed.draft = null;
            if (C.handPopFor === item.id) C.handPopFor = null;
            if (toastMsg) T.toast.show("info", toastMsg);
            await C.refresh();
        } catch (err) {
            T.toast.show("error", C.humanErr(err));
            C.refresh().catch(() => {
                /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
            });
        } finally {
            C.unlock();
        }
    }

    // 맡은 에이전트로 넘기는 동작. 제안한 에이전트면 제안을 받아들이고, 아니면 바로 맡긴다.
    function assignTo(item, agentId) {
        return () => {
            const cur = C.item(item.id);
            if (!cur || cur.assignee?.id === agentId) return;
            const offered = (cur.offers || []).find((o) => o.agentId === agentId);
            return offered ? T.api.acceptHandoff(item.id, agentId) : T.api.updateTodo(item.id, { assigneeId: agentId });
        };
    }

    // 맡기지 않고 내가 하는 일로 되돌린다.
    function unassign(item) {
        return () => {
            if (!C.item(item.id)?.assigneeId) return;
            return T.api.unassignTodo(item.id);
        };
    }

    function assigneeRow(item) {
        const who = item.assignee?.name || t("todosAssigneeRemoved");
        return T.h("div", { class: "td-offer-row td-hand-cur" }, [
            C.dotEl(item.assignee?.color || "#8e8e93"),
            T.h("span", { class: "td-offer-name", text: t("todosAssignedTo", { name: who }) }),
            T.h("span", { class: "td-spacer" }),
            T.h("button", {
                type: "button",
                class: "td-chip",
                text: item.status === "done" ? t("todosUnassignDone") : t("todosUnassign"),
                onclick: (e) => {
                    e.stopPropagation();
                    void assignFor(item, unassign(item), t("todosMovedDirect"));
                },
            }),
        ]);
    }

    // 목록 행의 넘기기 메뉴: 지금 담당, 제안한 에이전트들, 나머지 에이전트들.
    function handPop(item, offers, bots) {
        const pop = T.h("div", { class: "td-hand-pop", role: "listbox", "aria-label": t("todosAssignLabel") });
        pop.addEventListener("click", (e) => e.stopPropagation());
        if (item.assigneeId) pop.append(assigneeRow(item));

        const pick = (id, name, color, reason) =>
            T.h(
                "button",
                {
                    type: "button",
                    class: "td-hand-item",
                    onclick: (e) => {
                        e.stopPropagation();
                        void assignFor(item, assignTo(item, id), t("todosAssignedTo", { name }));
                    },
                },
                [
                    C.dotEl(color),
                    T.h("span", { class: "td-offer-main" }, [
                        T.h("span", { class: "td-offer-name", text: name }),
                        reason ? T.h("span", { class: "td-offer-reason", text: reason }) : null,
                    ]),
                ],
            );

        if (offers.length) {
            pop.append(T.h("div", { class: "td-hand-sec", text: t("todosOffersLabel") }));
            for (const o of offers) pop.append(pick(o.agentId, o.name, o.color, o.reason));
        }
        const others = bots.filter((b) => !offers.some((o) => o.agentId === b.id));
        if (others.length) {
            pop.append(T.h("div", { class: "td-hand-sec", text: offers.length ? t("todosHandoffOthers") : t("todosAssignLabel") }));
            for (const b of others) pop.append(pick(b.id, b.name, b.color, null));
        }
        requestAnimationFrame(() => {
            if (pop.isConnected && pop.getBoundingClientRect().bottom > T.visibleHeight() - 8) pop.classList.add("up");
        });
        return pop;
    }

    // 목록 행 오른쪽의 넘기기 버튼. 에이전트가 맡겠다고 제안한 일에만 보인다.
    function handoffEl(item) {
        if (item.status === "done") return null;
        const offers = (item.offers || []).filter((o) => o.agentId !== item.assigneeId);
        if (!offers.length) return null;
        const bots = (state.state.bots || []).filter((b) => b.id !== item.assigneeId);

        const wrap = T.h("span", { class: "td-hand-wrap" });
        const open = C.handPopFor === item.id;
        const btn = T.h("button", {
            type: "button",
            class: `td-handoff has${open ? " on" : ""}`,
            "aria-haspopup": "listbox",
            "aria-expanded": String(open),
            onclick(e) {
                e.stopPropagation();
                C.handPopFor = open ? null : item.id;
                C.build();
            },
        });
        btn.append(
            T.h(
                "span",
                { class: "td-dots" },
                offers.slice(0, 3).map((o) => C.dotEl(o.color)),
            ),
        );
        const label =
            offers.length === 1
                ? t("todosHandoffTo", { name: offers[0].name })
                : t("todosHandoffToMore", { name: offers[0].name, n: offers.length - 1 });
        btn.append(T.h("span", { class: "td-handoff-t", text: label }));
        wrap.append(btn);
        if (open) wrap.append(handPop(item, offers, bots));
        return wrap;
    }

    // 끝난 일의 담당: 맡았던 에이전트와 되돌리기.
    function offersEl(item) {
        if (item.status === "done" && item.assigneeId) {
            return T.h("div", { class: "td-edit-offers" }, [assigneeRow(item)]);
        }
        return null;
    }

    /* ── 세부사항 창의 부품 ──────────────────────────────────── */
    // 에이전트가 답을 기다리는 일: 질문과 그 대화로 가는 버튼.
    function waitNote(item) {
        if (!item.waiting) return null;
        const q = String(item.waiting.question || "")
            .replace(/\s+/g, " ")
            .trim();
        return T.h("div", { class: "td-wait-note" }, [
            T.h("span", { class: "td-wait-label" }, [C.dotEl(item.assignee?.color || "var(--warning)"), T.h("span", { text: t("todosNeedsYou") })]),
            q ? T.h("div", { class: "td-wait-question", text: q }) : null,
            T.h("button", {
                type: "button",
                class: "btn ghost td-wait-go",
                text: t("todosGoAnswer"),
                onclick: (e) => {
                    e.stopPropagation();
                    const convId = item.waiting?.convId;
                    if (!convId) return;
                    // 본문만 그 대화로 바꾼다. 열린 창들은 그대로 둔다.
                    T.util.pushUrl(`/a/${encodeURIComponent(convId)}`);
                    T.app?.renderRoute?.();
                },
            }),
        ]);
    }

    // 제목 칸: 체크(자동화 작업은 멈춤) + 제목. Enter는 창을 닫아 저장한다(Esc는 창이 받아 닫는다).
    function titleHead(item, ed, win) {
        const checked = item.status === "done" || (!C.isJob(item) && !!item.periodDone);
        const title = T.h("input", {
            type: "text",
            class: "td-edit-title",
            value: C.draftOf(ed).title,
            maxlength: "200",
            autocomplete: "off",
            placeholder: t("todosTitle"),
            "aria-label": t("todosTitle"),
        });
        title.addEventListener("input", () => {
            C.draftOf(ed).title = title.value;
        });
        title.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                void win.close();
            }
        });
        return T.h("div", { class: "td-edit-head" }, [C.isJob(item) && item.status !== "done" ? C.pauseBtn(item) : C.checkBtn(item, checked), title]);
    }

    // 에이전트에게 줄 지시. 맡긴 일이거나 지시가 이미 있을 때만 보인다.
    function promptEl(item, ed) {
        const d = C.draftOf(ed);
        if (!item.assigneeId && !String(item.prompt || "").trim() && !String(d.prompt || "").trim()) return null;
        const prompt = T.h("textarea", {
            class: "td-edit-prompt",
            rows: "1",
            maxlength: "4000",
            placeholder: t("todosPromptHint"),
            "aria-label": t("todosPromptHint"),
        });
        prompt.value = d.prompt;
        const grow = () => {
            prompt.style.height = "auto";
            prompt.style.height = `${Math.min(prompt.scrollHeight, 140)}px`;
        };
        prompt.addEventListener("input", () => {
            C.draftOf(ed).prompt = prompt.value;
            grow();
        });
        requestAnimationFrame(grow);
        return prompt;
    }

    // 지금 실행: 고친 것이 있으면 먼저 저장한 뒤 실행한다.
    async function dispatchRun(item, b) {
        if (b.disabled || C.dispatching.has(item.id)) return;
        C.dispatching.add(item.id);
        b.disabled = true;
        try {
            const ed = C.eds.get(item.id);
            if (ed?.draft && !(await C.commitDraft(ed))) return;
            await C.lock();
            try {
                await T.api.runTodo(item.id);
            } finally {
                C.unlock();
            }
            T.toast.show("info", t("todosQueued"));
        } catch (err) {
            T.toast.show("error", C.humanErr(err));
        } finally {
            C.dispatching.delete(item.id);
            b.disabled = false;
        }
    }

    function runBtn(item) {
        if (!(item.executor || item.assignee) || item.status === "done") return null;
        return T.h("button", {
            type: "button",
            class: "btn ghost",
            text: item.running ? t("todosRunning") : t("todosRunNow"),
            disabled: !!item.running,
            onclick: (e) => void dispatchRun(item, e.currentTarget),
        });
    }

    // 삭제: 묻고 지운 뒤 창을 닫는다. 이 할 일의 다른 창(일정·담당)은 목록을 다시 받으면 대상이 없어 닫힌다.
    function deleteBtn(item, win) {
        const btn = T.h("button", {
            type: "button",
            class: "btn ghost td-foot-del",
            text: t("delete"),
            async onclick() {
                const ok = await T.confirm({
                    title: t("confirmDeleteTitle", { name: (item.title || "").trim() || t("todos") }),
                    text: t("confirmDeleteText"),
                    confirmLabel: t("delete"),
                    danger: true,
                });
                if (!ok || !C.item(item.id)) return;
                btn.disabled = true;
                await C.lock();
                const rowEl = page.querySelector(`.td-row[data-id="${item.id}"]`);
                const neighbor = rowEl?.nextElementSibling?.dataset?.id || rowEl?.previousElementSibling?.dataset?.id || null;
                try {
                    await T.api.deleteTodo(item.id);
                    C.eds.delete(item.id);
                    if (neighbor) C.focusRowId = neighbor;
                    void win.close({ force: true });
                    await C.refresh();
                } catch (err) {
                    btn.disabled = false;
                    T.toast.show("error", C.humanErr(err));
                } finally {
                    C.unlock();
                }
            },
        });
        return btn;
    }

    C.modeLabel = modeLabel;
    C.whenEditor = whenEditor;
    C.assignFor = assignFor;
    C.assignTo = assignTo;
    C.unassign = unassign;
    C.handoffEl = handoffEl;
    C.offersEl = offersEl;
    C.waitNote = waitNote;
    C.titleHead = titleHead;
    C.promptEl = promptEl;
    C.runBtn = runBtn;
    C.deleteBtn = deleteBtn;
})(window.Taby);
