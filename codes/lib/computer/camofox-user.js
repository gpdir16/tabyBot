// 봇 id → camofox 프로필 유저명. 웹 컴퓨터 뷰, 에이전트의 terminal_run,
// 웹 터미널(PTY)이 모두 이 매핑을 공유해야 같은 브라우저 프로필을 본다.
// camofox CLI는 CAMOFOX_CLI_USER 환경변수를 --user 생략 시 기본값으로 쓴다.
export function camofoxUser(agentOrId) {
    const raw = (typeof agentOrId === "object" ? agentOrId?.id : agentOrId) || "tabybot";
    const safe = String(raw)
        .replace(/[^A-Za-z0-9_-]/g, "-")
        .slice(0, 48);
    return safe || "tabybot";
}

// camofox 서버는 CLI가 필요할 때 자동으로 띄우고 그 환경을 그대로 물려받는다.
// 기본 세션/유휴 타임아웃이 30분이라 화면 조작(xdotool)처럼 API를 안 타는
// 사용 중에도 브라우저가 죽는다 — 봇 세션은 봇 삭제 전까지 만료되면 안 되므로
// 사실상 무기한(100년) 값을 심어 둔다.
const CAMOFOX_NO_EXPIRY_MS = "3153600000000"; // 100년 — 타임아웃은 Date.now() 비교식이라 오버플로 없음
export function camofoxEnv(env) {
    return {
        ...env,
        CAMOFOX_IDLE_TIMEOUT_MS: env.CAMOFOX_IDLE_TIMEOUT_MS || CAMOFOX_NO_EXPIRY_MS,
        CAMOFOX_IDLE_EXIT_TIMEOUT_MS: env.CAMOFOX_IDLE_EXIT_TIMEOUT_MS || CAMOFOX_NO_EXPIRY_MS,
        CAMOFOX_SESSION_TIMEOUT: env.CAMOFOX_SESSION_TIMEOUT || CAMOFOX_NO_EXPIRY_MS,
    };
}
