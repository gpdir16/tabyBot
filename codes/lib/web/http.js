// 의존성 없는 최소 HTTP 라우터: JSON API, SSE, 정적 파일 서빙, 선택적 세션 인증.
// 구현 조각은 http/ 아래에 있다(압축, JSON, 인증, SSE, 정적 서빙).
import { createAuthGate, presentedToken } from "./http/auth.js";
import { readJsonBody, sendJson } from "./http/response.js";
import { createSse } from "./http/response.js";
import { createStaticServer, headOnly } from "./http/static.js";

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

// 라우트 패턴의 :키 부분을 디코딩해 params로 만든다. 디코딩이 깨진 경로는 null.
function extractParams(route, match) {
    const params = {};
    for (let i = 0; i < route.keys.length; i += 1) {
        try {
            params[route.keys[i]] = decodeURIComponent(match[i + 1]);
        } catch {
            return null;
        }
    }
    return params;
}

function sendUnauthorized(res) {
    const payload = JSON.stringify({ error: "unauthorized" });
    res.writeHead(401, {
        "WWW-Authenticate": 'Bearer realm="tabyBot"',
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
    });
    res.end(payload);
}

// 핸들러가 던진 오류를 응답으로 바꾼다.
function sendHandlerError(req, res, url, err) {
    if (!res.headersSent && err?.code === "BAD_JSON") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
    }
    console.error(`tabyBot: ${req.method} ${url.pathname} failed:`, err?.stack || err);
    if (res.headersSent) {
        res.end();
        return;
    }
    const tooLarge = err?.code === "UPLOAD_TOO_LARGE" || /payload too large/i.test(err?.message || "");
    sendJson(res, tooLarge ? 413 : 500, {
        error: tooLarge ? "upload_too_large" : "internal_error",
        detail: err?.message || String(err),
    });
}

// auth: { enabled() → 세션 요구 여부, verify(token) → 세션 유효 여부,
//         publicPaths[] → 인증 없이 열어둘 /api 경로(로그인 등) }
export function createRouter({ publicDir, auth = {} }) {
    const routes = [];
    const authorized = createAuthGate(auth);
    const serveStatic = createStaticServer({ publicDir });
    const sse = createSse();

    function add(method, pattern, handler) {
        const { regex, keys } = compilePattern(pattern);
        routes.push({ method, regex, keys, handler });
    }

    function buildContext(req, res, url, params) {
        return {
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
            sse: () => sse.openSse(req, res),
        };
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
            sendUnauthorized(res);
            return;
        }

        for (const route of routes) {
            if (route.method !== req.method) continue;
            const match = url.pathname.match(route.regex);
            if (!match) continue;

            const params = extractParams(route, match);
            if (!params) {
                sendJson(res, 400, { error: "bad_path" });
                return;
            }

            try {
                await route.handler(buildContext(req, res, url, params));
            } catch (err) {
                sendHandlerError(req, res, url, err);
            }
            return;
        }

        if (req.method === "GET" || req.method === "HEAD") {
            serveStatic(req, req.method === "HEAD" ? headOnly(res) : res, url);
            return;
        }

        sendJson(res, 404, { error: "not_found" });
    }

    return { add, handle, setSseSubscribe: sse.setSseSubscribe, setSeqNow: sse.setSeqNow };
}
