// tabyBot 서비스 워커: 정적 셸 캐시 + 푸시 알림 표시 + 클릭 시 앱 포커스.
const CACHE = "tabybot-shell-v4";
// 모든 라우트(/a/<uuid>, /s/<탭> …)가 같은 index.html을 쓰므로 셸은 한 항목으로 캐시한다.
const SHELL = "/";
const PRECACHE = [
    SHELL,
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

// 셸을 네트워크에서 다시 받아 캐시를 갱신한다. 내용이 바뀌었으면 열린 창에 알린다.
async function refreshShell(cache, cached) {
    const res = await fetch(SHELL, { cache: "no-cache" });
    if (!res.ok) return res;
    const before = cached?.headers.get("etag") || "";
    const after = res.headers.get("etag") || "";
    await cache.put(SHELL, res.clone());
    if (cached && before !== after) {
        const list = await self.clients.matchAll({ type: "window" }).catch(() => []);
        for (const client of list) client.postMessage({ type: "shell-updated" });
    }
    return res;
}

// 셸(HTML): 캐시를 즉시 돌려주고 뒤에서 갱신한다(stale-while-revalidate).
// 네트워크 왕복을 기다리지 않아 앱이 바로 뜨고, 새 배포는 다음 실행부터 적용된다.
async function serveShell(event) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(SHELL);
    const refresh = refreshShell(cache, cached).catch(() => null);
    if (cached) {
        event.waitUntil(refresh);
        return cached;
    }
    return (await refresh) || fetch(event.request);
}

// 버전이 붙은 에셋(/assets/...?v=)은 내용이 바뀌면 URL이 바뀌므로 캐시 우선이 안전하다.
async function serveVersioned(req, url) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) {
        // 같은 파일의 옛 버전 항목은 지운다.
        const keys = await cache.keys();
        await Promise.all(keys.filter((k) => new URL(k.url).pathname === url.pathname).map((k) => cache.delete(k)));
        await cache.put(req, res.clone());
    }
    return res;
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/api/")) return;

    // 앱 라우트로의 이동만 셸로 답한다 — 파일을 직접 연 경우(확장자 있음)는 아래 일반 경로로 간다.
    if (req.mode === "navigate" && !/\.[a-z0-9]+$/i.test(url.pathname)) {
        event.respondWith(serveShell(event));
        return;
    }

    if (url.pathname.startsWith("/assets/") && url.searchParams.has("v")) {
        event.respondWith(serveVersioned(req, url));
        return;
    }

    // 버전 없는 정적 파일은 네트워크 우선. 캐시 우선이면 고친 클라이언트가 영원히 안 내려간다.
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
