// 마지막 사용자 메시지 시각. 드리밍·능동 체크인 같은 백그라운드 작업은
// 사용자가 이 시간만큼 유휴일 때만 돈다.
let lastActivityAt = 0;

export const DEFAULT_IDLE_REQUIRED_MS = 30 * 60 * 1000;

export function markUserActivity(at = Date.now()) {
    lastActivityAt = at;
}

export function isUserIdle(requiredMs = DEFAULT_IDLE_REQUIRED_MS) {
    if (!lastActivityAt) return true;
    return Date.now() - lastActivityAt >= requiredMs;
}
