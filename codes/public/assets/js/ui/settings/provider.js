/* tabyBot 웹 클라이언트: 설정의 로그인 조각(OAuth 디바이스 플로우, 공식 CLI 로그인)과 모델 고급 설정.
   모델과 프로바이더 탭(models.js)과 온보딩이 쓴다. */
((T) => {
    "use strict";

    T.settingsCtx ??= {};
    const C = T.settingsCtx;
    const t = (k, v) => T.i18n.t(k, v);

    C.cliLoginPending = null; // 진행 중 CLI 로그인 { url }
    C.oauthPending = null; // 진행 중 OAuth 디바이스 플로우 { kind, userCode, deviceUrl }

    function isOauthProvider(meta) {
        return Boolean(meta && /-oauth$/.test(String(meta.type || "")));
    }

    // 로그인을 tabyBot이 아니라 공식 CLI에서 하는 프로바이더(Claude Agent SDK).
    function isCliLoginProvider(meta) {
        return Boolean(meta && meta.type === "claude-agent-sdk");
    }

    // OAuth 디바이스 플로우 섹션: 상태 표시 + 로그인 버튼 + 대기 중 안내(코드/링크).
    // rerender: 로그인 시작 후 화면을 다시 그릴 콜백(설정 시트는 build, 온보딩은 render).

    // 대기 박스가 떠 있는 동안 서버 폴링 주기(최대 ~8초)에만 의존하지 않고
    // 클라이언트가 직접 로그인 완료를 확인한다. SSE oauth_done 유실에도 동작한다.
    let oauthPollTimer = 0;

    let oauthPollTries = 0;

    function stopOauthPoll() {
        clearTimeout(oauthPollTimer);
        oauthPollTimer = 0;
    }

    function startOauthPoll(kind, refresh) {
        stopOauthPoll();
        oauthPollTries = 0;
        const tick = () => {
            // pending이 사라졌으면(다른 경로에서 완료/취소) 종료.
            if (!C.oauthPending || C.oauthPending.kind !== kind) return;
            oauthPollTries++;
            // 5분 후 포기: 디바이스 코드 만료와 맞춘다.
            if (oauthPollTries > 100) return;
            T.api
                .authStatus()
                .then((st) => {
                    if (!C.oauthPending || C.oauthPending.kind !== kind) return;
                    if (st?.[kind]) {
                        C.oauthPending = null;
                        stopOauthPoll();
                        refresh();
                    } else {
                        oauthPollTimer = setTimeout(tick, 3000);
                    }
                })
                .catch(() => {
                    if (C.oauthPending && C.oauthPending.kind === kind) oauthPollTimer = setTimeout(tick, 3000);
                });
        };
        oauthPollTimer = setTimeout(tick, 3000);
    }

    function oauthSection(kind, rerender) {
        const refresh = rerender || C.build;
        // 설정에서는 로그인이 계정 행 아래의 동작 행이다. 온보딩(rerender를 넘긴다)은 제 배치대로 같은 줄의 버튼을 쓴다.
        const inSettings = !rerender;
        const box = T.h("div", { class: "set-section" });

        if (C.oauthPending && C.oauthPending.kind === kind) {
            // 완료 감지: SSE 이벤트 + 상태 폴링 병행
            startOauthPoll(kind, refresh);
            // 디바이스 코드 카드: 코드 크게 표시 + 복사 + 페이지 열기
            box.append(
                T.h("div", { class: "oauth-pending" }, [
                    T.h("div", { class: "set-desc", text: t("oauthEnterCode") }),
                    T.h("div", { class: "oauth-code-row" }, [
                        T.h("span", { class: "oauth-code", text: C.oauthPending.userCode }),
                        T.h(
                            "button",
                            {
                                class: "btn-icon",
                                "aria-label": t("copy"),
                                onclick() {
                                    T.copyText(C.oauthPending.userCode).then((ok) => {
                                        if (ok) T.toast.show("info", t("copied"));
                                    });
                                },
                            },
                            [T.icon("copy")],
                        ),
                    ]),
                    T.h("a", {
                        class: "btn primary oauth-open",
                        href: C.oauthPending.deviceUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        text: t("oauthOpenPage"),
                    }),
                    T.h("div", { class: "oauth-foot" }, [
                        T.h("div", { class: "oauth-wait" }, [T.h("span", { class: "spin quiet" }), T.h("span", { text: t("oauthPending") })]),
                        T.h("button", {
                            class: "btn ghost",
                            text: t("cancel"),
                            onclick() {
                                T.api.cancelOauth(kind).catch(() => {
                                    /* 취소 요청이 실패해도 대기 중인 로그인은 만료되면 사라진다 */
                                });
                                C.oauthPending = null;
                                stopOauthPoll();
                                refresh();
                            },
                        }),
                    ]),
                ]),
            );
            return box;
        }

        const account = T.h("div", { class: "set-control" }, [T.h("div", { class: "set-desc", text: t("oauthChecking") })]);
        const row = T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: t("oauthAccount") }), account]);
        box.append(row);

        T.api
            .authStatus()
            .then((st) => {
                const loggedIn = Boolean(st?.[kind]);
                const loginLabel = loggedIn ? t("oauthRelogin") : t("oauthLogin");
                const login = async () => {
                    // 다시 로그인을 시작하면 서버가 지금 로그인부터 지운다. 중간에 그만두면 로그인이 없는 상태로 남는다.
                    if (loggedIn) {
                        const ok = await T.confirm({
                            title: t("oauthReloginConfirmTitle"),
                            text: t("oauthReloginConfirmText"),
                            confirmLabel: t("oauthRelogin"),
                            danger: true,
                        });
                        if (!ok) return;
                    }
                    T.api
                        .startOauth(kind)
                        .then((flow) => {
                            if (!flow?.userCode || !flow.deviceUrl) throw new Error(t("oauthFailed"));
                            C.oauthPending = { kind, userCode: flow.userCode, deviceUrl: flow.deviceUrl };
                            refresh();
                        })
                        .catch((err) => {
                            T.toast.show("error", T.api.errorText(err, t("oauthFailed")));
                        });
                };
                account.replaceChildren(
                    T.h("div", { class: `key-state${loggedIn ? "" : " off"}` }, [
                        T.h("span", { class: "key-dot" }),
                        T.h("span", { text: loggedIn ? t("oauthLoggedIn") : t("oauthNotLoggedIn") }),
                    ]),
                    ...(inSettings ? [] : [T.h("button", { class: `btn${loggedIn ? " ghost" : " primary"}`, text: loginLabel, onclick: login })]),
                );
                // 계정 행은 이미 묶음에 담겨 있다. 같은 묶음의 다음 행으로 붙인다.
                if (inSettings) row.after(C.actionRow(loginLabel, login));
            })
            .catch(() => {
                account.replaceChildren(T.h("div", { class: "set-desc", text: t("offlineNote") }));
            });
        return box;
    }

    // CLI 로그인 섹션: 로그인은 서버의 공식 CLI가 함. 여기서는 그 링크를 열게 하고 인증 코드를 받아 넘김.
    // rerender: 화면을 다시 그릴 콜백(설정 시트는 build, 온보딩은 render).
    function cliLoginSection(rerender) {
        const refresh = rerender || C.build;
        // oauthSection과 같은 배치: 설정에서는 로그인이 계정 행 아래의 동작 행, 온보딩은 같은 줄의 버튼.
        const inSettings = !rerender;
        const box = T.h("div", { class: "set-section" });

        if (C.cliLoginPending) {
            const code = T.h("input", { class: "input", type: "text", "aria-label": t("claudeLoginCode"), placeholder: t("claudeLoginCode") });
            const submit = T.h("button", {
                class: "btn primary",
                text: t("claudeLoginSubmit"),
                onclick() {
                    if (!code.value.trim()) return;
                    submit.disabled = true;
                    // 성공 여부는 oauth_done 이벤트로 옴. 여기서는 잘못된 코드만 바로 알림.
                    T.api
                        .submitClaudeLoginCode(code.value.trim())
                        .catch((err) => T.toast.show("error", T.api.errorText(err, t("oauthFailed"))))
                        .finally(() => {
                            submit.disabled = false;
                        });
                },
            });
            box.append(
                T.h("div", { class: "oauth-pending" }, [
                    T.h("div", { class: "set-desc", text: t("claudeLoginSteps") }),
                    T.h("a", {
                        class: "btn primary oauth-open",
                        href: C.cliLoginPending.url,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        text: t("oauthOpenPage"),
                    }),
                    T.h("div", { class: "oauth-code-row fill" }, [code, submit]),
                    T.h("div", { class: "oauth-foot" }, [
                        T.h("div", { class: "oauth-wait" }, [T.h("span", { class: "spin quiet" }), T.h("span", { text: t("oauthPending") })]),
                        T.h("button", {
                            class: "btn ghost",
                            text: t("cancel"),
                            onclick() {
                                T.api.cancelClaudeLogin().catch(() => {
                                    /* 취소 요청이 실패해도 대기 중인 로그인은 시간이 지나면 끝남 */
                                });
                                C.cliLoginPending = null;
                                refresh();
                            },
                        }),
                    ]),
                ]),
            );
            return box;
        }

        const account = T.h("div", { class: "set-control" }, [T.h("div", { class: "set-desc", text: t("oauthChecking") })]);
        const row = T.h("div", { class: "set-row" }, [T.h("div", { class: "set-label", text: t("oauthAccount") }), account]);
        const hint = T.h("div", { class: "set-desc", text: t("claudeLoginHint") });
        box.append(row, hint);

        T.api
            .claudeAuthStatus()
            .then((st) => {
                const loggedIn = Boolean(st?.loggedIn);
                const loginLabel = loggedIn ? t("oauthRelogin") : t("oauthLogin");
                // 계정 이름은 길어서 상태 옆에 두면 좁은 화면에서 줄이 깨짐. 설명 줄에 따로 적음.
                const who = [st?.email, st?.plan].filter(Boolean).join(", ");
                if (loggedIn && who) hint.before(T.h("div", { class: "set-desc account-who", text: who }));
                const login = () => {
                    T.api
                        .startClaudeLogin()
                        .then((flow) => {
                            if (!flow?.url) throw new Error(t("oauthFailed"));
                            C.cliLoginPending = { url: flow.url };
                            refresh();
                        })
                        .catch((err) => {
                            T.toast.show("error", T.api.errorText(err, t("oauthFailed")));
                        });
                };
                account.replaceChildren(
                    T.h("div", { class: `key-state${loggedIn ? "" : " off"}` }, [
                        T.h("span", { class: "key-dot" }),
                        T.h("span", { text: loggedIn ? t("oauthLoggedIn") : t("oauthNotLoggedIn") }),
                    ]),
                    ...(inSettings ? [] : [T.h("button", { class: `btn${loggedIn ? " ghost" : " primary"}`, text: loginLabel, onclick: login })]),
                );
                // 계정 행은 이미 묶음에 담겨 있음. 같은 묶음의 다음 행으로 붙임.
                if (inSettings) row.after(C.actionRow(loginLabel, login));
            })
            .catch(() => {
                account.replaceChildren(T.h("div", { class: "set-desc", text: t("offlineNote") }));
            });
        return box;
    }

    // 고급 설정 화면: 모델 전환 시 오염 방지 옵션. 압축 시점은 모델 프리셋마다 정한다.
    function buildModelAdvanced(sec, s) {
        // 모델이 바뀌면 모든 봇의 세션 압축 여부를 물어본다(실행은 사용자 확인 후).
        sec.append(
            T.h("div", { class: "set-row" }, [
                T.h("div", { class: "set-label", text: t("compressOnModelChange") }),
                C.switchEl(s.compressOnModelChange, (v) => C.put({ compressOnModelChange: v }), t("compressOnModelChange")),
            ]),
            T.h("div", { class: "set-desc", text: t("compressOnModelChangeDesc") }),
        );

        // 모든 봇의 세션 즉시 압축: 모델 전환 전 컨텍스트 오염 방지.
        // 기록 재작성 + LLM 호출이 드는 작업이므로 확인 대화상자를 거친다.
        // 진행 상태(sessionsCompressing)는 서버가 SSE로 알려 새로고침해도 유지된다.
        const compressing = Boolean(s.sessionsCompressing);
        const compressRow = C.actionRow(compressing ? t("compressing") : t("compressAllNow"), async () => {
            const ok = await T.confirm({
                title: t("compressAllConfirmTitle"),
                text: t("compressAllNowDesc"),
                confirmLabel: t("compressAllConfirmButton"),
            });
            if (!ok) return;
            compressRow.disabled = true;
            compressRow.querySelector(".act-label").textContent = t("compressing");
            T.api
                .compressAllSessions()
                .then((r) => {
                    const n = Number(r?.compressed) || 0;
                    const f = Number(r?.failed) || 0;
                    if (f) T.toast.show("warn", t("compressAllPartial", { n, f }));
                    else if (!n) T.toast.show("info", t("compressAllNone"));
                    else T.toast.show("info", t("compressAllDone", { n }));
                })
                .catch((err) => {
                    T.toast.show("error", T.api.errorText(err, t("compressAllFailed")));
                });
        });
        compressRow.disabled = compressing;
        sec.append(compressRow, T.h("div", { class: "set-desc", text: t("compressAllNowDesc") }));

        // 모든 봇의 세션 다시 시작: 압축해도 요약에 꼬인 흐름이 남을 때 쓴다. 실행 중인 턴도 멈춘다.
        // 지난 기록은 보관되어 화면과 검색에는 남고, 모델은 빈 세션으로 시작한다.
        const restartRow = C.actionRow(
            t("restartAllNow"),
            async () => {
                const ok = await T.confirm({
                    title: t("restartAllConfirmTitle"),
                    text: t("restartAllNowDesc"),
                    confirmLabel: t("restartAllConfirmButton"),
                    danger: true,
                });
                if (!ok) return;
                restartRow.disabled = true;
                restartRow.querySelector(".act-label").textContent = t("restarting");
                T.api
                    .restartAllSessions()
                    .then((r) => {
                        const n = Number(r?.restarted) || 0;
                        const f = Number(r?.failed) || 0;
                        if (f) T.toast.show("warn", t("restartAllPartial", { n, f }));
                        else if (!n) T.toast.show("info", t("restartAllNone"));
                        else T.toast.show("info", t("restartAllDone", { n }));
                    })
                    .catch((err) => T.toast.show("error", T.api.errorText(err, t("restartAllFailed"))))
                    .finally(() => {
                        restartRow.disabled = false;
                        restartRow.querySelector(".act-label").textContent = t("restartAllNow");
                    });
            },
            { danger: true },
        );
        restartRow.disabled = compressing;
        sec.append(restartRow, T.h("div", { class: "set-desc", text: t("restartAllNowDesc") }));
    }

    C.isOauthProvider = isOauthProvider;
    C.isCliLoginProvider = isCliLoginProvider;
    C.stopOauthPoll = stopOauthPoll;
    C.oauthSection = oauthSection;
    C.cliLoginSection = cliLoginSection;
    C.buildModelAdvanced = buildModelAdvanced;
})(window.Taby);
