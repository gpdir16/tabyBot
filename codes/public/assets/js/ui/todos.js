(function (T) {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const page = document.getElementById("todosPage");
    const touchMq = window.matchMedia?.("(max-width: 860px)");
    const isTouch = () => !!touchMq?.matches;

    let editId = null;
    let draft = null;
    let doneOpen = { user: false, agent: false };
    let handPopFor = null;
    let recoveredDismissed = false;
    let loading = false;
    let focusEdit = false;
    let saving = false;
    let seenSugIds = null;
    const actingSug = new Set();
    let focusRowId = null;
    let scrollToRow = null;
    let lastScrollTop = 0;

    const pendingActions = [];
    let pendingDeepId = null;
    let composing = 0;
    let buildQueued = false;
    let composingEl = null;
    let composingTimer = 0;
    let intentSeq = 0;
    const dispatching = new Set();

    /* ── 라우트 / 데이터 접근 ──────────────────────────────── */
    function routeFromPath() {
        const m = /^\/t(?:\/(.*?))?\/?$/.exec(location.pathname || "");
        if (!m) return null;
        return { id: m[1] && m[1] !== "new" ? m[1] : null };
    }

    function isOpen() {
        return !page.hidden;
    }

    function items() {
        return state.state.todos || [];
    }

    function suggestions() {
        return state.state.todoSuggestions || [];
    }

    function humanErr(err) {
        const code = typeof err?.payload === "string" ? err.payload : err?.payload?.error;
        const map = {
            title_required: "todosNoTitle",
            not_found: "todosErrGone",
            target_missing: "todosErrTargetGone",
            target_required: "todosErrTargetGone",
            offer_not_found: "todosErrNoOffer",
            too_many: "todosErrTooMany",
            agent_not_found: "todosErrNoAgent",
            "already running": "todosErrRunning",
            "scheduler not ready": "todosErrNotReady",
            not_open: "todosErrNotOpen",
            not_done: "todosErrNotDone",
            invalid_status: "todosErrGone",
            not_assigned: "todosErrNoAssignee",
            too_many_suggestions: "todosErrTooManySug",
            internal_error: "todosErrInternal",
            invalid_json: "todosErrBadReq",
            conflict: "todosErrConflict",
        };
        if (code && map[code]) return t(map[code]);
        if (typeof code !== "string") return T.api.errorText(err, t("errorPrefix"));
        if (code.startsWith("invalid cron") || code.startsWith("cron never fires")) return t("todosErrCron");
        if (code === "at must be in the future") return t("todosErrPast");
        if (code.startsWith("at must be")) return t("todosErrAt");
        if (code.startsWith("invalid timezone")) return t("todosErrTz");
        if (
            code.startsWith("Provide exactly one") ||
            code.startsWith("invalid datetime") ||
            code.startsWith("at requires") ||
            code.startsWith("interval") ||
            code.startsWith("kind ")
        )
            return t("todosErrSchedule");
        return T.api.errorText(err, t("errorPrefix"));
    }

    /* ── 시간/라벨 유틸 ────────────────────────────────────── */
    function pad(n) {
        return String(n).padStart(2, "0");
    }

    function lang() {
        return T.i18n.getLang();
    }

    const hasVisible = (s) => /[^\s\u200B-\u200D\u2060\uFEFF\u00AD]/.test(String(s ?? ""));

    function cronTime(cron) {
        const m = /^(\d+) (\d+) \* \* \*$/.exec(String(cron || ""));
        if (!m) return "";
        return pad(m[2]) + ":" + pad(m[1]);
    }

    function dailyTime(item) {
        return cronTime(item?.cron);
    }

    function everyLabel(raw) {
        const m = /^(\d+)\s*([smhd])$/i.exec(String(raw || "").trim());
        if (!m) return String(raw || "");
        const n = parseInt(m[1], 10);
        const u = m[2].toLowerCase();
        if (u === "s") return n === 60 ? t("todosEveryMinute") : t("todosEveryNSeconds", { n });
        if (u === "d") return n === 1 ? t("todosEveryDay") : n === 7 ? t("todosEveryWeekShort") : t("todosEveryNDays", { n });
        if (u === "h") return n === 1 ? t("todosEveryHour") : n === 24 ? t("todosEveryDay") : t("todosEveryNHours", { n });
        return n === 1 ? t("todosEveryMinute") : n === 60 ? t("todosEveryHour") : n === 1440 ? t("todosEveryDay") : t("todosEveryNMinutes", { n });
    }

    function dayName(d) {
        const days = t("todosWeekdays").split(",");
        const n = days[Number(d) % 7] || String(d);
        return lang() === "ja" ? n + "曜" : n;
    }
    function dayJoiner() {
        return lang() === "ja" ? "・" : lang() === "en" ? ", " : "·";
    }

    const DOW_ALIAS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const MONTH_ALIAS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    function cronLabel(cron) {
        let str = String(cron || "").trim();
        const parts = str.split(/\s+/);
        if (parts.length === 5) {
            parts[3] = parts[3].replace(/[a-z]+/gi, (w) => MONTH_ALIAS[w.toLowerCase()] ?? w);
            parts[4] = parts[4].replace(/[a-z]+/gi, (w) => DOW_ALIAS[w.toLowerCase()] ?? w);
            str = parts.join(" ");
        }
        const daily = /^(\d+) (\d+) \* \* \*$/.exec(str);
        if (daily && okHM(+daily[1], +daily[2])) return t("todosEveryDayAt", { time: pad(daily[2]) + ":" + pad(daily[1]) });
        const weekly = /^(\d+) (\d+) \* \* ([0-7])$/.exec(str);
        if (weekly && okHM(+weekly[1], +weekly[2]))
            return t("todosEveryWeek", { day: dayName(weekly[3]), time: pad(weekly[2]) + ":" + pad(weekly[1]) });
        const monthly = /^(\d+) (\d+) (\d{1,2}) \* \*$/.exec(str);
        if (monthly && okHM(+monthly[1], +monthly[2]) && +monthly[3] >= 1 && +monthly[3] <= 31)
            return t("todosEveryMonth", { day: String(Number(monthly[3])), time: pad(monthly[2]) + ":" + pad(monthly[1]) });
        const everyMin = /^\*\/(\d+) \* \* \* \*$/.exec(str);
        if (everyMin && +everyMin[1] >= 1 && +everyMin[1] <= 59) return t("todosEveryNMinutes", { n: Number(everyMin[1]) });
        const weekRange = /^(\d+) (\d+) \* \* ([0-7])-([0-7])$/.exec(str);
        if (weekRange && okHM(+weekRange[1], +weekRange[2])) {
            return t("todosEveryWeekRange", {
                a: dayName(weekRange[3]),
                b: dayName(weekRange[4]),
                time: pad(weekRange[2]) + ":" + pad(weekRange[1]),
            });
        }
        const weekList = /^(\d+) (\d+) \* \* ([0-7](?:,[0-7])*)$/.exec(str);
        if (weekList && okHM(+weekList[1], +weekList[2])) {
            const names = [...new Set(weekList[3].split(",").map((d) => Number(d) % 7))].map((d) => dayName(d)).join(dayJoiner());
            return t("todosEveryWeekDays", { days: names, time: pad(weekList[2]) + ":" + pad(weekList[1]) });
        }
        const monthList = /^(\d+) (\d+) ([0-9]{1,2}(?:,[0-9]{1,2})+) \* \*$/.exec(str);
        if (monthList && okHM(+monthList[1], +monthList[2]) && monthList[3].split(",").every((d) => +d >= 1 && +d <= 31)) {
            const days = monthList[3]
                .split(",")
                .map((d) => String(Number(d)))
                .join(dayJoiner());
            return t("todosEveryMonthDays", { days, time: pad(monthList[2]) + ":" + pad(monthList[1]) });
        }
        return str;
    }

    function toLocalInput(isoOrAt) {
        if (!isoOrAt) return "";
        const d = new Date(isoOrAt);
        if (Number.isNaN(d.getTime())) {
            const m = String(isoOrAt).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
            return m ? m[1] + "T" + m[2] : "";
        }
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function zonedPartsOf(d, tz) {
        const p = Object.fromEntries(
            new Intl.DateTimeFormat("en-US", {
                timeZone: tz,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })
                .formatToParts(d)
                .map((x) => [x.type, x.value]),
        );
        return { y: +p.year, m: +p.month, d: +p.day, hh: Number(p.hour) % 24, mm: +p.minute };
    }

    function toZonedInput(d, tz) {
        if (!d || Number.isNaN(d.getTime?.())) return "";
        try {
            const p = zonedPartsOf(d, tz);
            return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
        } catch {
            return toLocalInput(d);
        }
    }

    function wallClockDate(str, tz) {
        const m = String(str || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m || !tz) return null;
        try {
            const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
            const dtf = new Intl.DateTimeFormat("en-US", {
                timeZone: tz,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
            });
            let guess = naive;
            for (let i = 0; i < 4; i++) {
                const p = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
                const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
                const next = guess + (naive - wall);
                if (next === guess) break;
                guess = next;
            }
            return new Date(guess);
        } catch {
            return null;
        }
    }

    function atDate(item) {
        const raw = String(item?.at || "");
        if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
            const d = new Date(raw);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        if (item?.timezone) {
            const d = wallClockDate(raw, item.timezone);
            if (d) return d;
        }
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function localAt(days, hour, minute, tz) {
        if (tz && tz !== browserTz()) {
            const p = zonedPartsOf(new Date(), tz);
            const base = new Date(Date.UTC(p.y, p.m - 1, p.d + days, hour, minute));
            return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}T${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}`;
        }
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(hour, minute, 0, 0);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function atSeedInput(item) {
        const d = atDate(item);
        if (d) return toZonedInput(d, validTz(item.timezone) || browserTz());
        return toLocalInput(item.at);
    }

    function todayDefault(tz) {
        if (tz && tz !== browserTz()) {
            const now = new Date();
            const p = zonedPartsOf(now, tz);
            if (p.hh >= 18) {
                const plus = zonedPartsOf(new Date(now.getTime() + 3600000), tz);
                const sameDay = plus.y === p.y && plus.m === p.m && plus.d === p.d;
                return sameDay ? `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(plus.hh)}:${pad(plus.mm)}` : `${p.y}-${pad(p.m)}-${pad(p.d)}T23:59`;
            }
            return `${p.y}-${pad(p.m)}-${pad(p.d)}T18:00`;
        }
        const d = new Date();
        d.setHours(18, 0, 0, 0);
        if (d.getTime() <= Date.now()) {
            d.setTime(Date.now() + 3600000);
            const end = new Date();
            end.setHours(23, 59, 0, 0);
            if (d.getTime() > end.getTime()) d.setTime(end.getTime());
            d.setSeconds(0, 0);
        }
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function nowLocalInput(tz) {
        if (tz && tz !== browserTz()) return toZonedInput(new Date(), tz);
        const d = new Date();
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function dayDiff(iso, tz) {
        const d = iso instanceof Date ? iso : new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        const now = new Date();
        if (tz && tz !== browserTz()) {
            const a = zonedPartsOf(d, tz);
            const b = zonedPartsOf(now, tz);
            return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86400000);
        }
        const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        return Math.round((start(d) - start(now)) / 86400000);
    }

    function formatDay(iso, tz) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        const loc = lang() === "ko" ? "ko-KR" : lang() === "ja" ? "ja-JP" : "en-US";
        const tzOpt = tz ? { timeZone: tz } : {};
        const time = d.toLocaleString(loc, { hour: "numeric", minute: "2-digit", ...tzOpt });
        if (!tz) {
            const diff = dayDiff(iso);
            if (diff === 0) return `${t("todosToday")} ${time}`;
            if (diff === 1) return `${t("todosTomorrow")} ${time}`;
            if (diff === -1) return `${t("todosYesterday")} ${time}`;
        }
        const opts =
            d.getFullYear() !== new Date().getFullYear()
                ? { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
                : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
        return d.toLocaleString(loc, { ...opts, ...tzOpt });
    }

    function browserTz() {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    }

    function validTz(tz) {
        if (!tz) return "";
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: tz });
            return tz;
        } catch {
            return "";
        }
    }

    function tzSuffix(item) {
        const tz = validTz(item?.timezone);
        return tz && tz !== browserTz() ? ` (${tz})` : "";
    }

    function whenLabel(item) {
        if (item.status === "done" && item.lastDoneAt) return t("todosDoneAt", { time: formatDay(item.lastDoneAt) });
        if (!item.kind || item.kind === "none") return "";
        if (item.kind === "cron") {
            return (cronLabel(item.cron) || "") + tzSuffix(item);
        }
        if (item.kind === "at" && item.at) {
            const d = atDate(item);
            const foreign = validTz(item.timezone) && item.timezone !== browserTz() ? item.timezone : null;
            return (d ? formatDay(d, foreign) : String(item.at)) + tzSuffix(item);
        }
        if (item.kind === "every" && item.every) return everyLabel(item.every);
        return "";
    }

    const okHM = (m, h) => m >= 0 && m <= 59 && h >= 0 && h <= 23;

    function cronWeekly(cron) {
        const m = /^(\d+) (\d+) \* \* (\d+)$/.exec(String(cron || ""));
        if (!m || !okHM(+m[1], +m[2]) || +m[3] > 7) return null;
        return { dow: +m[3] % 7, time: pad(m[2]) + ":" + pad(m[1]) };
    }
    function cronMonthly(cron) {
        const m = /^(\d+) (\d+) (\d+) \* \*$/.exec(String(cron || ""));
        if (!m || !okHM(+m[1], +m[2]) || +m[3] < 1 || +m[3] > 31) return null;
        return { dom: +m[3], time: pad(m[2]) + ":" + pad(m[1]) };
    }
    function everyParts(raw) {
        const m = /^(\d+)\s*([smhd])$/i.exec(String(raw || "").trim());
        return m ? { n: +m[1], unit: m[2].toLowerCase() } : null;
    }

    function whenMode(item) {
        if (item.kind === "cron") {
            if (cronTime(item.cron)) return "daily";
            if (cronWeekly(item.cron)) return "weekly";
            if (cronMonthly(item.cron)) return "monthly";
            return "cronKeep";
        }
        if (item.kind === "every") {
            const p = everyParts(item.every);
            return p && p.unit !== "s" ? "every" : "everyKeep";
        }
        if (item.kind === "at" && item.at) {
            const d = atDate(item);
            const diff = d ? dayDiff(d, validTz(item.timezone)) : null;
            if (diff === 0) return "today";
            if (diff === 1) return "tomorrow";
            return "custom";
        }
        return "none";
    }

    function isOverdue(item) {
        if (item.status !== "open" || item.periodDone) return false;
        if (item.kind !== "at" || !item.at) return false;
        const d = atDate(item);
        return !!d && d.getTime() < Date.now();
    }

    function isTodayKind(item) {
        const next = Date.parse(item.nextRunAt || "");
        if (Number.isFinite(next)) return dayDiff(new Date(next)) === 0;
        if (item.kind === "at" && item.at) {
            const d = atDate(item);
            return !!d && dayDiff(d) === 0;
        }
        return false;
    }

    function safeColor(value) {
        return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : "var(--accent)";
    }

    function dotEl(color) {
        return T.h("i", { class: "td-dot", style: `background:${safeColor(color)}` });
    }

    /* ── 서버 동기화 ───────────────────────────────────────── */
    async function refresh() {
        loading = true;
        let ok = false;
        try {
            await state.fetchTodos();
            ok = true;
        } catch (err) {
            T.toast.show("error", humanErr(err));
        } finally {
            loading = false;
            if (editId && editId !== pendingDeepId && !items().some((row) => row.id === editId)) {
                const goneId = editId;
                closeGoneEditor(goneId);
                toastGone(goneId);
            } else if (editId && !draft && editId !== pendingDeepId) {
                beginEdit(editId);
                focusEdit = true;
            }
            if (isOpen()) build();
        }
        return ok;
    }

    async function addFromComposer(title, assigneeId) {
        const text = String(title || "").trim();
        if (!text) return false;
        try {
            const r = await T.api.createTodo({ title: text, timezone: browserTz(), assigneeId: assigneeId || undefined });
            scrollToRow = { id: r?.item?.id || "", until: Date.now() + 900 };
            await refresh();
            const bot = assigneeId ? (state.state.bots || []).find((b) => b.id === assigneeId) : null;
            T.toast.show("info", bot ? t("todosAssignedTo", { name: bot.name }) : t("todosAdded"));
            return true;
        } catch (err) {
            T.toast.show("error", humanErr(err));
            return false;
        }
    }

    async function toggle(item, on) {
        if (saving) {
            queuePending(() => {
                if (!routeFromPath()) return;
                const cur = items().find((row) => row.id === item.id);
                if (!cur || !!(cur.status === "done" || cur.periodDone) === !!on) return;
                toggle(cur, on);
            });
            return;
        }
        if (editId === item.id && draft) {
            const ok = await commitDraft();
            if (!ok) {
                build();
                return;
            }
        }
        if (editId === item.id) closeEditor();
        saving = true;
        try {
            if (on) await T.api.completeTodo(item.id);
            else await T.api.reopenTodo(item.id);
            if (on) {
                const recurring = item.kind === "every" || item.kind === "cron";
                if (recurring) {
                    T.toast.show("info", t("todosPeriodDone"));
                } else {
                    doneOpen[item.assigneeId ? "agent" : "user"] = true;
                    T.toast.show("info", t("todosMovedDone"));
                }
            } else {
                T.toast.show("info", t("todosReopened"));
            }
            await refresh();
        } catch (err) {
            T.toast.show("error", humanErr(err));
            build();
        } finally {
            saving = false;
            runPending();
        }
    }

    /* ── 편집 상태 ─────────────────────────────────────────── */
    function beginEdit(id) {
        const item = items().find((row) => row.id === id);
        if (!item) {
            closeEditor();
            return;
        }
        editId = id;
        draft = {
            title: item.title || "",
            prompt: item.prompt || "",
            base: item.updatedAt || null,
            mode: whenMode(item),
            at: item.kind === "at" ? atSeedInput(item) : "",
            atSeed: item.kind === "at" ? atSeedInput(item) : "",
            atTz: validTz(item.timezone),
            dailyTime: dailyTime(item) || "09:00",
            dailyFromCron: whenMode(item) === "daily",
            weeklyDow: cronWeekly(item.cron)?.dow ?? 1,
            weeklyTime: cronWeekly(item.cron)?.time || "09:00",
            weeklyFromCron: whenMode(item) === "weekly",
            monthlyDom: cronMonthly(item.cron)?.dom ?? 1,
            monthlyTime: cronMonthly(item.cron)?.time || "09:00",
            monthlyFromCron: whenMode(item) === "monthly",
            every: item.every || "",
            everyN: everyParts(item.every)?.n ?? 30,
            everyUnit: everyParts(item.every)?.unit || "m",
            cron: item.cron || "",
            cronText: item.cron || "",
            cronFromItem: item.kind === "cron",
            schedTouched: false,
            tz: validTz(item.timezone),
            keepMode: ["cronKeep", "everyKeep"].includes(whenMode(item)) ? whenMode(item) : null,
            orig: { title: item.title || "", prompt: item.prompt || "" },
            origSched: schedSig(item),
            origAssignee: item.assigneeId || null,
            armDelete: false,
        };
    }

    function closeEditor() {
        editId = null;
        draft = null;
        focusEdit = false;
        composing = 0;
        composingEl = null;
        clearTimeout(composingTimer);
    }

    function closeGoneEditor(id) {
        closeEditor();
        if (id && location.pathname === "/t/" + id) {
            try {
                history.replaceState(null, "", "/t");
            } catch (_) {}
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

    function rebaseDraft(fresh) {
        if (!draft || !fresh) return false;
        let clashed = false;
        for (const f of ["title", "prompt"]) {
            if (String(draft[f] || "") === String(draft.orig?.[f] || "")) draft[f] = fresh[f] || "";
            else if (String(fresh[f] || "") !== String(draft.orig?.[f] || "")) clashed = true;
        }
        if (draft.schedTouched && schedSig(fresh) !== draft.origSched) clashed = true;
        if (draft.pendingAssignee && (fresh.assigneeId || null) !== (draft.origAssignee || null)) clashed = true;
        draft.origSched = schedSig(fresh);
        draft.origAssignee = fresh.assigneeId || null;
        draft.orig = { title: fresh.title || "", prompt: fresh.prompt || "" };
        draft.base = fresh.updatedAt || null;
        if (!draft.schedTouched) {
            draft.mode = whenMode(fresh);
            draft.at = fresh.kind === "at" ? atSeedInput(fresh) : "";
            draft.atSeed = draft.at;
            draft.atTz = validTz(fresh.timezone);
            draft.dailyTime = dailyTime(fresh) || "09:00";
            draft.dailyFromCron = draft.mode === "daily";
            draft.weeklyDow = cronWeekly(fresh.cron)?.dow ?? 1;
            draft.weeklyTime = cronWeekly(fresh.cron)?.time || "09:00";
            draft.weeklyFromCron = draft.mode === "weekly";
            draft.monthlyDom = cronMonthly(fresh.cron)?.dom ?? 1;
            draft.monthlyTime = cronMonthly(fresh.cron)?.time || "09:00";
            draft.monthlyFromCron = draft.mode === "monthly";
            draft.every = fresh.every || "";
            draft.everyN = everyParts(fresh.every)?.n ?? 30;
            draft.everyUnit = everyParts(fresh.every)?.unit || "m";
            draft.cron = fresh.cron || "";
            draft.cronText = fresh.cron || "";
            draft.cronFromItem = fresh.kind === "cron";
            draft.tz = validTz(fresh.timezone);
            draft.keepMode = ["cronKeep", "everyKeep"].includes(draft.mode) ? draft.mode : null;
        }
        return clashed;
    }

    async function rebaseConflict() {
        try {
            await state.fetchTodos();
            const fresh = items().find((row) => row.id === editId);
            if (fresh) rebaseDraft(fresh);
        } catch (_) {}
    }

    function isConflict(err) {
        const code = err?.payload?.error ?? err?.payload;
        return code === "conflict";
    }

    async function commitStagedAssign(id, botId) {
        const cur = items().find((row) => row.id === id);
        const offered = (cur?.offers || []).find((o) => o.agentId === botId);
        if (offered) return T.api.acceptHandoff(id, botId);
        return T.api.updateTodo(id, { assigneeId: botId });
    }

    async function commitDraft() {
        if (!editId || !draft) return true;
        if (saving) return false;
        pullFields();
        const title = String(draft.title || "").trim();
        const id = editId;
        if (!title || !hasVisible(title)) {
            T.toast.show("error", t("todosNoTitle"));
            return false;
        }
        const parsed = draftToPatch();
        if (parsed.error) {
            T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
            return false;
        }
        const pendAssignee = draft.pendingAssignee || null;
        if (pendAssignee) draft.pendingAssignee = null;
        if (!Object.keys(parsed.body).length && !pendAssignee) {
            closeEditor();
            if (routeFromPath()) {
                try {
                    history.replaceState(null, "", "/t");
                } catch (_) {}
            }
            if (isOpen()) build();
            return true;
        }
        saving = true;
        let base = draft.base;
        let assignDone = false;
        try {
            if (pendAssignee) {
                const res = await commitStagedAssign(id, pendAssignee);
                assignDone = true;
                base = res?.item?.updatedAt || base;
            }
            if (Object.keys(parsed.body).length) await T.api.updateTodo(id, { ...parsed.body, baseUpdatedAt: base });
            let lateAssign = false;
            while (draft && draft.pendingAssignee) {
                const botId = draft.pendingAssignee;
                draft.pendingAssignee = null;
                const res = await commitStagedAssign(id, botId);
                assignDone = true;
                lateAssign = true;
                base = res?.item?.updatedAt || base;
            }
            if (lateAssign && parsed.body.prompt != null) {
                const res = await T.api.updateTodo(id, { prompt: parsed.body.prompt, baseUpdatedAt: base });
                base = res?.item?.updatedAt || base;
            }
            closeEditor();
            if (routeFromPath()) {
                try {
                    history.replaceState(null, "", "/t");
                } catch (_) {}
            }
            T.toast.show("info", t("todosAutoSaved"));
            await refresh();
            return true;
        } catch (err) {
            const code = err?.payload?.error ?? err?.payload;
            if (code === "not_found") {
                closeGoneEditor(id);
                toastGone(id);
                refresh().catch(() => {});
                if (isOpen()) build();
                return false;
            }
            if (pendAssignee && !assignDone && draft && !draft.pendingAssignee) draft.pendingAssignee = pendAssignee;
            if (isConflict(err)) await rebaseConflict();
            T.toast.show("error", humanErr(err));
            return false;
        } finally {
            saving = false;
            runPending();
        }
    }

    function openEdit(id, replace = false) {
        const my = ++intentSeq;
        if (editId === id) return;
        if (saving) {
            queuePending(() => {
                if (routeFromPath()) openEdit(id);
            });
            return;
        }
        if (editId && draft) {
            commitDraft().then((ok) => {
                if (ok && my === intentSeq && routeFromPath()) openEdit(id, true);
            });
            return;
        }
        const push = !editId && !replace;
        if (pendingDeepId !== id) pendingDeepId = null;
        beginEdit(id);
        if (editId !== id) return;
        focusEdit = true;
        try {
            if (push) history.pushState(null, "", "/t/" + id);
            else history.replaceState(null, "", "/t/" + id);
        } catch (_) {}
        build();
    }

    function cancelEdit() {
        if (saving) return;
        pendingDeepId = null;
        focusRowId = editId;
        closeEditor();
        try {
            history.replaceState(null, "", "/t");
        } catch (_) {}
        build();
    }

    function pullFields() {
        if (!draft || !page) return;
        const q = (s) => page.querySelector(s);
        const tm = q(".td-time");
        const dt = q(".td-date");
        if (!composing) {
            const title = q(".td-edit-title");
            const prompt = q(".td-edit-prompt");
            if (title) draft.title = title.value;
            if (prompt) draft.prompt = prompt.value;
        }
        if (tm) {
            const target = draft.mode === "weekly" ? "weeklyTime" : draft.mode === "monthly" ? "monthlyTime" : "dailyTime";
            if (tm.value !== draft[target]) draft.schedTouched = true;
            draft[target] = tm.value;
        }
        const num = q(".td-num");
        if (num) {
            const target = draft.mode === "monthly" ? "monthlyDom" : "everyN";
            if (num.value !== String(draft[target])) draft.schedTouched = true;
            draft[target] = num.value;
        }
        const sel = q(".td-sel");
        if (sel) {
            const target = draft.mode === "weekly" ? "weeklyDow" : "everyUnit";
            const v = draft.mode === "weekly" ? Number(sel.value) : sel.value;
            if (v !== draft[target]) draft.schedTouched = true;
            draft[target] = v;
        }
        const cronInp = q(".td-cron");
        if (cronInp) {
            if (cronInp.value !== (draft.cronText || "")) draft.schedTouched = true;
            draft.cronText = cronInp.value;
        }
        if (dt && dt.value !== (draft.at || "")) draft.schedTouched = true;
        if (dt) draft.at = dt.value;
    }

    function draftToPatch() {
        const title = String(draft.title || "").trim();
        if (!title || !hasVisible(title)) return { error: "title" };
        const body = {};
        if (title !== String(draft.orig?.title || "").trim()) body.title = title;
        if ((draft.prompt || "") !== (draft.orig?.prompt || "")) body.prompt = draft.prompt || "";
        if (!draft.schedTouched) return { body };
        const atModes = draft.mode === "today" || draft.mode === "tomorrow" || draft.mode === "custom";
        const keepItemTz =
            draft.mode === "every" ||
            draft.mode === "cronKeep" ||
            (draft.mode === "daily" && draft.dailyFromCron) ||
            (draft.mode === "weekly" && draft.weeklyFromCron) ||
            (draft.mode === "monthly" && draft.monthlyFromCron) ||
            (draft.mode === "cron" && draft.cronFromItem) ||
            (atModes && !!draft.atTz);
        const tz = keepItemTz ? draft.tz || draft.atTz || browserTz() : browserTz();
        const cronAtTime = (tm) => {
            const parts = String(tm || "").split(":");
            return `${Number(parts[1]) || 0} ${Number(parts[0]) || 0}`;
        };
        if (draft.mode === "none") {
            body.kind = "none";
            body.clearWhen = true;
            body.cron = "";
            body.every = "";
            body.at = "";
        } else if (draft.mode === "daily") {
            const tm = String(draft.dailyTime || "").trim();
            if (!tm) return { error: "schedule" };
            body.cron = `${cronAtTime(tm)} * * *`;
            body.every = "";
            body.at = "";
            if (tz) body.timezone = tz;
        } else if (draft.mode === "weekly") {
            const tm = String(draft.weeklyTime || "").trim();
            if (!tm) return { error: "schedule" };
            body.cron = `${cronAtTime(tm)} * * ${draft.weeklyDow}`;
            body.every = "";
            body.at = "";
            if (tz) body.timezone = tz;
        } else if (draft.mode === "monthly") {
            const tm = String(draft.monthlyTime || "").trim();
            const dom = Number(draft.monthlyDom);
            if (!tm || !Number.isInteger(dom) || dom < 1 || dom > 31) return { error: "schedule" };
            body.cron = `${cronAtTime(tm)} ${dom} * *`;
            body.every = "";
            body.at = "";
            if (tz) body.timezone = tz;
        } else if (draft.mode === "every") {
            const n = Number(draft.everyN);
            body.every = Number.isInteger(n) && n > 0 ? `${n}${draft.everyUnit || "m"}` : draft.every;
            if (!String(body.every || "").trim()) return { error: "schedule" };
            body.cron = "";
            body.at = "";
        } else if (draft.mode === "cron") {
            const c = String(draft.cronText || "").trim();
            if (!c) return { error: "schedule" };
            body.cron = c;
            body.every = "";
            body.at = "";
            if (tz) body.timezone = tz;
        } else if (draft.mode === "everyKeep" || draft.mode === "cronKeep") {
        } else {
            let at = draft.at;
            if (!String(at || "").trim()) return { error: "schedule" };
            const atFrame = draft.atTz || browserTz();
            const shownMs = (s) => (wallClockDate(s, atFrame) || new Date(NaN)).getTime();
            if (draft.mode === "today") {
                const shown = shownMs(draft.at);
                at = Number.isFinite(shown) && shown > Date.now() ? draft.at : todayDefault(draft.atTz);
            }
            if (draft.mode === "tomorrow") at = draft.at || localAt(1, 9, 0, draft.atTz);
            if (!at) at = todayDefault(draft.atTz);
            body.at = at;
            body.cron = "";
            body.every = "";
            if (tz) body.timezone = tz;
        }
        return { body };
    }

    async function saveEdit() {
        if (!draft || saving) return;
        pullFields();
        const parsed = draftToPatch();
        if (parsed.error) {
            T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
            return;
        }
        const id = editId;
        const pendAssignee = draft.pendingAssignee || null;
        if (pendAssignee) draft.pendingAssignee = null;
        if (!Object.keys(parsed.body).length && !pendAssignee) {
            focusRowId = id;
            closeEditor();
            if (routeFromPath()) {
                try {
                    history.replaceState(null, "", "/t");
                } catch (_) {}
            }
            build();
            return;
        }
        saving = true;
        let base = draft.base;
        let assignDone = false;
        try {
            if (pendAssignee) {
                const res = await commitStagedAssign(id, pendAssignee);
                assignDone = true;
                base = res?.item?.updatedAt || base;
            }
            if (Object.keys(parsed.body).length) await T.api.updateTodo(id, { ...parsed.body, baseUpdatedAt: base });
            let lateAssign = false;
            while (draft && draft.pendingAssignee) {
                const botId = draft.pendingAssignee;
                draft.pendingAssignee = null;
                const res = await commitStagedAssign(id, botId);
                assignDone = true;
                lateAssign = true;
                base = res?.item?.updatedAt || base;
            }
            if (lateAssign && parsed.body.prompt != null) {
                const res = await T.api.updateTodo(id, { prompt: parsed.body.prompt, baseUpdatedAt: base });
                base = res?.item?.updatedAt || base;
            }
            focusRowId = id;
            closeEditor();
            if (routeFromPath()) {
                try {
                    history.replaceState(null, "", "/t");
                } catch (_) {}
            }
            await refresh();
        } catch (err) {
            const code = err?.payload?.error ?? err?.payload;
            if (code === "not_found") {
                closeGoneEditor(id);
                toastGone(id);
                refresh().catch(() => {});
                if (isOpen()) build();
                return;
            }
            if (pendAssignee && !assignDone && draft && !draft.pendingAssignee) draft.pendingAssignee = pendAssignee;
            if (isConflict(err)) await rebaseConflict();
            T.toast.show("error", humanErr(err));
        } finally {
            saving = false;
            runPending();
        }
    }

    /* ── 행 부품 ───────────────────────────────────────────── */
    function checkBtn(item, checked) {
        const btn = T.h(
            "button",
            {
                type: "button",
                class: "td-check" + (checked ? " on" : ""),
                "aria-label": checked ? t("todosMarkOpen") : t("todosMarkDone"),
                "aria-pressed": String(checked),
            },
            [T.icon("check")],
        );
        btn.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") e.stopPropagation();
        });
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            toggle(item, !checked);
        });
        return btn;
    }

    function whoSpan(item) {
        if (!item.assigneeId) return null;
        const name = item.assignee?.name || t("todosAssigneeRemoved");
        return T.h("span", { class: "td-who" }, [dotEl(item.assignee?.color || "#8e8e93"), T.h("span", { text: t("todosAssignedTo", { name }) })]);
    }

    function metaEl(item, done) {
        const parts = [];
        const when = whenLabel(item);
        if (when) {
            const cls = "td-when" + (done ? "" : isOverdue(item) ? " over" : isTodayKind(item) ? " today" : "");
            parts.push(T.h("span", { class: cls, text: when }));
        }
        if (!done && item.waiting) {
            parts.push(T.h("span", { class: "td-when waiting", text: t("todosNeedsYou") }));
            const q = String(item.waiting.question || "")
                .replace(/\s+/g, " ")
                .trim();
            if (q) parts.push(T.h("span", { class: "td-wait-q", title: q, text: q }));
        } else if (!done && item.running) {
            parts.push(T.h("span", { class: "td-when running", text: t("todosRunning") }));
        }
        if (!done && item.lastError?.message) {
            const raw = String(item.lastError.message);
            const reason = raw === "interrupted" ? t("todosRunInterrupted") : raw.replace(/\s+/g, " ").trim().slice(0, 80);
            parts.push(T.h("span", { class: "td-when failed", title: raw, text: `${t("todosRunFailed")} · ${reason}` }));
        }
        if (!done) {
            const who = whoSpan(item);
            if (who) parts.push(who);
        }
        if (!parts.length) return null;
        const meta = T.h("div", { class: "td-row-meta" });
        parts.forEach((p, i) => {
            if (i) meta.append(T.h("span", { class: "td-sep", text: "·" }));
            meta.append(p);
        });
        return meta;
    }

    /* ── 편집 패널(행이 채워진 상태) ────────────────────────── */
    function whenEditor() {
        const chip = (id, label, forceOn) =>
            T.h("button", {
                type: "button",
                class: "td-chip" + (forceOn || draft.mode === id ? " on" : ""),
                "aria-pressed": String(Boolean(forceOn || draft.mode === id)),
                text: label,
                onclick() {
                    if (!draft || draft.mode === id) return;
                    pullFields();
                    draft.mode = id;
                    draft.schedTouched = true;
                    if (id === "today") draft.at = todayDefault(draft.atTz);
                    if (id === "tomorrow") draft.at = localAt(1, 9, 0, draft.atTz);
                    if (id === "custom" && !draft.at) draft.at = todayDefault(draft.atTz);
                    if (id === "today" || id === "tomorrow" || id === "custom") draft.atSeed = draft.at;
                    if (id === "daily" && !draft.dailyTime) draft.dailyTime = "09:00";
                    if (id === "cron" && !String(draft.cronText || "").trim()) draft.cronText = "0 9 * * *";
                    build();
                },
            });

        function whenInputKeys(e) {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                saveEdit();
            } else if (e.key === "Escape" && !e.isComposing) {
                e.preventDefault();
                cancelEdit();
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
        if (draft.keepMode === "everyKeep") chips.push(chip("everyKeep", everyLabel(draft.every || "—"), draft.mode === "everyKeep"));
        if (draft.keepMode === "cronKeep") chips.push(chip("cronKeep", cronLabel(draft.cron) || draft.cron || "—", draft.mode === "cronKeep"));

        const wrap = T.h("div", { class: "td-when-editor" }, [T.h("div", { class: "td-chips" }, chips)]);

        function timeInput(value, apply, ariaLabel) {
            const tm = T.h("input", { type: "time", class: "td-input td-time", "aria-label": ariaLabel, value });
            tm.addEventListener("change", () => {
                if (!draft) return;
                apply(tm.value);
                draft.schedTouched = true;
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
                if (!draft) return;
                apply(n.value);
                draft.schedTouched = true;
            });
            n.addEventListener("keydown", whenInputKeys);
            return n;
        }
        const row = (kids) => T.h("div", { class: "td-when-row" }, kids);

        if (draft.mode === "daily") {
            wrap.append(
                timeInput(
                    draft.dailyTime,
                    (v) => {
                        draft.dailyTime = v;
                    },
                    t("todosRepeatTime"),
                ),
            );
        } else if (draft.mode === "weekly") {
            const days = t("todosWeekdays").split(",");
            const sel = T.h(
                "select",
                { class: "td-input td-sel", "aria-label": t("todosWeeklyDay") },
                days.map((name, i) =>
                    T.h("option", {
                        value: String(i),
                        text: lang() === "ja" ? name + "曜" : name,
                        ...(i === draft.weeklyDow ? { selected: true } : {}),
                    }),
                ),
            );
            sel.addEventListener("change", () => {
                if (!draft) return;
                draft.weeklyDow = Number(sel.value) || 0;
                draft.schedTouched = true;
            });
            wrap.append(
                row([
                    sel,
                    timeInput(
                        draft.weeklyTime,
                        (v) => {
                            draft.weeklyTime = v;
                        },
                        t("todosRepeatTime"),
                    ),
                ]),
            );
        } else if (draft.mode === "monthly") {
            wrap.append(
                row([
                    numInput(
                        draft.monthlyDom,
                        (v) => {
                            draft.monthlyDom = v;
                        },
                        t("todosMonthlyDay"),
                        1,
                        31,
                    ),
                    T.h("span", { class: "td-when-suffix", text: t("todosMonthlyDaySuffix") }),
                    timeInput(
                        draft.monthlyTime,
                        (v) => {
                            draft.monthlyTime = v;
                        },
                        t("todosRepeatTime"),
                    ),
                ]),
            );
        } else if (draft.mode === "every") {
            const units = t("todosEveryUnits").split(",");
            const sel = T.h(
                "select",
                { class: "td-input td-sel", "aria-label": t("todosEveryUnit") },
                ["m", "h", "d"].map((u, i) => T.h("option", { value: u, text: units[i] || u, ...(u === draft.everyUnit ? { selected: true } : {}) })),
            );
            sel.addEventListener("change", () => {
                if (!draft) return;
                draft.everyUnit = sel.value;
                draft.schedTouched = true;
            });
            wrap.append(
                row([
                    numInput(
                        draft.everyN,
                        (v) => {
                            draft.everyN = v;
                        },
                        t("todosEveryN"),
                        1,
                    ),
                    sel,
                ]),
            );
        } else if (draft.mode === "everyKeep") {
            wrap.append(row([T.h("span", { class: "td-when-suffix", text: everyLabel(draft.every) })]));
        } else if (draft.mode === "cron") {
            const inp = T.h("input", {
                type: "text",
                class: "td-input td-cron",
                "aria-label": t("todosCronExpr"),
                placeholder: "0 9 * * 1-5",
                value: draft.cronText,
                spellcheck: "false",
                autocomplete: "off",
            });
            const hint = T.h("div", { class: "td-cron-hint" });
            const showHint = () => {
                hint.textContent = cronLabel(inp.value) || "";
            };
            inp.addEventListener("input", () => {
                if (!draft) return;
                draft.cronText = inp.value;
                draft.schedTouched = true;
                showHint();
            });
            inp.addEventListener("keydown", whenInputKeys);
            showHint();
            wrap.append(inp, hint);
        } else if (draft.mode === "today" || draft.mode === "tomorrow" || draft.mode === "custom") {
            const date = T.h("input", {
                type: "datetime-local",
                class: "td-input td-date",
                "aria-label": t("todosDate"),
                value: draft.at,
                min: nowLocalInput(draft.atTz),
            });
            date.addEventListener("keydown", whenInputKeys);
            date.addEventListener("change", () => {
                if (!draft) return;
                draft.schedTouched = true;
                if (!date.value) return;
                draft.at = date.value;
                if (draft.mode !== "custom" && date.value !== draft.atSeed) {
                    draft.mode = "custom";
                    pullFields();
                    setTimeout(() => {
                        if (draft && editId) build();
                    }, 0);
                }
            });
            wrap.append(date);
            if (draft.atTz && draft.atTz !== browserTz()) wrap.append(T.h("span", { class: "td-tz-note", text: `(${draft.atTz})` }));
        }
        return wrap;
    }

    function assignFor(item, fn, toastMsg) {
        if (saving) {
            queuePending(() => {
                if (routeFromPath()) assignFor(item, fn, toastMsg);
            });
            return;
        }
        const editing = editId === item.id && draft;
        if (editing) pullFields();
        const parsed = editing ? draftToPatch() : null;
        const dirty = parsed && !parsed.error && Object.keys(parsed.body).length > 0;
        if (parsed?.error) T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
        saving = true;
        (async () => {
            try {
                await fn();
                if (dirty && hasVisible(draft?.title)) {
                    await state.fetchTodos();
                    const cur = items().find((row) => row.id === item.id);
                    await T.api.updateTodo(item.id, { ...parsed.body, baseUpdatedAt: cur?.updatedAt ?? draft?.base });
                }
                if (!parsed?.error && editId === item.id) draft = null;
                if (handPopFor === item.id) handPopFor = null;
                if (toastMsg) T.toast.show("info", toastMsg);
                await refresh();
            } catch (err) {
                T.toast.show("error", humanErr(err));
                refresh().catch(() => {});
            } finally {
                saving = false;
                runPending();
            }
        })();
    }

    function assigneeRow(item) {
        const who = item.assignee?.name || t("todosAssigneeRemoved");
        return T.h("div", { class: "td-offer-row td-hand-cur" }, [
            dotEl(item.assignee?.color || "#8e8e93"),
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
                            const cur = items().find((row) => row.id === item.id);
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
                            const cur = items().find((row) => row.id === item.id);
                            if (!cur || cur.assignee?.id === id) return;
                            const offered = (cur.offers || []).find((o) => o.agentId === id);
                            return offered ? T.api.acceptHandoff(item.id, id) : T.api.updateTodo(item.id, { assigneeId: id });
                        },
                        t("todosAssignedTo", { name }),
                    );
                },
            });
            btn.append(
                dotEl(color),
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
            if (pop.isConnected && pop.getBoundingClientRect().bottom > window.innerHeight - 8) pop.classList.add("up");
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
        const open = handPopFor === item.id;
        const btn = T.h("button", {
            type: "button",
            class: "td-handoff" + (offers.length ? " has" : "") + (open ? " on" : ""),
            "aria-haspopup": "listbox",
            "aria-expanded": String(open),
            onclick(e) {
                e.stopPropagation();
                handPopFor = open ? null : item.id;
                build();
            },
        });
        if (offers.length) {
            btn.append(
                T.h(
                    "span",
                    { class: "td-dots" },
                    offers.slice(0, 3).map((o) => dotEl(o.color)),
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
            value: draft.title,
            maxlength: "200",
            autocomplete: "off",
            placeholder: t("todosTitle"),
            "aria-label": t("todosTitle"),
        });
        title.addEventListener("input", () => {
            if (!draft) return;
            draft.title = title.value;
        });
        title.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && !e.isComposing) {
                e.preventDefault();
                cancelEdit();
            } else if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                saveEdit();
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
                        dotEl(item.assignee?.color || "var(--warning)"),
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
                                if (isOpen()) hide();
                                history.pushState(null, "", `/a/${encodeURIComponent(convId)}`);
                                T.app?.renderRoute?.();
                            } catch (_) {}
                        },
                    }),
                ]),
            );
        }
        if (item.assigneeId || String(item.prompt || "").trim() || String(draft.prompt || "").trim()) {
            const prompt = T.h("textarea", {
                class: "td-edit-prompt",
                rows: "1",
                maxlength: "4000",
                placeholder: t("todosPromptHint"),
                "aria-label": t("todosPromptHint"),
            });
            prompt.value = draft.prompt;
            const growPrompt = () => {
                prompt.style.height = "auto";
                prompt.style.height = `${Math.min(prompt.scrollHeight, 140)}px`;
            };
            prompt.addEventListener("input", () => {
                if (!draft) return;
                draft.prompt = prompt.value;
                growPrompt();
            });
            prompt.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && !e.isComposing) {
                    e.preventDefault();
                    cancelEdit();
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
            saving = true;
            try {
                await T.api.deleteTodo(item.id);
                if (neighbor) focusRowId = neighbor;
                if (editId === item.id) {
                    closeEditor();
                    if (routeFromPath()) {
                        try {
                            history.replaceState(null, "", "/t");
                        } catch (_) {}
                    }
                }
                await refresh();
            } catch (err) {
                T.toast.show("error", humanErr(err));
                if (isOpen()) build();
            } finally {
                saving = false;
                runPending();
            }
        };

        const armed = draft.armDelete && Date.now() < (draft.armUntil || 0);
        const delBtn = T.h("button", {
            type: "button",
            class: "btn ghost" + (armed ? " danger" : ""),
            text: armed ? t("deleteConfirm") : t("delete"),
            async onclick() {
                if (saving) {
                    const wasArmed = !!(draft?.armDelete && Date.now() < (draft.armUntil || 0));
                    queuePending(() => {
                        if (!routeFromPath()) return;
                        if (wasArmed) void doDelete();
                        else if (items().some((row) => row.id === item.id)) {
                            openEdit(item.id);
                            if (draft && editId === item.id) {
                                draft.armDelete = true;
                                draft.armUntil = Date.now() + 4000;
                                if (isOpen()) build();
                            }
                        }
                    });
                    return;
                }
                if (!draft) return;
                if (!draft.armDelete || Date.now() >= (draft.armUntil || 0)) {
                    draft.armDelete = true;
                    draft.armUntil = Date.now() + 4000;
                    delBtn.classList.add("danger");
                    delBtn.textContent = t("deleteConfirm");
                    setTimeout(() => {
                        if (draft?.armDelete && Date.now() >= (draft.armUntil || 0)) {
                            draft.armDelete = false;
                            if (isOpen()) build();
                        }
                    }, 4200);
                    return;
                }
                delBtn.disabled = true;
                await doDelete();
            },
        });

        const cancelBtn = T.h("button", { type: "button", class: "btn ghost", text: t("cancel"), onclick: cancelEdit });
        const saveBtn = T.h("button", {
            type: "button",
            class: "btn primary",
            text: t("save"),
            async onclick() {
                if (saveBtn.disabled) return;
                saveBtn.disabled = true;
                cancelBtn.disabled = true;
                try {
                    await saveEdit();
                } finally {
                    saveBtn.disabled = false;
                    cancelBtn.disabled = false;
                }
            },
        });

        const foot = T.h("div", { class: "td-edit-foot" }, [
            delBtn,
            item.assignee && item.status !== "done"
                ? (() => {
                      const runNow = async (b) => {
                          if (b.disabled || dispatching.has(item.id)) return;
                          if (saving) {
                              queuePending(() => {
                                  const cur = items().find((r) => r.id === item.id);
                                  if (routeFromPath() && cur?.assigneeId && cur.status === "open" && !cur.running && !dispatching.has(item.id))
                                      void runNow(b);
                              });
                              return;
                          }
                          dispatching.add(item.id);
                          b.disabled = true;
                          try {
                              pullFields();
                              const parsed = draft ? draftToPatch() : null;
                              if (parsed?.error) {
                                  T.toast.show("error", parsed.error === "title" ? t("todosNoTitle") : t("todosErrSchedule"));
                                  return;
                              }
                              if (parsed && Object.keys(parsed.body).length) {
                                  const ok = await commitDraft();
                                  if (!ok) return;
                              }
                              await T.api.runTodo(item.id);
                              T.toast.show("info", t("todosQueued"));
                          } catch (err) {
                              T.toast.show("error", humanErr(err));
                          } finally {
                              dispatching.delete(item.id);
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
            T.h("div", { class: "td-edit-head" }, [checkBtn(item, checked), title, handoffEl(item, false)]),
            T.h("div", { class: "td-edit-body" }, body),
            foot,
        ]);
    }

    function rowEl(item, done) {
        const editing = editId === item.id && draft;
        const checked = done || !!item.periodDone;
        if (editing) {
            return T.h("div", { class: "td-row is-editing", role: "listitem", dataset: { id: item.id } }, [editEl(item, checked)]);
        }
        const row = T.h(
            "div",
            {
                class: "td-row" + (checked ? " is-done" : ""),
                role: "listitem",
                tabindex: "0",
                dataset: { id: item.id },
                "aria-label": [
                    item.title,
                    whenLabel(item),
                    done ? t("todosDoneState") : item.periodDone ? t("todosPeriodDoneState") : "",
                    item.running ? t("todosRunning") : "",
                    t("todosEditHint"),
                ]
                    .filter(Boolean)
                    .join(" — "),
            },
            [
                checkBtn(item, checked),
                T.h("div", { class: "td-row-main" }, [T.h("div", { class: "td-row-title", text: item.title }), metaEl(item, done)]),
                (!done && handoffEl(item, true)) || T.h("span", { class: "td-edit-cue", "aria-hidden": "true" }, [T.icon("chevron", "icon-sm")]),
            ],
        );
        row.addEventListener("click", () => openEdit(item.id));
        row.addEventListener("keydown", (e) => {
            if (e.target !== row) return;
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                openEdit(item.id);
            }
        });
        return row;
    }

    /* ── 제안 카드 ─────────────────────────────────────────── */
    function suggestionAtDate(row) {
        if (!row?.at) return null;
        const hasOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(String(row.at));
        return atDate({ at: row.at, timezone: hasOffset ? "" : validTz(row.timezone) });
    }

    function suggestionWhen(row) {
        const rowTz = validTz(row.timezone);
        const tz = rowTz && rowTz !== browserTz() ? ` (${rowTz})` : "";
        if (row.at) {
            const d = suggestionAtDate(row);
            const foreign = rowTz && rowTz !== browserTz() ? rowTz : null;
            return (d ? formatDay(d, foreign) : formatDay(row.at) || String(row.at)) + (foreign ? tz : "");
        }
        if (row.cron) return (cronLabel(row.cron) || row.cron) + tz;
        if (row.every) return everyLabel(row.every);
        return "";
    }

    function suggestionEl(row) {
        const kind = row.kind === "edit" || row.kind === "delete" ? row.kind : "add";
        const kindLabel = t(kind === "edit" ? "todosSuggestEdit" : kind === "delete" ? "todosSuggestDelete" : "todosSuggestAdd");
        const approveLabel = kind === "delete" ? t("delete") : kind === "edit" ? t("todosApply") : t("todosApprove");
        const target = row.targetId ? items().find((r) => r.id === row.targetId) : null;
        const title = row.title || target?.title || "";
        const patch = row.patch && typeof row.patch === "object" ? row.patch : {};

        const subs = [];
        const targetGone = kind !== "add" && !target;
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
            const siblings = suggestions().filter((r) => r.id !== row.id && r.targetId === row.targetId).length;
            if (siblings) subs.push(t("todosSuggestCascade", { n: siblings }));
        }
        const previews = [];
        if (kind === "edit") {
            const changes = [];
            const clipVal = (v) =>
                String(v ?? "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120);
            if (patch.title != null && patch.title !== target?.title) {
                changes.push(t("todosFieldTitle"));
                previews.unshift(`${t("todosFieldTitle")}: ${clipVal(patch.title) || "—"}`);
            }
            if (patch.cron != null || patch.every != null || patch.at != null || patch.clearWhen) changes.push(t("todosFieldWhen"));
            if (patch.timezone != null) {
                changes.push(t("todosFieldTz"));
                previews.push(`${t("todosFieldTz")}: ${clipVal(patch.timezone) || "—"}`);
            }
            if (patch.prompt != null) previews.push(`${t("todosFieldPrompt")}: ${clipVal(patch.prompt) || "—"}`);
            if (changes.length) subs.push(`${t("todosSuggestChanges")}: ${changes.join(", ")}`);
        }

        const rejectBtn = T.h("button", { type: "button", class: "btn ghost", text: t("todosReject") });
        const approveBtn = targetGone
            ? null
            : T.h("button", {
                  type: "button",
                  class: kind === "delete" ? "btn danger" : "btn primary",
                  text: approveLabel,
              });
        const act = async (fn, doneMsg) => {
            if (actingSug.has(row.id)) return;
            const cur = suggestions().find((r) => r.id === row.id);
            if (!cur) {
                T.toast.show("info", t("todosSugGone"));
                refresh().catch(() => {});
                return;
            }
            if (saving) {
                actingSug.add(row.id);
                queuePending(() => {
                    actingSug.delete(row.id);
                    act(fn, doneMsg);
                });
                return;
            }
            actingSug.add(row.id);
            if (approveBtn) approveBtn.disabled = true;
            rejectBtn.disabled = true;
            try {
                const res = await fn();
                if (res === false) {
                    if (approveBtn) approveBtn.disabled = false;
                    rejectBtn.disabled = false;
                    return;
                }
                const newId = res?.item?.id;
                if (newId && kind === "add") scrollToRow = { id: newId, until: Date.now() + 1200 };
                await refresh();
                if (doneMsg) T.toast.show("info", doneMsg);
                if (document.activeElement === document.body || document.activeElement === null) {
                    const target = page.querySelector(".td-sug .btn") || page.querySelector(".td-row");
                    target?.focus?.();
                }
            } catch (err) {
                if (approveBtn) approveBtn.disabled = false;
                rejectBtn.disabled = false;
                const code = err?.payload?.error ?? err?.payload;
                T.toast.show("error", code === "not_found" ? t("todosSugGone") : humanErr(err));
                refresh().catch(() => {});
            } finally {
                actingSug.delete(row.id);
            }
        };
        const approveFlow = async () => {
            if (editId === row.targetId && draft && kind !== "delete" && !(await commitDraft())) return false;
            const res = await T.api.approveTodo(row.id, { timezone: browserTz() });
            if (kind === "delete" && editId === row.targetId) closeGoneEditor(row.targetId);
            return res;
        };
        rejectBtn.addEventListener("click", () => act(() => T.api.rejectTodo(row.id), t("todosSugRejected")));
        if (approveBtn) approveBtn.addEventListener("click", () => act(approveFlow, kind === "add" ? t("todosAdded") : t("todosSugApproved")));

        const promptText = String((kind === "add" ? row.prompt : patch.prompt) || "")
            .replace(/\s+$/g, "")
            .slice(0, 300);
        return T.h("div", { class: "td-sug", role: "listitem", dataset: { id: row.id } }, [
            T.h("div", { class: "td-sug-head" }, [
                T.h("span", {
                    class: "td-sug-avatar",
                    text: ([...String(row.agentName || "?").trim()][0] || "?").toUpperCase(),
                    style: `background:${safeColor(row.agentColor)}`,
                }),
                T.h("span", { class: "td-sug-name", text: row.agentName || row.agentId || "" }),
                T.h("span", { class: "td-sug-badge " + kind, text: kindLabel }),
            ]),
            T.h("div", { class: "td-sug-title", text: title }),
            promptText && kind !== "edit" ? T.h("div", { class: "td-sug-sub", text: `${t("todosFieldPrompt")}: ${promptText}` }) : null,
            ...previews.map((text) => T.h("div", { class: "td-sug-sub", text })),
            subs.length ? T.h("div", { class: "td-sug-sub", text: subs.join(" · ") }) : null,
            T.h("div", { class: "td-sug-actions" }, [rejectBtn, approveBtn]),
        ]);
    }

    /* ── 섹션/빌드 ─────────────────────────────────────────── */
    function sectionEl(title, openItems, doneItems, emptyKey, doneKey) {
        const sec = T.h("section", { class: "td-sec" }, [
            T.h("div", { class: "td-sec-head" }, [
                T.h("h2", { class: "td-sec-title", text: title }),
                openItems.length ? T.h("span", { class: "td-sec-count", text: String(openItems.length) }) : null,
            ]),
        ]);
        if (!openItems.length && !doneItems.length) {
            sec.append(T.h("div", { class: "td-empty", text: t(emptyKey) }));
            return sec;
        }
        if (openItems.length) {
            const card = T.h("div", { class: "td-card", role: "list" });
            for (const item of openItems) card.append(rowEl(item, false));
            sec.append(card);
        }
        if (doneItems.length) {
            const open = doneOpen[doneKey];
            const btn = T.h("button", { type: "button", class: "td-done-btn" + (open ? " open" : ""), "aria-expanded": String(open) }, [
                T.icon("chevron", "icon-sm"),
                T.h("span", { text: t("todosCompleted", { n: doneItems.length }) }),
            ]);
            btn.addEventListener("click", async () => {
                const editing = editId ? items().find((r) => r.id === editId) : null;
                const editingHere = editing?.status === "done" && (editing.assigneeId ? "agent" : "user") === doneKey;
                if (doneOpen[doneKey] && editingHere && draft && !(await commitDraft())) return;
                doneOpen[doneKey] = !doneOpen[doneKey];
                build();
            });
            sec.append(btn);
            if (open) {
                const card = T.h("div", { class: "td-card td-done-card", role: "list" });
                for (const item of doneItems) card.append(rowEl(item, true));
                sec.append(card);
            }
        }
        return sec;
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

    function build() {
        if (!page) return;
        if (composing) {
            buildQueued = true;
            return;
        }
        buildQueued = false;
        if (handPopFor && !items().some((row) => row.id === handPopFor)) handPopFor = null;
        if (editId && editId !== pendingDeepId && !items().some((row) => row.id === editId)) {
            const goneId = editId;
            if (draft) toastGone(goneId);
            closeGoneEditor(goneId);
        } else if (editId && !draft && editId !== pendingDeepId) {
            beginEdit(editId);
            focusEdit = true;
        }

        const SEL =
            ".td-edit-title,.td-edit-prompt,.td-time,.td-date,.td-num,.td-sel,.td-cron,.td-chip,.td-check,.td-done-btn,.td-handoff,.td-hand-item,.btn";
        const active = document.activeElement;
        let focus = null;
        if (active && page.contains(active)) {
            const host = active.closest?.(".td-row,.td-sug");
            const cls = [...(active.classList || [])].find((c) => SEL.includes("." + c));
            if (cls && host?.dataset?.id) {
                const peers = [...host.querySelectorAll("." + cls)];
                focus = {
                    rid: host.dataset.id,
                    sel: host.classList.contains("td-sug") ? ".td-sug" : ".td-row",
                    cls,
                    i: Math.max(0, peers.indexOf(active)),
                    s: active.selectionStart,
                    e: active.selectionEnd,
                };
            }
        }
        const rowFocus = !focus && active && page.contains(active) && active.matches?.(".td-row[data-id]") ? active.dataset.id : null;
        const doneBtnFocus =
            !focus && !rowFocus && active?.matches?.(".td-done-btn") ? [...page.querySelectorAll(".td-done-btn")].indexOf(active) : -1;
        page.replaceChildren();

        const all = items();
        const mineOpen = all.filter((row) => row.status === "open" && !row.assigneeId);
        const agentOpen = all.filter((row) => row.status === "open" && row.assigneeId);
        const doneDesc = (a, b) => String(b.lastDoneAt || b.createdAt || "").localeCompare(String(a.lastDoneAt || a.createdAt || ""));
        const mineDone = all.filter((row) => row.status === "done" && !row.assigneeId).sort(doneDesc);
        const agentDone = all.filter((row) => row.status === "done" && row.assigneeId).sort(doneDesc);

        const editing = editId ? all.find((row) => row.id === editId) : null;
        if (editing?.status === "done") doneOpen[editing.assigneeId ? "agent" : "user"] = true;

        const pending = suggestions();
        let wrapChildren;
        if (state.state.todosFailed && !all.length) {
            const retryBtn = T.h("button", { type: "button", class: "btn", text: t("retry") });
            retryBtn.addEventListener("click", () => {
                retryBtn.disabled = true;
                refresh().catch(() => {});
            });
            wrapChildren = [T.h("div", { class: "td-loadfail" }, [T.h("div", { class: "td-empty", text: t("todosLoadFailed") }), retryBtn])];
        } else {
            const secUser = sectionEl(t("todosUser"), mineOpen, mineDone, "todosEmptyUser", "user");
            const secAgent = sectionEl(t("todosAgent"), agentOpen, agentDone, "todosEmptyAgent", "agent");
            const secSug = suggestionsEl(pending);
            wrapChildren = pending.length ? [secSug, secUser, secAgent] : [secUser, secAgent, secSug];
        }
        const rec = state.state.todosRecovered;
        if (rec && !recoveredDismissed) {
            const x = T.h("button", { type: "button", class: "td-recovered-x", text: "×", "aria-label": t("todosDismiss") });
            x.addEventListener("click", () => {
                recoveredDismissed = true;
                build();
            });
            wrapChildren.unshift(
                T.h("div", { class: "td-recovered" }, [
                    T.h("div", { class: "td-recovered-msg", text: t("todosStoreRecovered", { file: rec.backup || "todos.json.bak" }) }),
                    x,
                ]),
            );
        }
        const wrap = T.h("div", { class: "td-wrap" }, wrapChildren);
        page.append(wrap);

        if (focus) {
            const host = focus.rid ? page.querySelector(`${focus.sel || ".td-row"}[data-id="${focus.rid}"]`) : null;
            const el = host ? host.querySelectorAll("." + focus.cls)[focus.i] : null;
            if (el) {
                el.focus({ preventScroll: true });
                try {
                    el.setSelectionRange?.(focus.s ?? el.value?.length ?? 0, focus.e ?? el.value?.length ?? 0);
                } catch (_) {}
            }
        } else if (focusEdit) {
            focusEdit = false;
            const input = page.querySelector(".td-edit-title");
            if (input && !isTouch()) {
                input.focus({ preventScroll: true });
                input.selectionStart = input.selectionEnd = input.value.length;
            }
        } else {
            focusEdit = false;
        }
        const targetRow = focusRowId || rowFocus;
        focusRowId = null;
        if (targetRow) {
            const el = page.querySelector(`.td-row[data-id="${targetRow}"]`);
            if (el) {
                el.scrollIntoView({ block: "nearest" });
                el.focus({ preventScroll: true });
            }
        } else if (doneBtnFocus >= 0) {
            page.querySelectorAll(".td-done-btn")[doneBtnFocus]?.focus({ preventScroll: true });
        }
        if (scrollToRow) {
            const el = scrollToRow.id ? page.querySelector(`.td-row[data-id="${scrollToRow.id}"]`) : null;
            const scroller = page.parentElement;
            const r = el?.getBoundingClientRect();
            const s = scroller?.getBoundingClientRect();
            const visible = r && s && r.top >= s.top && r.bottom <= s.bottom;
            if (el && !visible) el.scrollIntoView({ block: "nearest" });
            if (!el || visible || Date.now() > scrollToRow.until) scrollToRow = null;
        }
    }

    /* ── 열기/닫기 ─────────────────────────────────────────── */
    async function resolveDeepLink(id) {
        const ok = await refresh().catch(() => false);
        if (pendingDeepId !== id) return;
        if (items().some((row) => row.id === id)) {
            pendingDeepId = null;
            if (!draft) {
                beginEdit(id);
                focusEdit = true;
            }
            if (editId === id) scrollToRow = { id, until: Date.now() + 1200 };
            if (isOpen()) build();
            return;
        }
        if (!ok) return;
        pendingDeepId = null;
        if (editId === id) closeEditor();
        if (editId) {
            if (isOpen()) build();
            return;
        }
        try {
            history.replaceState(null, "", "/t");
        } catch (_) {}
        toastGone(id);
        if (isOpen()) build();
    }

    function open(opt) {
        const o = opt || {};
        const my = ++intentSeq;
        if (saving) {
            queuePending(() => {
                if (routeFromPath()) open(o);
            });
            return;
        }
        if (o.id !== editId && draft) {
            commitDraft().then((ok) => {
                if (ok && my === intentSeq && routeFromPath()) open(o);
                else if (!ok && my === intentSeq && routeFromPath()) open({ id: editId, replace: true });
            });
            return;
        }
        if (o.id) {
            if (o.id !== editId) draft = null;
            else if (draft) {
                const cur = items().find((row) => row.id === o.id);
                if (cur) draft.base = cur.updatedAt || draft.base;
            }
            editId = o.id;
            pendingDeepId = items().some((row) => row.id === o.id) ? null : o.id;
            if (!pendingDeepId) scrollToRow = { id: o.id, until: Date.now() + 1200 };
        } else {
            pendingDeepId = null;
            closeEditor();
        }
        T.settingsUI?.hide?.();
        T.sidebar?.showChat?.();
        if (!o.fromUrl) {
            try {
                const path = o.id ? "/t/" + o.id : "/t";
                if (o.replace) history.replaceState(null, "", path);
                else history.pushState(null, "", path);
            } catch (_) {}
        } else if (!o.id && location.pathname !== "/t") {
            try {
                history.replaceState(null, "", "/t");
            } catch (_) {}
        }
        const wasHidden = page.hidden;
        page.hidden = false;
        page.setAttribute("aria-label", t("todos"));
        if (wasHidden && !o.id && !isTouch()) page.focus({ preventScroll: true });
        document.body.classList.add("todos-route");
        state.setCurrentTodo("list");
        T.sidebar?.syncRoute?.();
        T.chat?.refreshHeader?.();
        T.composer?.syncMode?.();
        const scroller = page.parentElement;
        if (scroller && wasHidden) scroller.scrollTop = o.id ? 0 : lastScrollTop;
        build();
        if (pendingDeepId) void resolveDeepLink(pendingDeepId);
        else if (!items().length && !suggestions().length && !loading) refresh();
    }

    function hide() {
        lastScrollTop = page.parentElement?.scrollTop ?? 0;
        page.hidden = true;
        document.body.classList.remove("todos-route");
        pendingDeepId = null;
        handPopFor = null;
        composing = 0;
        composingEl = null;
        clearTimeout(composingTimer);
        buildQueued = false;
        scrollToRow = null;
        if (editId && draft) void commitDraft();
        else closeEditor();
        state.setCurrentTodo(null);
        page.replaceChildren();
        T.chat?.refreshHeader?.();
        T.composer?.syncMode?.();
    }

    /* ── 구독 ──────────────────────────────────────────────── */
    function init() {
        document.addEventListener("click", (e) => {
            if (!handPopFor || e.target.closest?.(".td-hand-wrap")) return;
            handPopFor = null;
            if (isOpen()) build();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !handPopFor || e.defaultPrevented) return;
            handPopFor = null;
            if (isOpen()) build();
        });
        state.on("todos", (freshData) => {
            const cur = suggestions();
            if (seenSugIds && !isOpen()) {
                const fresh = cur.filter((row) => !seenSugIds.has(row.id));
                if (fresh.length) {
                    const name = fresh[0].agentName || "";
                    T.toast.show("info", name ? t("todosNewSuggest", { name }) : t("todosNewSuggestAnon"), () => {
                        if (location.pathname !== "/t") {
                            try {
                                history.pushState(null, "", "/t");
                            } catch (_) {}
                        }
                        T.app?.renderRoute?.();
                    });
                }
            }
            seenSugIds = new Set(cur.map((row) => row.id));
            if (pendingDeepId && freshData === true) {
                const id = pendingDeepId;
                if (items().some((row) => row.id === id)) {
                    pendingDeepId = null;
                    if (!draft) {
                        beginEdit(id);
                        focusEdit = true;
                    }
                    if (editId === id) scrollToRow = { id, until: Date.now() + 1200 };
                } else {
                    pendingDeepId = null;
                    if (editId === id) closeGoneEditor(id);
                    if (!editId) {
                        try {
                            history.replaceState(null, "", "/t");
                        } catch (_) {}
                        toastGone(id);
                    }
                }
            }
            if (!isOpen()) return;
            if (freshData === true && editId && !items().some((row) => row.id === editId)) {
                const goneId = editId;
                closeGoneEditor(goneId);
                toastGone(goneId);
            }
            if (editId && draft) {
                if (!composing) pullFields();
                const fresh = items().find((row) => row.id === editId);
                if (fresh && rebaseDraft(fresh)) T.toast.show("info", t("todosExternChanged"));
            }
            build();
        });
        page.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
            if (handPopFor) {
                e.preventDefault();
                handPopFor = null;
                build();
                return;
            }
            if (editId && !e.target?.closest?.(".td-sug")) {
                e.preventDefault();
                cancelEdit();
            }
        });
        const endComposition = () => {
            composing = 0;
            composingEl = null;
            clearTimeout(composingTimer);
            if (buildQueued) {
                buildQueued = false;
                build();
            }
        };
        page.addEventListener("compositionstart", (e) => {
            composing += 1;
            composingEl = e.target;
            clearTimeout(composingTimer);
            composingTimer = setTimeout(endComposition, 15000);
        });
        page.addEventListener("compositionend", () => {
            composing = Math.max(0, composing - 1);
            if (!composing) endComposition();
        });
        page.addEventListener("focusout", (e) => {
            if (composing && e.target === composingEl) endComposition();
        });
        state.on("bots", () => {
            if (draft?.pendingAssignee && !(state.state.bots || []).some((b) => b.id === draft.pendingAssignee)) {
                draft.pendingAssignee = null;
                T.toast.show("info", t("todosAssigneeGone"));
            }
            if (editId && draft) pullFields();
            if (isOpen()) build();
        });
        window.addEventListener("pagehide", () => {
            if (!editId || !draft) return;
            pullFields();
            const parsed = draftToPatch();
            const body = parsed.error ? {} : { ...parsed.body };
            const botId = draft.pendingAssignee;
            if (botId) {
                body.assigneeId = botId;
                const cur = items().find((r) => r.id === editId);
                const offered = (cur?.offers || []).find((o) => o.agentId === botId);
                if (offered?.prompt && body.prompt == null) body.prompt = offered.prompt;
            }
            if (!Object.keys(body).length) return;
            try {
                const headers = { "Content-Type": "application/json" };
                const tk = localStorage.getItem("tabybot.web.token");
                if (tk) headers.Authorization = "Bearer " + tk;
                fetch(`/api/todos/${editId}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ ...body, baseUpdatedAt: draft.base }),
                    keepalive: true,
                });
            } catch (_) {}
        });
        const scroller = page.parentElement;
        scroller?.addEventListener("wheel", () => (scrollToRow = null), { passive: true });
        scroller?.addEventListener("touchmove", () => (scrollToRow = null), { passive: true });
        T.i18n.onChange(() => {
            if (isOpen()) {
                if (editId && draft) pullFields();
                page.setAttribute("aria-label", t("todos"));
                build();
                T.chat?.refreshHeader?.();
                T.composer?.syncMode?.();
            }
        });
    }

    function describeDue(msg) {
        const parts = [String(msg?.title || "")];
        const w = whenLabel({
            status: "open",
            kind: msg?.kind,
            cron: msg?.cron,
            every: msg?.every,
            at: msg?.at,
            timezone: msg?.timezone,
        });
        if (w) parts.push(w);
        return parts.filter(Boolean).join(" — ").slice(0, 180);
    }

    T.todosUI = { init, open, hide, isOpen, routeFromPath, addFromComposer, describeDue };
})((window.Taby = window.Taby || {}));
