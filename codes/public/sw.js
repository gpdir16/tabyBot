// tabyBot 서비스 워커: 정적 셸 캐시 + 푸시 알림 표시 + 클릭 시 앱 포커스.
const CACHE = "tabybot-shell-v3";
const PRECACHE = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/assets/icons/icon-192.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-192-maskable.png",
    "/assets/icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/api/")) return;

    // HTML은 네트워크 우선(배포 즉시 반영), 그 외 정적 파일은 캐시 우선.
    if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches
                        .open(CACHE)
                        .then((c) => c.put(req, copy))
                        .catch(() => {});
                    return res;
                })
                .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html"))),
        );
        return;
    }

    // JS/CSS는 네트워크 우선. 캐시 우선이면 고친 클라이언트가 영원히 안 내려간다.
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches
                        .open(CACHE)
                        .then((c) => c.put(req, copy))
                        .catch(() => {});
                }
                return res;
            })
            .catch(() => caches.match(req)),
    );
});

self.addEventListener("push", (event) => {
    let data = { title: "tabyBot", body: "", tag: "tabybot", url: "/" };
    try {
        if (event.data) data = { ...data, ...event.data.json() };
    } catch {
        try {
            data.body = event.data ? event.data.text() : "";
        } catch {
            // 페이로드 없음
        }
    }
    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .catch(() => [])
            .then((list) => {
                if (list.some((c) => c.visibilityState === "visible")) return;
                return self.registration.showNotification(data.title || "tabyBot", {
                    body: data.body || "",
                    tag: data.tag || "tabybot",
                    icon: "/assets/icons/icon-192.png",
                    badge: "/assets/icons/icon-192.png",
                    data: { url: data.url || "/" },
                });
            }),
    );
});

let appToken = "";

self.addEventListener("message", (event) => {
    if (event.data?.type === "auth-token") appToken = String(event.data.token || "");
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || "/";
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
            const existing = list.find((c) => "focus" in c);
            if (existing) {
                try {
                    existing.postMessage({ type: "sw-navigate", url: target });
                } catch (_) {}
                return existing.focus();
            }
            const url = appToken ? target + (target.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(appToken) : target;
            if (self.clients.openWindow) return self.clients.openWindow(url);
        }),
    );
});

self.addEventListener("pushsubscriptionchange", (event) => {
    const b64ToBytes = (b64) => {
        const pad = "=".repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    };
    const auth = appToken ? { Authorization: "Bearer " + appToken } : {};
    event.waitUntil(
        (async () => {
            const cfg = await fetch("/api/push/config", { headers: auth }).then((r) => (r.ok ? r.json() : null));
            if (!cfg?.publicKey) return;
            const sub = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: b64ToBytes(cfg.publicKey),
            });
            await fetch("/api/push/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...auth },
                body: JSON.stringify(sub.toJSON()),
            });
        })().catch(() => {}),
    );
});
