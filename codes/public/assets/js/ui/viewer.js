/* tabyBot 웹 클라이언트: 파일 미리보기 뷰어.
   첨부 클릭 시 새 탭/바로 다운로드 대신 앱 안 모달로 연다.
   이미지/영상/오디오/PDF는 인라인으로, 텍스트 계열은 fetch로 읽어
   <pre>에 표시한다. 다운로드/새 탭은 뷰어 안의 보조 동작. */
(function (T) {
    "use strict";

    const t = (k, v) => T.i18n.t(k, v);

    let overlay = null;
    let reqSeq = 0;

    const TEXT_MAX = 2 * 1024 * 1024;
    const TEXT_EXT =
        /^(txt|md|markdown|csv|tsv|json|jsonl|log|diff|patch|yaml|yml|toml|ini|xml|svg|js|mjs|cjs|ts|jsx|tsx|py|rb|go|rs|java|c|h|cc|cpp|hpp|cs|swift|kt|kts|sh|bash|zsh|fish|sql|html|css|scss|less|lua|r|php|pl|conf|cfg|env|properties|gradle|dockerfile|makefile|mk|gitignore|editorconfig)$/i;

    function extOf(name) {
        const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
        return m ? m[1] : "";
    }

    function kindOf(mime, name) {
        const m = String(mime || "").toLowerCase();
        if (m.startsWith("image/")) return "image";
        if (m.startsWith("video/")) return "video";
        if (m.startsWith("audio/")) return "audio";
        if (m === "application/pdf") return "pdf";
        if (m.startsWith("text/") || m === "application/json" || m === "application/xml" || TEXT_EXT.test(extOf(name))) return "text";
        return "other";
    }

    // /api/files URL이면 inline 렌더를 요청한다. 서버가 허용 타입만 inline으로 보낸다.
    function inlineUrl(url) {
        if (!/^\/api\/files\//.test(url)) return url;
        return url + (url.includes("?") ? "&" : "?") + "inline=1";
    }

    function close() {
        if (overlay) overlay.remove();
        overlay = null;
        document.body.classList.remove("viewer-open");
    }

    function fallbackPane(name) {
        return T.h("div", { class: "fv-empty" }, [
            T.h("span", { class: "fv-empty-name", text: name }),
            T.h("span", { class: "fv-empty-desc", text: t("fvNoPreview") }),
        ]);
    }

    async function open(file) {
        const seq = ++reqSeq;
        close();

        const name = file.name || t("file");
        const url = String(file.url || "");
        const kind = kindOf(file.mime, name);
        const canDownload = Boolean(url);

        const body = T.h("div", { class: "fv-body" });
        const bodyFill = (el) => {
            if (seq !== reqSeq) return;
            body.replaceChildren();
            if (el) body.append(el);
        };

        if (kind === "image") {
            body.append(T.h("img", { class: "fv-media fv-img", src: url, alt: name }));
        } else if (kind === "video") {
            body.append(T.h("video", { class: "fv-media", src: url, controls: true, playsinline: true }));
        } else if (kind === "audio") {
            body.append(T.h("audio", { class: "fv-audio", src: url, controls: true }));
        } else if (kind === "pdf") {
            body.append(T.h("iframe", { class: "fv-frame", src: inlineUrl(url), title: name }));
        } else if (kind === "text") {
            body.append(T.h("div", { class: "fv-loading", text: t("loading") }));
            try {
                const headers = {};
                const tk = T.api.getToken();
                if (tk) headers.Authorization = "Bearer " + tk;
                const res = await fetch(url, { headers });
                if (!res.ok) throw new Error("status " + res.status);
                const len = Number(res.headers.get("content-length") || 0);
                if (len > TEXT_MAX) throw new Error("too_large");
                const text = await res.text();
                if (text.length > TEXT_MAX) throw new Error("too_large");
                bodyFill(T.h("pre", { class: "fv-text", text }));
            } catch {
                bodyFill(fallbackPane(name));
            }
        } else {
            body.append(fallbackPane(name));
        }

        const dlBtn = canDownload ? T.h("a", { class: "btn ghost", href: url, download: name, text: t("fvDownload"), rel: "noopener" }) : null;
        const tabBtn = canDownload ? T.h("a", { class: "btn ghost", href: url, target: "_blank", rel: "noopener", text: t("fvOpenTab") }) : null;

        overlay = T.h("div", { class: "fv-overlay", role: "dialog", "aria-modal": "true", "aria-label": name }, [
            T.h("div", { class: "fv-card" }, [
                T.h("div", { class: "fv-head" }, [
                    T.h("div", { class: "fv-title", text: name, title: name }),
                    T.h("div", { class: "fv-tools" }, [
                        dlBtn,
                        tabBtn,
                        T.h("button", { class: "btn-icon", "data-tip": t("close"), "aria-label": t("close"), onclick: close }, [T.icon("x")]),
                    ]),
                ]),
                body,
            ]),
        ]);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close();
        });
        document.body.append(overlay);
        document.body.classList.add("viewer-open");
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && overlay) {
            e.stopPropagation();
            close();
        }
    });

    T.viewer = { open, close, isOpen: () => !!overlay };
})((window.Taby = window.Taby || {}));
