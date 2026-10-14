import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { buildClaudeEnv, invalidateClaudeInfo } from "./claude-agent-client.js";

// Claude 로그인은 SDK에 든 공식 실행 파일의 `claude auth login`이 함. tabyBot은 그 프로세스를
// 띄워 로그인 링크를 화면에 전하고, 사용자가 붙여 넣은 인증 코드 한 줄만 넘김.
// 토큰 교환, 저장은 전부 CLI가 하며 tabyBot은 토큰을 보지 않음.

const require = createRequire(import.meta.url);
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const URL_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CODE_REPLY_MS = 10_000;

// 진행 중인 로그인 프로세스. 한 번에 하나만 둠.
let active = null;

// SDK와 같은 순서로 플랫폼별 실행 파일을 찾음.
function claudeBinary() {
    const { platform, arch } = process;
    const ext = platform === "win32" ? ".exe" : "";
    const musl = platform === "linux" && process.report?.getReport?.().header?.glibcVersionRuntime === undefined;
    const names =
        platform === "linux" ? (musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`]) : [`${platform}-${arch}`];
    for (const name of names) {
        try {
            return require.resolve(`${SDK_PACKAGE}-${name}/claude${ext}`);
        } catch {
            // 이 플랫폼용 패키지가 없으면 다음 후보를 봄.
        }
    }
    throw new Error("Claude CLI binary not found. Reinstall dependencies (npm install).");
}

function lastLine(text) {
    return text.trim().split("\n").filter(Boolean).pop() || "";
}

// 로그인을 시작하고 사용자가 열 링크를 돌려줌. 끝나면 onDone({ ok, detail })을 부름.
export function startClaudeLogin({ onDone, envOverride } = {}) {
    cancelClaudeLogin();
    const child = spawn(claudeBinary(), ["auth", "login"], {
        env: { ...buildClaudeEnv(envOverride), TERM: "dumb", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const login = { child, stderr: "", cancelled: false, onStderr: null };
    active = login;
    const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);

    return new Promise((resolve, reject) => {
        let stdout = "";
        let settled = false;
        const urlTimer = setTimeout(() => fail(new Error("Claude CLI did not print a sign-in link.")), URL_TIMEOUT_MS);
        function fail(err) {
            if (settled) return;
            settled = true;
            clearTimeout(urlTimer);
            login.cancelled = true;
            child.kill();
            reject(err);
        }
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            // 줄이 끝까지 온 뒤에 읽음. 링크가 잘린 채로 나가면 안 됨.
            const url = /visit:\s*(https:\/\/\S+)\s*\n/.exec(stdout)?.[1];
            if (!url || settled) return;
            settled = true;
            clearTimeout(urlTimer);
            resolve({ url });
        });
        child.stderr.on("data", (chunk) => {
            login.stderr = (login.stderr + chunk).slice(-2000);
            login.onStderr?.();
        });
        child.on("error", fail);
        child.on("exit", (code) => {
            clearTimeout(timer);
            if (active === login) active = null;
            login.exitCode = code;
            // 로그인 상태가 바뀌었을 수 있음. 다음 조회는 CLI에서 다시 읽음.
            invalidateClaudeInfo();
            login.onExit?.();
            if (!settled) return fail(new Error(lastLine(login.stderr) || "Claude CLI exited before sign-in started."));
            if (login.cancelled) return;
            onDone?.(code === 0 ? { ok: true } : { ok: false, detail: lastLine(login.stderr) || `claude auth login exited with code ${code}` });
        });
    });
}

// 사용자가 붙여 넣은 인증 코드를 CLI에 넘김. 잘못된 코드면 CLI의 오류 문구로 거절함.
export function submitClaudeLoginCode(code) {
    const login = active;
    // 한 줄만 넘김. 제어 문자는 버림.
    const line = String(code || "")
        .replace(/\p{Cc}/gu, "")
        .trim()
        .slice(0, 4096);
    if (!login) throw new Error("No sign-in in progress. Start again.");
    if (!line) throw new Error("Code is empty.");

    login.stderr = "";
    return new Promise((resolve, reject) => {
        const done = (fn, value) => {
            clearTimeout(timer);
            login.onStderr = null;
            login.onExit = null;
            fn(value);
        };
        // 답이 늦으면 대기 상태로 돌려줌. 결과는 onDone으로 따로 알림.
        const timer = setTimeout(() => done(resolve, { ok: true, pending: true }), CODE_REPLY_MS);
        login.onStderr = () => done(reject, new Error(lastLine(login.stderr)));
        login.onExit = () => done(resolve, { ok: true, pending: false });
        login.child.stdin.write(`${line}\n`);
    });
}

export function cancelClaudeLogin() {
    if (!active) return;
    active.cancelled = true;
    active.child.kill();
    active = null;
}
