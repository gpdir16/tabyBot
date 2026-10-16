/* tabyBot 웹 클라이언트: 설정 > 효율적인 운영 탭. 요금과 사용량을 아끼는 기능을 모은다.
   첫 화면에는 최근 7일 지표와 두 화면(사용 통계, 프롬프트 캐시 유지)으로 들어가는 행만 둔다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);

    C.efficiencySub = null; // 한 단계 더 들어간 화면: "stats"(사용 통계) | "cache"(프롬프트 캐시 유지) | null
    let range = 7; // 사용 통계에서 보는 기간(일)

    const locale = () => ({ ko: "ko-KR", ja: "ja-JP" })[T.i18n.getLang()] || "en-US";

    // 토큰 수를 "1.2만", "34K"처럼 짧게.
    function compact(n) {
        return new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
    }

    const percent = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-");

    // 길이를 "5분", "1.5시간"처럼.
    function durationText(ms) {
        const minutes = Math.round(ms / 60000);
        if (minutes < 60) return t("cacheKeepAliveMinutes", { n: minutes });
        return t("cacheKeepAliveHours", { n: Math.round((minutes / 60) * 10) / 10 });
    }

    // 최근 n일의 날짜별 합계와 모델별 합계.
    function usageOf(days, n) {
        const recent = (days || []).slice(-n);
        const sum = () => ({ calls: 0, input: 0, cached: 0, written: 0, output: 0, pings: 0, pingInput: 0 });
        const total = sum();
        const models = new Map();
        const daily = recent.map(({ date, models: rows }) => {
            const day = sum();
            for (const [id, row] of Object.entries(rows || {})) {
                const m = models.get(id) || sum();
                for (const k of Object.keys(day)) {
                    const v = row[k] || 0;
                    day[k] += v;
                    total[k] += v;
                    m[k] += v;
                }
                models.set(id, m);
            }
            return { date, ...day };
        });
        return { total, daily, models };
    }

    function buildEfficiency(body) {
        const s = state.state.settings;
        if (!s) {
            body.append(T.h("div", { class: "empty-note", text: t("offlineNote") }));
            return;
        }
        const sec = T.h("div", { class: "set-section" });
        body.append(sec);
        if (C.efficiencySub === "stats") {
            statsView(sec, s);
            return;
        }
        if (C.efficiencySub === "cache") {
            cacheView(sec, s);
            return;
        }
        const week = usageOf(s.usage?.days, 7).total;
        const open = (which) => () =>
            C.openForm(() => {
                C.efficiencySub = which;
            });
        const ka = s.cacheKeepAlive;
        const modeLabel = !ka
            ? t("cacheKeepAliveOff")
            : t({ auto: "cacheKeepAliveAuto", custom: "cacheKeepAliveCustom", off: "cacheKeepAliveOff" }[ka.mode] || "cacheKeepAliveAuto");
        sec.append(
            C.fieldLabel(t("usageLastWeek")),
            T.h("div", { class: "set-group eff-metrics" }, [
                metric(percent(week.cached, week.input), t("usageHitRate")),
                metric(week.calls ? compact(week.input + week.output) : "-", t("usageTokens")),
            ]),
            C.navRow(t("usageStatsMore"), "", open("stats")),
            C.navRow(t("cacheKeepAlive"), modeLabel, open("cache")),
        );
    }

    function metric(value, label) {
        return T.h("div", { class: "eff-metric" }, [
            T.h("span", { class: "eff-metric-val", text: value }),
            T.h("span", { class: "eff-metric-label", text: label }),
        ]);
    }

    // ── 사용 통계 ──

    function statsView(sec, s) {
        const { total, daily, models } = usageOf(s.usage?.days, range);
        sec.append(
            C.labeledRow(
                t("usageRange"),
                C.settingSelect(
                    [7, 30, 90].map((n) => ({ value: String(n), label: t("usageDays", { n }) })),
                    String(range),
                    (v) => {
                        range = Number(v);
                        C.build();
                    },
                    t("usageRange"),
                ),
            ),
        );
        if (!total.calls && !total.pings) {
            sec.append(T.h("div", { class: "set-desc", text: t("usageEmpty") }));
            return;
        }
        sec.append(chart(daily));

        sec.append(
            C.fieldLabel(t("usageTotals")),
            C.valueRow(t("usageCalls"), t("usageTimes", { n: total.calls.toLocaleString(locale()) })),
            C.valueRow(t("usageInput"), compact(total.input)),
            C.valueRow(t("usageCached"), `${compact(total.cached)} (${percent(total.cached, total.input)})`),
        );
        if (total.written) sec.append(C.valueRow(t("usageWritten"), compact(total.written)));
        sec.append(C.valueRow(t("usageOutput"), compact(total.output)));
        if (total.pings) sec.append(C.valueRow(t("usagePings"), t("usageTimes", { n: total.pings.toLocaleString(locale()) })));

        // 모델 이름이 길어 한 줄에 다 들어가지 않으므로 모델과 프로바이더를 두 줄로 나눈다.
        const modelRow = (id, m) => {
            const [pid, ...rest] = id.split("|");
            const provider = s.providers?.find((p) => p.id === pid)?.label || pid;
            return T.h("div", { class: "set-row eff-model" }, [
                T.h("span", { class: "eff-model-name" }, [
                    T.h("span", { class: "set-label", text: rest.join("|") || provider }),
                    T.h("span", { class: "eff-model-sub", text: provider }),
                ]),
                T.h("span", {
                    class: "eff-model-val",
                    text: t("usageModelValue", { tokens: compact(m.input + m.output), pct: percent(m.cached, m.input) }),
                }),
            ]);
        };
        const rows = [...models.entries()].filter(([, m]) => m.calls).sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
        if (rows.length) {
            sec.append(C.fieldLabel(t("usageByModel")));
            for (const [id, m] of rows) {
                sec.append(modelRow(id, m));
            }
        }
        sec.append(T.h("div", { class: "set-desc", text: t("usageNote") }));
    }

    // 날짜별 입력 토큰 막대. 캐시에서 읽은 부분과 새로 처리한 부분을 나눠 칠한다.
    function chart(daily) {
        const max = Math.max(1, ...daily.map((d) => d.input));
        const fmt = new Intl.DateTimeFormat(locale(), { month: "numeric", day: "numeric", timeZone: "UTC" });
        const dateText = (date) => fmt.format(new Date(`${date}T00:00:00Z`));
        const bars = daily.map((d) => {
            const fresh = d.input - d.cached;
            return T.h(
                "div",
                {
                    class: "eff-bar",
                    title: `${dateText(d.date)}: ${t("usageInput")} ${compact(d.input)}, ${t("usageCached")} ${compact(d.cached)}`,
                },
                [
                    T.h("span", { class: "eff-bar-fresh", style: `height:${(fresh / max) * 100}%` }),
                    T.h("span", { class: "eff-bar-cached", style: `height:${(d.cached / max) * 100}%` }),
                ],
            );
        });
        const swatch = (cls, label) => T.h("span", { class: "eff-legend-item" }, [T.h("span", { class: `eff-swatch ${cls}` }), label]);
        return T.h("div", { class: "set-group eff-chart" }, [
            T.h("div", { class: "eff-chart-max", text: compact(max) }),
            T.h("div", { class: "eff-bars" }, bars),
            T.h("div", { class: "eff-chart-axis" }, [
                T.h("span", { text: dateText(daily[0].date) }),
                T.h("span", { text: dateText(daily[daily.length - 1].date) }),
            ]),
            T.h("div", { class: "eff-legend" }, [swatch("eff-bar-cached", t("usageCached")), swatch("eff-bar-fresh", t("usageFresh"))]),
        ]);
    }

    // ── 프롬프트 캐시 유지 ──

    function cacheView(sec, s) {
        sec.append(T.h("div", { class: "set-desc", text: t("cacheKeepAliveDesc") }));
        const providerLabel = s.providers?.find((p) => p.id === s.provider?.id)?.label || s.provider?.label || s.provider?.id || "";
        sec.append(C.valueRow(t("provider"), providerLabel));
        const ka = s.cacheKeepAlive;
        // 요청 수로 과금되거나 로컬에서 도는 프로바이더는 캐시를 살려 둬도 아끼는 것이 없다.
        if (!ka) {
            sec.append(T.h("div", { class: "set-desc", text: t("cacheKeepAliveUnsupported") }));
            return;
        }
        cacheKeepAliveRows(sec, ka);
        if (ka.mode === "auto" && ka.pattern) patternRows(sec, ka.pattern);
    }

    // 캐시 유지 설정: 모드(자동, 사용자 지정, 끔), 사용자 지정 값, 자동일 때의 예상.
    function cacheKeepAliveRows(sec, ka) {
        const save = (value) => C.put({ cacheKeepAlive: value }).then(() => C.build());
        const custom = (patch) => save({ mode: "custom", ttlMinutes: ka.ttlMinutes || 60, keepHours: ka.keepHours || 3, ...patch });
        sec.append(
            C.labeledRow(
                t("cacheKeepAliveMode"),
                C.settingSelect(
                    [
                        { value: "auto", label: t("cacheKeepAliveAuto") },
                        { value: "custom", label: t("cacheKeepAliveCustom") },
                        { value: "off", label: t("cacheKeepAliveOff") },
                    ],
                    ka.mode,
                    (mode) => (mode === "custom" ? custom({}) : save({ mode })),
                    t("cacheKeepAliveMode"),
                ),
            ),
        );
        if (ka.mode === "off") return;
        if (ka.mode === "custom") {
            const ttlLabel = (n) => durationText(n * 60000);
            const keepLabel = (n) => durationText(n * 3600000);
            sec.append(
                C.labeledRow(
                    t("cacheKeepAliveTtl"),
                    C.settingSelect(
                        C.presetOptions(
                            [5, 30, 60].map((n) => ({ value: String(n), label: ttlLabel(n) })),
                            String(ka.ttlMinutes),
                            ttlLabel(ka.ttlMinutes),
                        ),
                        String(ka.ttlMinutes),
                        (v) => custom({ ttlMinutes: Number(v) }),
                        t("cacheKeepAliveTtl"),
                    ),
                ),
                C.labeledRow(
                    t("cacheKeepAliveKeep"),
                    C.settingSelect(
                        C.presetOptions(
                            [0.5, 1, 3, 6, 12, 24].map((n) => ({ value: String(n), label: keepLabel(n) })),
                            String(ka.keepHours),
                            keepLabel(ka.keepHours),
                        ),
                        String(ka.keepHours),
                        (v) => custom({ keepHours: Number(v) }),
                        t("cacheKeepAliveKeep"),
                    ),
                ),
            );
            return;
        }
        // 저장 응답이 오기 전(설정을 먼저 반영한 상태)에는 요약이 없다.
        if (!ka.pattern) return;
        sec.append(
            C.valueRow(t("cacheKeepAliveTtl"), durationText(ka.ttlMs)),
            C.valueRow(
                t("cacheKeepAliveKeep"),
                !ka.cachedSeen ? t("cacheKeepAliveWaiting") : ka.keepMs ? durationText(ka.keepMs) : t("cacheKeepAliveNotWorth"),
            ),
        );
    }

    // 사용 패턴: 무엇으로 이뤄졌는지와, 쉬었다 돌아오기까지 걸린 시간의 분포.
    function patternRows(sec, pattern) {
        sec.append(
            T.h("hr", { class: "divider" }),
            C.fieldLabel(t("cacheKeepAlivePattern")),
            C.valueRow(t("cacheKeepAliveOwnRecords"), t("cacheKeepAliveCount", { n: pattern.own })),
            C.valueRow(t("cacheKeepAliveBaseRecords"), t("cacheKeepAliveCount", { n: pattern.base })),
            C.valueRow(t("cacheKeepAliveOwnWeight"), `${pattern.ownShare}%`),
            T.h("div", { class: "set-desc", text: t("cacheKeepAlivePatternDesc") }),
            T.h("hr", { class: "divider" }),
            C.fieldLabel(t("cacheKeepAliveReturns")),
        );
        let from = 0;
        for (const bucket of pattern.returns || []) {
            const label =
                bucket.underMinutes === null
                    ? t("cacheKeepAliveOver", { d: durationText(from * 60000) })
                    : from === 0
                      ? t("cacheKeepAliveUnder", { d: durationText(bucket.underMinutes * 60000) })
                      : `${durationText(from * 60000)} ~ ${durationText(bucket.underMinutes * 60000)}`;
            sec.append(C.valueRow(label, `${bucket.percent}%`));
            from = bucket.underMinutes ?? from;
        }
    }

    C.buildEfficiency = buildEfficiency;
})(window.Taby);
