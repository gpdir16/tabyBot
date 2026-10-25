/* tabyBot 웹 클라이언트: 설정 탭들이 같이 쓰는 입력 컴포넌트. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    // 이름이 붙은 항목의 삭제 확인. 확인하면 true.
    function confirmDelete(name) {
        return T.confirm({
            title: t("confirmDeleteTitle", { name }),
            text: t("confirmDeleteText"),
            confirmLabel: t("delete"),
            danger: true,
        });
    }

    /* ── 공통 컴포넌트 ──────────────────────────────────────── */
    function switchEl(checked, onChange, label) {
        const input = T.h("input", { type: "checkbox", "aria-label": label || "" });
        input.checked = !!checked;
        input.addEventListener("change", () => onChange(input.checked));
        return T.h("label", { class: "switch" }, [input, T.h("span", { class: "tr" }), T.h("span", { class: "kn" })]);
    }

    function settingSelect(options, current, onPick, label) {
        const select = T.h("select", { "aria-label": label || "" });
        for (const o of options) {
            const option = T.h("option", { value: o.value, text: o.label });
            option.selected = o.value === current;
            select.append(option);
        }
        select.addEventListener("change", () => onPick(select.value));
        return T.h("div", { class: "select-wrap" }, [select, T.icon("chevron")]);
    }

    function fieldLabel(text) {
        return T.h("div", { class: "field-label", text });
    }

    /* ── 계정 탭 ─────────────────────────────────────────── */
    function accountField(labelText, ...kids) {
        return T.h("div", { class: "field" }, [fieldLabel(labelText), ...kids]);
    }

    function accountInput(type, label, autocomplete) {
        const el = T.h("input", { class: "input", type, "aria-label": label, autocomplete, spellcheck: "false" });
        el.addEventListener("keydown", (e) => e.stopPropagation());
        return el;
    }

    /* 비밀 입력(API 키 등): 입력칸 + 보기 토글. 설정과 온보딩에서 공용으로 쓴다.
       onCommit: blur/Enter 시 확정값, onInput: 입력마다 값 전달(온보딩 draft 동기화용). */
    // onCommit: 포커스가 빠질 때 저장. onEnter: Enter로 저장(저장 버튼을 따로 두는 곳).
    function secretInput({ value = "", placeholder = "", aria = "", onInput, onCommit, onEnter }) {
        const input = T.h("input", {
            class: "input",
            type: "password",
            value,
            placeholder,
            "aria-label": aria,
            autocomplete: "new-password",
            spellcheck: "false",
        });
        const eye = T.h(
            "button",
            {
                class: "btn-icon",
                "aria-label": t("showApiKey"),
                "aria-pressed": "false",
                onclick() {
                    const show = input.type === "password";
                    input.type = show ? "text" : "password";
                    eye.setAttribute("aria-label", t(show ? "hideApiKey" : "showApiKey"));
                    eye.setAttribute("aria-pressed", String(show));
                    eye.replaceChildren(T.icon(show ? "eye-off" : "eye"));
                },
            },
            [T.icon("eye")],
        );
        input.addEventListener("input", () => onInput?.(input.value));
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key !== "Enter" || e.isComposing) return;
            if (onEnter) {
                e.preventDefault();
                onEnter(input.value);
            } else input.blur();
        });
        if (onCommit) input.addEventListener("blur", () => onCommit(input.value));
        return T.h("div", { class: "key-row" }, [input, eye]);
    }

    // 이름표(왼쪽)와 컨트롤(오른쪽)이 한 줄에 놓이는 설정 행.
    function labeledRow(label, control) {
        return T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: label }), T.h("div", { class: "set-control" }, [control])]);
    }

    // 현재 값이 프리셋에 없으면 그대로 보여주는 임시 옵션을 뒤에 붙인다.
    function presetOptions(presets, currentValue, currentLabel) {
        const opts = presets.slice();
        if (currentValue !== undefined && currentValue !== "" && !opts.some((o) => o.value === currentValue)) {
            opts.push({ value: currentValue, label: currentLabel });
        }
        return opts;
    }

    /* ── 묶음 목록의 행 ──────────────────────────────────────
       설정의 누를 수 있는 것은 모두 행이다: 들어가는 행(꺾쇠)과 동작 행(강조색·빨간색 글자). */
    // 값만 보여 주는 행.
    function valueRow(label, value) {
        return T.h("div", { class: "set-row" }, [T.h("span", { class: "set-label", text: label }), T.h("span", { class: "nav-val", text: value })]);
    }

    // 누르면 한 단계 더 들어가는 행: 이름 · 오른쪽 값 · 꺾쇠.
    function navRow(label, value, onclick) {
        return T.h("button", { type: "button", class: "set-row nav-row", onclick }, [
            T.h("span", { class: "set-label", text: label }),
            T.h("span", { class: "nav-val", text: value || "" }),
            T.icon("chevron", "nav-chev"),
        ]);
    }

    // 목록의 항목 행: 이름(+배지) · 설명 한 줄 · 꺾쇠. 누르면 그 항목의 화면으로 들어간다.
    // trailing: 꺾쇠 앞에 놓을 것(순서 손잡이 등). menu: 길게 누르기·우클릭 메뉴의 항목을 돌려주는 함수.
    function itemRow({ name, badge, badgeClass, sub, subMono, trailing, onclick, menu }) {
        const row = T.h("button", { type: "button", class: "ext-row nav-row", onclick }, [
            T.h("span", { class: "ext-main" }, [
                T.h("span", { class: "ext-name" }, [
                    T.h("span", { class: "ext-nm", text: name }),
                    badge ? T.h("span", { class: `ext-badge${badgeClass ? ` ${badgeClass}` : ""}`, text: badge }) : null,
                ]),
                sub ? T.h("span", { class: `ext-sub${subMono ? " mono" : ""}`, text: sub }) : null,
            ]),
            trailing || null,
            T.icon("chevron", "nav-chev"),
        ]);
        if (menu) T.ctxmenu.attach(row, menu);
        return row;
    }

    // 동작 행: 강조색(danger면 빨간색) 글자의 한 줄. icon을 주면 글자 앞에 붙는다("추가" 행).
    // own이면 제 묶음에 담겨 나온다(삭제·로그아웃처럼 다른 행과 떨어져 있어야 하는 동작). 아이콘이 없으면 가운데에 놓인다.
    function actionRow(label, onclick, { danger = false, icon = null, own = false, href = null } = {}) {
        const cls = `set-row act-row${danger ? " danger" : ""}${own && !icon ? " center" : ""}`;
        const kids = [icon ? T.icon(icon) : null, T.h("span", { class: "act-label", text: label })];
        const row = href
            ? T.h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, kids)
            : T.h("button", { type: "button", class: cls, onclick }, kids);
        if (!own) return row;
        const group = T.h("div", { class: "set-group act-group" }, [row]);
        group.row = row;
        return group;
    }

    /* ── 편집 화면의 저장과 떠나기 ────────────────────────────
       화면을 그리는 동안(layout.js의 buildView) 탭이 C.viewSlot에 채워 넣는다.
       action: 탐색 바 오른쪽의 버튼, dirty: 입력이 처음과 달라졌는지 알려 주는 함수. */
    C.viewSlot = {};

    // 탐색 바 오른쪽의 동작 버튼(저장). run이 끝날 때까지 꺼져 있어 두 번 눌리지 않는다.
    // 저장에 성공하면 화면이 다시 그려지고, 실패하면 run이 알린 뒤 버튼이 다시 켜진다.
    function headAction(label, run) {
        const btn = T.h("button", {
            type: "button",
            class: "sp-action",
            text: label,
            async onclick() {
                if (btn.busy) return;
                btn.busy = true;
                btn.disabled = true;
                try {
                    await run();
                } finally {
                    btn.busy = false;
                    btn.sync?.();
                }
            },
        });
        C.viewSlot.action = btn;
        return btn;
    }

    // 폼의 입력값을 처음과 견준다. 달라지기 전에는 저장 버튼이 꺼져 있고, 달라진 채로 떠나려 하면 묻는다(layout.js의 confirmLeave).
    // 폼을 다 채운 뒤에 부른다. extra: 입력 요소가 아닌 값(색상 선택 등)을 문자열로 돌려주는 함수.
    // 화면에 붙어 있는지와 상관없이 달라졌는지만 보는 함수를 돌려준다(한 단계 들어간 화면에 가려진 폼을 지킬 때 쓴다).
    function trackForm(root, extra) {
        const read = () =>
            JSON.stringify([
                [...root.querySelectorAll("input, textarea, select")].map((el) => (el.type === "checkbox" ? el.checked : el.value)),
                extra ? extra() : null,
            ]);
        const initial = read();
        const changed = () => read() !== initial;
        C.viewSlot.dirty = () => root.isConnected && changed();
        return changed;
    }

    function fieldOf(label, control, desc) {
        return T.h("div", { class: "field" }, [fieldLabel(label), control, desc ? T.h("div", { class: "set-desc", text: desc }) : null]);
    }

    // 저장 시점에 값을 읽는 셀렉트. 즉시 PUT하는 settingSelect와 달리 ref를 돌려준다.
    function editorSelect(options, current, aria) {
        const sel = T.h("select", { "aria-label": aria });
        for (const o of options) {
            const opt = T.h("option", { value: o.value, text: o.label });
            if (o.value === current) opt.selected = true;
            sel.append(opt);
        }
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        return sel;
    }

    function selectWrap(sel) {
        return T.h("div", { class: "select-wrap" }, [sel, T.icon("chevron")]);
    }

    /* ── 프로필 사진 ─────────────────────────────────────────
       에이전트와 그룹 대화방의 편집 화면에는 사진 행을 두고, 누르면 사진 화면(avatarScreen)으로 한 단계 들어간다.
       사진 화면에서 고르거나 지운 것은 편집 화면에 담아 두었다가 그 화면의 저장 버튼을 누를 때 올린다(commit). */
    const AVATAR_PX = 256;

    // 고른 이미지를 가운데 정사각형으로 잘라 AVATAR_PX 이하 PNG로 만든다. 브라우저가 못 읽는 이미지면 오류를 던진다.
    async function squareAvatar(file) {
        const url = URL.createObjectURL(file);
        try {
            const img = new Image();
            img.src = url;
            await img.decode();
            const side = Math.min(img.naturalWidth, img.naturalHeight);
            if (!side) throw new Error("empty_image");
            const out = Math.min(AVATAR_PX, side);
            const canvas = T.h("canvas", { width: String(out), height: String(out) });
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
            return await new Promise((resolve, reject) => {
                canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode_failed"))), "image/png");
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // who: 사진을 고를 대상(에이전트 또는 state.chats() 모양의 그룹 대화방, 새로 만들 때는 null이나 이름 없는 모양).
    // onOpen: 사진 행을 누르면 사진 화면을 연다(설정과 대화 정보 창이 여는 방법이 다르다).
    // row: 편집 화면에 넣을 행. value(): 고친 상태를 문자열로(trackForm의 extra). commit(key): 고친 것을 서버에 반영하고
    // 받은 /api/agents 스냅샷을 돌려준다(고친 것이 없으면 null). 실패하면 오류를 던진다.
    function avatarPicker(who, onOpen) {
        const fallback = { ...(who || {}), avatar: "" };
        let pending = null; // 새로 고른 사진(Blob)
        let removed = false;
        let picks = 0;
        const urls = new Set();
        const preview = T.h("span", { class: "avatar-preview-slot" });
        const row = T.h("button", { type: "button", class: "set-row nav-row avatar-row", onclick: () => onOpen() }, [
            T.h("span", { class: "set-label", text: t("agentPhoto") }),
            preview,
            T.icon("chevron", "nav-chev"),
        ]);

        // 지금 상태의 아바타(새로 고른 사진, 지운 뒤의 기본 모양, 원래 모양). cls로 크기를 정한다.
        const face = (cls) => {
            if (!pending) return T.chatAvatar(removed ? fallback : who || fallback, cls);
            const url = URL.createObjectURL(pending);
            urls.add(url);
            return T.h("span", { class: `${cls} has-img` }, [T.h("img", { class: "avatar-img", src: url, alt: "" })]);
        };
        // 사진이 바뀌면 행의 미리보기를 다시 그리고, 저장 버튼이 알도록 change를 낸다.
        const changed = () => {
            for (const url of urls) URL.revokeObjectURL(url);
            urls.clear();
            preview.replaceChildren(face("bot-avatar avatar-preview"));
            row.dispatchEvent(new Event("change", { bubbles: true }));
        };
        preview.append(face("bot-avatar avatar-preview"));
        // 사진 화면이 열리기 전에 미리 준비한 사진을 받아 둔다.
        loadPresets().catch(() => {
            // 못 받으면 사진 화면을 열 때 다시 받는다
        });

        return {
            row,
            face,
            hasPhoto: () => Boolean(pending) || (!removed && Boolean(who?.avatar)),
            pick(blob) {
                pending = blob;
                removed = false;
                picks += 1;
                changed();
            },
            remove() {
                pending = null;
                removed = Boolean(who?.avatar);
                changed();
            },
            value: () => (pending ? `new:${picks}` : removed ? "removed" : ""),
            commit(key) {
                if (!key) return Promise.resolve(null);
                if (pending) return T.api.setAvatar(key, pending);
                if (removed) return T.api.removeAvatar(key);
                return Promise.resolve(null);
            },
        };
    }

    // 사진 화면: 큰 미리보기, 사진 선택, (사진이 있으면) 사진 지우기, 그 아래 미리 준비해 둔 사진들.
    // 고르거나 지우면 편집 화면의 picker에 담고 done()으로 돌아간다.
    // picker(): 지금 편집 화면의 avatarPicker(편집 화면이 다시 그려졌을 수 있어 쓸 때마다 묻는다).
    function avatarScreen(body, picker, done) {
        const p = picker();
        if (!p) return;
        // 파일 입력은 고를 때만 문서에 붙이고, 고르거나 취소하면 뗀다.
        const file = T.h("input", { type: "file", accept: "image/*", hidden: true, "aria-hidden": "true", tabindex: "-1" });
        file.addEventListener("cancel", () => file.remove());
        // 고른 이미지를 정사각형으로 줄여 담고 편집 화면으로 돌아간다.
        // 한 화면에서는 처음 고른 것 하나만 담는다. 사진을 받는 동안 또 누르거나 화면을 떠났다가 늦게 도착한 것을
        // 담으면, 저장한 뒤 새로 그린 편집 화면이 다시 고친 상태가 되어 떠날 때 버릴지 묻는다.
        let using = false;
        const use = async (image) => {
            if (using) return;
            using = true;
            let blob;
            try {
                blob = await squareAvatar(await image());
            } catch {
                using = false;
                if (body.isConnected) T.toast.show("error", t("avatarInvalid"));
                return;
            }
            if (!body.isConnected) return;
            picker()?.pick(blob);
            done();
        };
        file.addEventListener("change", () => {
            file.remove();
            const picked = file.files?.[0];
            file.value = "";
            if (picked) void use(() => picked);
        });

        const sec = T.h("div", { class: "set-section" });
        sec.append(T.h("div", { class: "avatar-hero" }, [p.face("bot-avatar avatar-big")]));
        // 파일 고르기 창은 사용자 제스처 안에서만 열리므로 누른 자리에서 바로 연다.
        sec.append(
            C.actionRow(t("avatarChoose"), () => {
                document.body.append(file);
                file.click();
            }),
        );
        if (p.hasPhoto()) {
            sec.append(
                C.actionRow(
                    t("avatarRemove"),
                    () => {
                        picker()?.remove();
                        done();
                    },
                    { danger: true },
                ),
            );
        }
        sec.append(...presetRows(use));
        body.append(sec);
    }

    // 미리 준비해 둔 사진(codes/public/assets/avatars/)을 소제목 아래 목록으로 보인다. 행은 대화 정보 창의 멤버 행과 같은 모양이다
    // (C.itemRow에 아바타를 앞에 붙인 것, .ci-agent-row). 하나도 없으면 둘 다 감춘다. 같은 칸(set-section) 안에 두어야
    // 앞 묶음과의 구획 간격이 붙는다. 목록은 늦게 도착해 groupRows가 묶어 주지 못하므로 직접 묶음(set-group)에 담는다.
    // 목록은 바뀌지 않으므로 처음 한 번만 받아 두고 다시 그릴 때마다 그것을 쓴다(못 받았으면 다음에 다시 받는다).
    let presetList = null;
    // 편집 화면에 사진 행이 생길 때 목록과 사진을 미리 받아 둔다. 사진 화면을 열면 바로 보이고, 고를 때도 캐시에서 읽는다
    // (주소에 버전이 붙어 있어 오래 캐시된다).
    function loadPresets() {
        if (presetList) return presetList;
        presetList = T.api.avatarPresets().then(
            (r) => {
                for (const p of r?.presets || []) new Image().src = p.href;
                return r;
            },
            (err) => {
                presetList = null;
                throw err;
            },
        );
        return presetList;
    }
    function presetRows(use) {
        const list = T.h("div", { class: "set-group", hidden: true });
        const label = C.fieldLabel(t("avatarPresets"));
        const desc = T.h("div", { class: "set-desc", text: t("avatarPresetsDesc"), hidden: true });
        label.hidden = true;
        loadPresets()
            .then(({ presets = [] }) => {
                list.replaceChildren(
                    ...presets.map((p) => {
                        const row = itemRow({
                            name: p.name,
                            onclick: () =>
                                use(async () => {
                                    const res = await fetch(p.href);
                                    if (!res.ok) throw new Error(`http_${res.status}`);
                                    return res.blob();
                                }),
                        });
                        row.classList.add("ci-agent-row");
                        row.prepend(T.h("span", { class: "bot-avatar has-img" }, [T.h("img", { class: "avatar-img", src: p.href, alt: "" })]));
                        return row;
                    }),
                );
                label.hidden = desc.hidden = list.hidden = !presets.length;
            })
            .catch(() => {
                // 목록을 못 받으면 미리 준비한 사진 칸만 감춘 채 둔다(직접 고르기는 그대로 된다)
            });
        return [label, desc, list];
    }

    C.confirmDelete = confirmDelete;
    C.switchEl = switchEl;
    C.settingSelect = settingSelect;
    C.fieldLabel = fieldLabel;
    C.accountField = accountField;
    C.accountInput = accountInput;
    C.secretInput = secretInput;
    C.labeledRow = labeledRow;
    C.presetOptions = presetOptions;
    C.valueRow = valueRow;
    C.navRow = navRow;
    C.itemRow = itemRow;
    C.actionRow = actionRow;
    C.headAction = headAction;
    C.trackForm = trackForm;
    C.fieldOf = fieldOf;
    C.editorSelect = editorSelect;
    C.selectWrap = selectWrap;
    C.avatarPicker = avatarPicker;
    C.avatarScreen = avatarScreen;
})(window.Taby);
