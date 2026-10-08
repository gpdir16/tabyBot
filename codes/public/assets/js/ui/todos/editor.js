/* tabyBot 웹 클라이언트: 편집 패널(일정·담당·넘기기). */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    C.handPopFor = null;

    /* ── 편집 패널(행이 채워진 상태) ────────────────────────── */
    function whenEditor() {
        const chip = (id, label, forceOn) =>
            T.h("button", {
                type: "button",
                class: `td-chip${forceOn || C.draft.mode === id ? " on" : ""}`,
                "aria-pressed": String(Boolean(forceOn || C.draft.mode === id)),
                text: label,
                onclick() {
                    if (!C.draft || C.draft.mode === id) return;
                    C.pullFields();
                    C.draft.mode = id;
                    C.draft.schedTouched = true;
                    if (id === "today") C.draft.at = C.todayDefault(C.draft.atTz);
                    if (id === "tomorrow") C.draft.at = C.localAt(1, 9, 0, C.draft.atTz);
                    if (id === "custom" && !C.draft.at) C.draft.at = C.todayDefault(C.draft.atTz);
                    if (id === "today" || id === "tomorrow" || id === "custom") C.draft.atSeed = C.draft.at;
                    if (id === "daily" && !C.draft.dailyTime) C.draft.dailyTime = "09:00";
                    if (id === "cron" && !String(C.draft.cronText || "").trim()) C.draft.cronText = "0 9 * * *";
                    C.build();
                },
            });

        function whenInputKeys(e) {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                C.saveEdit();
            } else if (e.key === "Escape" && !e.isComposing) {
                e.preventDefault();
                C.cancelEdit();
            }
        }

        const chips = [
            chip("none", t("todosWhenNone")),
            chip("today", t("todosToday")),
            chip("tomorrow", t("todosTomorrow")),
            chip("custom", t("todosPickDate")),
            chip("daily", t("todosWhenDaily")),
            chip("weekly", t("todosWhenWeekly")),
            chip("monthly", t("todosWhenMonthly")),
            chip("every", t("todosWhenEvery")),
            chip("cron", t("todosWhenCron")),
        ];
        if (C.draft.keepMode === "everyKeep") chips.push(chip("everyKeep", C.everyLabel(C.draft.every || "-"), C.draft.mode === "everyKeep"));
        if (C.draft.keepMode === "cronKeep")
            chips.push(chip("cronKeep", C.cronLabel(C.draft.cron) || C.draft.cron || "-", C.draft.mode === "cronKeep"));

        const wrap = T.h("div", { class: "td-when-editor" }, [T.h("div", { class: "td-chips" }, chips)]);

        function timeInput(value, apply, ariaLabel) {
            const tm = T.h("input", { type: "time", class: "td-input td-time", "aria-label": ariaLabel, value });
            tm.addEventListener("change", () => {
                if (!C.draft) return;
                apply(tm.value);
                C.draft.schedTouched = true;
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
                if (!C.draft) return;
                apply(n.value);
                C.draft.schedTouched = true;
            });
            n.addEventListener("keydown", whenInputKeys);
            return n;
        }
        const row = (kids) => T.h("div", { class: "td-when-row" }, kids);

        if (C.draft.mode === "daily") {
            wrap.append(
                timeInput(
                    C.draft.dailyTime,
                    (v) => {
                        C.draft.dailyTime = v;
                    },
                    t("todosRepeatTime"),
                ),
            );
        } else if (C.draft.mode === "weekly") {
            const days = t("todosWeekdays").split(",");
            const sel = T.h(
                "select",
                { class: "td-input td-sel", "aria-label": t("todosWeeklyDay") },
                days.map((name, i) =>
                    T.h("option", {
                        value: String(i),
                        text: C.lang() === "ja" ? `${name}曜` : name,
                        ...(i === C.draft.weeklyDow ? { selected: true } : {}),
                    }),
                ),
            );
            sel.addEventListener("change", () => {
                if (!C.draft) return;
                C.draft.weeklyDow = Number(sel.value) || 0;
                C.draft.schedTouched = true;
            });
            wrap.append(
                row([
                    sel,
                    timeInput(
                        C.draft.weeklyTime,
                        (v) => {
                            C.draft.weeklyTime = v;
                        },
                        t("todosRepeatTime"),
                    ),
                ]),
            );
        } else if (C.draft.mode === "monthly") {
            wrap.append(
                row([
                    numInput(
                        C.draft.monthlyDom,
                        (v) => {
                            C.draft.monthlyDom = v;
                        },
                        t("todosMonthlyDay"),
                        1,
                        31,
                    ),
                    T.h("span", { class: "td-when-suffix", text: t("todosMonthlyDaySuffix") }),
                    timeInput(
                        C.draft.monthlyTime,
                        (v) => {
                            C.draft.monthlyTime = v;
                        },
                        t("todosRepeatTime"),
                    ),
                ]),
            );
        } else if (C.draft.mode === "every") {
            const units = t("todosEveryUnits").split(",");
            const sel = T.h(
                "select",
                { class: "td-input td-sel", "aria-label": t("todosEveryUnit") },
                ["m", "h", "d"].map((u, i) =>
                    T.h("option", { value: u, text: units[i] || u, ...(u === C.draft.everyUnit ? { selected: true } : {}) }),
                ),
            );
            sel.addEventListener("change", () => {
                if (!C.draft) return;
                C.draft.everyUnit = sel.value;
                C.draft.schedTouched = true;
            });
            wrap.append(
                row([
                    numInput(
                        C.draft.everyN,
                        (v) => {
                            C.draft.everyN = v;
                        },
                        t("todosEveryN"),
                        1,
                    ),
                    sel,
                ]),
            );
        } else if (C.draft.mode === "everyKeep") {
            wrap.append(row([T.h("span", { class: "td-when-suffix", text: C.everyLabel(C.draft.every) })]));
        } else if (C.draft.mode === "cron") {
            const inp = T.h("input", {
                type: "text",
                class: "td-input td-cron",
                "aria-label": t("todosCronExpr"),
                placeholder: "0 9 * * 1-5",
                value: C.draft.cronText,
                spellcheck: "false",
                autocomplete: "off",
            });
            const hint = T.h("div", { class: "td-cron-hint" });
            const showHint = () => {
                hint.textContent = C.cronLabel(inp.value) || "";
            };
            inp.addEventListener("input", () => {
                if (!C.draft) return;
                C.draft.cronText = inp.value;
                C.draft.schedTouched = true;
                showHint();
            });
            inp.addEventListener("keydown", whenInputKeys);
            showHint();
            wrap.append(inp, hint);
        } else if (C.draft.mode === "today" || C.draft.mode === "tomorrow" || C.draft.mode === "custom") {
            const date = T.h("input", {
                type: "datetime-local",
                class: "td-input td-date",
                "aria-label": t("todosDate"),
                value: C.draft.at,
                min: C.nowLocalInput(C.draft.atTz),
            });
            date.addEventListener("keydown", whenInputKeys);
            date.addEventListener("change", () => {
                if (!C.draft) return;
                C.draft.schedTouched = true;
                if (!date.value) return;
                C.draft.at = date.value;
                if (C.draft.mode !== "custom" && date.value !== C.draft.atSeed) {
                    C.draft.mode = "custom";
                    C.pullFields();
                    setTimeout(() => {
                        if (C.draft && C.editId) C.build();
                    }, 0);
                }
            });
            wrap.append(date);
            if (C.draft.atTz && C.draft.atTz !== C.browserTz()) wrap.append(T.h("span", { class: "td-tz-note", text: `(${C.draft.atTz})` }));
        }
        return wrap;
    }

    function assignFor(item, fn, toastMsg) {
        if (C.saving) {
            C.queuePending(() => {
                if (C.routeFromPath()) assignFor(item, fn, toastMsg);
            });
            return;
        }
        const editing = C.editId === item.id && C.draft;
        if (editing) C.pullFields();
        const parsed = editing ? C.draftToPatch() : null;
        const dirty = parsed && !parsed.error && Object.keys(parsed.body).length > 0;
        if (parsed?.error) T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
        C.saving = true;
        (async () => {
            try {
                await fn();
                if (dirty && C.hasVisible(C.draft?.title)) {
                    await state.fetchTodos();
                    const cur = C.items().find((row) => row.id === item.id);
                    await T.api.updateTodo(item.id, { ...parsed.body, baseUpdatedAt: cur?.updatedAt ?? C.draft?.base });
                }
                if (!parsed?.error && C.editId === item.id) C.draft = null;
                if (C.handPopFor === item.id) C.handPopFor = null;
                if (toastMsg) T.toast.show("info", toastMsg);
                await C.refresh();
            } catch (err) {
                T.toast.show("error", C.humanErr(err));
                C.refresh().catch(() => {
                    /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
                });
            } finally {
                C.saving = false;
                C.runPending();
            }
        })();
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
                    assignFor(
                        item,
                        () => {
                            const cur = C.items().find((row) => row.id === item.id);
                            if (!cur?.assigneeId) return;
                            return T.api.unassignTodo(item.id);
                        },
                        t("todosMovedDirect"),
                    );
                },
            }),
        ]);
    }

    function handPop(item, offers, bots) {
        const pop = T.h("div", { class: "td-hand-pop", role: "listbox", "aria-label": t("todosAssignLabel") });
        pop.addEventListener("click", (e) => e.stopPropagation());
        if (item.assigneeId) pop.append(assigneeRow(item));

        const pick = (id, name, color, reason) => {
            const btn = T.h("button", {
                type: "button",
                class: "td-hand-item",
                onclick: (e) => {
                    e.stopPropagation();
                    assignFor(
                        item,
                        () => {
                            const cur = C.items().find((row) => row.id === item.id);
                            if (!cur || cur.assignee?.id === id) return;
                            const offered = (cur.offers || []).find((o) => o.agentId === id);
                            return offered ? T.api.acceptHandoff(item.id, id) : T.api.updateTodo(item.id, { assigneeId: id });
                        },
                        t("todosAssignedTo", { name }),
                    );
                },
            });
            btn.append(
                C.dotEl(color),
                T.h("span", { class: "td-offer-main" }, [
                    T.h("span", { class: "td-offer-name", text: name }),
                    reason ? T.h("span", { class: "td-offer-reason", text: reason }) : null,
                ]),
            );
            return btn;
        };

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

    function handoffEl(item, onlyOffers) {
        const done = item.status === "done";
        if (done) return null;
        const offers = (item.offers || []).filter((o) => o.agentId !== item.assigneeId);
        const bots = (state.state.bots || []).filter((b) => b.id !== item.assigneeId);
        if (onlyOffers ? !offers.length : !item.assigneeId && !offers.length && !bots.length) return null;

        const wrap = T.h("span", { class: "td-hand-wrap" });
        const open = C.handPopFor === item.id;
        const btn = T.h("button", {
            type: "button",
            class: `td-handoff${offers.length ? " has" : ""}${open ? " on" : ""}`,
            "aria-haspopup": "listbox",
            "aria-expanded": String(open),
            onclick(e) {
                e.stopPropagation();
                C.handPopFor = open ? null : item.id;
                C.build();
            },
        });
        if (offers.length) {
            btn.append(
                T.h(
                    "span",
                    { class: "td-dots" },
                    offers.slice(0, 3).map((o) => C.dotEl(o.color)),
                ),
            );
        }
        const label =
            offers.length === 1
                ? t("todosHandoffTo", { name: offers[0].name })
                : offers.length > 1
                  ? t("todosHandoffToMore", { name: offers[0].name, n: offers.length - 1 })
                  : t("todosHandoff");
        btn.append(T.h("span", { class: "td-handoff-t", text: label }));
        wrap.append(btn);
        if (open) wrap.append(handPop(item, offers, bots));
        return wrap;
    }

    function offersEl(item) {
        if (item.status === "done" && item.assigneeId) {
            return T.h("div", { class: "td-edit-offers" }, [assigneeRow(item)]);
        }
        return null;
    }

    function editEl(item, checked) {
        const title = T.h("input", {
            type: "text",
            class: "td-edit-title",
            value: C.draft.title,
            maxlength: "200",
            autocomplete: "off",
            placeholder: t("todosTitle"),
            "aria-label": t("todosTitle"),
        });
        title.addEventListener("input", () => {
            if (!C.draft) return;
            C.draft.title = title.value;
        });
        title.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && !e.isComposing) {
                e.preventDefault();
                C.cancelEdit();
            } else if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                C.saveEdit();
            }
        });

        const body = [];
        if (item.waiting) {
            const q = String(item.waiting.question || "")
                .replace(/\s+/g, " ")
                .trim();
            body.push(
                T.h("div", { class: "td-wait-note" }, [
                    T.h("span", { class: "td-wait-label" }, [
                        C.dotEl(item.assignee?.color || "var(--warning)"),
                        T.h("span", { text: t("todosNeedsYou") }),
                    ]),
                    q ? T.h("div", { class: "td-wait-question", text: q }) : null,
                    T.h("button", {
                        type: "button",
                        class: "btn ghost td-wait-go",
                        text: t("todosGoAnswer"),
                        onclick: (e) => {
                            e.stopPropagation();
                            const convId = item.waiting?.convId;
                            if (!convId) return;
                            try {
                                if (C.isOpen()) C.hide();
                                history.pushState(null, "", `/a/${encodeURIComponent(convId)}`);
                                T.app?.renderRoute?.();
                            } catch {
                                // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
                            }
                        },
                    }),
                ]),
            );
        }
        if (item.assigneeId || String(item.prompt || "").trim() || String(C.draft.prompt || "").trim()) {
            const prompt = T.h("textarea", {
                class: "td-edit-prompt",
                rows: "1",
                maxlength: "4000",
                placeholder: t("todosPromptHint"),
                "aria-label": t("todosPromptHint"),
            });
            prompt.value = C.draft.prompt;
            const growPrompt = () => {
                prompt.style.height = "auto";
                prompt.style.height = `${Math.min(prompt.scrollHeight, 140)}px`;
            };
            prompt.addEventListener("input", () => {
                if (!C.draft) return;
                C.draft.prompt = prompt.value;
                growPrompt();
            });
            prompt.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && !e.isComposing) {
                    e.preventDefault();
                    C.cancelEdit();
                }
            });
            requestAnimationFrame(growPrompt);
            body.push(prompt);
        }
        if (item.status !== "done") body.push(whenEditor());
        body.push(offersEl(item));

        const doDelete = async () => {
            const rowEl0 = page.querySelector(`.td-row[data-id="${item.id}"]`);
            const neighbor = rowEl0?.nextElementSibling?.dataset?.id || rowEl0?.previousElementSibling?.dataset?.id || null;
            C.saving = true;
            try {
                await T.api.deleteTodo(item.id);
                if (neighbor) C.focusRowId = neighbor;
                if (C.editId === item.id) {
                    C.closeEditor();
                    if (C.routeFromPath()) {
                        T.util.replaceUrl("/t");
                    }
                }
                await C.refresh();
            } catch (err) {
                T.toast.show("error", C.humanErr(err));
                if (C.isOpen()) C.build();
            } finally {
                C.saving = false;
                C.runPending();
            }
        };

        const delBtn = T.h("button", {
            type: "button",
            class: "btn ghost td-foot-del",
            text: t("delete"),
            async onclick() {
                if (!C.draft) return;
                const ok = await T.confirm({
                    title: t("confirmDeleteTitle", { name: (item.title || "").trim() || t("todos") }),
                    text: t("confirmDeleteText"),
                    confirmLabel: t("delete"),
                    danger: true,
                });
                if (!ok || !C.draft || C.editId !== item.id) return;
                if (C.saving) {
                    C.queuePending(() => {
                        if (C.routeFromPath() && C.items().some((row) => row.id === item.id)) void doDelete();
                    });
                    return;
                }
                delBtn.disabled = true;
                await doDelete();
            },
        });

        const cancelBtn = T.h("button", { type: "button", class: "btn ghost td-foot-cancel", text: t("cancel"), onclick: C.cancelEdit });
        const saveBtn = T.h("button", {
            type: "button",
            class: "btn primary td-foot-save",
            text: t("save"),
            async onclick() {
                if (saveBtn.disabled) return;
                saveBtn.disabled = true;
                cancelBtn.disabled = true;
                try {
                    await C.saveEdit();
                } finally {
                    saveBtn.disabled = false;
                    cancelBtn.disabled = false;
                }
            },
        });

        const foot = T.h("div", { class: "td-edit-foot" }, [
            delBtn,
            (item.executor || item.assignee) && item.status !== "done"
                ? (() => {
                      const runNow = async (b) => {
                          if (b.disabled || C.dispatching.has(item.id)) return;
                          if (C.saving) {
                              C.queuePending(() => {
                                  const cur = C.items().find((r) => r.id === item.id);
                                  if (
                                      C.routeFromPath() &&
                                      (cur?.executor || cur?.assigneeId) &&
                                      cur.status === "open" &&
                                      !cur.running &&
                                      !C.dispatching.has(item.id)
                                  )
                                      void runNow(b);
                              });
                              return;
                          }
                          C.dispatching.add(item.id);
                          b.disabled = true;
                          try {
                              C.pullFields();
                              const parsed = C.draft ? C.draftToPatch() : null;
                              if (parsed?.error) {
                                  T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
                                  return;
                              }
                              if (parsed && Object.keys(parsed.body).length) {
                                  const ok = await C.commitDraft();
                                  if (!ok) return;
                              }
                              await T.api.runTodo(item.id);
                              T.toast.show("info", t("todosQueued"));
                          } catch (err) {
                              T.toast.show("error", C.humanErr(err));
                          } finally {
                              C.dispatching.delete(item.id);
                              b.disabled = false;
                          }
                      };
                      return T.h("button", {
                          type: "button",
                          class: "btn ghost",
                          text: item.running ? t("todosRunning") : t("todosRunNow"),
                          disabled: !!item.running,
                          onclick: (e) => void runNow(e.currentTarget),
                      });
                  })()
                : null,
            T.h("span", { class: "td-spacer" }),
            cancelBtn,
            saveBtn,
        ]);

        return T.h("div", { class: "td-edit" }, [
            T.h("div", { class: "td-edit-head" }, [
                C.isJob(item) && item.status !== "done" ? C.pauseBtn(item) : C.checkBtn(item, checked),
                title,
                handoffEl(item, false),
            ]),
            T.h("div", { class: "td-edit-body" }, body),
            foot,
        ]);
    }

    C.assignFor = assignFor;
    C.handoffEl = handoffEl;
    C.editEl = editEl;
})(window.Taby);
