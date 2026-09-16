// 의존성 없는 최소 WebSocket(RFC 6455) 서버.
// 컴퓨터 화면 스트림/PTY 터미널 같은 양방향 채널을 http 서버의 upgrade로 제공한다.
import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function acceptKey(key) {
    return crypto
        .createHash("sha1")
        .update(String(key) + WS_GUID)
        .digest("base64");
}

// 클라이언트 프레임은 반드시 마스크된다. 조각난 메시지는 버퍼에 합쳐 완성 시 emit한다.
class WsConn {
    constructor(req, socket) {
        this.req = req;
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.frags = null; // { opcode, parts: Buffer[], size }
        this.handlers = new Map(); // event → Set<fn>
        this.closed = false;

        socket.on("data", (chunk) => this.#feed(chunk));
        socket.on("error", () => this.#teardown());
        socket.on("close", () => this.#teardown());
        socket.on("end", () => this.#teardown());
        // 프록시(Cloudflare 터널 등)는 유휴 연결을 ~100초에 끊는다.
        // ping으로 트래픽을 유지하고 죽은 소켓도 조기에 정리한다.
        this.pingTimer = setInterval(() => this.#ping(), 25000);
        this.pingTimer.unref?.();
    }

    #ping() {
        if (this.closed) return;
        this.#sendFrame(0x9, Buffer.alloc(0));
    }

    on(event, fn) {
        // 이벤트당 여러 리스너를 허용한다 — 나중에 등록한 핸들러가
        // 앞의 것을 덮어쓰지 않게 Set으로 모은다.
        let set = this.handlers.get(event);
        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }
        set.add(fn);
        return this;
    }

    #emit(event, ...args) {
        const set = this.handlers.get(event);
        if (!set) return;
        for (const fn of set) {
            try {
                fn(...args);
            } catch {}
        }
    }

    #feed(chunk) {
        if (this.closed) return;
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (;;) {
            const b = this.buf;
            if (b.length < 2) return;
            const fin = (b[0] & 0x80) !== 0;
            const opcode = b[0] & 0x0f;
            const masked = (b[1] & 0x80) !== 0;
            let len = b[1] & 0x7f;
            let off = 2;
            if (len === 126) {
                if (b.length < off + 2) return;
                len = b.readUInt16BE(off);
                off += 2;
            } else if (len === 127) {
                if (b.length < off + 8) return;
                len = Number(b.readBigUInt64BE(off));
                off += 8;
            }
            if (len > MAX_MESSAGE_BYTES) return this.close(1009);
            const maskOff = off;
            if (masked) off += 4;
            if (b.length < off + len) return;
            let payload = b.subarray(off, off + len);
            if (masked) {
                const key = b.subarray(maskOff, maskOff + 4);
                const unmasked = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ key[i & 3];
                payload = unmasked;
            } else {
                payload = Buffer.from(payload);
            }
            this.buf = b.subarray(off + len);

            if (opcode === 0x8) {
                this.close();
                return;
            }
            if (opcode === 0x9) {
                this.#sendFrame(0xa, payload);
                continue;
            }
            if (opcode === 0xa) continue;
            if (opcode === 0x0 && !this.frags) return this.close(1002);
            if ((opcode === 0x1 || opcode === 0x2) && this.frags) return this.close(1002);

            if (fin && opcode !== 0x0) {
                this.#emit("message", opcode === 0x1 ? payload.toString("utf8") : payload, opcode === 0x2);
                continue;
            }
            if (!this.frags) this.frags = { opcode, parts: [], size: 0 };
            this.frags.parts.push(payload);
            this.frags.size += payload.length;
            if (this.frags.size > MAX_MESSAGE_BYTES) return this.close(1009);
            if (fin) {
                const full = Buffer.concat(this.frags.parts);
                const op = this.frags.opcode;
                this.frags = null;
                this.#emit("message", op === 0x1 ? full.toString("utf8") : full, op === 0x2);
            }
        }
    }

    #sendFrame(opcode, payload) {
        if (this.closed || this.socket.destroyed) return;
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.from([0x80 | opcode, len]);
        } else if (len < 65536) {
            header = Buffer.allocUnsafe(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.allocUnsafe(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        try {
            this.socket.write(Buffer.concat([header, payload]));
        } catch {
            this.#teardown();
        }
    }

    send(data) {
        if (typeof data === "string") this.#sendFrame(0x1, Buffer.from(data, "utf8"));
        else if (data) this.#sendFrame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }

    sendJson(obj) {
        try {
            this.send(JSON.stringify(obj));
        } catch {}
    }

    close(code = 1000) {
        if (this.closed) return;
        const payload = Buffer.allocUnsafe(2);
        payload.writeUInt16BE(code, 0);
        this.#sendFrame(0x8, payload);
        this.#teardown();
    }

    #teardown() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.pingTimer);
        try {
            this.socket.destroy();
        } catch {}
        this.#emit("close");
    }
}

function authorized(url, req, token) {
    if (!token) return true;
    const header = req.headers.authorization || "";
    if (header === `Bearer ${token}`) return true;
    if (req.headers["x-tabybot-token"] === token) return true;
    return url.searchParams.get("token") === token;
}

// 경로 접두사 → 핸들러(conn, req, url). 매칭 안 되면 소켓을 닫는다.
export function createWsServer({ token = "" } = {}) {
    const routes = [];

    function add(pathPrefix, handler) {
        routes.push({ pathPrefix, handler });
    }

    function handleUpgrade(req, socket, head) {
        const url = new URL(req.url || "/", "http://localhost");
        const hit = routes.find((r) => url.pathname.startsWith(r.pathPrefix));
        if (!hit || !authorized(url, req, token)) {
            socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        const key = req.headers["sec-websocket-key"];
        if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") {
            socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        socket.setNoDelay(true);
        socket.setTimeout(0);
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
        const conn = new WsConn(req, socket);
        // 업그레이드 헤더 뒤에 딸려 온 바이트(head)는 스트림 앞으로 되돌려 data 이벤트로 파싱한다.
        if (head && head.length) socket.unshift(head);
        hit.handler(conn, req, url);
    }

    return { add, handleUpgrade };
}
