// HTTP 응답 도우미: 압축·ETag, JSON 응답과 본문 읽기, SSE 연결.
import zlib from "node:zlib";

// ── 응답 압축과 ETag 비교. ──

// 텍스트 계열만 압축한다. 이미지/폰트는 이미 압축돼 있어 CPU만 쓴다.
export const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/;
export const MIN_COMPRESS_BYTES = 1024;

// Accept-Encoding에서 쓸 수 있는 가장 좋은 인코딩을 고른다(br은 HTTPS에서만 온다).
export function pickEncoding(req) {
    const accept = String(req?.headers?.["accept-encoding"] || "");
    if (/\bbr\b/.test(accept)) return "br";
    if (/\bgzip\b/.test(accept)) return "gzip";
    return "";
}

export function compress(buffer, encoding) {
    if (encoding === "br") {
        return zlib.brotliCompressSync(buffer, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length },
        });
    }
    return zlib.gzipSync(buffer, { level: 6 });
}

// If-None-Match는 약한 비교로 충분하다(프록시가 W/를 붙여 돌려보내기도 한다).
export function etagMatches(req, etag) {
    const header = String(req?.headers?.["if-none-match"] || "");
    if (!header) return false;
    return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

// ── JSON 응답 보내기와 요청 본문 읽기. ──

// req를 주면 큰 응답(대화 기록 등)을 압축해 보낸다. 느린 회선에서 체감이 크다.
export function sendJson(res, status, body, req = null) {
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

export async function readJsonBody(req, limitBytes = 20 * 1024 * 1024) {
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

// ── SSE(서버 전송 이벤트) 연결. ──

// subscribe(fn) → unsubscribe, seqNow() → 현재 이벤트 번호는 서버가 나중에 주입한다.
export function createSse() {
    let sseSubscribe = null;
    let seqNow = () => 0;

    function openSse(req, res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        req.socket.setKeepAlive(true);
        req.socket.setTimeout(0);
        // 끊긴 연결의 쓰기 오류는 아래 close 처리에서 정리한다.
        res.on("error", () => {
            /* 정리는 close에서 한다 */
        });
        req.on("error", () => {
            /* 정리는 close에서 한다 */
        });
        res.write(`data: ${JSON.stringify({ type: "hello", seq: seqNow() })}\n\n`);
        // 프록시/방화벽 유휴 끊김 방지 + 클라이언트 생존 감지용 데이터 프레임
        const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
        }, 15_000);
        const unsubscribe = sseSubscribe
            ? sseSubscribe((payload) => {
                  if (!res.destroyed) res.write(`data: ${payload}\n\n`);
              })
            : () => {
                  /* 구독할 이벤트 버스가 없으면 해제할 것도 없다 */
              };
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

    return {
        openSse,
        setSseSubscribe(fn) {
            sseSubscribe = fn;
        },
        setSeqNow(fn) {
            seqNow = typeof fn === "function" ? fn : () => 0;
        },
    };
}
