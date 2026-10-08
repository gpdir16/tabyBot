// 저장된 메시지의 모양: 내부 메시지 판별, 표식, 침묵 마커, 말하기 호출 추출, 턴 변환.
import { EMPTY_REPLY_HINT, QUIET_EMPTY_HINT, STOP_BY_USER_HINT } from "../session.js";

// ── 저장된 메시지의 모양: 내부 메시지 판별, 침묵 마커, 말하기 호출 추출, 턴 변환. ──

export const RECOVERY_PROMPT =
    "Internal continuation instruction: continue the same task naturally from the current conversation state. Treat the existing messages and tool results as completed work, do not restart completed work, and inspect the current state before retrying an incomplete tool. Do not mention this continuation or any internal recovery to the user.";

const INTERNAL_USER_HINTS = new Set([
    "You have enough tool output. Stop calling tools. Reply to the user in plain text now using results you already have.",
    STOP_BY_USER_HINT,
    EMPTY_REPLY_HINT,
    QUIET_EMPTY_HINT,
    RECOVERY_PROMPT,
]);

export const RECOVERABLE_TURN_STATUSES = new Set(["pending", "in_progress", "interrupted"]);

// 새 턴 체크포인트가 거슬러 합쳐도 되는 상태: interrupted는 복구 실행에서만 합친다.
export const PENDING_MERGE_STATUSES = new Set(["pending", "in_progress"]);

export function cloneStoredMessage(message) {
    return JSON.parse(JSON.stringify(message));
}

export function isInternalStoredMessage(message) {
    return message?.role === "user" && INTERNAL_USER_HINTS.has(message.content);
}

// 모델에게만 가는 내부 지시문인가(화면에는 보이지 않는다).
export function isInternalHintText(text) {
    return INTERNAL_USER_HINTS.has(text);
}

// 모델이 __SILENT__ 마커를 메시지 앞/뒤에 붙인 경우도 침묵 의사로 인정한다.
// 정확히 일치하지 않아서 잡담이 사용자에게 배달되는 것을 막는다.
export function isSilentMarkedText(text) {
    const t = typeof text === "string" ? text.trim() : "";
    return t.startsWith("__SILENT__") || t.endsWith("__SILENT__");
}

// 툴 호출 메시지의 user_say 호출에서 사용자용 발화 텍스트만 추출한다.
// 같은 메시지에 붙은 본문 텍스트는 내부 메모이므로 사용자에게 보이지 않는다.
export function sayTextsFromMessage(message) {
    const out = [];
    for (const tc of message?.tool_calls || []) {
        if (tc?.function?.name !== "user_say") continue;
        try {
            const text = String(JSON.parse(tc.function.arguments || "{}")?.text || "").trim();
            if (text) out.push(text);
        } catch {
            // 인자 JSON이 깨진 호출은 건너뛴다.
        }
    }
    return out;
}

export function turnToMessages(turn) {
    return Array.isArray(turn?.messages) ? turn.messages : [];
}

export function extractTurnMessages(messages, fromIndex) {
    return messages
        .slice(fromIndex)
        .filter((m) => !isInternalStoredMessage(m))
        .map((m) => {
            // 첫 추출 시각을 발화 시각으로 쓴다. 원본에 남겨 다음 체크포인트에서도 유지한다.
            if (typeof m.at !== "string" || !m.at) m.at = new Date().toISOString();
            return cloneStoredMessage(m);
        });
}

export function sanitizeTurnStats(stats) {
    if (!stats || typeof stats !== "object") return null;
    const toolCallCount = Number(stats.toolCallCount);
    const modelCallCount = Number(stats.modelCallCount);
    const tokensUsed = Number(stats.tokensUsed);
    const contextWindow = Number(stats.contextWindow);
    if (![toolCallCount, modelCallCount, tokensUsed, contextWindow].some((n) => Number.isFinite(n) && n > 0)) return null;
    return {
        toolCallCount: Number.isFinite(toolCallCount) ? toolCallCount : 0,
        modelCallCount: Number.isFinite(modelCallCount) ? modelCallCount : 0,
        tokensUsed: Number.isFinite(tokensUsed) ? tokensUsed : 0,
        contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
    };
}

// ── 저장된 메시지에 섞여 들어가는 내부 표식과 화면·미리보기용 정리. ──

// 예전 버전이 첨부 안내를 사용자 메시지 뒤에 덧붙이던 표식. 옛 기록을 읽을 때만 쓴다.
export const ATTACHED_FILES_MARK = "[User attached files]";

// 예약·능동 실행이 시작할 때 붙이는 표식. 사용자가 보낸 말이 아님을 뜻한다.
export const SCHEDULED_TURN_MARKER = "[tabybot-scheduled]";

// 작업 중에 사용자가 추가로 보낸 메시지를 합쳐 넣을 때의 머리말.
export const PENDING_USER_PREFIX = "The user sent additional message(s) while you were working:";

// 첨부 안내가 덧붙은 사용자 메시지에서 사람이 쓴 본문만 남긴다.
export function stripAttachedFiles(content) {
    const s = String(content || "");
    const i = s.indexOf(ATTACHED_FILES_MARK);
    return i === -1 ? s : s.slice(0, i).trim();
}

export function isScheduledTurnText(text) {
    return typeof text === "string" && text.includes(SCHEDULED_TURN_MARKER);
}
