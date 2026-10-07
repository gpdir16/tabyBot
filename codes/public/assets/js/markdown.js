/* tabyBot 웹 클라이언트: 마크다운 파이프라인.
   marked로 파싱하고, DOMPurify로 살균한 뒤, hljs로 코드를 하이라이트한다.
   코드블록은 DOM 후처리로 언어 라벨 + 복사 버튼 헤더 바를 감싼다.
   턴이 끝나면 전체 렌더에서 하이라이트를 적용한다. */
(function (T) {
    "use strict";

    let ready = false;

    function init() {
        if (ready) return;
        if (typeof marked === "undefined" || typeof DOMPurify === "undefined") return;
        try {
            marked.use({ gfm: true, breaks: true });
            // 외부 링크: 새 탭 + opener 차단
            DOMPurify.addHook("afterSanitizeAttributes", (node) => {
                if (node.tagName === "A") {
                    node.setAttribute("target", "_blank");
                    node.setAttribute("rel", "noopener noreferrer");
                }
            });
        } catch (_) {
            /* 벤더 초기화 실패 시에도 텍스트 폴백 동작 */
        }
        ready = true;
    }

    // 마크다운 문자열을 살균된 DOM 컨테이너(div.md)로 바꾼다.
    function render(text, opt) {
        const o = opt || {};
        const box = T.h("div", { class: "md" + (o.extraClass ? " " + o.extraClass : "") });
        const src = String(text == null ? "" : text);
        init();

        let html = null;
        if (ready) {
            try {
                html = DOMPurify.sanitize(marked.parse(src));
            } catch (_) {
                html = null;
            }
        }
        if (html != null) {
            box.innerHTML = html; // 이미 살균됨
        } else {
            box.textContent = src; // 벤더 부재/오류 폴백
        }

        enhanceCodeBlocks(box, o.highlight !== false);
        return box;
    }

    // pre>code 를 .codeblock(헤더 바 포함)으로 감싸고 하이라이트 적용
    function enhanceCodeBlocks(container, highlight) {
        container.querySelectorAll("pre > code").forEach((code) => {
            const pre = code.parentElement;
            if (!pre || pre.parentElement.closest(".codeblock-head")) return;

            const m = /language-([\w+#.-]+)/.exec(code.className || "");
            const langName = m ? m[1] : "text";

            const copyBtn = T.h("button", {
                class: "code-copy",
                "data-tip": T.i18n.t("copy"),
                "aria-label": T.i18n.t("copy"),
                onclick() {
                    const ok = T.copyText(code.textContent || "");
                    Promise.resolve(ok).then((done) => {
                        if (!done) return;
                        copyBtn.classList.add("copied");
                        setTimeout(() => copyBtn.classList.remove("copied"), 1200);
                    });
                },
            });
            copyBtn.append(T.icon("copy", "ic-copy"), T.icon("check", "ic-check"));

            const head = T.h("div", { class: "codeblock-head" }, [T.h("span", { class: "code-lang", text: langName }), copyBtn]);
            const block = T.h("div", { class: "codeblock" });
            pre.replaceWith(block);
            block.append(head, pre);

            if (highlight && typeof hljs !== "undefined") {
                try {
                    hljs.highlightElement(code);
                } catch (_) {
                    /* 미지원 언어 무시 */
                }
            }
        });
    }

    // 미리보기 자리 표시 문자(사설 영역): 표·코드 블록·이미지. 서버(chat-history.js)와 같은 값을 쓴다.
    const PREVIEW_TABLE = "\uE000";
    const PREVIEW_CODE = "\uE001";
    const PREVIEW_IMAGE = "\uE002";
    const PREVIEW_ICONS = { [PREVIEW_TABLE]: "table", [PREVIEW_CODE]: "code", [PREVIEW_IMAGE]: "image" };
    // 표의 구분 행 한 칸(":---:" 등)과 구분 행 전체.
    const TABLE_CELL = "[ \\t]*:?-+:?[ \\t]*";
    const TABLE_DELIM = `(?:\\|${TABLE_CELL}(?:\\|${TABLE_CELL})*\\|?|${TABLE_CELL}(?:\\|${TABLE_CELL})+\\|?)`;
    const PREVIEW_TABLE_RE = new RegExp(
        `(^|\\n)[ \\t]*[^\\n]*\\|[^\\n]*\\n[ \\t]*${TABLE_DELIM}[ \\t]*(?=\\n|$)(?:\\n[ \\t]*[^\\n]*\\|[^\\n]*)*`,
        "g",
    );

    // 사이드바 한 줄 미리보기: 마크다운 기호만 걷어 낸 평문. 표·코드·이미지는 자리 표시 문자로 남는다.
    function stripPreview(text) {
        let s = String(text || "");
        if (!s) return "";
        // 한 줄에 옮기기 어려운 블록은 자리 표시 문자로 남긴다(목록에서 아이콘으로 그린다).
        // 코드 블록: 줄 머리에서 시작하는 펜스만 잡는다(글 속에서 백틱 세 개를 언급한 것은 건드리지 않는다).
        s = s.replace(/(^|\n)[ \t]*```[\s\S]*?(\n[ \t]*```|$)/g, `$1 ${PREVIEW_CODE} `);
        // 표: 머리 행 + 구분 행 + 본문 행들. 구분 행은 파이프가 하나는 있어야 하고 줄 끝까지 구분 행이어야 한다
        // (파이프가 든 문장 다음 줄의 "---"나 "--help"를 표로 잡지 않게).
        s = s.replace(PREVIEW_TABLE_RE, `$1 ${PREVIEW_TABLE} `);
        // 이미 한 줄로 펴져 저장된 표(예전 미리보기)
        s = s.replace(/\|[^\n]*\|[ \t]*:?-{2,}:?[ \t]*\|[^\n]*/g, ` ${PREVIEW_TABLE} `);
        s = s.replace(/`([^`]+)`/g, "$1");
        s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ` ${PREVIEW_IMAGE} `);
        s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
        s = s.replace(/(\*\*|__)([^*_\n]+)\1/g, "$2");
        s = s.replace(/([*_])([^*_\n]+)\1/g, "$2");
        s = s.replace(/~~(.*?)~~/g, "$1");
        s = s.replace(/(^|\s)#{1,6}\s+/g, "$1");
        s = s.replace(/(^|\s)>\s+/g, "$1");
        s = s.replace(/(^|\s)[-*+]\s+/g, "$1");
        s = s.replace(/(^|\s)\d+\.\s+/g, "$1");
        return s.replace(/\s+/g, " ").trim();
    }

    // 미리보기 문자열을 노드로 바꾼다: 자리 표시 문자는 아이콘, 나머지는 글자.
    function previewNodes(text) {
        return String(text || "")
            .split(/([\uE000-\uE002])/)
            .filter(Boolean)
            .map((part) => (PREVIEW_ICONS[part] ? T.icon(PREVIEW_ICONS[part], "pv-icon") : document.createTextNode(part)));
    }
    // 읽어 주는 이름 등 글자만 필요한 곳: 자리 표시 문자를 뺀다.
    function previewPlain(text) {
        return String(text || "")
            .replace(/[\uE000-\uE002]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    T.md = { render, stripPreview, previewNodes, previewPlain };
})((window.Taby = window.Taby || {}));
