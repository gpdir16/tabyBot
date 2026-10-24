/* tabyBot 웹 클라이언트: 설정 > 일반·알림 탭. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    /* ── 일반 탭 ────────────────────────────────────────────── */
    function buildGeneral(body) {
        const s = state.state.settings || {};
        const sec = T.h("div", { class: "set-section" });

        // 언어
        const langSel = T.h("select", { "aria-label": t("language") });
        [
            ["en", "English"],
            ["ko", "한국어"],
            ["ja", "日本語"],
        ].forEach(([v, label]) => {
            const o = T.h("option", { value: v, text: label });
            if (T.i18n.getLang() === v) o.selected = true;
            langSel.append(o);
        });
        langSel.addEventListener("change", () => {
            T.i18n.setLang(langSel.value); // 즉시 전환 + 저장
            C.put({ language: langSel.value });
        });
        if (state.state.settings?.language && T.i18n.getLang() !== state.state.settings.language) {
            T.i18n.setLang(state.state.settings.language, { persist: false });
            langSel.value = state.state.settings.language;
        } else {
            langSel.value = T.i18n.getLang();
        }
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", {}, [T.h("div", { class: "set-label", text: t("language") })]),
                T.h("div", { class: "select-wrap" }, [langSel, T.icon("chevron")]),
            ]),
        );

        // 시간대: 스케줄(체크인·스윕·투두) 기준. 비우면 서버 시간대(도커는 UTC).
        const tzs =
            typeof Intl.supportedValuesOf === "function"
                ? Intl.supportedValuesOf("timeZone")
                : ["Asia/Seoul", "Asia/Tokyo", "UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin"];
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("timezone") }),
                C.settingSelect(
                    C.presetOptions(
                        [{ value: "", label: t("tzServerDefault") }, ...tzs.map((z) => ({ value: z, label: z }))],
                        s.timezone || "",
                        s.timezone || "",
                    ),
                    s.timezone || "",
                    (v) => C.put({ timezone: v }),
                    t("timezone"),
                ),
            ]),
        );

        // 테마 (클라이언트 전용)
        const curTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("theme") }),
                C.settingSelect(
                    [
                        { value: "dark", label: t("dark") },
                        { value: "light", label: t("light") },
                    ],
                    curTheme,
                    (v) => {
                        if (T.app) T.app.applyTheme(v);
                    },
                    t("theme"),
                ),
            ]),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 응답 통계 푸터
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("statsFooter") }),
                C.switchEl(s.showReplyFooter, (v) => C.put({ showReplyFooter: v }), t("statsFooter")),
            ]),
        );

        // 업데이트 확인
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("updateCheck") }),
                C.switchEl(s.updateCheckEnabled, (v) => C.put({ updateCheckEnabled: v }), t("updateCheck")),
            ]),
        );

        // 설치 창을 열 수 있으면 그 창을, 못 여는 모바일 브라우저(iOS 등)면 직접 추가하는 방법을 띄운다.
        if (T.notifications?.canInstall() || T.notifications?.canGuideInstall()) {
            sec.append(
                C.actionRow(t("installApp"), () => {
                    if (T.notifications.canInstall()) T.notifications.promptInstall().then(() => C.build());
                    else T.notifications.showInstallGuide();
                }),
            );
        }

        sec.append(T.h("hr", { class: "divider" }));

        const nsfwLabels = {
            strict: t("nsfwStrict"),
            moderate: t("nsfwModerate"),
            explicit: t("nsfwExplicit"),
        };
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("nsfwLevel") }),
                C.settingSelect(
                    (s.nsfwLevels || ["strict", "moderate", "explicit"]).map((v) => ({ value: v, label: nsfwLabels[v] || v })),
                    s.nsfwLevel,
                    (v) => C.put({ nsfwLevel: v }),
                    t("nsfwLevel"),
                ),
            ]),
        );

        const approvalLabels = { user: t("approvalUser"), model: t("approvalModel"), always: t("approvalAlways") };
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("approvalLevel") }),
                C.settingSelect(
                    (s.approvalLevels || ["user", "model", "always"]).map((v) => ({ value: v, label: approvalLabels[v] || v })),
                    s.approvalLevel,
                    (v) => C.put({ approvalLevel: v }),
                    t("approvalLevel"),
                ),
            ]),
        );

        body.append(sec);
    }

    /* ── 알림 탭 ────────────────────────────────────────────
       서버가 보낸 시스템 알림의 기록. 새 알림은 모달로 뜨고(ui/notices.js), 여기서 지난 것을 다시 본다. */
    // 이 기기의 알림(OS 알림 + 웹 푸시) 스위치. 켤 수 없는 기기에서도 행은 보여 주고 이유를 적는다
    // (iOS는 홈 화면에 추가한 앱에서만, 그 밖에는 HTTPS에서만 알림을 쓸 수 있다).
    function appendNotifyToggle(sec) {
        const support = T.notifications.support();
        const usable = support === "ok" || support === "denied";
        const toggle = C.switchEl(
            usable && T.notifications.enabled(),
            (v) => {
                T.notifications.setOn(v).then((ok) => {
                    if (v && !ok) T.toast.show("error", t("notificationsDenied"));
                    C.build();
                });
            },
            t("notifications"),
        );
        if (!usable) toggle.querySelector("input").disabled = true;
        sec.append(T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: t("notifications") }), toggle]));
        const reason = {
            ok: "notificationsDesc",
            denied: "notificationsBlocked",
            "ios-install": "notificationsIosInstall",
            insecure: "notificationsInsecure",
            unsupported: "notificationsUnsupported",
        }[support];
        sec.append(T.h("div", { class: "set-desc", text: t(reason) }));
    }

    function buildNotices(body) {
        const sec = T.h("div", { class: "set-section" });
        appendNotifyToggle(sec);
        sec.append(T.h("hr", { class: "divider" }));

        const tasks = T.notices.tasks();
        if (tasks.length) {
            sec.append(
                T.h("div", { class: "field-label", text: t("tasksRunning") }),
                T.h("div", { class: "nt-list nt-history" }, tasks.map(T.notices.buildTask)),
                T.h("hr", { class: "divider" }),
            );
        }

        sec.append(T.h("div", { class: "set-desc", text: t("noticesDesc") }));
        const list = T.notices.items();
        if (!T.notices.loaded()) {
            T.notices.refresh();
            sec.append(T.h("div", { class: "set-desc", text: t("loading") }));
        } else if (!list.length) {
            sec.append(T.h("div", { class: "set-desc", text: t("noticesEmpty") }));
        } else {
            sec.append(T.h("div", { class: "nt-list nt-history" }, list.map(T.notices.buildRow)));
            const clear = C.actionRow(
                t("noticesClear"),
                async () => {
                    const ok = await T.confirm({
                        title: t("noticesClearConfirmTitle"),
                        text: t("confirmDeleteText"),
                        confirmLabel: t("noticesClear"),
                        danger: true,
                    });
                    if (!ok) return;
                    clear.row.disabled = true;
                    T.notices.clearAll().catch((err) => {
                        clear.row.disabled = false;
                        T.toast.show("error", T.api.errorText(err, t("saveFailed")));
                    });
                },
                { danger: true, own: true },
            );
            sec.append(clear);
        }
        body.append(sec);
    }

    C.buildGeneral = buildGeneral;
    C.buildNotices = buildNotices;
})(window.Taby);
