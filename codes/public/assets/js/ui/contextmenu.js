/* tabyBot 웹 클라이언트 — 커스텀 컨텍스트 메뉴.
   브라우저 기본 우클릭 메뉴/iOS 콜아웃을 가로채고 앱 메뉴를 띄운다(네이티브 앱 동작).
   - 데스크톱: 우클릭(contextmenu)
   - 터치: 길게 누르기(~550ms, 10px 이내)
   대상에 따라 항목을 고른다: 입력 필드 편집 동작 > 텍스트 선택 복사 >
   링크 복사 > .md 이미지 열기 > 메시지 복사. 해당 없으면 차단만 한다. */
(function (T) {
    "use strict";

    const t = (k, v) => T.i18n.t(k, v);

    let menu = null;
    let suppressClick = false; // 롱프레스로 메뉴가 뜬 뒤 따라오는 합성 클릭 억제
    let lpTimer = 0;
    let lpStart = null;

    const LONG_PRESS_MS = 550;
    const LONG_PRESS_MOVE_PX = 10;
    // app.css의 user-select: text 화이트리스트와 같게 유지한다.
    const SELECTABLE = "input, textarea, [contenteditable], .md, .bubble-text, .ask-q, .ask-answer, .model-id, .oauth-code";

    function closeMenu() {
        if (menu) menu.remove();
        menu = null;
        document.removeEventListener("pointerdown", onDocPointer, true);
        document.removeEventListener("keydown", onDocKey, true);
        if (T.tooltip) T.tooltip.hide();
    }

    function onDocPointer(e) {
        if (menu && !menu.contains(e.target)) closeMenu();
    }

    function onDocKey(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            closeMenu();
        }
    }

    function menuItem(label, fn, iconName) {
        return T.h(
            "button",
            {
                role: "menuitem",
                onclick(e) {
                    e.stopPropagation();
                    closeMenu();
                    fn();
                },
            },
            [iconName ? T.icon(iconName) : null, document.createTextNode(label)],
        );
    }

    // (x,y)에 메뉴를 띄우고 뷰포트 안으로 클램프한다.
    function openAt(x, y, items) {
        closeMenu();
        menu = T.h("div", { class: "menu ctx-menu", role: "menu" }, items);
        document.body.append(menu);
        const w = menu.offsetWidth;
        const hgt = menu.offsetHeight;
        menu.style.left = `${Math.min(Math.max(8, x), window.innerWidth - w - 8)}px`;
        menu.style.top = `${Math.min(Math.max(8, y), window.innerHeight - hgt - 8)}px`;
        document.addEventListener("pointerdown", onDocPointer, true);
        document.addEventListener("keydown", onDocKey, true);
        menu.querySelector("button")?.focus({ preventScroll: true });
        if (T.tooltip) T.tooltip.hide();
    }

    /* ── 대상별 메뉴 항목 ──────────────────────────────────── */
    function editableEl(target) {
        const el = target?.closest?.("input, textarea, [contenteditable]");
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
            items.push(
                menuItem(t("cut"), () => {
                    if (info.ce) {
                        document.execCommand("cut");
                        return;
                    }
                    T.copyText(el.value.slice(el.selectionStart, el.selectionEnd));
                    insertEditableText(info, "");
                }),
            );
        }
        if (hasSel) {
            items.push(
                menuItem(t("copy"), () => {
                    if (info.ce) document.execCommand("copy");
                    else T.copyText(el.value.slice(el.selectionStart, el.selectionEnd));
                }),
            );
        }
        if (!info.readOnly) {
            items.push(
                menuItem(t("paste"), () => {
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
                }),
            );
        }
        items.push(
            menuItem(t("selectAll"), () => {
                el.focus();
                if (info.ce) {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                } else el.select();
            }),
        );
        return items;
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
        } catch (_) {}
    }

    // 우클릭/롱프레스 대상에서 보여줄 항목을 고른다. 없으면 null.
    function itemsFor(target) {
        const ed = editableEl(target);
        if (ed) return editableItems(ed);

        const sel = String(window.getSelection()?.toString() || "");
        if (sel) return [menuItem(t("copy"), () => void T.copyText(sel), "copy")];

        const link = target?.closest?.("a[href]");
        if (link && link.href && link.getAttribute("href") !== "#") {
            return [menuItem(t("copyLink"), () => void T.copyText(link.href), "copy")];
        }

        const img = target?.closest?.("img");
        if (img && (img.closest(".md") || img.classList.contains("thumb"))) {
            return [menuItem(t("openImage"), () => openImage(img))];
        }

        const row = target?.closest?.(".msg-row");
        if (row) {
            const textEl = row.querySelector(".bubble-text, .md");
            const text = String(textEl?.textContent || "");
            if (text.trim()) return [menuItem(t("copyMessage"), () => void T.copyText(text), "copy")];
        }
        return null;
    }

    function showFor(x, y, target) {
        const items = itemsFor(target);
        if (!items || !items.length) return false;
        openAt(x, y, items);
        return true;
    }

    function init() {
        // 우클릭: 항상 브라우저 메뉴를 차단하고, 의미 있는 대상이면 앱 메뉴를 띄운다.
        // 폴더 탭 등 자체 contextmenu 핸들러가 먼저 preventDefault한 경우는 건드리지 않는다.
        document.addEventListener("contextmenu", (e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            closeMenu();
            // Android는 터치 롱프레스에 실제 contextmenu를 쏜다 — 이 경우
            // 손을 떼며 오는 합성 클릭이 메뉴 첫 항목을 누르지 않게 삼킨다.
            if (showFor(e.clientX, e.clientY, e.target) && lpStart) suppressClick = true;
        });

        // 터치 롱프레스 → 합성 contextmenu를 발행해 우클릭과 같은 경로로 처리한다.
        // 이렇게 하면 봇 행(⋯ 메뉴)·폴더 탭 등 자체 핸들러도 터치에서 그대로 동작한다.
        document.addEventListener(
            "pointerdown",
            (e) => {
                if (e.pointerType !== "touch" || !e.isPrimary) return;
                clearTimeout(lpTimer);
                lpStart = { x: e.clientX, y: e.clientY, target: e.target };
                lpTimer = setTimeout(() => {
                    lpTimer = 0;
                    if (!lpStart || menu) return;
                    const pos = lpStart;
                    pos.target.dispatchEvent(
                        new MouseEvent("contextmenu", {
                            bubbles: true,
                            cancelable: true,
                            clientX: pos.x,
                            clientY: pos.y,
                            view: window,
                        }),
                    );
                    // 어떤 .menu든(내 메뉴, 봇 ⋯ 메뉴, 폴더 메뉴) 떴으면 뒤이은 릴리즈 클릭을 삼킨다.
                    if (menu || document.querySelector(".menu")) suppressClick = true;
                }, LONG_PRESS_MS);
            },
            { passive: true },
        );
        document.addEventListener(
            "pointermove",
            (e) => {
                if (!lpStart || e.pointerType !== "touch") return;
                if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > LONG_PRESS_MOVE_PX) {
                    clearTimeout(lpTimer);
                    lpStart = null;
                }
            },
            { passive: true },
        );
        const cancelLp = (e) => {
            // 선택 가능한 텍스트 위의 pointercancel은 브라우저가 제스처를 네이티브
            // 텍스트 선택으로 가져간 신호다 — iOS는 콜아웃이 차단돼 네이티브 메뉴가
            // 안 뜨므로 타이머를 유지해 커스텀 메뉴가 대신 열리게 한다.
            if (e?.type === "pointercancel" && lpStart && lpStart.target?.closest?.(SELECTABLE)) return;
            clearTimeout(lpTimer);
            lpStart = null;
        };
        document.addEventListener("pointerup", cancelLp, { passive: true });
        document.addEventListener("pointercancel", cancelLp, { passive: true });
        document.addEventListener("scroll", cancelLp, { passive: true, capture: true });

        // 롱프레스 메뉴가 뜬 직후의 합성 클릭(손을 떼며 발생)이 대상을 실행하지 않게 한 번 삼킨다.
        // 메뉴가 누른 지점 바로 위에 뜨므로 첫 클릭은 메뉴 항목 안에서도 삼켜야 한다.
        document.addEventListener(
            "click",
            (e) => {
                if (!suppressClick) return;
                suppressClick = false;
                e.preventDefault();
                e.stopPropagation();
            },
            true,
        );
    }

    T.ctxmenu = { init, close: closeMenu };
})((window.Taby = window.Taby || {}));
