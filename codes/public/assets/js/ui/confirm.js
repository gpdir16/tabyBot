/* tabyBot 웹 클라이언트: 확인 대화상자.
   삭제처럼 되돌리기 어려운 동작 앞에서 "정말 할까요?"를 묻는다. 시스템 알림(ui/notices.js)과
   같은 경고창 모양을 쓰고, 결과는 Promise<boolean>으로 돌려준다(취소·Esc·바깥 누름은 false). */
(function (T) {
    "use strict";

    const t = (k, v) => T.i18n.t(k, v);
    const OUT_MS = 180; // 닫히는 모션(app.css의 .nt-modal.out과 같게)

    // opt: { title, text?, confirmLabel?, danger? }
    function confirm(opt) {
        return new Promise((resolve) => {
            const opener = document.activeElement;
            let done = false;

            const finish = (result) => {
                if (done) return;
                done = true;
                el.classList.add("out");
                setTimeout(() => el.remove(), OUT_MS);
                if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
                resolve(result);
            };

            const buttons = [
                T.h("button", { class: "nt-btn", type: "button", text: t("cancel"), onclick: () => finish(false) }),
                T.h("button", {
                    class: "nt-btn strong" + (opt.danger ? " danger" : ""),
                    type: "button",
                    text: opt.confirmLabel || t("noticeOk"),
                    onclick: () => finish(true),
                }),
            ];
            const el = T.h(
                "div",
                {
                    class: "nt-modal",
                    role: "alertdialog",
                    "aria-modal": "true",
                    "aria-labelledby": "cfTitle",
                    "aria-describedby": "cfText",
                    onclick(e) {
                        if (e.target === el) finish(false);
                    },
                },
                [
                    T.h("div", { class: "nt-alert" }, [
                        T.h("div", { class: "nt-alert-body" }, [
                            T.h("h2", { id: "cfTitle", class: "nt-alert-title", text: opt.title }),
                            T.h("p", { id: "cfText", class: "nt-alert-text", text: opt.text || "" }),
                        ]),
                        T.h("div", { class: "nt-alert-btns" }, buttons),
                    ]),
                ],
            );
            // 대화상자에 포커스가 있을 때는 전역 단축키(/ 등)가 뒤 UI를 건드리지 않게 한다.
            el.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Escape") finish(false);
            });
            T.touchPick(
                el,
                ".nt-btn",
                (btn) => btn.click(),
                (e) => !e.target.closest(".nt-alert-body"),
            );
            document.getElementById("overlayRoot").append(el);
            el.tabIndex = -1;
            el.focus({ preventScroll: true });
        });
    }

    T.confirm = confirm;
})((window.Taby = window.Taby || {}));
