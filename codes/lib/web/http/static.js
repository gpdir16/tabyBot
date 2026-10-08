// 정적 클라이언트 서빙: 메모리 캐시, 버전이 붙은 영구 캐시, index.html 에셋 URL 재작성, SPA 폴백.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { COMPRESSIBLE, MIN_COMPRESS_BYTES, compress, etagMatches, pickEncoding } from "./response.js";
import { sendJson } from "./response.js";

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

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// index.html의 에셋 참조를 `/assets/...?v=<버전>` 절대 경로로 바꿔 내보낸다.
// - 버전이 붙은 URL은 영구 캐시(immutable)라 재방문 시 네트워크를 타지 않는다.
// - 절대 경로라 /a/<uuid>, /s/<탭> 어디서 열어도 같은 캐시 항목을 쓴다.
// 파일이 바뀌면 버전이 바뀌므로 배포는 다음 로드에 바로 반영된다.
const ASSET_REF = /\b(src|href)="\/?(assets\/[^"?#]+)"/g;

// 앱 스크립트·스타일은 개발 편의상 파일을 잘게 나눠 두었다. 서버로 내보낼 때는 index.html에서 연달아 이어진
// 태그를 번들 하나로 묶어 요청 수를 줄인다(느린 회선에서 체감이 크다). file://로 직접 열면 원래 태그를 그대로 쓴다.
// TABYBOT_NO_BUNDLE=1이면 묶지 않는다(디버깅).
const BUNDLES = [
    {
        path: "assets/bundle.js",
        run: /(?:[ \t]*<script src="assets\/js\/[^"]+"><\/script>\n)+/,
        item: /<script src="(assets\/js\/[^"]+)"><\/script>/g,
        tag: (href) => `        <script src="${href}"></script>\n`,
    },
];
const BUNDLING_ENABLED = process.env.TABYBOT_NO_BUNDLE !== "1";

// HEAD 요청에는 본문을 쓰지 않는다.
export function headOnly(res) {
    const realEnd = res.end.bind(res);
    res.write = () => true;
    res.end = (a, b, c) => {
        const cb = [a, b, c].find((x) => typeof x === "function");
        return realEnd(cb);
    };
    return res;
}

export function createStaticServer({ publicDir }) {
    // 정적 파일 메모리 캐시: 파일이 바뀌면(mtime/size) 다시 읽는다.
    // 셸 전체가 1MB 남짓이라 본문과 압축본을 통째로 들고 있어도 부담이 없다.
    const staticCache = new Map();
    let indexCache = null;
    const bundleFiles = new Map(); // 번들 경로 → 묶인 파일 경로들(index.html 순서)
    const bundleCache = new Map(); // 번들 경로 → { version, body, encoded }

    function loadStatic(filePath, stat) {
        const hit = staticCache.get(filePath);
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
        const body = fs.readFileSync(filePath);
        const entry = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            // 내용 해시: 같은 내용이면 재배포(이미지 재빌드로 mtime만 바뀜) 후에도 캐시가 유지된다.
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

    // index.html에서 연달아 이어진 앱 스크립트/스타일 태그를 번들 참조 하나로 바꾼다.
    function extractBundles(html) {
        let out = html;
        bundleFiles.clear();
        if (!BUNDLING_ENABLED) return out;
        for (const bundle of BUNDLES) {
            const run = bundle.run.exec(out);
            if (!run) continue;
            bundleFiles.set(
                bundle.path,
                [...run[0].matchAll(bundle.item)].map((m) => m[1]),
            );
            out = out.replace(run[0], bundle.tag(bundle.path));
        }
        return out;
    }

    // 번들에 묶인 파일들의 내용 해시를 합쳐 번들 버전으로 쓴다. 파일 하나만 바뀌어도 버전이 바뀐다.
    function bundleVersion(bundlePath) {
        let signature = "";
        for (const rel of bundleFiles.get(bundlePath) || []) {
            const assetPath = path.join(publicDir, rel);
            signature += `${loadStatic(assetPath, fs.statSync(assetPath)).version}|`;
        }
        return crypto.createHash("sha1").update(signature).digest("hex").slice(0, 12);
    }

    function buildBundle(bundlePath, version) {
        const hit = bundleCache.get(bundlePath);
        if (hit?.version === version) return hit;
        const parts = [];
        for (const rel of bundleFiles.get(bundlePath) || []) {
            const assetPath = path.join(publicDir, rel);
            parts.push(loadStatic(assetPath, fs.statSync(assetPath)).body.toString("utf8"));
        }
        // 파일 끝에 줄바꿈이 없어도 다음 파일의 첫 줄과 붙지 않게 줄바꿈으로 잇는다.
        const entry = { version, body: Buffer.from(`${parts.join("\n")}\n`, "utf8"), encoded: new Map() };
        bundleCache.set(bundlePath, entry);
        return entry;
    }

    function buildIndex() {
        const indexPath = path.join(publicDir, "index.html");
        const stat = fs.statSync(indexPath);
        const source = loadStatic(indexPath, stat);
        const sourceHtml = extractBundles(source.body.toString("utf8"));
        const versions = new Map();
        for (const bundlePath of bundleFiles.keys()) versions.set(bundlePath, bundleVersion(bundlePath));
        let signature = source.version;
        for (const [bundlePath, version] of versions) signature += `|${bundlePath}:${version}`;
        for (const match of sourceHtml.matchAll(ASSET_REF)) {
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
        const html = sourceHtml.replace(ASSET_REF, (_, attr, rel) => `${attr}="/${rel}${versions.get(rel) ? `?v=${versions.get(rel)}` : ""}"`);
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

    function serveBundle(req, res, url, bundlePath) {
        buildIndex(); // 번들 구성은 index.html에서 읽는다
        if (!bundleFiles.has(bundlePath)) {
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        const entry = buildBundle(bundlePath, bundleVersion(bundlePath));
        // 요청한 버전이 지금 번들과 같을 때만 영구 캐시를 허용한다.
        const versioned = url.searchParams.get("v") === entry.version;
        sendBuffer(req, res, {
            body: entry.body,
            encoded: entry.encoded,
            etag: `"${entry.version}"`,
            type: MIME[path.extname(bundlePath)],
            cacheControl: versioned ? IMMUTABLE_CACHE : "no-cache",
        });
    }

    return function serveStatic(req, res, url) {
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
        if (BUNDLING_ENABLED && BUNDLES.some((bundle) => bundle.path === rel)) {
            serveBundle(req, res, url, rel);
            return;
        }
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
        // 요청한 버전이 지금 파일과 같을 때만 영구 캐시를 허용한다. 배포 도중의
        // 옛 버전 URL이 새 내용을 영구 캐시에 박아 넣는 일을 막는다.
        const versioned = url.searchParams.get("v") === entry.version;
        sendBuffer(req, res, {
            body: entry.body,
            encoded: entry.encoded,
            etag: `"${entry.version}"`,
            type: MIME[ext] || "application/octet-stream",
            cacheControl: versioned ? IMMUTABLE_CACHE : "no-cache",
        });
    };
}
