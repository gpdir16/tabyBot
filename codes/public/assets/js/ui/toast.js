/* tabyBot 웹 클라이언트: 토스트.
   방금 한 동작의 결과를 잠깐 알려 주는 작은 알약 모양 표시("복사됨", "저장 실패" 등).
   화면 아래 가운데에 글자만 한 줄로 떴다가 스스로 사라지고, 한 번에 하나만 보인다
   (새 것이 오면 이전 것은 바로 물러난다). 눌러서 바로 닫을 수도 있다.

   확인이 필요한 일(서버 알림, 새 버전, 서버 연결 불가, 에이전트 오류)은 여기가 아니라
   경고창(T.notices.alert, ui/notices.js)으로 띄운다. */
((T) => {
    "use strict";

    const root = document.getElementById("toasts");
    const SHOW_MS = 2600;
    const SHOW_ERROR_MS = 4000; // 실패 안내는 읽을 시간을 조금 더 준다
    const OUT_MS = 200;

    let current = null;
    let timer = 0;

    function dismiss(el) {
        if (!el?.isConnected) return;
        if (current === el) current = null;
        el.classList.remove("in");
        el.classList.add("out");
        setTimeout(() => el.remove(), OUT_MS);
    }

    // level: "info" | "warn" | "error". warn/error는 실패 색으로 보인다.
    function show(level, text) {
        const message = String(text == null ? "" : text).trim();
        if (!root || !message) return;
        const failed = level === "error" || level === "warn";
        dismiss(current);
        const el = T.h("div", { class: `toast${failed ? " error" : ""}` }, [T.h("span", { text: message })]);
        el.addEventListener("click", () => dismiss(el));
        root.append(el);
        current = el;
        // 표시 트랜지션용 더블 rAF
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
        clearTimeout(timer);
        timer = setTimeout(() => dismiss(el), failed ? SHOW_ERROR_MS : SHOW_MS);
    }

    T.toast = { show };
})(window.Taby);
