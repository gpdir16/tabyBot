/* tabyBot 웹 클라이언트: 전역 네임스페이스(Taby) 생성과 여러 화면이 같이 쓰는 순수 함수.
   스크립트 체인의 맨 처음에 로드되어야 한다. */
window.Taby = window.Taby ?? {};

((T) => {
    "use strict";

    const ATTACHED_FILES_MARK = "[User attached files]";

    // 첨부 파일 안내가 덧붙은 사용자 메시지에서 화면에 보일 본문만 남긴다.
    function displayUserText(content) {
        const s = String(content || "");
        const i = s.indexOf(ATTACHED_FILES_MARK);
        return i === -1 ? s : s.slice(0, i).trim();
    }

    function formatSize(bytes) {
        const size = Number(bytes);
        if (!Number.isFinite(size) || size < 0) return "";
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    // 첨부 칩에 보일 파일 종류(확장자 우선, 없으면 MIME 하위 타입).
    function fileType(mime, name) {
        const ext = String(name || "")
            .split(".")
            .pop();
        if (ext && ext !== name && ext.length <= 8) return ext.toUpperCase();
        const sub = String(mime || "")
            .split("/")
            .pop();
        if (sub && sub !== "octet-stream") return sub.toUpperCase();
        return "FILE";
    }

    // 에이전트 색은 #rrggbb만 받고, 그 밖의 값은 강조색으로 대신한다. style 속성에 그대로 들어가므로 검증이 필요하다.
    function safeColor(value) {
        return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : "var(--accent)";
    }

    // 주소만 바꾼다. 주소 갱신이 막힌 환경(샌드박스 iframe 등)에서는 화면만 바꾸고 주소는 그대로 둔다.
    // 바꿨으면 true.
    function pushUrl(url, state = null) {
        try {
            history.pushState(state, "", url);
            return true;
        } catch {
            return false;
        }
    }

    function replaceUrl(url, state = null) {
        try {
            history.replaceState(state, "", url);
            return true;
        } catch {
            return false;
        }
    }

    T.util = { displayUserText, formatSize, fileType, safeColor, pushUrl, replaceUrl };
})(window.Taby);
