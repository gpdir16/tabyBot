// 의존성 없는 최소 HTTP 라우터: JSON API, SSE, 정적 파일 서빙, 선택적 세션 인증.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

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

// 텍스트 계열만 압축한다 — 이미지/폰트는 이미 압축돼 있어 CPU만 쓴다.
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Accept-Encoding에서 쓸 수 있는 가장 좋은 인코딩을 고른다(br은 HTTPS에서만 온다).
function pickEncoding(req) {
    const accept = String(req?.headers?.["accept-encoding"] || "");
    if (/\bbr\b/.test(accept)) return "br";
    if (/\bgzip\b/.test(accept)) return "gzip";
    return "";
}

function compress(buffer, encoding) {
    if (encoding === "br") {
        return zlib.brotliCompressSync(buffer, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length },
        });
    }
    return zlib.gzipSync(buffer, { level: 6 });
}

// If-None-Match는 약한 비교로 충분하다(프록시가 W/를 붙여 돌려보내기도 한다).
function etagMatches(req, etag) {
    const header = String(req?.headers?.["if-none-match"] || "");
    if (!header) return false;
    return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

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

// auth: { enabled() → 세션 요구 여부, verify(token) → 세션 유효 여부,
//         publicPaths[] → 인증 없이 열어둘 /api 경로(로그인 등) }
export function createRouter({ publicDir, auth = {} }) {
    const routes = [];
    const authEnabled = typeof auth.enabled === "function" ? auth.enabled : () => false;
    const verifyToken = typeof auth.verify === "function" ? auth.verify : () => false;
    const publicApi = new Set(Array.isArray(auth.publicPaths) ? auth.publicPaths : []);

    function add(method, pattern, handler) {
        const { regex, keys } = compilePattern(pattern);
        routes.push({ method, regex, keys, handler });
    }

    // 세션 토큰 추출: Authorization Bearer → x-tabybot-token 헤더 → ?token= 쿼리.
    function presentedToken(url, req) {
        const header = req.headers.authorization || "";
        if (header.startsWith("Bearer ")) return header.slice(7).trim();
        const alt = req.headers["x-tabybot-token"];
        if (alt) return String(alt);
        return url.searchParams.get("token") || "";
    }

    function authorized(url, req) {
        // PWA 셸(SW/매니페스트/아이콘)은 브라우저가 헤더를 못 실으므로 공개한다.
        if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/assets/icons/")) {
            return true;
        }
        if (!authEnabled()) return true;
        // 인증 모드에서도 정적 셸(HTML/JS/CSS)은 공개한다 — 로그인 화면 자체가
        // 이 파일들로 로드된다. 데이터와 액션은 전부 /api/ 아래라 계속 보호된다.
        if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
            return true;
        }
        if (publicApi.has(url.pathname)) return true;
        const presented = presentedToken(url, req);
        return presented ? verifyToken(presented) : false;
    }

    // req를 주면 큰 응답(대화 기록 등)을 압축해 보낸다 — 느린 회선에서 체감이 크다.
    function sendJson(res, status, body, req = null) {
        let payload = Buffer.from(JSON.stringify(body), "utf8");
        const headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        };
        const encoding = payload.length >= MIN_COMPRESS_BYTES ? pickEncoding(req) : "";
        if (encoding) {
            payload = compress(payload, encoding);
            headers["Content-Encoding"] = encoding;
            headers.Vary = "Accept-Encoding";
        }
        headers["Content-Length"] = payload.length;
        res.writeHead(status, headers);
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

    // 정적 파일 메모리 캐시: 파일이 바뀌면(mtime/size) 다시 읽는다.
    // 셸 전체가 1MB 남짓이라 본문과 압축본을 통째로 들고 있어도 부담이 없다.
    const staticCache = new Map();
    function loadStatic(filePath, stat) {
        const hit = staticCache.get(filePath);
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
        const body = fs.readFileSync(filePath);
        const entry = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            // 내용 해시 — 같은 내용이면 재배포(이미지 재빌드로 mtime만 바뀜) 후에도 캐시가 유지된다.
            version: crypto.createHash("sha1").update(body).digest("hex").slice(0, 12),
            body,
            encoded: new Map(),
        };
        staticCache.set(filePath, entry);
        return entry;
    }

    function sendBuffer(req, res, { body, encoded, etag, type, cacheControl }) {
        const headers = { "Content-Type": type, "Cache-Control": cacheControl, ETag: etag };
        const compressible = COMPRESSIBLE.test(type) && body.length >= MIN_COMPRESS_BYTES;
        if (compressible) headers.Vary = "Accept-Encoding";
        if (etagMatches(req, etag)) {
            res.writeHead(304, headers);
            res.end();
            return;
        }
        let payload = body;
        const encoding = compressible ? pickEncoding(req) : "";
        if (encoding) {
            payload = encoded.get(encoding);
            if (!payload) {
                payload = compress(body, encoding);
                encoded.set(encoding, payload);
            }
            headers["Content-Encoding"] = encoding;
        }
        headers["Content-Length"] = payload.length;
        res.writeHead(200, headers);
        res.end(payload);
    }

    // index.html의 에셋 참조를 `/assets/...?v=<버전>` 절대 경로로 바꿔 내보낸다.
    // - 버전이 붙은 URL은 영구 캐시(immutable)라 재방문 시 네트워크를 타지 않는다.
    // - 절대 경로라 /a/<uuid>, /s/<탭> 어디서 열어도 같은 캐시 항목을 쓴다.
    // 파일이 바뀌면 버전이 바뀌므로 배포는 다음 로드에 바로 반영된다.
    const ASSET_REF = /\b(src|href)="\/?(assets\/[^"?#]+)"/g;
    let indexCache = null;
    function buildIndex() {
        const indexPath = path.join(publicDir, "index.html");
        const stat = fs.statSync(indexPath);
        const source = loadStatic(indexPath, stat);
        const versions = new Map();
        let signature = source.version;
        for (const match of source.body.toString("utf8").matchAll(ASSET_REF)) {
            const rel = match[2];
            if (versions.has(rel)) continue;
            let version = "";
            try {
                const assetPath = path.join(publicDir, rel);
                version = loadStatic(assetPath, fs.statSync(assetPath)).version;
            } catch {
                // 없는 에셋은 버전 없이 둔다(요청 시 404).
            }
            versions.set(rel, version);
            signature += `|${version}`;
        }
        if (indexCache?.signature === signature) return indexCache;
        const html = source.body
            .toString("utf8")
            .replace(ASSET_REF, (_, attr, rel) => `${attr}="/${rel}${versions.get(rel) ? `?v=${versions.get(rel)}` : ""}"`);
        const body = Buffer.from(html, "utf8");
        indexCache = {
            signature,
            body,
            encoded: new Map(),
            etag: `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`,
        };
        return indexCache;
    }

    function serveIndex(req, res) {
        const index = buildIndex();
        sendBuffer(req, res, { body: index.body, encoded: index.encoded, etag: index.etag, type: MIME[".html"], cacheControl: "no-cache" });
    }

    function serveStatic(req, res, url) {
        const urlPath = url.pathname;
        // SPA 폴백: 정적 파일이 아닌 경로(/a/<uuid> 등)는 index.html로 서빙한다.
        // 단, 하위 경로에서 상대 URL로 요청된 에셋(/a/assets/...)은 실제 파일로 되돌린다.
        const normalizedAsset = urlPath.match(/^\/(?:[^/]+\/)+?(assets\/.+)$/);
        const assetPath = normalizedAsset ? `/${normalizedAsset[1]}` : null;
        if (!assetPath && (urlPath === "/" || urlPath === "/index.html" || !path.extname(urlPath))) {
            serveIndex(req, res);
            return;
        }
        const rel = assetPath ? assetPath.slice(1) : urlPath.replace(/^\/+/, "");
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
                serveIndex(req, res);
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
        const entry = loadStatic(filePath, stat);
        // 요청한 버전이 지금 파일과 같을 때만 영구 캐시를 허용한다 — 배포 도중의
        // 옛 버전 URL이 새 내용을 영구 캐시에 박아 넣는 일을 막는다.
        const versioned = url.searchParams.get("v") === entry.version;
        sendBuffer(req, res, {
            body: entry.body,
            encoded: entry.encoded,
            etag: `"${entry.version}"`,
            type: MIME[ext] || "application/octet-stream",
            cacheControl: versioned ? IMMUTABLE_CACHE : "no-cache",
        });
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
                token: presentedToken(url, req),
                json: () => readJsonBody(req),
                sendJson: (status, body) => sendJson(res, status, body, req),
                json200: (body) => sendJson(res, 200, body, req),
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
            serveStatic(req, req.method === "HEAD" ? headOnly(res) : res, url);
            return;
        }

        sendJson(res, 404, { error: "not_found" });
    }

    return { add, handle, setSseSubscribe, setSeqNow };
}
