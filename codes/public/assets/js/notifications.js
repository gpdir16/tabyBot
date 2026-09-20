/* tabyBot 웹 클라이언트 — PWA 알림/설치.
   - 탭이 숨겨져 있으면 Notification API로 즉시 표시
   - 브라우저가 닫혀 있으면 서비스 워커 웹 푸시로 전달
   - 설치 프롬프트(beforeinstallprompt)는 설정 시트에서 노출 */
(function (T) {
    "use strict";

    const KEY = "tabybot.notify.enabled";
    let swReg = null;
    let deferredInstall = null;

    function enabled() {
        try {
            return localStorage.getItem(KEY) === "1";
        } catch (_) {
            return false;
        }
    }

    function persist(on) {
        try {
            localStorage.setItem(KEY, on ? "1" : "0");
        } catch (_) {}
    }

    function urlBase64ToUint8Array(b64) {
        const pad = "=".repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    async function registerSw() {
        if (!("serviceWorker" in navigator) || location.protocol === "file:") return null;
        try {
            swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
            return swReg;
        } catch (_) {
            return null;
        }
    }

    async function ensurePush() {
        if (!enabled() || !swReg || !window.isSecureContext || !swReg.pushManager) return;
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        try {
            const cfg = await T.api.pushConfig();
            if (!cfg || !cfg.publicKey) return;
            let sub = await swReg.pushManager.getSubscription();
            if (!sub) {
                sub = await swReg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
                });
            }
            await T.api.pushSubscribe(sub.toJSON());
        } catch (_) {
            // 푸시 미지원/HTTP 환경에서는 페이지 알림만 동작
        }
    }

    async function disablePush() {
        if (!swReg || !swReg.pushManager) return;
        try {
            const sub = await swReg.pushManager.getSubscription();
            if (!sub) return;
            try {
                await T.api.pushUnsubscribe(sub.toJSON());
            } catch (_) {}
            await sub.unsubscribe();
        } catch (_) {}
    }

    async function setOn(on) {
        if (on) {
            if (typeof Notification === "undefined") return false;
            const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
            if (perm !== "granted") {
                persist(false);
                return false;
            }
            persist(true);
            await ensurePush();
            return true;
        }
        persist(false);
        await disablePush();
        if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
        return false;
    }

    function show(title, body, tag, url) {
        if (!enabled() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
        // 보고 있는 탭이면 토스트만 쓰고 OS 알림은 띄우지 않는다.
        if (!document.hidden && document.hasFocus()) return;
        const opts = {
            body: body || "",
            tag: tag || "tabybot",
            icon: "/assets/icons/icon-192.png",
            badge: "/assets/icons/icon-192.png",
            data: { url: url || "/" },
        };
        if (swReg) {
            swReg.showNotification(title || "tabyBot", opts);
        } else {
            const n = new Notification(title || "tabyBot", opts);
            n.onclick = () => {
                window.focus();
                if (url) location.href = url;
            };
        }
        if (navigator.setAppBadge) navigator.setAppBadge(1).catch(() => {});
    }

    function isStandalone() {
        return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    }

    async function promptInstall() {
        if (!deferredInstall) return false;
        deferredInstall.prompt();
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        T.state.emit("pwa", { installable: false });
        return choice.outcome === "accepted";
    }

    // 로그인/로그아웃으로 세션 토큰이 바뀌면 SW 쪽 보관 토큰도 맞춘다
    // (알림 클릭시 여는 URL, pushsubscriptionchange 재구독에 쓰인다).
    function syncAuth() {
        try {
            const tk = localStorage.getItem("tabybot.web.token") || "";
            if (swReg?.active) swReg.active.postMessage({ type: "auth-token", token: tk });
        } catch (_) {}
    }

    function init() {
        void registerSw().then(() => {
            syncAuth();
            if (enabled()) void ensurePush();
        });
        navigator.serviceWorker?.addEventListener?.("message", (ev) => {
            const url = ev.data?.type === "sw-navigate" ? String(ev.data.url || "") : "";
            if (!url || !url.startsWith("/") || url.startsWith("//")) return;
            try {
                if (location.pathname + location.search !== url) history.pushState(null, "", url);
                T.app?.renderRoute?.();
            } catch (_) {}
        });
        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            deferredInstall = e;
            T.state.emit("pwa", { installable: true });
        });
        window.addEventListener("appinstalled", () => {
            deferredInstall = null;
            T.state.emit("pwa", { installable: false });
        });
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
        });
    }

    T.notifications = {
        init,
        show,
        setOn,
        enabled,
        syncAuth,
        canInstall: () => Boolean(deferredInstall) && !isStandalone(),
        promptInstall,
    };
})((window.Taby = window.Taby || {}));
