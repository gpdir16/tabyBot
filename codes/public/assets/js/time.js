/* tabyBot 웹 클라이언트: 서버 시간대. 화면의 시각 표시와 날짜 계산(오늘, 어제, 며칠 전)을 모두 서버가 쓰는 시간대로 한다.
   서버 시간대는 설정한 시간대이고, 비어 있으면 서버 기본값(도커는 UTC)이다. 설정 응답의 serverTimezone으로 받는다. */
((T) => {
    "use strict";

    function browserZone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        } catch (_) {
            return "UTC";
        }
    }

    function validZone(tz) {
        if (!tz) return "";
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: tz });
            return tz;
        } catch (_) {
            return "";
        }
    }

    function zone() {
        // 설정을 받기 전에는 브라우저 시간대로 그린다.
        return validZone(T.state?.state?.settings?.serverTimezone) || browserZone();
    }

    function locale() {
        const lang = T.i18n.getLang();
        return lang === "ko" ? "ko-KR" : lang === "ja" ? "ja-JP" : "en-US";
    }

    // 시간대의 벽시계 값(연, 월, 일, 시, 분).
    function parts(date, tz = zone()) {
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
                .formatToParts(date)
                .map((x) => [x.type, x.value]),
        );
        return { y: +p.year, m: +p.month, d: +p.day, hh: Number(p.hour) % 24, mm: +p.minute };
    }

    // b(기본은 지금)의 날짜에서 a의 날짜까지 며칠인지(a가 내일이면 1, 어제면 -1).
    function dayDiff(a, b = new Date(), tz = zone()) {
        const pa = parts(a, tz);
        const pb = parts(b, tz);
        return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
    }

    // 서버 시간대로 쓴 시각. opts.timeZone을 주면 그 시간대로 쓴다(시간대를 따로 가진 할 일).
    function format(date, opts, loc = locale()) {
        return new Intl.DateTimeFormat(loc, { timeZone: zone(), ...opts }).format(date);
    }

    // 서버 시간대가 바뀌면(설정 변경) fn을 부른다. 이미 그린 시각을 다시 그리는 데 쓴다.
    function onChange(fn) {
        let last = zone();
        T.state.on("settings", () => {
            const next = zone();
            if (next === last) return;
            last = next;
            fn(next);
        });
    }

    T.time = { validZone, zone, locale, parts, dayDiff, format, onChange };
})(window.Taby);
