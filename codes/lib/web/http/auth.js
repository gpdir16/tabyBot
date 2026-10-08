// 선택적 세션 인증.
// auth: { enabled() → 세션 요구 여부, verify(token) → 세션 유효 여부,
//         publicPaths[] → 인증 없이 열어둘 /api 경로(로그인 등) }

// 세션 토큰은 Authorization Bearer, x-tabybot-token 헤더, ?token= 쿼리 순으로 찾는다.
export function presentedToken(url, req) {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) return header.slice(7).trim();
    const alt = req.headers["x-tabybot-token"];
    if (alt) return String(alt);
    return url.searchParams.get("token") || "";
}

export function createAuthGate(auth = {}) {
    const authEnabled = typeof auth.enabled === "function" ? auth.enabled : () => false;
    const verifyToken = typeof auth.verify === "function" ? auth.verify : () => false;
    const publicApi = new Set(Array.isArray(auth.publicPaths) ? auth.publicPaths : []);

    return function authorized(url, req) {
        // PWA 셸(SW/매니페스트/아이콘)은 브라우저가 헤더를 못 실으므로 공개한다.
        if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/assets/icons/")) {
            return true;
        }
        if (!authEnabled()) return true;
        // 인증 모드에서도 정적 셸(HTML/JS/CSS)은 공개한다. 로그인 화면 자체가
        // 이 파일들로 로드된다. 데이터와 액션은 전부 /api/ 아래라 계속 보호된다.
        if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
            return true;
        }
        if (publicApi.has(url.pathname)) return true;
        const presented = presentedToken(url, req);
        return presented ? verifyToken(presented) : false;
    };
}
