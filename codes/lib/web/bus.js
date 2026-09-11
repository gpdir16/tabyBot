// 전역 이벤트 버스: 백엔드에서 발생한 모든 실시간 이벤트를 웹 클라이언트(SSE)로 전달한다.
import { maybePush } from "./push.js";

const subscribers = new Set();
const eventLog = [];
let nextEventSeq = 1;
const MAX_EVENT_LOG = 2000;

export function subscribe(handler) {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
}

export function eventsSince(since = 0) {
    const cursor = Number.isFinite(Number(since)) ? Number(since) : 0;
    return {
        events: eventLog.filter((event) => event.seq > cursor),
        cursor: nextEventSeq - 1,
    };
}

// 직렬화는 한 번만 수행해 모든 구독자가 동일한 문자열을 받는다.
export function emit(event) {
    const item = { ...event, at: new Date().toISOString(), seq: nextEventSeq++ };
    eventLog.push(item);
    if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
    const payload = JSON.stringify(item);
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
