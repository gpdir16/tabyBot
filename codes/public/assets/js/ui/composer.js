/* tabyBot 웹 클라이언트 — 컴포저.
   pill 컨테이너(자동성장), 파일 첨부(선택/드래그앤드롭/paste),
   업로드 칩 미리보기, Enter 전송 / Shift+Enter 줄바꿈(IME 조합 보호),
   실행 중 정지 버튼 전환. */
(function (T) {
    "use strict";

    const { state } = T;
    const t = (k) => T.i18n.t(k);

    const box = document.getElementById("composer");
    const chipsEl = document.getElementById("chips");
    const input = document.getElementById("composerInput");
    const btnSend = document.getElementById("btnSend");
    const btnStop = document.getElementById("btnStop");
    const btnAttach = document.getElementById("btnAttach");
    const fileInput = document.getElementById("fileInput");

    const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

    // 모바일 구분은 화면 크기(≤860px)로 한다 — sidebar.js와 동일 기준. 좁은 화면엔 Shift가 없으므로 Enter 전송 대신 기본 줄바꿈 유지
    const isTouch = window.matchMedia?.("(max-width: 860px)").matches;

    // attachments: [{ id: string|null, name, mime, size, objUrl, uploading }]
    let attachments = [];
    let dragDepth = 0;
    let draftId = null;
    const drafts = new Map(); // uuid → { text, attachments }

    /* ── 자동성장 ───────────────────────────────────────────── */
    function grow() {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 200) + "px";
        box.classList.toggle("multiline", input.scrollHeight > 40 || attachments.length > 0);
    }

    function updateSendState() {
        const uploading = attachments.some((a) => a.uploading);
        const hasText = !!input.value.trim();
        btnSend.disabled = uploading || (!hasText && !attachments.length);
    }

    /* ── 첨부 칩 ────────────────────────────────────────────── */
    function formatSize(bytes) {
        const size = Number(bytes);
        if (!Number.isFinite(size) || size < 0) return "";
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

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

    function renderChips() {
        chipsEl.textContent = "";
        chipsEl.classList.toggle("hidden", !attachments.length);
        for (const a of attachments) {
            const chip = T.h("div", { class: "chip" });
            const preview = a.mime?.startsWith("image/")
                ? T.h("img", { alt: a.name || "" })
                : T.h("div", { class: "chip-file", title: a.name || t("file") }, [
                      T.h("strong", { class: "chip-file-name", text: a.name || t("file") }),
                      T.h("span", {
                          class: "chip-file-meta",
                          text: `${fileType(a.mime, a.name)}${formatSize(a.size) ? ` · ${formatSize(a.size)}` : ""}`,
                      }),
                  ]);
            preview.addEventListener("click", () => {
                try {
                    window.open(a.objUrl, "_blank");
                } catch (_) {}
            });
            if (preview.tagName === "IMG") preview.src = a.objUrl;
            chip.append(preview);
            if (a.uploading) chip.append(T.h("div", { class: "spin-overlay" }, [T.h("div", { class: "spin" })]));
            chip.append(
                T.h(
                    "button",
                    {
                        class: "chip-x",
                        "aria-label": t("cancel"),
                        onclick(e) {
                            e.stopPropagation();
                            removeAttachment(a);
                        },
                    },
                    [T.icon("x")],
                ),
            );
            chipsEl.append(chip);
        }
        grow();
        updateSendState();
    }

    function removeAttachment(a) {
        const i = attachments.indexOf(a);
        if (i > -1) attachments.splice(i, 1);
        try {
            URL.revokeObjectURL(a.objUrl);
        } catch (_) {}
        renderChips();
    }

    function addFiles(files) {
        for (const f of files) {
            if (!f.size) {
                T.toast.show("error", t("emptyFile"));
                continue;
            }
            if (f.size > MAX_UPLOAD_BYTES) {
                T.toast.show("error", t("fileTooLarge"));
                continue;
            }
            const a = {
                id: null,
                name: f.name || t("file"),
                mime: f.type || "application/octet-stream",
                size: f.size,
                objUrl: URL.createObjectURL(f),
                uploading: true,
            };
            attachments.push(a);
            renderChips();
            T.api
                .upload(f)
                .then((res) => {
                    if (!res || typeof res.id !== "string") throw new Error("invalid upload response");
                    a.id = res.id;
                    a.name = res.name || a.name;
                    a.mime = res.mime || a.mime;
                    a.size = f.size;
                    a.uploading = false;
                    renderChips();
                })
                .catch((err) => {
                    T.toast.show("error", err?.status === 413 ? t("fileTooLarge") : T.api.errorText(err, t("uploadFailed")));
                    removeAttachment(a);
                });
        }
    }

    /* ── 전송 / 정지 ────────────────────────────────────────── */
    async function send() {
        if (btnSend.disabled) return;
        const text = input.value.trim();
        const readyAtts = attachments
            .filter((a) => !a.uploading)
            .map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, objUrl: a.objUrl }));
        if (!text && !readyAtts.length) return;
        if (attachments.some((a) => a.uploading)) return;

        // 즉시 비우고(스냅 반응), 실패 시 복원
        input.value = "";
        const sent = attachments;
        attachments = [];
        renderChips();
        grow();

        const ok = await T.chat.submitMessage({ text, attachments: readyAtts });
        if (!ok) restore(text, sent);
        else if (state.state.currentId) drafts.delete(state.state.currentId);
        input.focus();
    }

    function restore(text, atts) {
        input.value = text;
        // 업로드가 완료된 것만 되돌린다
        attachments = atts.filter((a) => a.id);
        renderChips();
        grow();
        input.focus();
        saveDraft();
    }

    async function stop() {
        const id = state.state.currentId;
        if (!id) return;
        try {
            await T.api.stopConversation(id);
        } catch (_) {
            /* turn_done에서 정리됨 */
        }
    }

    /* ── 실행 중 표시 ───────────────────────────────────────── */
    function refreshRunState() {
        const c = state.currentConv();
        const running = !!(c && c.live);
        btnStop.classList.toggle("hidden", !running);
        btnSend.classList.toggle("hidden", running);
        btnStop.tabIndex = running ? 0 : -1;
        btnSend.tabIndex = running ? -1 : 0;
        if (T.tooltip) T.tooltip.hide();
    }

    function saveDraft() {
        if (!draftId) return;
        drafts.set(draftId, { text: input.value, attachments: attachments.slice() });
    }

    function loadDraft(id) {
        if (draftId === id) return;
        if (draftId) saveDraft();
        else if (id && (input.value || attachments.length)) {
            drafts.set(id, { text: input.value, attachments: attachments.slice() });
        }
        draftId = id || null;
        const d = (id && drafts.get(id)) || { text: "", attachments: [] };
        input.value = d.text || "";
        attachments = Array.isArray(d.attachments) ? d.attachments.slice() : [];
        renderChips();
        grow();
        updateSendState();
    }

    /* ── 바인딩 ─────────────────────────────────────────────── */
    function init() {
        input.addEventListener("input", () => {
            grow();
            updateSendState();
        });

        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            // IME 조합(한/일 입력) 중 Enter는 전송하지 않는다
            if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                send();
            }
        });

        btnSend.addEventListener("click", send);
        btnStop.addEventListener("click", stop);
        btnAttach.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => {
            addFiles([...fileInput.files]);
            fileInput.value = "";
        });

        // 드래그앤드롭
        ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
            box.addEventListener(ev, (e) => {
                e.preventDefault();
                if (ev === "dragenter") {
                    dragDepth++;
                    box.classList.add("dragover");
                    return;
                }
                if (ev === "dragover") {
                    box.classList.add("dragover");
                    return;
                }
                if (ev === "dragleave") {
                    dragDepth = Math.max(0, dragDepth - 1);
                } else if (ev === "drop") {
                    dragDepth = 0;
                    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
                }
                if (!dragDepth) box.classList.remove("dragover");
            }),
        );

        // 붙여넣기 파일
        input.addEventListener("paste", (e) => {
            const files = e.clipboardData && e.clipboardData.files;
            if (files && files.length) {
                e.preventDefault();
                addFiles([...files]);
            }
        });

        state.on("live", refreshRunState);
        state.on("turn_done", refreshRunState);
        state.on("current", (id) => {
            loadDraft(id);
            refreshRunState();
        });
        T.i18n.onChange(() => {
            input.placeholder = t("sendPlaceholder");
        });

        grow();
        updateSendState();
        refreshRunState();
    }

    function setValue(v) {
        input.value = v;
        grow();
        updateSendState();
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
        saveDraft();
    }

    T.composer = { init, setValue, restore };
})((window.Taby = window.Taby || {}));
