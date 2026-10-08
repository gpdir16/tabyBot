/* tabyBot 웹 클라이언트: 입력·링크·이미지·메시지별 메뉴 제공자. */
((T) => {
    "use strict";

    T.ctxCtx ??= {};
    const C = T.ctxCtx;
    const t = (k, v) => T.i18n.t(k, v);

    /* ── 공통 제공자: 입력 필드 / 선택 / 링크 / 이미지 / 메시지 ── */
    function editableEl(target) {
        const el = target?.closest?.(C.EDITABLE);
        if (!el || el.disabled) return null;
        const mode = el.getAttribute("contenteditable");
        const ce = mode != null && mode !== "false";
        return { el, ce, readOnly: !!el.readOnly };
    }

    function editSelection(info) {
        if (info.ce) {
            const sel = window.getSelection();
            return sel && !sel.isCollapsed && info.el.contains(sel.anchorNode);
        }
        return info.el.selectionEnd > info.el.selectionStart;
    }

    function insertEditableText(info, text) {
        const el = info.el;
        if (info.ce) {
            el.focus();
            document.execCommand("insertText", false, text);
            return;
        }
        const s = el.selectionStart ?? el.value.length;
        const epos = el.selectionEnd ?? s;
        el.value = el.value.slice(0, s) + text + el.value.slice(epos);
        el.selectionStart = el.selectionEnd = s + text.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function editableItems(info) {
        const el = info.el;
        const hasSel = editSelection(info);
        const items = [];
        if (hasSel && !info.readOnly) {
            items.push({
                label: t("cut"),
                onSelect() {
                    if (info.ce) {
                        document.execCommand("cut");
                        return;
                    }
                    T.copyText(el.value.slice(el.selectionStart, el.selectionEnd));
                    insertEditableText(info, "");
                },
            });
        }
        if (hasSel) {
            items.push({
                label: t("copy"),
                icon: "copy",
                onSelect() {
                    if (info.ce) document.execCommand("copy");
                    else T.copyText(el.value.slice(el.selectionStart, el.selectionEnd));
                },
            });
        }
        if (!info.readOnly) {
            items.push({
                label: t("paste"),
                onSelect() {
                    if (!navigator.clipboard?.readText) {
                        T.toast.show("error", t("clipboardBlocked"));
                        return;
                    }
                    navigator.clipboard
                        .readText()
                        .then((text) => {
                            if (text) insertEditableText(info, text);
                        })
                        .catch(() => T.toast.show("error", t("clipboardBlocked")));
                },
            });
        }
        items.push({
            label: t("selectAll"),
            onSelect() {
                el.focus();
                if (info.ce) selectContents(el);
                else el.select();
            },
        });
        return items;
    }

    function selectContents(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function openImage(img) {
        const src = img.currentSrc || img.src;
        if (!src) return;
        if (T.viewer) {
            // 확장자가 없는 blob/쿼리 URL도 있으므로 image로 강제한다.
            T.viewer.open({ name: img.alt || t("file"), mime: "image/*", url: src });
            return;
        }
        try {
            window.open(src, "_blank", "noopener");
        } catch {
            // 팝업이 막혀도 동작에는 영향이 없다
        }
    }

    // 터치 기기에서는 메시지 본문을 길게 눌러도 글자가 선택되지 않는다(메뉴가 뜬다).
    // "텍스트 선택"을 고르면 그 메시지만 선택 가능해지고 전체가 선택된 채로 시작한다.
    // 선택이 풀리면 원래대로 돌아간다.
    C.selectingRow = null;

    function startTextSelection(row, textEl) {
        endTextSelection();
        C.selectingRow = row;
        row.classList.add("selecting");
        selectContents(textEl);
    }

    function endTextSelection() {
        C.selectingRow?.classList.remove("selecting");
        C.selectingRow = null;
    }

    function messageSpec(target) {
        const row = target?.closest?.(".msg-row");
        if (!row) return null;
        const items = [];
        const link = target.closest("a[href]");
        if (link?.href && link.getAttribute("href") !== "#") {
            items.push({ label: t("copyLink"), icon: "copy", onSelect: () => void T.copyText(link.href) });
        }
        const img = target.closest("img");
        if (img && (img.closest(".md") || img.classList.contains("thumb"))) {
            items.push({ label: t("openImage"), icon: "eye", onSelect: () => openImage(img) });
        }
        const textEl = row.querySelector(".bubble-text, .md");
        // 코드 블록의 머리(언어 이름·복사 버튼)와 글 끝에 붙은 시각은 글이 아니므로 빼고 읽는다.
        const plain = textEl?.cloneNode(true);
        for (const n of plain?.querySelectorAll(".codeblock-head, .msg-time") ?? []) n.remove();
        const text = String(plain?.textContent || "");
        if (text.trim()) {
            if (items.length) items.push({ sep: true });
            items.push({ label: t("copyMessage"), icon: "copy", onSelect: () => void T.copyText(text) });
            items.push({ label: t("selectText"), icon: "text-select", onSelect: () => startTextSelection(row, textEl) });
        }
        if (!items.length) return null;
        return { items, source: target.closest(".bubble, .thumb, .file-attachment") || row.querySelector(".bubble") };
    }

    // 대상에 맞는 메뉴를 고른다. 없으면 null.
    function resolve(target, touch) {
        if (!(target instanceof Element)) return null;
        const ed = editableEl(target);
        if (ed) return { items: editableItems(ed) };

        // 마우스로 글자를 끌어 선택한 상태의 우클릭은 복사만 보여 준다.
        const sel = String(window.getSelection()?.toString() || "");
        if (sel && !touch) return { items: [{ label: t("copy"), icon: "copy", onSelect: () => void T.copyText(sel) }] };

        // attach로 메뉴를 붙인 가장 가까운 조상.
        for (let el = target; el && el !== document.body; el = el.parentElement) {
            const own = C.attached.get(el);
            if (!own) continue;
            const items = (typeof own === "function" ? own() : own) || [];
            return items.length ? { source: el, items } : null;
        }

        for (const provide of C.providers) {
            const spec = provide(target, touch);
            if (spec) return spec;
        }

        const msg = messageSpec(target);
        if (msg) return msg;

        const link = target.closest("a[href]");
        if (link?.href && link.getAttribute("href") !== "#") {
            return { items: [{ label: t("copyLink"), icon: "copy", onSelect: () => void T.copyText(link.href) }] };
        }
        return null;
    }

    C.endTextSelection = endTextSelection;
    C.resolve = resolve;
})(window.Taby);
