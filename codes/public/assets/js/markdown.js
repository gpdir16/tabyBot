/* tabyBot 웹 클라이언트 — 마크다운 파이프라인.
   marked(파싱) → DOMPurify(살균) → hljs(코드 하이라이트).
   코드블록은 DOM 후처리로 언어 라벨 + 복사 버튼 헤더 바를 감싼다.
   스트리밍 중에는 하이라이트를 생략하고, 턴 종료 시 전체 렌더에서 적용한다. */
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

    // 스트리밍 중 닫히지 않은 펜스/인라인 코드는 이후 텍스트를 삼켜
    // 렌더가 한 프레임은 정상, 다음은 중간에서 끊긴 것처럼 보인다.
    function balanceStreamMarkdown(src) {
        let s = String(src);
        const fenceCount = (s.match(/^```/gm) || []).length;
        if (fenceCount % 2 === 1) s += "\n```";
        // 펜스 밖의 홀수 인라인 백틱도 임시로 닫는다.
        const inlineTicks = (s.replace(/^```[\s\S]*?^```/gm, "").match(/`/g) || []).length;
        if (inlineTicks % 2 === 1) s += "`";
        return s;
    }

    // 마크다운 문자열 → 살균된 DOM 컨테이너(div.md)
    function render(text, opt) {
        const o = opt || {};
        const box = T.h("div", { class: "md" + (o.extraClass ? " " + o.extraClass : "") });
        let src = String(text == null ? "" : text);
        if (o.stream) src = balanceStreamMarkdown(src);
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
                        copyBtn.classList.add(done ? "copied" : "copied-fail");
                        if (done) setTimeout(() => copyBtn.classList.remove("copied"), 1200);
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

    // 스트리밍 커서를 텍스트 흐름 끝에 부착한다.
    // 인라인 요소(code/em/strong/a…) '내부'로 파고들지 않고 그 다음 형제로 붙인다 —
    // 그렇지 않으면 인라인 코드 스트리밍 중 커서가 코드 배경 안에 갇혀 줄바꿈까지 멈춰 보인다.
    const INLINE_TAGS = new Set(["CODE", "EM", "STRONG", "A", "DEL", "B", "I", "S", "MARK", "SPAN"]);
    function appendCursor(container) {
        container.querySelectorAll(".cursor").forEach((c) => c.remove());
        let node = container;
        while (node.lastElementChild && !INLINE_TAGS.has(node.lastElementChild.tagName)) {
            node = node.lastElementChild;
        }
        // node의 마지막 자식이 인라인 요소면 그 형제로, 아니면 내부에 부착
        const target = node;
        const last = target.lastChild;
        const caret = T.h("span", { class: "cursor", text: "\u258D" });
        if (last && last.nodeType === 1 && INLINE_TAGS.has(last.tagName)) {
            last.after(caret);
        } else {
            target.appendChild(caret);
        }
    }
    // 라이브(하이라이트 생략) 블록을 턴 종료 시 전체 하이라이트로 승격 — DOM 구조는 유지
    function upgradeHighlight(container) {
        enhanceCodeBlocks(container, true);
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

    T.md = { render, appendCursor, upgradeHighlight, stripPreview };
})((window.Taby = window.Taby || {}));
