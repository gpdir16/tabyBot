/* tabyBot 웹 클라이언트: 메시지 시각·날짜 표시와 이미지 주소 도우미. */
((T) => {
    "use strict";

    T.chatCtx ??= {};
    const C = T.chatCtx;

    /* ── 유틸 ───────────────────────────────────────────────── */
    function fmt(n) {
        try {
            return Number(n).toLocaleString(T.i18n.getLang() === "ko" ? "ko-KR" : T.i18n.getLang() === "ja" ? "ja-JP" : "en-US");
        } catch (_) {
            return String(n);
        }
    }

    function i18nLocale() {
        return T.i18n.getLang() === "ko" ? "ko-KR" : T.i18n.getLang() === "ja" ? "ja-JP" : "en-US";
    }

    function fmtMsgTime(at) {
        const ms = Date.parse(at || "");
        if (!Number.isFinite(ms)) return "";
        try {
            return new Intl.DateTimeFormat(i18nLocale(), { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
        } catch (_) {
            return "";
        }
    }

    function fmtMsgTitle(at) {
        const ms = Date.parse(at || "");
        if (!Number.isFinite(ms)) return "";
        try {
            return new Intl.DateTimeFormat(i18nLocale(), { dateStyle: "medium", timeStyle: "medium" }).format(new Date(ms));
        } catch (_) {
            return "";
        }
    }

    // 날짜 구분선용 로컬 날짜 키/라벨: 시각만으로는 며칠 전 메시지와 오늘 메시지가
    // 구분되지 않아 순서가 엉켜 보이는 문제를 막는다.
    function dayKeyOf(at) {
        const ms = Date.parse(at || "");
        if (!Number.isFinite(ms)) return "";
        const d = new Date(ms);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }

    function fmtMsgDate(at) {
        const ms = Date.parse(at || "");
        if (!Number.isFinite(ms)) return "";
        try {
            // 메신저의 날짜 칩처럼 "10월 6일"만 쓴다. 올해가 아니면 연도를 붙인다.
            const d = new Date(ms);
            const opts =
                d.getFullYear() === new Date().getFullYear() ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" };
            return new Intl.DateTimeFormat(i18nLocale(), opts).format(d);
        } catch (_) {
            return "";
        }
    }

    // 메시지 발화 시각: 시각만 보이고 전체 날짜시각은 툴팁으로.
    function msgTimeEl(at) {
        const label = fmtMsgTime(at);
        if (!label) return null;
        return T.h("span", { class: "msg-time", text: label, title: fmtMsgTitle(at) });
    }

    // 시각을 글의 흐름 안에 둔다. 메신저처럼 마지막 줄 끝에 흘러 붙고, 자리가 모자라면 한 줄 아래로 내려간다.
    // - 통계 푸터가 있으면 그 줄의 오른쪽 끝(시각이 따로 한 줄을 더 차지하지 않게)
    // - 글이 문단(또는 보낸 글)으로 끝나면 그 마지막 줄 끝
    // - 목록·코드·표로 끝나면 그 아래 오른쪽
    // - 말풍선이 없으면(첨부만 있는 메시지) 첨부 아래
    function placeTime(time, stack, bubble) {
        if (!time) return;
        const foot = bubble?.querySelector(":scope > .stats-footer");
        const text = bubble?.querySelector(":scope > .bubble-text");
        const lastBlock = bubble?.querySelector(":scope > .md")?.lastElementChild;
        if (foot) foot.append(time);
        else if (text) text.append(time);
        else if (lastBlock?.tagName === "P") lastBlock.append(time);
        else if (lastBlock) bubble.append(time);
        else stack.append(time);
    }

    // 이미지 src: blob/data는 그대로, 파일 API는 쿼리 토큰을 붙인다.
    function setThumbSrc(img, pathOrUrl) {
        if (!pathOrUrl) return;
        if (pathOrUrl.startsWith("blob:") || pathOrUrl.startsWith("data:") || pathOrUrl.includes("?token=") || !T.api.getToken()) {
            img.src = pathOrUrl;
            return;
        }
        if (pathOrUrl.startsWith("/api/files/")) {
            img.src = T.api.fileHref(pathOrUrl.split("/").pop().split("?")[0]);
            return;
        }
        img.src = pathOrUrl;
    }

    C.fmt = fmt;
    C.dayKeyOf = dayKeyOf;
    C.fmtMsgDate = fmtMsgDate;
    C.msgTimeEl = msgTimeEl;
    C.placeTime = placeTime;
    C.setThumbSrc = setThumbSrc;
})(window.Taby);
