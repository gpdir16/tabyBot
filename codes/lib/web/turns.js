// 턴 오케스트레이션: 사용자 메시지 1건을 에이전트 턴으로 실행하고 SSE 이벤트로 방송한다.
import { runAgent } from "../agent/loop.js";
import { appendChatTurn, appendPendingUserTurn } from "../agent/chat-history.js";
import { beginAgentSession, endAgentSession, enqueueAgentMessage, isAgentSessionRunning, requestAgentStop } from "../agent/session.js";
import { cancelQueuedAgentWork, scheduleWork } from "../agent-queue.js";
import { loadUserConfig } from "../config-loader.js";
import { setCronJobHandler as registerCronJobHandler } from "../cron/scheduler.js";
import { formatAgentError, t } from "../i18n.js";
import { emit } from "./bus.js";
import { ensureTitleFromMessage, getConversationMeta } from "./conversations.js";
import { firstAgentId } from "../agents-store.js";

function isStoppedByUser(result) {
    return result?.error === "stopped_by_user";
}

function isReplyFailure(result) {
    return (result?.error === "tool_rounds_exceeded" || result?.error === "empty_reply_exhausted") && !result.text?.trim();
}

function isSilentReply(result) {
    return Boolean(result?.silent) && !result?.text?.trim();
}

function saveChatTurn(sessionKey, result, attachments = [], displayText = null) {
    if (!result?.turnMessages?.length) return;
    try {
        const messages = result.turnMessages.map((message) => ({ ...message }));
        const userMessage = messages.find((message) => message?.role === "user");
        if (userMessage) {
            if (Array.isArray(userMessage.content)) {
                const textPart = userMessage.content.find((part) => part?.type === "text");
                userMessage.content = displayText != null ? displayText : textPart?.text || "";
            } else if (displayText != null) {
                userMessage.content = displayText;
            }
        }
        appendChatTurn(sessionKey, messages, { stats: result.stats, attachments });
    } catch (err) {
        console.error("Chat history save failed:", err?.stack || err);
    }
}

export async function runTurn({ sessionKey, agentId, userText, displayText = null, attachments = [] }) {
    const lang = loadUserConfig().language || "en";
    const session = beginAgentSession(sessionKey);
    const startedAt = Date.now();
    let lastPhase = null;

    const status = (phase, detail = null) => {
        // 같은 phase 연속 방출은 클라이언트 상태 깜빡임만 유발하므로 스킵
        if (phase === lastPhase && !detail) return;
        lastPhase = phase;
        emit({ type: "status", conversationId: sessionKey, phase, detail });
    };

    try {
        status("generating");
        const result = await runAgent(userText, {
            chatId: sessionKey,
            sessionKey,
            agentId,
            session,
            attachments,
            onStatusPhase: (phase, detail) => status(phase, detail),
            onTextDelta: (text, full) => emit({ type: "delta", conversationId: sessionKey, text, full }),
        });

        // 실행 중 대화가 삭제되었으면 디스크에 되살리지 않는다.
        if (getConversationMeta(sessionKey)) {
            saveChatTurn(sessionKey, result, attachments, displayText);
            ensureTitleFromMessage(sessionKey, displayText || attachments[0]?.name || userText);
        }

        if (isStoppedByUser(result)) {
            emit({
                type: "turn_done",
                conversationId: sessionKey,
                text: result.text?.trim() || t("stopped_by_user", lang),
                stats: result.stats || null,
                error: null,
                stopped: true,
            });
            return result;
        }

        if (result?.error && result.error !== "silent") {
            const detail = result.errorDetail ? formatAgentError(new Error(result.errorDetail), lang) : t(result.error, lang) || result.error;
            emit({
                type: "turn_done",
                conversationId: sessionKey,
                text: null,
                stats: result.stats || null,
                error: { code: result.error, detail },
            });
            return result;
        }

        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: isSilentReply(result) ? null : result.text || "",
            stats: result.stats || null,
            error: null,
            silent: isSilentReply(result),
            elapsedMs: Date.now() - startedAt,
        });
        return result;
    } catch (err) {
        console.error("Agent turn error:", err?.stack || err);
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: { code: "agent_turn_failed", detail: formatAgentError(err, lang) },
        });
        return { error: "agent_turn_failed", text: null };
    } finally {
        endAgentSession(sessionKey);
    }
}

// 실행 중이면 현재 턴에 끼워 넣고(pending), 아니면 새 턴을 예약한다.
export function dispatchMessage({ sessionKey, agentId, userText, displayText = null, attachments = [] }) {
    try {
        appendPendingUserTurn(sessionKey, displayText ?? userText, attachments);
        ensureTitleFromMessage(sessionKey, displayText || attachments[0]?.name || userText);
    } catch (err) {
        console.error("Pending user turn save failed:", err?.stack || err);
    }
    if (isAgentSessionRunning(sessionKey)) {
        const queued = enqueueAgentMessage(sessionKey, userText);
        if (queued) return { queued: true };
    }
    void scheduleWork("user", () => runTurn({ sessionKey, agentId, userText, displayText, attachments }), {
        sessionKey,
        cancellable: true,
    }).catch((err) => {
        console.error("Agent error:", err?.stack || err);
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: { code: "agent_turn_failed", detail: formatAgentError(err, loadUserConfig().language || "en") },
        });
    });
    return { queued: false };
}

export function stopConversation(sessionKey) {
    const stoppedQueued = cancelQueuedAgentWork(sessionKey);
    const stoppedActive = stoppedQueued ? false : requestAgentStop(sessionKey);
    if (stoppedQueued || stoppedActive) {
        emit({
            type: "turn_done",
            conversationId: sessionKey,
            text: null,
            stats: null,
            error: null,
            stopped: true,
        });
    }
    return stoppedActive || stoppedQueued;
}

// 크론 잡 결과는 잡별 대화에 기록되고 알림으로 방송된다.
export function setCronJobHandler() {
    registerCronJobHandler(async (job) => {
        const lang = loadUserConfig().language || "en";
        const conversationId = job.chatId?.startsWith("web-") ? job.chatId : `cron-${job.id}`;
        const header = t("cron_auto_header", lang);
        try {
            const result = await runTurn({
                sessionKey: conversationId,
                agentId: job.agentId || firstAgentId(),
                userText: `${header}\n\n${job.prompt}`,
            });
            if (!result || isSilentReply(result)) return;
            const body = result?.text?.trim() || t("cron_no_output", lang);
            emit({ type: "notice", level: "info", text: `⏰ ${job.name}: ${body.slice(0, 400)}`, conversationId });
            emit({ type: "conversations_changed" });
        } catch (err) {
            console.error("Cron job error:", err?.stack || err);
        }
    });
}
