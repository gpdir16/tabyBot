/* tabyBot 웹 클라이언트 — 마크다운 파이프라인.
   marked(파싱) → DOMPurify(살균) → hljs(코드 하이라이트).
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

    // 마크다운 문자열 → 살균된 DOM 컨테이너(div.md)
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

    // 사이드바 한 줄 미리보기: 마크다운 기호만 걷어 낸 평문.
    function stripPreview(text) {
        let s = String(text || "");
        if (!s) return "";
        s = s.replace(/```[\s\S]*?```/g, " ");
        s = s.replace(/`([^`]+)`/g, "$1");
        s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
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

    T.md = { render, stripPreview };
})((window.Taby = window.Taby || {}));
