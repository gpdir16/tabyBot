/* tabyBot 웹 클라이언트: PWA 알림/설치.
   - 탭이 숨겨져 있으면 Notification API로 즉시 표시
   - 브라우저가 닫혀 있으면 서비스 워커 웹 푸시로 전달
   - 설치 프롬프트(beforeinstallprompt)는 설정 시트에서 노출
   - 모바일 브라우저에서 처음 열면 홈 화면에 추가하는 방법을 한 번 안내한다 */
((T) => {
    "use strict";

    const KEY = "tabybot.notify.enabled";
    let swReg = null;
    let deferredInstall = null;
    const GUIDE_KEY = "tabybot.installGuide.shown";
    // beforeinstallprompt는 로드 뒤 조금 늦게 올 수 있다. 그동안 기다렸다가 안내 방식을 고른다.
    const GUIDE_WAIT_MS = 3000;
    let guideTimer = 0;
    // 앱을 화면에 띄운 동안 서버에 주기적으로 알려, 이 기기로는 푸시를 보내지 않게 한다(서버 push.js 참고).
    // 서버는 마지막 알림 뒤 45초가 지나면 숨겨진 것으로 본다.
    const PRESENCE_MS = 20000;
    const DEVICE_KEY = "tabybot.push.device";
    const clientId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let pushEndpoint = "";

    // 이 브라우저(설치한 앱)의 고정 이름. 다시 구독해도 같은 이름이라 서버가 예전 구독을 지운다.
    function deviceId() {
        try {
            const saved = localStorage.getItem(DEVICE_KEY);
            if (saved) return saved;
            const made = clientId;
            localStorage.setItem(DEVICE_KEY, made);
            return made;
        } catch (_) {
            return clientId; // 저장소를 못 쓰면 매번 새 구독이 된다
        }
    }

    function enabled() {
        try {
            return localStorage.getItem(KEY) === "1";
        } catch (_) {
            return false;
        }
    }

    function reportPresence(visible = !document.hidden) {
        if (!pushEndpoint) return;
        T.api.pushPresence(pushEndpoint, clientId, visible).catch(() => {
            /* 유실돼도 서버가 잠시 뒤 숨겨진 것으로 보고 푸시를 다시 보낸다 */
        });
    }

    function persist(on) {
        try {
            localStorage.setItem(KEY, on ? "1" : "0");
        } catch {
            // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
        }
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

    // iOS PWA는 서비스 워커가 페이지를 장악하기 전에 구독하면 구독은 만들어지지만
    // 푸시가 서비스 워커로 오지 않아 알림이 영원히 오지 않는다. 장악될 때까지 기다린다.
    async function waitForController(ms = 10000) {
        if (navigator.serviceWorker.controller) return true;
        if (!(await navigator.serviceWorker.ready.catch(() => null))?.active) return false;
        if (navigator.serviceWorker.controller) return true;
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                navigator.serviceWorker.removeEventListener("controllerchange", done);
                resolve(Boolean(navigator.serviceWorker.controller));
            };
            const timer = setTimeout(done, ms);
            navigator.serviceWorker.addEventListener("controllerchange", done);
        });
    }

    // 구독이 끝났으면 true. 실패하면 false를 돌려주고 호출한 쪽이 다시 시도한다.
    // 앱을 열 때 한 번만 시도하면 네트워크가 늦게 붙은 판은 구독 없이 지나가고,
    // 화면에는 "알림 켜짐"인데 서버로 갈 구독이 없어 알림이 오지 않는다.
    async function ensurePush() {
        if (!enabled() || !swReg || !window.isSecureContext || !swReg.pushManager) return false;
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
        try {
            const cfg = await T.api.pushConfig();
            if (!cfg?.publicKey) return false;
            if (!(await waitForController())) return false;
            let sub = await swReg.pushManager.getSubscription();
            if (sub?.options?.applicationServerKey) {
                const cur = new Uint8Array(sub.options.applicationServerKey);
                const want = urlBase64ToUint8Array(cfg.publicKey);
                const same = cur.length === want.length && cur.every((b, i) => b === want[i]);
                if (!same) {
                    try {
                        await T.api.pushUnsubscribe(sub.toJSON());
                    } catch {
                        // 구독 해제 실패는 무시한다. 다음 구독 때 서버가 정리한다
                    }
                    try {
                        await sub.unsubscribe();
                    } catch {
                        // 이미 닫혔거나 정리된 대상이면 무시한다
                    }
                    sub = null;
                }
            }
            if (!sub) {
                sub = await swReg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
                });
            }
            await T.api.pushSubscribe({ ...sub.toJSON(), deviceId: deviceId() });
            pushEndpoint = sub.endpoint;
            reportPresence();
            return true;
        } catch (err) {
            // 푸시 미지원/HTTP 환경에서는 페이지 알림만 동작한다.
            console.warn("tabyBot: push subscribe failed:", err?.name || err?.message || err);
            return false;
        }
    }

    // 네트워크나 서버가 늦게 준비돼 구독하지 못했으면 조금씩 간격을 늘려 다시 시도한다.
    let retryTimer = 0;
    let retryMs = 5000;
    function retryPush() {
        if (retryTimer) return;
        retryTimer = setTimeout(async () => {
            retryTimer = 0;
            if (await ensurePush()) return;
            if (!enabled()) return;
            retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
            retryPush();
        }, retryMs);
    }

    async function disablePush() {
        pushEndpoint = "";
        clearTimeout(retryTimer);
        retryTimer = 0;
        if (!swReg?.pushManager) return;
        try {
            const sub = await swReg.pushManager.getSubscription();
            if (!sub) return;
            try {
                await T.api.pushUnsubscribe(sub.toJSON());
            } catch {
                // 구독 해제 실패는 무시한다. 다음 구독 때 서버가 정리한다
            }
            await sub.unsubscribe();
        } catch {
            // 이미 닫혔거나 정리된 대상이면 무시한다
        }
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
            if (!(await ensurePush())) retryPush();
            return true;
        }
        persist(false);
        await disablePush();
        if (navigator.clearAppBadge)
            navigator.clearAppBadge().catch(() => {
                /* 배지 API를 쓸 수 없는 환경이면 무시한다 */
            });
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
        if (navigator.setAppBadge)
            navigator.setAppBadge(1).catch(() => {
                /* 배지 API를 쓸 수 없는 환경이면 무시한다 */
            });
    }

    function isStandalone() {
        return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    }

    function isIos() {
        // iPadOS는 데스크톱 Safari로 자신을 알리므로 터치 지원으로 구분한다.
        return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    }

    // 홈 화면에 추가할 수 있는 모바일 기기의 종류. 데스크톱이면 null.
    // iOS의 모든 브라우저는 공유 메뉴로 추가하고, 안드로이드 Firefox는 메뉴 위치와 이름이 다르다.
    function mobilePlatform() {
        if (isIos()) return "ios";
        if (/Android/i.test(navigator.userAgent)) return /Firefox/i.test(navigator.userAgent) ? "firefox" : "android";
        return null;
    }

    function canGuideInstall() {
        return Boolean(mobilePlatform()) && !isStandalone();
    }

    // 설치 안내 경고창. 브라우저가 설치 창을 열 수 있으면 설치 버튼을, 아니면 직접 추가하는 방법을 보여 준다.
    function showInstallGuide() {
        const platform = mobilePlatform();
        if (!platform || isStandalone()) return;
        const t = (k) => T.i18n.t(k);
        const text = deferredInstall
            ? t("installGuidePrompt")
            : t({ ios: "installGuideIos", firefox: "installGuideFirefox", android: "installGuideAndroid" }[platform]);
        T.notices.alert({
            key: "install-guide",
            title: t("installGuideTitle"),
            text,
            actions: deferredInstall ? [{ label: t("installApp"), run: () => void promptInstall() }] : [],
        });
    }

    function guideShown() {
        try {
            return localStorage.getItem(GUIDE_KEY) === "1";
        } catch (_) {
            // 저장소를 못 쓰면 매번 띄우지 않도록 이미 본 것으로 친다
            return true;
        }
    }

    function showGuideOnce() {
        clearTimeout(guideTimer);
        guideTimer = 0;
        if (guideShown() || !canGuideInstall()) return;
        try {
            localStorage.setItem(GUIDE_KEY, "1");
        } catch {
            // 저장하지 못해도 이번 안내는 띄운다
        }
        showInstallGuide();
    }

    // 부트가 끝난 뒤 한 번 부른다. 설치 창 이벤트가 오면 바로, 안 오면 잠시 뒤에 안내한다.
    function offerInstallGuide() {
        if (guideTimer || guideShown() || !canGuideInstall()) return;
        if (deferredInstall) showGuideOnce();
        else guideTimer = setTimeout(showGuideOnce, GUIDE_WAIT_MS);
    }

    // 이 기기에서 알림을 켤 수 있는지. 못 켜면 이유를 돌려준다(설정 화면이 그 이유를 보여 준다).
    // "ok" | "insecure"(HTTPS 아님) | "ios-install"(홈 화면에 추가해야 함) | "unsupported" | "denied"(권한 차단)
    function support() {
        if (typeof Notification === "undefined") {
            // iOS는 홈 화면에 추가한 앱에서만 알림 API를 연다. 그 밖에는 HTTPS가 아니면 막힌다.
            if (isIos() && !isStandalone()) return "ios-install";
            if (!window.isSecureContext) return "insecure";
            return "unsupported";
        }
        return Notification.permission === "denied" ? "denied" : "ok";
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
            if (swReg?.active) swReg.active.postMessage({ type: "auth-token", token: tk, device: deviceId() });
            // 모든 기기 로그아웃은 서버의 알림 구독을 지운다. 다시 로그인하면 알림이 켜져 있을 때 다시 구독한다.
            if (tk && enabled()) void ensurePush().then((ok) => ok || retryPush());
        } catch {
            // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
        }
    }

    function init() {
        void registerSw().then(async () => {
            syncAuth();
            if (enabled() && !(await ensurePush())) retryPush();
        });
        window.addEventListener("online", () => {
            if (enabled()) void ensurePush().then((ok) => ok || retryPush());
        });
        navigator.serviceWorker?.addEventListener?.("message", (ev) => {
            // 캐시된 셸로 먼저 떴는데 서버에 새 버전이 있다. 바로 적용할지 경고창으로 묻는다.
            if (ev.data?.type === "shell-updated") {
                T.notices.alert({
                    key: "app-updated",
                    text: T.i18n.t("appUpdated"),
                    actions: [{ label: T.i18n.t("appReload"), run: () => location.reload() }],
                });
                return;
            }
            const url = ev.data?.type === "sw-navigate" ? String(ev.data.url || "") : "";
            if (!url?.startsWith("/") || url.startsWith("//")) return;
            // 창 목록(?w=)은 지금 열린 창들 그대로 둔다(util.pushUrl).
            if (location.pathname + location.search !== T.windows.urlWith(url)) T.util.pushUrl(url);
            T.app?.renderRoute?.();
        });
        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            deferredInstall = e;
            T.state.emit("pwa", { installable: true });
            if (guideTimer) showGuideOnce();
        });
        window.addEventListener("appinstalled", () => {
            deferredInstall = null;
            T.state.emit("pwa", { installable: false });
        });
        document.addEventListener("visibilitychange", () => {
            reportPresence();
            if (!document.hidden && navigator.clearAppBadge)
                navigator.clearAppBadge().catch(() => {
                    /* 배지 API를 쓸 수 없는 환경이면 무시한다 */
                });
        });
        window.addEventListener("pagehide", () => reportPresence(false));
        setInterval(() => {
            if (!document.hidden) reportPresence();
        }, PRESENCE_MS);
    }

    // 설정 화면의 "테스트 알림": 이 기기 구독으로 서버가 실제 푸시를 보내게 한다.
    // 구독이 없으면 먼저 다시 구독한다(권한이 살아 있는데 구독만 사라진 경우가 흔하다).
    async function testPush() {
        if (!(await ensurePush())) return { ok: false, status: 0 };
        try {
            const r = await T.api.pushTest(pushEndpoint);
            if (r?.sent !== true) return { ok: false, delivered: false, status: r?.status || 0 };
            // 서버가 돌려준 태그가 이 기기의 알림 목록에 나타나는지 본다(서비스 워커 버전과 무관).
            return { ok: true, delivered: await waitForNotification(r.tag, 12000), status: r.status || 0 };
        } catch (err) {
            return { ok: false, delivered: false, status: err?.status || 0 };
        }
    }

    // 이 기기 등록의 알림 목록에 해당 태그가 뜰 때까지 기다린다.
    async function waitForNotification(tag, ms) {
        if (!tag) return false;
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            try {
                const list = await swReg.getNotifications({ includeTriggered: true });
                if (list.some((n) => n.tag === tag)) return true;
            } catch {
                // 알림 목록을 못 읽는 브라우저면 서버 쪽 결과만 보여 준다
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return false;
    }

    T.notifications = {
        init,
        show,
        setOn,
        enabled,
        support,
        syncAuth,
        testPush,
        dropPush: disablePush,
        canInstall: () => Boolean(deferredInstall) && !isStandalone(),
        canGuideInstall,
        promptInstall,
        showInstallGuide,
        offerInstallGuide,
    };
})(window.Taby);
