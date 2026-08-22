import { Bot } from "grammy";
import { loadUserConfig, loadAgentConfig } from "./config-loader.js";
import { requireApprovedAccess, runOwnerApprove } from "./auth-access.js";
import { runAgent } from "./agent/loop.js";
import { appendChatTurn } from "./agent/chat-history.js";
import { handleNewChat } from "./agent/new-chat.js";
import { TelegramDraftStream } from "./telegram-draft.js";
import { TelegramStatusMessage } from "./telegram-status.js";
import { isConfigReady, isWizardActive, openConfigWizard, handleConfigWizardText, handleConfigWizardCallback } from "./onboarding.js";
import { isAgentsWizardActive, openAgentsWizard, handleAgentsWizardText, handleAgentsWizardCallback } from "./agents-wizard.js";
import { sendTelegramReply } from "./telegram-stats.js";
import { t, formatAgentError } from "./i18n.js";
import { cancelQueuedAgentWork, scheduleWork } from "./agent-queue.js";
import { hasPendingAsk, resolvePendingAskByButton, resolvePendingAskByText } from "./agent/user-ask.js";
import { beginAgentSession, endAgentSession, enqueueAgentMessage, isAgentSessionRunning, requestAgentStop } from "./agent/session.js";
import { saveIncomingTelegramFile, formatFileUserMessage } from "./telegram-downloads.js";
import { isVisionImageAttachment } from "./llm/vision.js";
import { ensureModelMeta } from "./llm/model-meta.js";
import { getMergedProvider } from "./config-loader.js";
import { setCronJobHandler, startCronScheduler } from "./cron/scheduler.js";
import { startUpdateScheduler } from "./update/scheduler.js";
import { sendChatActionSafe, safeTelegramApi, sendMessageSafe } from "./telegram-api.js";
import { memoryFilePath } from "./path-labels.js";
import { routeFromCtx, telegramThreadOpts } from "./agent-route.js";
import { refreshTopicsEnabled, getTopicsEnabled, ensureMainTopic } from "./telegram-topics.js";
import { getOwnerChatId } from "./auth.js";

function isReplyFailure(result) {
    return (result?.error === "tool_rounds_exceeded" || result?.error === "empty_reply_exhausted") && !result.text?.trim();
}

function isStoppedByUser(result) {
    return result?.error === "stopped_by_user";
}

function isAgentError(result) {
    return result?.error === "agent_error" || result?.error === "agent_turn_failed";
}

function isSilentReply(result) {
    return Boolean(result?.silent) && !result?.text?.trim();
}

function replyFailureMessage(result, lang) {
    if (result?.error === "empty_reply_exhausted") return t("empty_reply_exhausted", lang);
    return t("tool_rounds_exceeded", lang);
}

async function notifyUserError(status, ctx, bot, route, text) {
    const extra = telegramThreadOpts(route.threadId);
    const shown = await status.completeError(text);
    if (!shown) {
        if (ctx) {
            await sendMessageSafe(ctx.api, route.chatId, text, extra);
        } else {
            await sendTelegramReply(bot, route.chatId, text, null, extra);
        }
    }
}

async function streamReplyEditFallback(bot, route, fullText, stats) {
    await sendTelegramReply(bot, route.chatId, (fullText || "").trim() || "…", stats, telegramThreadOpts(route.threadId));
}

async function replyWithStreaming(bot, ctx, route, userText, status, { visionAttachment = null, session = null } = {}) {
    const agentConfig = loadAgentConfig();
    const rawMode = agentConfig.telegramStreaming ?? "draft";
    const mode = rawMode === "off" || rawMode === "draft" ? rawMode : "off";
    if (rawMode !== mode) {
        console.warn(`tabyAgent: unknown telegramStreaming "${rawMode}", using "off"`);
    }
    const extra = telegramThreadOpts(route.threadId);
    const agentOpts = {
        chatId: route.chatId,
        sessionKey: route.sessionKey,
        threadId: route.threadId,
        agentId: route.agentId,
        bot,
        session,
        onStatusPhase: (phase, detail) => status.setPhase(phase, detail),
    };

    if (mode === "off") {
        const result = await runAgent(userText, { ...agentOpts, visionAttachment });
        if (isStoppedByUser(result)) return result;
        if (isAgentError(result)) return result;
        await status.completeSuccess();
        if (!isSilentReply(result)) {
            await sendTelegramReply(bot, route.chatId, result.text, result.stats, extra);
        }
        saveChatTurn(route.sessionKey, result);
        return result;
    }

    if (mode === "draft") {
        const draftId = ctx.update.update_id;
        const draft = new TelegramDraftStream(bot, route.chatId, draftId, extra);

        const result = await runAgent(userText, {
            ...agentOpts,
            visionAttachment,
            onTextDelta: (_delta, full) => {
                void draft.update(full);
            },
        });

        const finalText = result.text || draft.getLastText() || "…";

        if (isStoppedByUser(result)) {
            if (!result.text?.trim() && draft.getLastText()) {
                result.text = draft.getLastText();
            }
            return result;
        }

        if (isReplyFailure(result) || isAgentError(result)) {
            return result;
        }

        await status.completeSuccess();

        if (isSilentReply(result)) {
            saveChatTurn(route.sessionKey, result);
            return result;
        }

        if (draft.isAvailable() && draft.getLastText()) {
            await draft.update(finalText);
            const sent = await draft.finalize(result.stats);
            if (sent) {
                saveChatTurn(route.sessionKey, result);
                return result;
            }
        }

        await streamReplyEditFallback(bot, route, finalText, result.stats);
        saveChatTurn(route.sessionKey, result);
        return result;
    }

    const result = await runAgent(userText, { ...agentOpts, visionAttachment });
    if (isStoppedByUser(result) || isAgentError(result)) return result;
    if (!isReplyFailure(result)) {
        await status.completeSuccess();
        if (!isSilentReply(result)) {
            await streamReplyEditFallback(bot, route, result.text || "…", result.stats);
        }
    }
    saveChatTurn(route.sessionKey, result);
    return result;
}

function saveChatTurn(sessionKey, result) {
    if (result?.turnMessages?.length) {
        try {
            appendChatTurn(sessionKey, result.turnMessages);
        } catch (err) {
            console.error("Chat history save failed:", err?.stack || err);
        }
    }
}

async function runCronJobForUser(bot, job) {
    try {
        const lang = loadUserConfig().language || "en";
        const header = t("cron_auto_header", lang);
        const userText = `${header}\n\n${job.prompt}`;
        const result = await runAgent(userText, { chatId: job.chatId, bot });
        saveChatTurn(job.chatId, result);
        if (isSilentReply(result)) return;
        const body = result.text?.trim() || t("cron_no_output", lang);
        await sendTelegramReply(bot, job.chatId, `${header}\n\n${body}`, result.stats);
    } catch (err) {
        console.error("Cron job error:", err?.stack || err);
    }
}

async function handleAgentTurn(bot, ctx, route, userText, { visionAttachment = null } = {}) {
    const lang = loadUserConfig().language || "en";
    if (getTopicsEnabled() === true) {
        await refreshTopicsEnabled(bot);
    }
    await ensureMainTopic(bot, route.chatId);
    const extra = telegramThreadOpts(route.threadId);
    const status = new TelegramStatusMessage(bot, route.chatId, lang, extra);
    const session = beginAgentSession(route.sessionKey);

    try {
        await status.start();
        await sendChatActionSafe(bot, route.chatId, "typing", extra);

        const result = await replyWithStreaming(bot, ctx, route, userText, status, { visionAttachment, session });

        if (isAgentError(result)) {
            const msg = result.errorDetail ? formatAgentError(new Error(result.errorDetail), lang) : t("tool_rounds_exceeded", lang);
            await notifyUserError(status, ctx, bot, route, msg);
            return result;
        }

        if (isStoppedByUser(result)) {
            await status.completeSuccess();
            const body = result.text?.trim() || t("stopped_by_user", lang);
            await sendTelegramReply(bot, route.chatId, body, result.stats, extra);
            saveChatTurn(route.sessionKey, result);
            return result;
        }

        if (isReplyFailure(result)) {
            await notifyUserError(status, ctx, bot, route, replyFailureMessage(result, lang));
        }

        return result;
    } catch (err) {
        console.error("Agent turn error:", err?.stack || err);
        await notifyUserError(status, ctx, bot, route, formatAgentError(err, lang));
        return { error: "agent_turn_failed", text: null };
    } finally {
        status.dispose();
        endAgentSession(route.sessionKey);
    }
}

function tryEnqueueDuringRun(sessionKey, text) {
    return enqueueAgentMessage(sessionKey, text);
}

function dispatchAgentWork(ctx, route, workFn) {
    const lang = loadUserConfig().language || "en";
    void scheduleWork("user", workFn, { chatId: route.chatId, sessionKey: route.sessionKey, cancellable: true }).catch((err) => {
        console.error("Agent error:", err?.stack || err);
        void sendMessageSafe(ctx.api, route.chatId, formatAgentError(err, lang), telegramThreadOpts(route.threadId));
    });
}

function dispatchAgentTurn(bot, ctx, route, userText, { visionAttachment = null } = {}) {
    dispatchAgentWork(ctx, route, () => handleAgentTurn(bot, ctx, route, userText, { visionAttachment }));
}

async function registerBotCommands(bot) {
    const lang = loadUserConfig().language || "en";

    const commandsByLang = {
        en: [
            { command: "start", description: "Begin / show help" },
            { command: "new", description: "Start a new chat (self-improves in background)" },
            { command: "stop", description: "Stop the running task" },
            { command: "config", description: "Open settings" },
            { command: "agents", description: "Manage extra agents" },
            { command: "approve", description: "Approve a new device with a 6-digit code" },
            { command: "help", description: "Show help and available commands" },
        ],
        ko: [
            { command: "start", description: "시작 / 도움말" },
            { command: "new", description: "새 대화 시작 (백그라운드 자기개선)" },
            { command: "stop", description: "진행 중인 작업 중지" },
            { command: "config", description: "설정 열기" },
            { command: "agents", description: "에이전트 관리" },
            { command: "approve", description: "6자리 코드로 새 기기 승인" },
            { command: "help", description: "도움말 및 명령어 보기" },
        ],
        ja: [
            { command: "start", description: "開始 / ヘルプ" },
            { command: "new", description: "新しい会話を開始 (バックグラウンド自己改善)" },
            { command: "stop", description: "実行中の作業を停止" },
            { command: "config", description: "設定を開く" },
            { command: "agents", description: "エージェント管理" },
            { command: "approve", description: "6 桁コードで新端末を承認" },
            { command: "help", description: "ヘルプとコマンド一覧" },
        ],
    };

    const list = commandsByLang[lang] || commandsByLang.en;
    const res = await safeTelegramApi(() => bot.api.setMyCommands(list));
    if (!res.ok) {
        console.warn("setMyCommands failed:", res.error);
    }
    return res.ok;
}

function helpMessage(lang) {
    const memoryPath = memoryFilePath();
    if (lang === "ko") {
        return [
            "# tabyAgent 도움말",
            "",
            "## 명령어",
            "- `/new` — 새 대화 시작 (백그라운드에서 이전 대화 자기개선)",
            "- `/stop` — 진행 중인 작업 중지",
            "- `/config` — 설정 (언어, 모델, 사고 수준, 푸터, 업데이트 등)",
            "- `/agents` — 에이전트 관리",
            "- `/approve <6-digit code>` — 새 기기 승인",
            "",
            "## 기능",
            "- 파일 첨부: 사진·문서·음성·영상 전송 가능",
            "- 비전: 지원 모델에서 이미지 분석",
            "- 마크다운: 굵게, 기울임, 코드, 표, 인용, 스포일러 지원",
            `- 메모리: ${memoryPath} 에 자동 저장`,
            "",
            "궁금한 점이 있으면 그냥 메시지를 보내세요.",
        ].join("\n");
    }
    if (lang === "ja") {
        return [
            "# tabyAgent ヘルプ",
            "",
            "## コマンド",
            "- `/new` — 新しい会話を開始 (バックグラウンドで前の会話を自己改善)",
            "- `/stop` — 実行中の作業を停止",
            "- `/config` — 設定 (言語, モデル, 思考レベル, フッター, 更新確認 等)",
            "- `/agents` — エージェント管理",
            "- `/approve <6-digit code>` — 新端末を承認",
            "",
            "## 機能",
            "- ファイル添付: 画像・書類・音声・動画に対応",
            "- ビジョン: 対応モデルで画像分析",
            "- Markdown: 太字, 斜体, コード, 表, 引用, スポイラー対応",
            `- メモリ: ${memoryPath} に自動保存`,
            "",
            "質問があれば、そのままメッセージを送ってください。",
        ].join("\n");
    }
    return [
        "# tabyAgent help",
        "",
        "## Commands",
        "- `/new` — Start a new chat (self-improves on the previous one in the background)",
        "- `/stop` — Stop the running task",
        "- `/config` — Settings (change language, model, thinking level, footer, updates, etc.)",
        "- `/agents` — Manage extra agents",
        "- `/approve <6-digit code>` — Approve a new device",
        "",
        "## Features",
        "- Attachments: photos, documents, voice, video supported",
        "- Vision: image analysis on supported models",
        "- Markdown: bold, italic, code, tables, blockquotes, spoilers",
        `- Memory: durable facts saved to ${memoryPath}`,
        "",
        "If you have a question, just send a message.",
    ].join("\n");
}

export async function startTelegramBot() {
    const token = loadUserConfig().telegram?.botToken?.trim();
    if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN not set");
    }

    const bot = new Bot(token);
    bot.catch((err) => {
        console.error("Telegram bot error:", err?.stack || err);
    });
    const streamMode = loadAgentConfig().telegramStreaming ?? "draft";
    console.log(`tabyAgent: Telegram running (streaming: ${streamMode})`);

    await registerBotCommands(bot);
    await refreshTopicsEnabled(bot);
    const ownerChatId = getOwnerChatId();
    if (ownerChatId) await ensureMainTopic(bot, ownerChatId);

    setCronJobHandler((job) => runCronJobForUser(bot, job));
    startCronScheduler();
    startUpdateScheduler(bot);

    bot.command("start", async (ctx) => {
        const route = routeFromCtx(ctx);
        if (!isConfigReady()) {
            await openConfigWizard(ctx, bot);
            return;
        }
        if (!(await requireApprovedAccess(ctx, { claimFirst: true }))) {
            return;
        }
        const lang = loadUserConfig().language || "en";
        await sendMessageSafe(bot.api, route.chatId, `${t("start_ready", lang)}\n\n${helpMessage(lang)}`, telegramThreadOpts(route.threadId));
    });

    bot.command("help", async (ctx) => {
        const route = routeFromCtx(ctx);
        const lang = loadUserConfig().language || "en";
        if (!isConfigReady()) {
            await openConfigWizard(ctx, bot);
            return;
        }
        if (!(await requireApprovedAccess(ctx))) {
            return;
        }
        await sendMessageSafe(bot.api, route.chatId, helpMessage(lang), telegramThreadOpts(route.threadId));
    });

    bot.command("new", async (ctx) => {
        const route = routeFromCtx(ctx);
        const lang = loadUserConfig().language || "en";

        if (!isConfigReady()) {
            await openConfigWizard(ctx, bot);
            return;
        }

        if (!(await requireApprovedAccess(ctx))) {
            return;
        }

        try {
            await scheduleWork(
                "user",
                async () => {
                    const message = await handleNewChat(bot, route.sessionKey);
                    await sendMessageSafe(ctx.api, route.chatId, message, telegramThreadOpts(route.threadId));
                },
                { chatId: route.chatId, sessionKey: route.sessionKey },
            );
        } catch (err) {
            console.error("New chat error:", err?.stack || err);
            await sendMessageSafe(ctx.api, route.chatId, formatAgentError(err, lang), telegramThreadOpts(route.threadId));
        }
    });

    bot.command("stop", async (ctx) => {
        const route = routeFromCtx(ctx);
        const lang = loadUserConfig().language || "en";

        if (!isConfigReady()) {
            await openConfigWizard(ctx, bot);
            return;
        }

        if (!(await requireApprovedAccess(ctx))) {
            return;
        }

        const stoppedQueued = cancelQueuedAgentWork(route.sessionKey);
        const stoppedActive = stoppedQueued ? false : requestAgentStop(route.sessionKey);
        if (stoppedActive || stoppedQueued) {
            await sendMessageSafe(ctx.api, route.chatId, t("stop_requested", lang), telegramThreadOpts(route.threadId));
            return;
        }

        await sendMessageSafe(ctx.api, route.chatId, t("stop_nothing_running", lang), telegramThreadOpts(route.threadId));
    });

    bot.command("config", async (ctx) => {
        if (isConfigReady() && !(await requireApprovedAccess(ctx))) {
            return;
        }
        await openConfigWizard(ctx, bot);
    });

    bot.command("agents", async (ctx) => {
        if (isConfigReady() && !(await requireApprovedAccess(ctx))) {
            return;
        }
        await openAgentsWizard(ctx, bot);
    });

    bot.command("approve", async (ctx) => {
        const chatId = String(ctx.chat.id);
        const lang = loadUserConfig().language || "en";
        const code = (ctx.match || "").trim();

        if (!isConfigReady()) {
            await sendMessageSafe(ctx.api, String(ctx.chat.id), t("auth_denied_command", lang));
            return;
        }

        if (!(await requireApprovedAccess(ctx))) {
            return;
        }

        if (!code) {
            await sendMessageSafe(ctx.api, String(ctx.chat.id), t("auth_approve_usage", lang));
            return;
        }

        const result = await runOwnerApprove(bot, chatId, code);
        const route = routeFromCtx(ctx);
        await sendMessageSafe(ctx.api, chatId, result.message, telegramThreadOpts(route.threadId));
    });

    bot.callbackQuery(/^cfg:/, async (ctx) => {
        await handleConfigWizardCallback(ctx, bot);
    });

    bot.callbackQuery(/^ag:/, async (ctx) => {
        await handleAgentsWizardCallback(ctx, bot);
    });

    bot.callbackQuery(/^ask:/, async (ctx) => {
        const route = routeFromCtx(ctx);
        const lang = loadUserConfig().language || "en";
        const parts = String(ctx.callbackQuery?.data || "").split(":");
        const askId = parts[1];
        const idx = Number(parts[2]);
        if (!askId || !Number.isInteger(idx)) {
            await ctx.answerCallbackQuery({ text: t("user_ask_expired", lang) });
            return;
        }
        const answered = resolvePendingAskByButton(route.sessionKey, askId, idx);
        if (answered === null) {
            await ctx.answerCallbackQuery({ text: t("user_ask_expired", lang) });
            return;
        }
        await ctx.answerCallbackQuery({ text: `✅ ${answered.slice(0, 60)}` });
    });

    bot.on(["message:document", "message:photo", "message:video", "message:audio", "message:voice"], async (ctx) => {
        const route = routeFromCtx(ctx);

        if (!isConfigReady() || isWizardActive(route.chatId) || isAgentsWizardActive(route.chatId)) {
            return;
        }

        const lang = loadUserConfig().language || "en";

        if (!(await requireApprovedAccess(ctx, { claimFirst: true }))) {
            return;
        }

        try {
            if (isAgentSessionRunning(route.sessionKey)) {
                const saved = await saveIncomingTelegramFile(ctx);
                const userText = formatFileUserMessage(saved, { visionAttached: false });
                if (tryEnqueueDuringRun(route.sessionKey, userText)) {
                    return;
                }
            }

            dispatchAgentWork(ctx, route, async () => {
                const saved = await saveIncomingTelegramFile(ctx);
                let visionAttachment = null;
                if (isVisionImageAttachment(saved)) {
                    const meta = await ensureModelMeta(getMergedProvider(loadUserConfig()));
                    if (meta.supportsVision) visionAttachment = saved;
                }
                const userText = formatFileUserMessage(saved, { visionAttached: Boolean(visionAttachment) });
                return handleAgentTurn(bot, ctx, route, userText, { visionAttachment });
            });
        } catch (err) {
            console.error("File message error:", err?.stack || err);
            await sendMessageSafe(ctx.api, route.chatId, formatAgentError(err, lang), telegramThreadOpts(route.threadId));
        }
    });

    bot.on("message:text", async (ctx) => {
        const route = routeFromCtx(ctx);
        const text = ctx.message.text;

        if (isAgentsWizardActive(route.chatId)) {
            await handleAgentsWizardText(ctx, bot);
            return;
        }

        if (!isConfigReady() || isWizardActive(route.chatId)) {
            await handleConfigWizardText(ctx, bot);
            return;
        }

        const trimmed = text.trim();
        if (trimmed === "/new" || trimmed === "/stop" || trimmed === "/agents" || trimmed.startsWith("/agents@")) {
            return;
        }

        const lang = loadUserConfig().language || "en";

        if (!(await requireApprovedAccess(ctx, { claimFirst: true }))) {
            return;
        }

        // 대기 중인 user_ask가 있으면 이 텍스트를 답변으로 처리하고 에이전트 큐로 보내지 않는다.
        if (hasPendingAsk(route.sessionKey) && resolvePendingAskByText(route.sessionKey, trimmed)) {
            return;
        }

        try {
            if (tryEnqueueDuringRun(route.sessionKey, text)) {
                return;
            }

            dispatchAgentTurn(bot, ctx, route, text);
        } catch (err) {
            console.error("Agent error:", err?.stack || err);
            await sendMessageSafe(ctx.api, route.chatId, formatAgentError(err, lang), telegramThreadOpts(route.threadId));
        }
    });

    await bot.start();
}
