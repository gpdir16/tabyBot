/* tabyBot 웹 클라이언트: 설정 > 자기 개선 탭. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    function buildSelfImprovement(body) {
        const s = state.state.settings;
        if (!s) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }
        const si = s.selfImprovement || {};
        const d = si.dreaming || {};
        const r = si.review || {};
        const p = si.proactive || {};
        const putSi = (section, patch) => C.put({ selfImprovement: { [section]: patch } });

        const sec = T.h("div", { class: "set-section" });
        sec.append(T.h("div", { class: "set-warn", text: t("siUsageWarn") }));

        // 자동 체크인
        sec.append(C.fieldLabel(t("siProactive")));
        sec.append(T.h("div", { class: "set-desc", text: t("siProactiveDesc") }));
        sec.append(
            C.labeledRow(
                t("siEnabled"),
                C.switchEl(p.enabled, (v) => putSi("proactive", { enabled: v }), t("siEnabled")),
            ),
        );
        sec.append(
            C.labeledRow(
                t("siInterval"),
                C.settingSelect(
                    C.presetOptions(
                        [
                            { value: "60", label: t("siEvery1h") },
                            { value: "180", label: t("siEvery3h") },
                            { value: "360", label: t("siEvery6h") },
                            { value: "720", label: t("siEvery12h") },
                        ],
                        String(p.intervalMin ?? 360),
                        `${p.intervalMin}min`,
                    ),
                    String(p.intervalMin ?? 360),
                    (v) => putSi("proactive", { intervalMin: Number(v) }),
                    t("siInterval"),
                ),
            ),
        );
        sec.append(
            C.labeledRow(
                t("siActiveHours"),
                C.settingSelect(
                    C.presetOptions(
                        [
                            { value: "0-24", label: t("siHoursAll") },
                            { value: "8-23", label: t("siHoursFull") },
                            { value: "9-18", label: t("siHoursDay") },
                            { value: "18-23", label: t("siHoursEvening") },
                        ],
                        `${p.activeStartHour ?? 8}-${p.activeEndHour ?? 23}`,
                        `${p.activeStartHour ?? 8}–${p.activeEndHour ?? 23}h`,
                    ),
                    `${p.activeStartHour ?? 8}-${p.activeEndHour ?? 23}`,
                    (v) => {
                        const [sh, eh] = v.split("-").map(Number);
                        putSi("proactive", { activeStartHour: sh, activeEndHour: eh });
                    },
                    t("siActiveHours"),
                ),
            ),
        );
        sec.append(
            C.labeledRow(
                t("siIdle"),
                C.settingSelect(
                    C.presetOptions(
                        [
                            { value: "15", label: t("siIdle15") },
                            { value: "30", label: t("siIdle30") },
                            { value: "60", label: t("siIdle60") },
                        ],
                        String(p.idleMin ?? 30),
                        `${p.idleMin}min`,
                    ),
                    String(p.idleMin ?? 30),
                    (v) => putSi("proactive", { idleMin: Number(v) }),
                    t("siIdle"),
                ),
            ),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 드림 스윕
        sec.append(C.fieldLabel(t("siDreaming")));
        sec.append(T.h("div", { class: "set-desc", text: t("siDreamingDesc") }));
        sec.append(
            C.labeledRow(
                t("siEnabled"),
                C.switchEl(d.enabled, (v) => putSi("dreaming", { enabled: v }), t("siEnabled")),
            ),
        );
        sec.append(
            C.labeledRow(
                t("siSchedule"),
                C.settingSelect(
                    C.presetOptions(
                        [
                            { value: "0 */6 * * *", label: t("siSched6h") },
                            { value: "0 4 * * *", label: t("siSchedDaily") },
                            { value: "0 4 * * 0", label: t("siSchedWeekly") },
                        ],
                        d.cron || "0 4 * * *",
                        String(d.cron || ""),
                    ),
                    d.cron || "0 4 * * *",
                    (v) => putSi("dreaming", { cron: v }),
                    t("siSchedule"),
                ),
            ),
        );

        sec.append(T.h("hr", { class: "divider" }));

        // 세션 리뷰
        sec.append(C.fieldLabel(t("siReview")));
        sec.append(T.h("div", { class: "set-desc", text: t("siReviewDesc") }));
        sec.append(
            C.labeledRow(
                t("siEnabled"),
                C.switchEl(r.enabled, (v) => putSi("review", { enabled: v }), t("siEnabled")),
            ),
        );
        sec.append(
            C.labeledRow(
                t("siReviewLevel"),
                C.settingSelect(
                    C.presetOptions(
                        [
                            { value: "3", label: t("siRevSmall") },
                            { value: "5", label: t("siRevMid") },
                            { value: "10", label: t("siRevLarge") },
                        ],
                        String(r.minToolCalls ?? 5),
                        String(r.minToolCalls ?? 5),
                    ),
                    String(r.minToolCalls ?? 5),
                    (v) => putSi("review", { minToolCalls: Number(v) }),
                    t("siReviewLevel"),
                ),
            ),
        );

        body.append(sec);
    }

    C.buildSelfImprovement = buildSelfImprovement;
})(window.Taby);
