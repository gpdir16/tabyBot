// 전역 이벤트 버스: 백엔드에서 발생한 모든 실시간 이벤트를 웹 클라이언트(SSE)로 전달한다.
import { maybePush } from "./push.js";

const subscribers = new Set();

export function subscribe(handler) {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
}

export function liveClientCount() {
    return subscribers.size;
}

// 직렬화는 한 번만 수행해 모든 구독자가 동일한 문자열을 받는다.
export function emit(event) {
    const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
    for (const handler of [...subscribers]) {
        try {
            handler(payload);
        } catch {
            // 개별 구독자(SSE 연결) 실패가 다른 구독자에 영향 주지 않도록 무시
        }
    }
    // SSE 수신자가 없으면 웹 푸시로 전달한다(브라우저가 닫혀 있을 때).
    void maybePush(event, { liveClients: subscribers.size });
}
