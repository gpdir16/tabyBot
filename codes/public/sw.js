// tabyBot 서비스 워커: 정적 셸 캐시 + 푸시 알림 표시 + 클릭 시 앱 포커스.
const CACHE = "tabybot-shell-v2";
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/assets/icons/icon-192.png", "/assets/icons/icon-512.png"];

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
        self.registration.showNotification(data.title || "tabyBot", {
            body: data.body || "",
            tag: data.tag || "tabybot",
            icon: "/assets/icons/icon-192.png",
            badge: "/assets/icons/icon-192.png",
            data: { url: data.url || "/" },
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || "/";
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
            const existing = list.find((c) => "focus" in c);
            if (existing) return existing.focus();
            if (self.clients.openWindow) return self.clients.openWindow(target);
        }),
    );
});
