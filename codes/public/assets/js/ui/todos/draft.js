/* tabyBot 웹 클라이언트: 할 일 편집 상태(초안)와 저장·충돌 처리. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");

    C.editId = null;

    C.draft = null;

    const doneOpen = { user: false, agent: false, jobs: false };

    C.focusEdit = false;

    C.saving = false;

    const pendingActions = [];

    /* ── 편집 상태 ─────────────────────────────────────────── */
    // 항목의 일정에서 편집 초안의 일정 필드를 만든다(처음 열 때와 서버 값으로 다시 맞출 때 같이 쓴다).
    function scheduleDraftFields(item) {
        const mode = C.whenMode(item);
        const weekly = C.cronWeekly(item.cron);
        const monthly = C.cronMonthly(item.cron);
        const every = C.everyParts(item.every);
        const at = item.kind === "at" ? C.atSeedInput(item) : "";
        return {
            mode,
            at,
            atSeed: at,
            atTz: C.validTz(item.timezone),
            dailyTime: C.dailyTime(item) || "09:00",
            dailyFromCron: mode === "daily",
            weeklyDow: weekly?.dow ?? 1,
            weeklyTime: weekly?.time || "09:00",
            weeklyFromCron: mode === "weekly",
            monthlyDom: monthly?.dom ?? 1,
            monthlyTime: monthly?.time || "09:00",
            monthlyFromCron: mode === "monthly",
            every: item.every || "",
            everyN: every?.n ?? 30,
            everyUnit: every?.unit || "m",
            cron: item.cron || "",
            cronText: item.cron || "",
            cronFromItem: item.kind === "cron",
            tz: C.validTz(item.timezone),
            keepMode: ["cronKeep", "everyKeep"].includes(mode) ? mode : null,
        };
    }

    function beginEdit(id) {
        const item = C.items().find((row) => row.id === id);
        if (!item) {
            closeEditor();
            return;
        }
        C.editId = id;
        C.draft = {
            title: item.title || "",
            prompt: item.prompt || "",
            base: item.updatedAt || null,
            ...scheduleDraftFields(item),
            schedTouched: false,
            orig: { title: item.title || "", prompt: item.prompt || "" },
            origSched: schedSig(item),
            origAssignee: item.assigneeId || null,
        };
    }

    function closeEditor() {
        C.editId = null;
        C.draft = null;
        C.focusEdit = false;
        C.composing = 0;
        C.composingEl = null;
        clearTimeout(C.composingTimer);
    }

    function closeGoneEditor(id) {
        closeEditor();
        if (id && location.pathname === `/t/${id}`) {
            T.util.replaceUrl("/t");
        }
    }

    let lastGoneToast = { id: null, at: 0 };

    function toastGone(id) {
        const now = Date.now();
        if (lastGoneToast.id === id && now - lastGoneToast.at < 4000) return;
        lastGoneToast = { id, at: now };
        T.toast.show("info", t("todosErrGone"));
    }

    function runPending() {
        const list = pendingActions.splice(0);
        for (const p of list) {
            try {
                p();
            } catch (err) {
                console.error("pending action failed:", err);
            }
        }
    }

    function queuePending(fn) {
        pendingActions.push(fn);
    }

    function schedSig(it) {
        return JSON.stringify([it.status, it.kind, it.cron, it.every, it.at, it.timezone]);
    }

    // 서버의 최신 항목에 초안을 다시 맞춘다. 내가 고친 것과 남이 고친 것이 부딪히면 true.
    function rebaseDraft(fresh) {
        if (!C.draft || !fresh) return false;
        let clashed = false;
        for (const f of ["title", "prompt"]) {
            if (String(C.draft[f] || "") === String(C.draft.orig?.[f] || "")) C.draft[f] = fresh[f] || "";
            else if (String(fresh[f] || "") !== String(C.draft.orig?.[f] || "")) clashed = true;
        }
        if (C.draft.schedTouched && schedSig(fresh) !== C.draft.origSched) clashed = true;
        if (C.draft.pendingAssignee && (fresh.assigneeId || null) !== (C.draft.origAssignee || null)) clashed = true;
        C.draft.origSched = schedSig(fresh);
        C.draft.origAssignee = fresh.assigneeId || null;
        C.draft.orig = { title: fresh.title || "", prompt: fresh.prompt || "" };
        C.draft.base = fresh.updatedAt || null;
        if (!C.draft.schedTouched) Object.assign(C.draft, scheduleDraftFields(fresh));
        return clashed;
    }

    async function rebaseConflict() {
        try {
            await state.fetchTodos();
            const fresh = C.items().find((row) => row.id === C.editId);
            if (fresh) rebaseDraft(fresh);
        } catch {
            // 실패해도 다음 이벤트나 재접속 때 다시 받는다
        }
    }

    function errorCode(err) {
        return err?.payload?.error ?? err?.payload;
    }

    function isConflict(err) {
        return errorCode(err) === "conflict";
    }

    function commitStagedAssign(id, botId) {
        const cur = C.items().find((row) => row.id === id);
        const offered = (cur?.offers || []).find((o) => o.agentId === botId);
        if (offered) return T.api.acceptHandoff(id, botId);
        return T.api.updateTodo(id, { assigneeId: botId });
    }

    // 편집을 끝내고 /t/<id> 주소에서 목록 주소로 돌아간다.
    function leaveEditorUrl() {
        if (C.routeFromPath()) T.util.replaceUrl("/t");
    }

    // 저장 준비: 입력칸을 읽어 서버에 보낼 변경을 만들고, 대기 중인 담당 변경을 꺼낸다.
    // 저장할 수 없으면(오류 토스트를 띄우고) null.
    function prepareSave() {
        pullFields();
        const parsed = draftToPatch();
        if (parsed.error) {
            T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
            return null;
        }
        const pendAssignee = C.draft.pendingAssignee || null;
        if (pendAssignee) C.draft.pendingAssignee = null;
        const hasChanges = Object.keys(parsed.body).length > 0 || Boolean(pendAssignee);
        return { id: C.editId, body: parsed.body, pendAssignee, hasChanges };
    }

    // 초안을 서버에 보낸다: 대기 중이던 담당 변경 → 본문 수정 → 저장하는 동안 새로 생긴 담당 변경 순.
    // progress.assignDone은 담당 변경이 이미 반영됐는지(실패했을 때 되돌릴지 판단하는 데 쓴다).
    async function sendDraft({ id, body, pendAssignee }, progress) {
        let base = C.draft.base;
        if (pendAssignee) {
            const res = await commitStagedAssign(id, pendAssignee);
            progress.assignDone = true;
            base = res?.item?.updatedAt || base;
        }
        if (Object.keys(body).length) await T.api.updateTodo(id, { ...body, baseUpdatedAt: base });
        let lateAssign = false;
        while (C.draft?.pendingAssignee) {
            const botId = C.draft.pendingAssignee;
            C.draft.pendingAssignee = null;
            const res = await commitStagedAssign(id, botId);
            progress.assignDone = true;
            lateAssign = true;
            base = res?.item?.updatedAt || base;
        }
        if (lateAssign && body.prompt != null) {
            await T.api.updateTodo(id, { prompt: body.prompt, baseUpdatedAt: base });
        }
    }

    async function handleSaveFailure(err, { id, pendAssignee }, progress) {
        if (errorCode(err) === "not_found") {
            closeGoneEditor(id);
            toastGone(id);
            C.refresh().catch(() => {
                /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
            });
            if (C.isOpen()) C.build();
            return;
        }
        if (pendAssignee && !progress.assignDone && C.draft && !C.draft.pendingAssignee) C.draft.pendingAssignee = pendAssignee;
        if (isConflict(err)) await rebaseConflict();
        T.toast.show("error", C.humanErr(err));
    }

    // 저장하고(onSaved로 편집 화면을 정리하고) 목록을 새로 받는다. 성공하면 true.
    async function persistDraft(save, onSaved) {
        C.saving = true;
        const progress = { assignDone: false };
        try {
            await sendDraft(save, progress);
            onSaved();
            await C.refresh();
            return true;
        } catch (err) {
            await handleSaveFailure(err, save, progress);
            return false;
        } finally {
            C.saving = false;
            runPending();
        }
    }

    // 다른 항목으로 넘어가기 전의 자동 저장. 계속 진행해도 되면 true.
    async function commitDraft() {
        if (!C.editId || !C.draft) return true;
        if (C.saving) return false;
        const save = prepareSave();
        if (!save) return false;
        if (!save.hasChanges) {
            closeEditor();
            leaveEditorUrl();
            if (C.isOpen()) C.build();
            return true;
        }
        return persistDraft(save, () => {
            closeEditor();
            leaveEditorUrl();
            T.toast.show("info", t("todosAutoSaved"));
        });
    }

    function openEdit(id, replace = false) {
        const my = ++C.intentSeq;
        if (C.editId === id) return;
        if (C.saving) {
            queuePending(() => {
                if (C.routeFromPath()) openEdit(id);
            });
            return;
        }
        if (C.editId && C.draft) {
            commitDraft().then((ok) => {
                if (ok && my === C.intentSeq && C.routeFromPath()) openEdit(id, true);
            });
            return;
        }
        const push = !C.editId && !replace;
        if (C.pendingDeepId !== id) C.pendingDeepId = null;
        beginEdit(id);
        if (C.editId !== id) return;
        C.focusEdit = true;
        try {
            if (push) history.pushState(null, "", `/t/${id}`);
            else history.replaceState(null, "", `/t/${id}`);
        } catch {
            // 주소 갱신이 막힌 환경에서는 화면만 바꾸고 주소는 그대로 둔다
        }
        C.build();
    }

    function cancelEdit() {
        if (C.saving) return;
        C.pendingDeepId = null;
        C.focusRowId = C.editId;
        closeEditor();
        T.util.replaceUrl("/t");
        C.build();
    }

    // 입력칸의 값을 초안에 옮긴다. 일정 값이 달라졌으면 일정을 건드린 것으로 표시한다.
    function setScheduleValue(key, value, current = C.draft[key]) {
        if (value !== current) C.draft.schedTouched = true;
        C.draft[key] = value;
    }

    function pullFields() {
        if (!C.draft || !page) return;
        const q = C.find;
        if (!C.composing) {
            const title = q(".td-edit-title");
            const prompt = q(".td-edit-prompt");
            if (title) C.draft.title = title.value;
            if (prompt) C.draft.prompt = prompt.value;
        }
        const mode = C.draft.mode;
        const time = q(".td-time");
        if (time) setScheduleValue(mode === "weekly" ? "weeklyTime" : mode === "monthly" ? "monthlyTime" : "dailyTime", time.value);
        const num = q(".td-num");
        if (num) {
            const key = mode === "monthly" ? "monthlyDom" : "everyN";
            setScheduleValue(key, num.value, String(C.draft[key]));
        }
        const sel = q(".td-sel");
        if (sel) {
            if (mode === "weekly") setScheduleValue("weeklyDow", Number(sel.value));
            else setScheduleValue("everyUnit", sel.value);
        }
        const cron = q(".td-cron");
        if (cron) setScheduleValue("cronText", cron.value, C.draft.cronText || "");
        const date = q(".td-date");
        if (date) setScheduleValue("at", date.value, C.draft.at || "");
    }

    const SCHEDULE_ERROR = { error: "schedule" };

    // "분 시" 크론 앞부분: "09:30" → "30 9".
    function cronAtTime(time) {
        const parts = String(time || "").split(":");
        return `${Number(parts[1]) || 0} ${Number(parts[0]) || 0}`;
    }

    // 일정 시간대: 원래 항목의 시간대를 이어 쓸 수 있는 모드면 그것을, 아니면 브라우저 시간대를 쓴다.
    function scheduleTimezone(d) {
        const atModes = d.mode === "today" || d.mode === "tomorrow" || d.mode === "custom";
        const keepItemTz =
            d.mode === "every" ||
            d.mode === "cronKeep" ||
            (d.mode === "daily" && d.dailyFromCron) ||
            (d.mode === "weekly" && d.weeklyFromCron) ||
            (d.mode === "monthly" && d.monthlyFromCron) ||
            (d.mode === "cron" && d.cronFromItem) ||
            (atModes && !!d.atTz);
        return keepItemTz ? d.tz || d.atTz || C.browserTz() : C.browserTz();
    }

    // 하루 중 시각을 정한 반복(매일·매주·매달)을 크론 일정으로 만든다.
    function timedCronFields(tz, { time, suffix }) {
        const tm = String(time || "").trim();
        if (!tm) return SCHEDULE_ERROR;
        return { fields: { cron: `${cronAtTime(tm)} ${suffix}`, every: "", at: "", ...(tz ? { timezone: tz } : {}) } };
    }

    function everyFields(d) {
        const n = Number(d.everyN);
        const every = Number.isInteger(n) && n > 0 ? `${n}${d.everyUnit || "m"}` : d.every;
        if (!String(every || "").trim()) return SCHEDULE_ERROR;
        return { fields: { every, cron: "", at: "" } };
    }

    function customCronFields(d, tz) {
        const cron = String(d.cronText || "").trim();
        if (!cron) return SCHEDULE_ERROR;
        return { fields: { cron, every: "", at: "", ...(tz ? { timezone: tz } : {}) } };
    }

    // 날짜·시각을 고른 일회 일정(오늘/내일/직접).
    function atFields(d, tz) {
        if (!String(d.at || "").trim()) return SCHEDULE_ERROR;
        let at = d.at;
        const atFrame = d.atTz || C.browserTz();
        if (d.mode === "today") {
            const shown = (C.wallClockDate(d.at, atFrame) || new Date(Number.NaN)).getTime();
            // 오늘로 고른 시각이 이미 지났으면 오늘의 기본 시각으로 바꾼다.
            at = Number.isFinite(shown) && shown > Date.now() ? d.at : C.todayDefault(d.atTz);
        }
        if (d.mode === "tomorrow") at = d.at || C.localAt(1, 9, 0, d.atTz);
        if (!at) at = C.todayDefault(d.atTz);
        return { fields: { at, cron: "", every: "", ...(tz ? { timezone: tz } : {}) } };
    }

    // 초안의 일정을 서버 요청 필드로 바꾼다. { fields } 또는 { error }.
    function scheduleFields(d) {
        const tz = scheduleTimezone(d);
        switch (d.mode) {
            case "none":
                return { fields: { kind: "none", clearWhen: true, cron: "", every: "", at: "" } };
            case "daily":
                return timedCronFields(tz, { time: d.dailyTime, suffix: "* * *" });
            case "weekly":
                return timedCronFields(tz, { time: d.weeklyTime, suffix: `* * ${d.weeklyDow}` });
            case "monthly": {
                const dom = Number(d.monthlyDom);
                if (!Number.isInteger(dom) || dom < 1 || dom > 31) return SCHEDULE_ERROR;
                return timedCronFields(tz, { time: d.monthlyTime, suffix: `${dom} * *` });
            }
            case "every":
                return everyFields(d);
            case "cron":
                return customCronFields(d, tz);
            case "everyKeep":
            case "cronKeep":
                return { fields: {} }; // 기존 일정을 그대로 둔다
            default:
                return atFields(d, tz);
        }
    }

    // 초안에서 바뀐 부분만 모아 서버에 보낼 본문을 만든다. { body } 또는 { error: "title" | "schedule" }.
    function draftToPatch() {
        const d = C.draft;
        const title = String(d.title || "").trim();
        if (!title || !C.hasVisible(title)) return { error: "title" };
        const body = {};
        if (title !== String(d.orig?.title || "").trim()) body.title = title;
        if ((d.prompt || "") !== (d.orig?.prompt || "")) body.prompt = d.prompt || "";
        if (!d.schedTouched) return { body };
        const schedule = scheduleFields(d);
        if (schedule.error) return schedule;
        return { body: { ...body, ...schedule.fields } };
    }

    async function saveEdit() {
        if (!C.draft || C.saving) return;
        const save = prepareSave();
        if (!save) return;
        if (!save.hasChanges) {
            C.focusRowId = save.id;
            closeEditor();
            leaveEditorUrl();
            C.build();
            return;
        }
        await persistDraft(save, () => {
            C.focusRowId = save.id;
            closeEditor();
            leaveEditorUrl();
        });
    }

    /* ── 행 부품 ───────────────────────────────────────────── */
    async function toggleEnabled(item) {
        if (C.saving) {
            queuePending(() => {
                if (!C.routeFromPath()) return;
                const cur = C.items().find((row) => row.id === item.id);
                if (cur && C.isJob(cur) && cur.enabled !== !item.enabled) toggleEnabled(cur);
            });
            return;
        }
        if (C.editId === item.id && C.draft) {
            const ok = await commitDraft();
            if (!ok) {
                C.build();
                return;
            }
        }
        C.saving = true;
        try {
            await T.api.updateTodo(item.id, { enabled: !item.enabled });
            T.toast.show("info", item.enabled ? t("todosPaused") : t("todosResumed"));
            await C.refresh();
        } catch (err) {
            T.toast.show("error", C.humanErr(err));
            C.build();
        } finally {
            C.saving = false;
            runPending();
        }
    }

    C.doneOpen = doneOpen;
    C.beginEdit = beginEdit;
    C.closeEditor = closeEditor;
    C.closeGoneEditor = closeGoneEditor;
    C.toastGone = toastGone;
    C.runPending = runPending;
    C.queuePending = queuePending;
    C.rebaseDraft = rebaseDraft;
    C.commitDraft = commitDraft;
    C.openEdit = openEdit;
    C.cancelEdit = cancelEdit;
    C.pullFields = pullFields;
    C.draftToPatch = draftToPatch;
    C.saveEdit = saveEdit;
    C.toggleEnabled = toggleEnabled;
})(window.Taby);
