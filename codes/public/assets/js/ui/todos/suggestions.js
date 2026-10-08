/* tabyBot 웹 클라이언트: 에이전트 제안 카드. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    C.seenSugIds = null;

    const actingSug = new Set();

    /* ── 제안 카드 ─────────────────────────────────────────── */
    function suggestionAtDate(row) {
        if (!row?.at) return null;
        const hasOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(String(row.at));
        return C.atDate({ at: row.at, timezone: hasOffset ? "" : C.validTz(row.timezone) });
    }

    function suggestionWhen(row) {
        const rowTz = C.validTz(row.timezone);
        const tz = rowTz && rowTz !== C.browserTz() ? ` (${rowTz})` : "";
        if (row.at) {
            const d = suggestionAtDate(row);
            const foreign = rowTz && rowTz !== C.browserTz() ? rowTz : null;
            return (d ? C.formatDay(d, foreign) : C.formatDay(row.at) || String(row.at)) + (foreign ? tz : "");
        }
        if (row.cron) return (C.cronLabel(row.cron) || row.cron) + tz;
        if (row.every) return C.everyLabel(row.every);
        return "";
    }

    const clipPreview = (v) =>
        String(v ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);

    // 수정 제안이 바꾸려는 항목 이름들(changes)과 바뀌는 값의 미리보기(previews).
    function summarizeEdit(patch, target) {
        const changes = [];
        const previews = [];
        if (patch.title != null && patch.title !== target?.title) {
            changes.push(t("todosFieldTitle"));
            previews.unshift(`${t("todosFieldTitle")}: ${clipPreview(patch.title) || "-"}`);
        }
        if (patch.cron != null || patch.every != null || patch.at != null || patch.clearWhen) changes.push(t("todosFieldWhen"));
        if (patch.timezone != null) {
            changes.push(t("todosFieldTz"));
            previews.push(`${t("todosFieldTz")}: ${clipPreview(patch.timezone) || "-"}`);
        }
        if (patch.prompt != null) previews.push(`${t("todosFieldPrompt")}: ${clipPreview(patch.prompt) || "-"}`);
        return { changes, previews };
    }

    // 카드 아래에 보이는 부연 줄들: 대상, 일정, 지난 시각 경고, 이유, 연쇄 삭제, 변경 요약.
    function describeSuggestion(row, kind, target, patch) {
        const subs = [];
        if (kind !== "add") {
            subs.push(target ? t("todosSuggestTarget", { title: target.title }) : t("todosSuggestTargetGone"));
        }
        const merged = { ...row, ...(kind === "edit" ? patch : {}) };
        const when = suggestionWhen(merged);
        if (when) subs.push(when);
        if (merged.at) {
            const d = suggestionAtDate(merged);
            if (d && d.getTime() < Date.now()) subs.push(t(target?.status === "done" ? "todosSugPastDone" : "todosSugPastWarn"));
        }
        if (row.reason) subs.push(String(row.reason).replace(/\s+/g, " ").trim().slice(0, 200));
        if (kind === "delete" && target) {
            const siblings = C.suggestions().filter((r) => r.id !== row.id && r.targetId === row.targetId).length;
            if (siblings) subs.push(t("todosSuggestCascade", { n: siblings }));
        }
        let previews = [];
        if (kind === "edit") {
            const edit = summarizeEdit(patch, target);
            previews = edit.previews;
            if (edit.changes.length) subs.push(`${t("todosSuggestChanges")}: ${edit.changes.join(", ")}`);
        }
        return { subs, previews };
    }

    // 승인·거절 버튼과 그 동작. 같은 제안에 대한 동작은 동시에 하나만 돈다.
    function suggestionActions(row, kind, targetGone) {
        const approveLabel = kind === "delete" ? t("delete") : kind === "edit" ? t("todosApply") : t("todosApprove");
        const rejectBtn = T.h("button", { type: "button", class: "btn ghost", text: t("todosReject") });
        const approveBtn = targetGone
            ? null
            : T.h("button", {
                  type: "button",
                  class: kind === "delete" ? "btn danger" : "btn primary",
                  text: approveLabel,
              });
        const setBusy = (busy) => {
            if (approveBtn) approveBtn.disabled = busy;
            rejectBtn.disabled = busy;
        };
        const act = async (fn, doneMsg) => {
            if (actingSug.has(row.id)) return;
            const cur = C.suggestions().find((r) => r.id === row.id);
            if (!cur) {
                T.toast.show("info", t("todosSugGone"));
                C.refresh().catch(() => {
                    /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
                });
                return;
            }
            if (C.saving) {
                actingSug.add(row.id);
                C.queuePending(() => {
                    actingSug.delete(row.id);
                    act(fn, doneMsg);
                });
                return;
            }
            actingSug.add(row.id);
            setBusy(true);
            try {
                const res = await fn();
                if (res === false) {
                    setBusy(false);
                    return;
                }
                const newId = res?.item?.id;
                if (newId && kind === "add") C.scrollToRow = { id: newId, until: Date.now() + 1200 };
                await C.refresh();
                if (doneMsg) T.toast.show("info", doneMsg);
                if (document.activeElement === document.body || document.activeElement === null) {
                    const next = page.querySelector(".td-sug .btn") || page.querySelector(".td-row");
                    next?.focus?.();
                }
            } catch (err) {
                setBusy(false);
                const code = err?.payload?.error ?? err?.payload;
                T.toast.show("error", code === "not_found" ? t("todosSugGone") : C.humanErr(err));
                C.refresh().catch(() => {
                    /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
                });
            } finally {
                actingSug.delete(row.id);
            }
        };
        const approveFlow = async () => {
            // 편집 중인 항목을 고치는 제안이면 편집 내용을 먼저 저장한다.
            if (C.editId === row.targetId && C.draft && kind !== "delete" && !(await C.commitDraft())) return false;
            const res = await T.api.approveTodo(row.id, { timezone: C.browserTz() });
            if (kind === "delete" && C.editId === row.targetId) C.closeGoneEditor(row.targetId);
            return res;
        };
        rejectBtn.addEventListener("click", () => act(() => T.api.rejectTodo(row.id), t("todosSugRejected")));
        if (approveBtn) approveBtn.addEventListener("click", () => act(approveFlow, kind === "add" ? t("todosAdded") : t("todosSugApproved")));
        return { rejectBtn, approveBtn };
    }

    function suggestionEl(row) {
        const kind = row.kind === "edit" || row.kind === "delete" ? row.kind : "add";
        const kindLabel = t(kind === "edit" ? "todosSuggestEdit" : kind === "delete" ? "todosSuggestDelete" : "todosSuggestAdd");
        const target = row.targetId ? C.items().find((r) => r.id === row.targetId) : null;
        const title = row.title || target?.title || "";
        const patch = row.patch && typeof row.patch === "object" ? row.patch : {};

        const { subs, previews } = describeSuggestion(row, kind, target, patch);
        const { rejectBtn, approveBtn } = suggestionActions(row, kind, kind !== "add" && !target);

        const promptText = String((kind === "add" ? row.prompt : patch.prompt) || "")
            .replace(/\s+$/g, "")
            .slice(0, 300);
        return T.h("div", { class: "td-sug", role: "listitem", dataset: { id: row.id } }, [
            T.h("div", { class: "td-sug-head" }, [
                T.h("span", {
                    class: "td-sug-avatar",
                    text: ([...String(row.agentName || "?").trim()][0] || "?").toUpperCase(),
                    style: `background:${T.util.safeColor(row.agentColor)}`,
                }),
                T.h("span", { class: "td-sug-name", text: row.agentName || row.agentId || "" }),
                T.h("span", { class: `td-sug-badge ${kind}`, text: kindLabel }),
            ]),
            T.h("div", { class: "td-sug-title", text: title }),
            promptText && kind !== "edit" ? T.h("div", { class: "td-sug-sub", text: `${t("todosFieldPrompt")}: ${promptText}` }) : null,
            ...previews.map((text) => T.h("div", { class: "td-sug-sub", text })),
            subs.length ? T.h("div", { class: "td-sug-sub", text: subs.join(" · ") }) : null,
            T.h("div", { class: "td-sug-actions" }, [rejectBtn, approveBtn]),
        ]);
    }

    function suggestionsEl(pending) {
        const sec = T.h("section", { class: "td-sec" }, [
            T.h("div", { class: "td-sec-head" }, [
                T.h("h2", { class: "td-sec-title", text: t("todosSuggestions") }),
                pending.length ? T.h("span", { class: "td-sec-count attn", text: String(pending.length) }) : null,
            ]),
        ]);
        if (!pending.length) {
            sec.append(T.h("div", { class: "td-empty", text: t("todosEmptySuggest") }));
            return sec;
        }
        const card = T.h("div", { class: "td-card", role: "list" });
        for (const row of pending) card.append(suggestionEl(row));
        sec.append(card);
        return sec;
    }

    C.suggestionsEl = suggestionsEl;
})(window.Taby);
