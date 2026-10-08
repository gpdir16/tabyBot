// LLM 클라이언트가 공유하는 전송 오류 판별·재시도 흐름과 OAuth 로그인 도우미.

// ── LLM 클라이언트가 공유하는 전송 오류 판별과 재시도 흐름. ──

export function isAbortError(err) {
    return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function normalizeErrorText(err) {
    return String(err?.message || err || "")
        .toLowerCase()
        .trim();
}

const TRANSIENT_MARKERS = [
    "premature close",
    "socket hang up",
    "fetch failed",
    "network error",
    "connection reset",
    "connection terminated",
    "econnreset",
    "etimedout",
    "eai_again",
    "und_err_socket",
    "terminated",
];

// 재시도해 볼 만한 일시적 네트워크 오류인가.
export function isTransientTransportError(err) {
    const text = normalizeErrorText(err);
    if (!text) return false;
    return TRANSIENT_MARKERS.some((marker) => text.includes(marker));
}

// 사용자가 중단했을 때 던지는 오류. partialText는 중단 전까지 받은 본문.
export function stoppedError(partialText) {
    const err = new Error("Stopped by user.");
    err.name = "AbortError";
    if (partialText !== undefined) err.partialText = partialText;
    return err;
}

export function throwIfAborted(signal) {
    if (signal?.aborted) throw stoppedError();
}

function wasStopped(signal, err) {
    return Boolean(signal?.aborted || isAbortError(err));
}

// 스트리밍 없이 한 번 요청한다. 중단으로 끊긴 오류는 "사용자 중단" 오류로 바꾼다.
export async function requestOnce(signal, request) {
    try {
        return await request();
    } catch (err) {
        if (wasStopped(signal, err)) throw stoppedError();
        throw err;
    }
}

// 스트리밍 요청을 최대 attempts번 시도한다. 일시적 전송 오류면 다시 시도하고,
// 그래도 안 되면 스트리밍 없이(runFallback) 한 번 더 시도한다.
// runStream(partial)은 받은 본문을 partial.text에 기록해 두면 중단 오류가 그것을 실어 보낸다.
export async function streamWithFallback({ signal, runStream, runFallback, attempts = 2 }) {
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const partial = { text: "" };
        try {
            return await runStream(partial);
        } catch (err) {
            if (wasStopped(signal, err)) throw stoppedError(partial.text);
            lastErr = err;
            if (!isTransientTransportError(err)) throw err;
        }
    }

    try {
        return await runFallback();
    } catch (fallbackErr) {
        if (wasStopped(signal, fallbackErr)) throw stoppedError();
        throw lastErr || fallbackErr;
    }
}

// ── OAuth 로그인 모듈(Codex, Grok, GitHub Copilot)이 같이 쓰는 도우미. ──

// JWT 본문(claims)을 서명 검증 없이 읽는다. 계정 id 같은 표시용 값을 꺼낼 때만 쓴다.
export function parseJwtClaims(token) {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        return null;
    }
}

// 폴링 간격 대기. signal이 중단되면 "Login cancelled."로 거절한다.
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Login cancelled."));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Login cancelled."));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
