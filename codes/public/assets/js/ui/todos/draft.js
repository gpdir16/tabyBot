/* tabyBot 웹 클라이언트: 할 일 편집 상태(초안)와 저장·충돌 처리.
   초안은 할 일마다 하나다(C.eds: 할 일 id → { id, draft, busy }). 그 할 일의 창들(세부사항·일정·담당)이 같은 초안을 나눠 쓴다.
   세부사항 창을 닫을 때, 또는 그 할 일의 마지막 창을 닫을 때 서버에 보낸다(detail.js). 다른 할 일의 창은 따로 고치고 따로 저장된다. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    const eds = new Map();

    const doneOpen = { user: false, agent: false, jobs: false };

    // 서버에 쓰는 요청은 한 번에 하나씩 보낸다(lock/unlock).
    let saving = false;
    const waiting = [];

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

    function makeDraft(item) {
        return {
            title: item.title || "",
            prompt: item.prompt || "",
            base: item.updatedAt || null,
            ...scheduleDraftFields(item),
            schedTouched: false,
            orig: { title: item.title || "", prompt: item.prompt || "" },
            origSched: schedSig(item),
        };
    }

    // 할 일의 편집 상태. 그 할 일의 창이 처음 열릴 때 만들고, 창이 다 닫히면 치운다(detail.js의 leaveEd).
    function edFor(id) {
        let ed = eds.get(id);
        if (!ed) {
            ed = { id, draft: null, busy: null };
            eds.set(id, ed);
        }
        return ed;
    }

    // 초안. 없으면(처음이거나 방금 저장함) 지금 항목으로 새로 만든다. 항목이 없으면 null.
    function draftOf(ed) {
        if (!ed.draft) {
            const item = C.item(ed.id);
            ed.draft = item ? makeDraft(item) : null;
        }
        return ed.draft;
    }

    let lastGoneToast = { id: null, at: 0 };

    function toastGone(id) {
        const now = Date.now();
        if (lastGoneToast.id === id && now - lastGoneToast.at < 4000) return;
        lastGoneToast = { id, at: now };
        T.toast.show("info", t("todosErrGone"));
    }

    // 서버에 쓰기 전에 잡는다: 다른 저장이 끝날 때까지 차례를 기다린다. 다 쓰면 unlock으로 놓는다.
    function lock() {
        if (!saving) {
            saving = true;
            return Promise.resolve();
        }
        return new Promise((resolve) => waiting.push(resolve));
    }

    // 기다리던 다음 차례에 넘긴다(없으면 놓는다).
    function unlock() {
        const next = waiting.shift();
        if (next) next();
        else saving = false;
    }

    function schedSig(it) {
        return JSON.stringify([it.status, it.kind, it.cron, it.every, it.at, it.timezone]);
    }

    // 서버의 최신 항목에 초안을 다시 맞춘다. 내가 고친 것과 남이 고친 것이 부딪히면 true.
    function rebaseDraft(d, fresh) {
        if (!d || !fresh) return false;
        let clashed = false;
        for (const f of ["title", "prompt"]) {
            if (String(d[f] || "") === String(d.orig?.[f] || "")) d[f] = fresh[f] || "";
            else if (String(fresh[f] || "") !== String(d.orig?.[f] || "")) clashed = true;
        }
        if (d.schedTouched && schedSig(fresh) !== d.origSched) clashed = true;
        d.origSched = schedSig(fresh);
        d.orig = { title: fresh.title || "", prompt: fresh.prompt || "" };
        d.base = fresh.updatedAt || null;
        if (!d.schedTouched) Object.assign(d, scheduleDraftFields(fresh));
        return clashed;
    }

    async function rebaseConflict(ed) {
        try {
            await state.fetchTodos();
            const fresh = C.item(ed.id);
            if (fresh && ed.draft) rebaseDraft(ed.draft, fresh);
        } catch {
            // 실패해도 다음 이벤트나 재접속 때 다시 받는다
        }
    }

    function errorCode(err) {
        return err?.payload?.error ?? err?.payload;
    }

    // 초안을 서버 요청으로 바꾸지 못한 까닭(제목 없음·일정 오류)을 알린다.
    function toastPatchError(code) {
        T.toast.show("error", code === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
    }

    // 초안을 서버에 보낸다. 바뀐 것이 없거나 저장했으면 true, 못 했으면(알린 뒤) false.
    // 같은 초안을 동시에 두 번 보내지 않는다(세부사항 창과 일정 창이 함께 닫힐 때 등).
    function commitDraft(ed) {
        if (!ed) return Promise.resolve(true);
        ed.busy ||= sendDraft(ed).finally(() => {
            ed.busy = null;
        });
        return ed.busy;
    }

    async function sendDraft(ed) {
        await lock();
        try {
            if (!ed.draft) return true;
            pullFields(ed);
            const parsed = draftToPatch(ed.draft);
            if (parsed.error) {
                toastPatchError(parsed.error);
                return false;
            }
            if (!Object.keys(parsed.body).length) {
                ed.draft = null;
                return true;
            }
            await T.api.updateTodo(ed.id, { ...parsed.body, baseUpdatedAt: ed.draft.base });
            ed.draft = null;
            T.toast.show("info", t("todosAutoSaved"));
            await C.refresh();
            return true;
        } catch (err) {
            if (errorCode(err) === "not_found") {
                // 그사이 지워졌다. 목록을 다시 받으면 이 할 일의 창들은 대상이 없어 닫힌다.
                ed.draft = null;
                toastGone(ed.id);
                C.refresh().catch(() => {
                    /* 실패해도 다음 이벤트나 재접속 때 다시 받는다 */
                });
                return true;
            }
            if (errorCode(err) === "conflict") await rebaseConflict(ed);
            T.toast.show("error", C.humanErr(err));
            return false;
        } finally {
            unlock();
        }
    }

    // 입력칸의 값을 초안에 옮긴다. 일정 값이 달라졌으면 일정을 건드린 것으로 표시한다.
    function setScheduleValue(d, key, value, current = d[key]) {
        if (value !== current) d.schedTouched = true;
        d[key] = value;
    }

    // 이 할 일의 창들(세부사항: 제목·지시, 일정: 일정 칸)에서 아직 초안에 옮기지 않은 값을 읽는다.
    function pullFields(ed) {
        const d = ed?.draft;
        if (!d) return;
        const main = T.windows.get(`t:${ed.id}`)?.body;
        if (main) {
            const title = main.querySelector(".td-edit-title");
            const prompt = main.querySelector(".td-edit-prompt");
            if (title) d.title = title.value;
            if (prompt) d.prompt = prompt.value;
        }
        const when = T.windows.get(`t.when:${ed.id}`)?.body;
        if (!when) return;
        const q = (sel) => when.querySelector(sel);
        const mode = d.mode;
        const time = q(".td-time");
        if (time) setScheduleValue(d, mode === "weekly" ? "weeklyTime" : mode === "monthly" ? "monthlyTime" : "dailyTime", time.value);
        const num = q(".td-num");
        if (num) {
            const key = mode === "monthly" ? "monthlyDom" : "everyN";
            setScheduleValue(d, key, num.value, String(d[key]));
        }
        const sel = q(".td-sel");
        if (sel) {
            if (mode === "weekly") setScheduleValue(d, "weeklyDow", Number(sel.value));
            else setScheduleValue(d, "everyUnit", sel.value);
        }
        const cron = q(".td-cron");
        if (cron) setScheduleValue(d, "cronText", cron.value, d.cronText || "");
        const date = q(".td-date");
        if (date) setScheduleValue(d, "at", date.value, d.at || "");
    }

    const SCHEDULE_ERROR = { error: "schedule" };

    // "분 시" 크론 앞부분: "09:30" → "30 9".
    function cronAtTime(time) {
        const parts = String(time || "").split(":");
        return `${Number(parts[1]) || 0} ${Number(parts[0]) || 0}`;
    }

    // 일정 시간대: 원래 항목의 시간대를 이어 쓸 수 있는 모드면 그것을, 아니면 서버 시간대를 쓴다.
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
        return keepItemTz ? d.tz || d.atTz || C.serverTz() : C.serverTz();
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
        const atFrame = d.atTz || C.serverTz();
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
    function draftToPatch(d) {
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

    /* ── 행 부품 ───────────────────────────────────────────── */
    async function toggleEnabled(item) {
        // 이 할 일의 창에 고친 것이 있으면 먼저 저장한다.
        const ed = eds.get(item.id);
        if (ed?.draft && !(await commitDraft(ed))) {
            C.redraw();
            return;
        }
        await lock();
        try {
            // 기다리는 사이 이미 바뀌었거나 사라졌으면 그대로 둔다.
            const cur = C.item(item.id);
            if (!cur || cur.enabled !== item.enabled) return;
            await T.api.updateTodo(item.id, { enabled: !item.enabled });
            T.toast.show("info", item.enabled ? t("todosPaused") : t("todosResumed"));
            await C.refresh();
        } catch (err) {
            T.toast.show("error", C.humanErr(err));
            C.redraw();
        } finally {
            unlock();
        }
    }

    C.eds = eds;
    C.doneOpen = doneOpen;
    C.edFor = edFor;
    C.draftOf = draftOf;
    C.toastGone = toastGone;
    C.lock = lock;
    C.unlock = unlock;
    C.rebaseDraft = rebaseDraft;
    C.commitDraft = commitDraft;
    C.toastPatchError = toastPatchError;
    C.pullFields = pullFields;
    C.draftToPatch = draftToPatch;
    C.toggleEnabled = toggleEnabled;
})(window.Taby);
