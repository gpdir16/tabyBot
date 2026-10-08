/* tabyBot 웹 클라이언트: 할 일의 시간·반복 규칙 표시와 변환. */
((T) => {
    "use strict";

    T.todosCtx ??= {};
    const C = T.todosCtx;
    const t = (k, v) => T.i18n.t(k, v);

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
        return `${pad(m[2])}:${pad(m[1])}`;
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
        return lang() === "ja" ? `${n}曜` : n;
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
        if (daily && okHM(+daily[1], +daily[2])) return t("todosEveryDayAt", { time: `${pad(daily[2])}:${pad(daily[1])}` });
        const weekly = /^(\d+) (\d+) \* \* ([0-7])$/.exec(str);
        if (weekly && okHM(+weekly[1], +weekly[2]))
            return t("todosEveryWeek", { day: dayName(weekly[3]), time: `${pad(weekly[2])}:${pad(weekly[1])}` });
        const monthly = /^(\d+) (\d+) (\d{1,2}) \* \*$/.exec(str);
        if (monthly && okHM(+monthly[1], +monthly[2]) && +monthly[3] >= 1 && +monthly[3] <= 31)
            return t("todosEveryMonth", { day: String(Number(monthly[3])), time: `${pad(monthly[2])}:${pad(monthly[1])}` });
        const everyMin = /^\*\/(\d+) \* \* \* \*$/.exec(str);
        if (everyMin && +everyMin[1] >= 1 && +everyMin[1] <= 59) return t("todosEveryNMinutes", { n: Number(everyMin[1]) });
        const weekRange = /^(\d+) (\d+) \* \* ([0-7])-([0-7])$/.exec(str);
        if (weekRange && okHM(+weekRange[1], +weekRange[2])) {
            return t("todosEveryWeekRange", {
                a: dayName(weekRange[3]),
                b: dayName(weekRange[4]),
                time: `${pad(weekRange[2])}:${pad(weekRange[1])}`,
            });
        }
        const weekList = /^(\d+) (\d+) \* \* ([0-7](?:,[0-7])*)$/.exec(str);
        if (weekList && okHM(+weekList[1], +weekList[2])) {
            const names = [...new Set(weekList[3].split(",").map((d) => Number(d) % 7))].map((d) => dayName(d)).join(dayJoiner());
            return t("todosEveryWeekDays", { days: names, time: `${pad(weekList[2])}:${pad(weekList[1])}` });
        }
        const monthList = /^(\d+) (\d+) ([0-9]{1,2}(?:,[0-9]{1,2})+) \* \*$/.exec(str);
        if (monthList && okHM(+monthList[1], +monthList[2]) && monthList[3].split(",").every((d) => +d >= 1 && +d <= 31)) {
            const days = monthList[3]
                .split(",")
                .map((d) => String(Number(d)))
                .join(dayJoiner());
            return t("todosEveryMonthDays", { days, time: `${pad(monthList[2])}:${pad(monthList[1])}` });
        }
        return str;
    }

    function toLocalInput(isoOrAt) {
        if (!isoOrAt) return "";
        const d = new Date(isoOrAt);
        if (Number.isNaN(d.getTime())) {
            const m = String(isoOrAt).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
            return m ? `${m[1]}T${m[2]}` : "";
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
        return { dow: +m[3] % 7, time: `${pad(m[2])}:${pad(m[1])}` };
    }

    function cronMonthly(cron) {
        const m = /^(\d+) (\d+) (\d+) \* \*$/.exec(String(cron || ""));
        if (!m || !okHM(+m[1], +m[2]) || +m[3] < 1 || +m[3] > 31) return null;
        return { dom: +m[3], time: `${pad(m[2])}:${pad(m[1])}` };
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

    C.lang = lang;
    C.hasVisible = hasVisible;
    C.dailyTime = dailyTime;
    C.everyLabel = everyLabel;
    C.cronLabel = cronLabel;
    C.wallClockDate = wallClockDate;
    C.atDate = atDate;
    C.localAt = localAt;
    C.atSeedInput = atSeedInput;
    C.todayDefault = todayDefault;
    C.nowLocalInput = nowLocalInput;
    C.formatDay = formatDay;
    C.browserTz = browserTz;
    C.validTz = validTz;
    C.whenLabel = whenLabel;
    C.cronWeekly = cronWeekly;
    C.cronMonthly = cronMonthly;
    C.everyParts = everyParts;
    C.whenMode = whenMode;
    C.isOverdue = isOverdue;
    C.isTodayKind = isTodayKind;
})(window.Taby);
