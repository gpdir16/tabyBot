// 의존성 없는 최소 HTTP 라우터: JSON API, SSE, 정적 파일 서빙, 선택적 토큰 인증.
import fs from "node:fs";
import path from "node:path";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
};

function compilePattern(pattern) {
    const keys = [];
    const source = pattern
        .replace(/:[A-Za-z0-9_]+/g, (segment) => {
            keys.push(segment.slice(1));
            return "([^/]+)";
        })
        .replace(/\//g, "\\/");
    return { regex: new RegExp(`^${source}$`), keys };
}

export function createRouter({ publicDir, token = "" }) {
    const routes = [];

    function add(method, pattern, handler) {
        const { regex, keys } = compilePattern(pattern);
        routes.push({ method, regex, keys, handler });
    }

    function authorized(url, req) {
        // PWA 셸(SW/매니페스트/아이콘)은 브라우저가 헤더를 못 실으므로 공개한다.
        if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/assets/icons/")) {
            return true;
        }
        if (!token) return true;
        const header = req.headers.authorization || "";
        if (header === `Bearer ${token}`) return true;
        if (req.headers["x-tabybot-token"] === token) return true;
        return url.searchParams.get("token") === token;
    }

    function sendJson(res, status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(payload),
            "Cache-Control": "no-store",
        });
        res.end(payload);
    }

    async function readJsonBody(req, limitBytes = 20 * 1024 * 1024) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > limitBytes) throw new Error("payload too large");
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch (err) {
            err.code = "BAD_JSON";
            throw err;
        }
    }

    function headOnly(res) {
        const realEnd = res.end.bind(res);
        res.write = () => true;
        res.end = (a, b, c) => {
            const cb = [a, b, c].find((x) => typeof x === "function");
            return realEnd(cb);
        };
        return res;
    }

    function serveIndex(res) {
        const indexPath = path.join(publicDir, "index.html");
        const stat = fs.statSync(indexPath);
        res.writeHead(200, {
            "Content-Type": MIME[".html"],
            "Content-Length": stat.size,
            "Cache-Control": "no-cache",
        });
        fs.createReadStream(indexPath)
            .on("error", () => res.destroy())
            .pipe(res);
    }

    function serveStatic(res, urlPath) {
        // SPA 폴백: 정적 파일이 아닌 경로(/a/<uuid> 등)는 index.html로 서빙한다.
        // 단, 하위 경로에서 상대 URL로 요청된 에셋(/a/assets/...)은 실제 파일로 되돌린다.
        const normalizedAsset = urlPath.match(/^\/(?:[^/]+\/)+?(assets\/.+)$/);
        const assetPath = normalizedAsset ? `/${normalizedAsset[1]}` : null;
        if (!assetPath && urlPath !== "/" && !path.extname(urlPath)) {
            serveIndex(res);
            return;
        }
        const rel = assetPath ? assetPath.slice(1) : urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        const filePath = path.resolve(publicDir, rel);
        // 경로 탈출 방지: publicDir 바깥은 절대 서빙하지 않는다.
        if (!filePath.startsWith(path.resolve(publicDir) + path.sep) && filePath !== path.resolve(publicDir)) {
            sendJson(res, 403, { error: "forbidden" });
            return;
        }
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch {
            // 확장자 없는 임의 깊은 경로도 앱으로 진입시킨다(새로고침 대응).
            if (!path.extname(rel)) {
                serveIndex(res);
                return;
            }
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        if (!stat.isFile()) {
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const isVendor = filePath.includes(`${path.sep}vendor${path.sep}`);
        res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Content-Length": stat.size,
            "Cache-Control": isVendor ? "public, max-age=86400" : "no-cache",
        });
        fs.createReadStream(filePath)
            .on("error", () => res.destroy())
            .pipe(res);
    }

    function openSse(req, res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        req.socket.setKeepAlive(true);
        req.socket.setTimeout(0);
        res.on("error", () => {});
        req.on("error", () => {});
        res.write(`data: ${JSON.stringify({ type: "hello", seq: seqNow() })}\n\n`);
        // 프록시/방화벽 유휴 끊김 방지 + 클라이언트 생존 감지용 데이터 프레임
        const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
        }, 15_000);
        const unsubscribe = sseSubscribe
            ? sseSubscribe((payload) => {
                  if (!res.destroyed) res.write(`data: ${payload}\n\n`);
              })
            : () => {};
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            if (!res.destroyed) res.end();
        };
        req.on("close", close);
        res.on("close", close);
        return close;
    }

    let sseSubscribe = null;
    let seqNow = () => 0;
    function setSseSubscribe(fn) {
        sseSubscribe = fn;
    }
    function setSeqNow(fn) {
        seqNow = typeof fn === "function" ? fn : () => 0;
    }

    async function handle(req, res) {
        const url = new URL(req.url || "/", "http://localhost");

        const rawPath = (req.url || "/").split(/[?#]/)[0] || "/";
        if (/\/{2,}/.test(rawPath) && (req.method === "GET" || req.method === "HEAD")) {
            const target = rawPath.replace(/\/{2,}/g, "/") + url.search;
            res.writeHead(301, { Location: target, "Cache-Control": "no-store" });
            res.end();
            return;
        }

        if (!authorized(url, req)) {
            const payload = JSON.stringify({ error: "unauthorized" });
            res.writeHead(401, {
                "WWW-Authenticate": 'Bearer realm="tabyBot"',
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": Buffer.byteLength(payload),
                "Cache-Control": "no-store",
            });
            res.end(payload);
            return;
        }

        for (const route of routes) {
            if (route.method !== req.method) continue;
            const match = url.pathname.match(route.regex);
            if (!match) continue;

            const params = {};
            let badPath = false;
            route.keys.forEach((key, i) => {
                try {
                    params[key] = decodeURIComponent(match[i + 1]);
                } catch {
                    badPath = true;
                }
            });
            if (badPath) {
                sendJson(res, 400, { error: "bad_path" });
                return;
            }

            const ctx = {
                req,
                res,
                params,
                query: Object.fromEntries(url.searchParams),
                json: () => readJsonBody(req),
                json200: (body) => sendJson(res, 200, body),
                json400: (error) => sendJson(res, 400, { error }),
                json404: () => sendJson(res, 404, { error: "not_found" }),
                json409: (error, extra = {}) => sendJson(res, 409, { error, ...extra }),
                json413: (error, extra = {}) => sendJson(res, 413, { error, ...extra }),
                sse: () => openSse(req, res),
            };

            try {
                await route.handler(ctx);
            } catch (err) {
                if (!res.headersSent && err?.code === "BAD_JSON") {
                    sendJson(res, 400, { error: "invalid_json" });
                    return;
                }
                console.error(`tabyBot: ${req.method} ${url.pathname} failed:`, err?.stack || err);
                if (!res.headersSent) {
                    const tooLarge = err?.code === "UPLOAD_TOO_LARGE" || /payload too large/i.test(err?.message || "");
                    sendJson(res, tooLarge ? 413 : 500, {
                        error: tooLarge ? "upload_too_large" : "internal_error",
                        detail: err?.message || String(err),
                    });
                } else res.end();
            }
            return;
        }

        if (req.method === "GET" || req.method === "HEAD") {
            serveStatic(req.method === "HEAD" ? headOnly(res) : res, url.pathname);
            return;
        }

        sendJson(res, 404, { error: "not_found" });
    }

    return { add, handle, setSseSubscribe, setSeqNow };
}
