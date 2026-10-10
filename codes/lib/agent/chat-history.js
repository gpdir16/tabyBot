// 대화 기록 저장소의 공개 인터페이스. 구현은 history/ 아래 모듈에 나뉘어 있다.
export { conversationDir } from "./history/files.js";
export {
    RECOVERY_PROMPT,
    cloneStoredMessage,
    isInternalStoredMessage,
    isSilentMarkedText,
    sayTextsFromMessage,
    turnToMessages,
    extractTurnMessages,
} from "./history/messages.js";
export { stripMarkdownForPreview, previewSnippetFromTurns, lastActivityAtFromTurns, markChatRead } from "./history/preview.js";
export {
    loadChatHistory,
    loadFullChatHistory,
    compressedSummaryTurn,
    replaceChatHistoryAfterCompression,
    extractSessionTextLines,
    formatPastSessionsForPrompt,
} from "./history/sessions.js";
export {
    appendPendingUserTurn,
    checkpointChatTurn,
    markChatTurnInterrupted,
    hasRecoverableChatTurn,
    prepareChatTurnRecovery,
    lastChatTurnMessages,
    appendChatTurn,
} from "./history/turns.js";
