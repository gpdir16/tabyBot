import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";
import { USER_DIR } from "./paths.js";
import { getMergedProvider, loadUserConfig, saveUserConfig, loadProviderConfig } from "./config-loader.js";
import { claimOwnerIfNone, hasOwner, isApproved, issuePendingCode } from "./auth.js";
import { t } from "./i18n.js";
import { getApproveCliHint } from "./runtime.js";
import { fetchProviderModels, providerFromWizardState, partitionModelsForPicker, buildVendorPickerItems, MODELS_PER_PAGE } from "./llm/models.js";
import { deleteMessageSafe, sendMessageSafe } from "./telegram-api.js";
import { restartUpdateScheduler } from "./update/scheduler.js";
import { clearCodexTokens, startDeviceFlow, pollDeviceFlow } from "./llm/codex-tokens.js";
import { clearGrokTokens, startGrokDeviceFlow, pollGrokDeviceFlow } from "./llm/grok-tokens.js";
import { fetchGrokModels } from "./llm/grok-client.js";
import {
    getThinkingLevel,
    isReplyFooterEnabled,
    normalizeThinkingLevel,
    seedWizardDataFromConfig,
    thinkingLevelLabel,
    getProviderThinkingMeta,
    getNsfwLevel,
    normalizeNsfwLevel,
    nsfwLevelLabel,
    NSFW_LEVELS,
    getApprovalLevel,
    normalizeApprovalLevel,
    approvalLevelLabel,
    APPROVAL_LEVELS,
} from "./user-settings.js";

const STATE_PATH = path.join(USER_DIR, "temp", "onboarding.json");

// AbortController는 JSON state에 저장되지 않으므로 모듈에 유지
let grokLoginAbort = null;

const PROVIDERS = {
    openai: { id: "default", label: "OpenAI" },
    openrouter: { id: "openrouter", label: "OpenRouter" },
    synthetic: { id: "synthetic", label: "Synthetic" },
    ollama: { id: "ollama", label: "Ollama (local)", apiKeyOptional: true },
    ollamaCloud: { id: "ollama-cloud", label: "Ollama Cloud" },
    zenmux: { id: "zenmux", label: "ZenMux" },
    upstage: { id: "upstage", label: "Upstage" },
    codex: { id: "codex", label: "Codex OAuth (ChatGPT Plus/Pro)", apiKeyOptional: true },
    grok: { id: "grok", label: "Grok OAuth", apiKeyOptional: true },
    custom: { id: "default", custom: true, label: "Custom URL" },
};

const CODEX_MODELS = [
    { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    { id: "gpt-5.5", label: "gpt-5.5" },
    { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark (Pro)" },
];

const GROK_MODELS = [
    { id: "grok-4.6", label: "grok-4.6" },
    { id: "grok-4.5", label: "grok-4.5" },
    { id: "grok-4.3", label: "grok-4.3" },
    { id: "grok-build", label: "grok-build" },
    { id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" },
    { id: "grok-4.20-0309-non-reasoning", label: "grok-4.20-0309-non-reasoning" },
];

function emptyState(chatId, { mode = "onboarding" } = {}) {
    return {
        mode,
        step: mode === "reconfig" ? "menu" : "language",
        data: {},
        done: "Done",
        activeMessageId: null,
    };
}

function loadState() {
    if (!fs.existsSync(STATE_PATH)) return null;
    try {
        const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
        if (!("activeMessageId" in state)) state.activeMessageId = null;
        return state;
    } catch (err) {
        console.error(`tabyAgent: invalid onboarding state:`, err.message);
        return null;
    }
}

function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clearState() {
    try {
        fs.unlinkSync(STATE_PATH);
    } catch {
        // ignore
    }
}

async function clearActivePrompt(bot, chatId, state) {
    await deleteMessageSafe(bot, chatId, state.activeMessageId);
    state.activeMessageId = null;
    saveState(state);
}

async function replaceStep(bot, chatId, state, text, keyboard) {
    await clearActivePrompt(bot, chatId, state);
    const opts = keyboard ? { reply_markup: keyboard } : {};
    const sent = await sendMessageSafe(bot, chatId, text, opts);
    state.activeMessageId = sent.messageIds[0] ?? null;
    saveState(state);
    return sent;
}

export function isConfigReady() {
    const config = loadUserConfig();
    if (!config.telegram?.botToken?.trim()) return false;
    if (!config.provider?.model?.trim()) return false;
    const pid = config.provider?.id || "default";
    try {
        const p = loadProviderConfig(pid);
        if (p.apiKeyOptional) return true;
    } catch {
        // unknown provider — require apiKey
    }
    return Boolean(config.provider?.apiKey?.trim());
}

export function bootstrapBotTokenFromEnv() {
    const fromEnv = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!fromEnv) return false;
    const config = loadUserConfig();
    if (!config.telegram) config.telegram = {};
    if (!config.telegram.botToken) {
        config.telegram.botToken = fromEnv;
        saveUserConfig(config);
    }
    return true;
}

export function hasBotToken() {
    return Boolean(loadUserConfig().telegram?.botToken?.trim());
}

export function isWizardActive(chatId) {
    const state = loadState();
    return Boolean(state?.adminChatId === String(chatId) && state?.step);
}

async function applyConfig(partial) {
    const config = loadUserConfig();
    if (!config.telegram) config.telegram = {};
    if (!config.provider) config.provider = { id: "default" };

    if (partial.language) config.language = partial.language;
    if (partial.providerId) config.provider.id = partial.providerId;
    if (partial.baseURL !== undefined) {
        if (partial.baseURL) config.provider.baseURL = partial.baseURL;
        else delete config.provider.baseURL;
    }
    if (partial.providerKey && partial.providerKey !== "custom") {
        delete config.provider.baseURL;
    }
    if (partial.apiKey) config.provider.apiKey = partial.apiKey;
    if (partial.model) config.provider.model = partial.model;
    if (partial.thinkingMeta) {
        config.thinkingLevel = normalizeThinkingLevel(partial.thinkingLevel ?? config.thinkingLevel, partial.thinkingMeta);
    } else if (partial.thinkingLevel !== undefined) {
        const pid = config.provider?.id || "default";
        const meta = getProviderThinkingMeta(pid);
        config.thinkingLevel = normalizeThinkingLevel(partial.thinkingLevel, meta);
    }
    if (partial.showReplyFooter !== undefined) {
        config.showReplyFooter = Boolean(partial.showReplyFooter);
    }
    if (partial.nsfwLevel !== undefined) {
        config.nsfwLevel = normalizeNsfwLevel(partial.nsfwLevel);
    }
    if (partial.approvalLevel !== undefined) {
        config.approvalLevel = normalizeApprovalLevel(partial.approvalLevel);
    }
    if (partial.updateCheckEnabled !== undefined) {
        config.updateCheckEnabled = Boolean(partial.updateCheckEnabled);
    }

    saveUserConfig(config);
}

function texts(lang) {
    const t = {
        en: {
            welcome: "tabyAgent setup — choose your language:",
            provider: "Choose LLM provider:",
            baseURL: "Send your API base URL (e.g. https://api.example.com/v1)",
            apiKey: "Send your API key.",
            modelVendorPick: "Model selection ({total} detected)",
            modelVariantPick: "Organization selection ({total} detected)",
            modelLoading: "Loading models from your provider…",
            modelFetchFailed: "Could not load the model list. Send the model name manually.",
            modelManual: "Send the model name.",
            prevPage: "◀ Prev",
            nextPage: "Next ▶",
            modelBack: "◀ Providers",
            done: "Done",
            invalid: "Invalid input. Tap a button or send /config to restart.",
            busy: "Setup is in progress in another chat.",
            manual: "Enter manually",
            cancel: "Cancel setup",
            codexLoginTitle: "Codex (ChatGPT OAuth)",
            codexLoginPending:
                "Waiting for authorization… Open the link below, enter the code, then approve.\n\n🔗 {url}\n\nCode: {code}\n\nThis will auto-complete when you approve.",
            codexLoginSuccess: "✅ ChatGPT login successful!",
            codexLoginFailed: "❌ Login failed: {error}\n\nTap retry to try again.",
            codexLoginRetry: "Retry login",
            codexLoginCancel: "Cancel",
            grokLoginTitle: "Grok (xAI OAuth)",
            grokLoginPending:
                "Waiting for authorization… Open the link below, enter the code, then approve.\n\n🔗 {url}\n\nCode: {code}\n\nThis will auto-complete when you approve.",
            grokLoginSuccess: "✅ Grok login successful!",
            grokLoginFailed: "❌ Login failed: {error}\n\nTap retry to try again.",
            grokLoginRetry: "Retry login",
            grokLoginCancel: "Cancel",
            menuTitle: "tabyAgent settings",
            catLanguage: "Language",
            catThinking: "Thinking level",
            catModel: "Model",
            catProvider: "LLM provider",
            catApiKey: "API key",
            catFooter: "Reply stats footer",
            catUpdate: "Update notifications",
            catNsfw: "NSFW content limit",
            nsfwPick: "Choose the NSFW content level to allow:",
            nsfwStrict: "Not allowed",
            nsfwModerate: "Indirect mentions only",
            nsfwExplicit: "Fully allowed",
            catApproval: "Permanent actions",
            approvalPick: "For permanent/irreversible actions (payments, account/data deletion, external sends), decide who approves them.",
            thinkingPick: "Pick a level returned by /models for this model:",
            thinkingManual: "Send the exact thinking/reasoning value your API expects:",
            footerPick: "Show token/tool stats under each reply:",
            updatePick: "Check GitHub for new releases and notify you:",
            backMenu: "◀ Menu",
            toggleOn: "On",
            toggleOff: "Off",
        },
        ko: {
            welcome: "tabyAgent 설정 — 언어를 선택하세요:",
            provider: "LLM 제공자를 선택하세요:",
            baseURL: "API base URL을 보내주세요 (예: https://api.example.com/v1)",
            apiKey: "API 키를 보내주세요.",
            modelVendorPick: "모델 선택 ({total}개 감지됨)",
            modelVariantPick: "조직 선택 ({total}개 감지됨)",
            modelLoading: "제공자에서 모델 목록을 불러오는 중…",
            modelFetchFailed: "모델 목록을 가져오지 못했습니다. 모델 이름을 직접 보내주세요.",
            modelManual: "모델 이름을 보내주세요.",
            prevPage: "◀ 이전",
            nextPage: "다음 ▶",
            modelBack: "◀ 제공자",
            done: "완료",
            invalid: "잘못된 입력입니다. 버튼을 누르거나 /config 로 다시 시작하세요.",
            busy: "다른 채팅에서 설정 중입니다.",
            manual: "직접 입력",
            cancel: "설정 취소",
            codexLoginTitle: "Codex (ChatGPT OAuth)",
            codexLoginPending:
                "인증 대기 중… 아래 링크를 열고 코드를 입력한 뒤 승인하세요.\n\n🔗 {url}\n\n코드: {code}\n\n승인하면 자동으로 완료됩니다.",
            codexLoginSuccess: "✅ ChatGPT 로그인 성공!",
            codexLoginFailed: "❌ 로그인 실패: {error}\n\n다시 시도하려면 버튼을 누르세요.",
            codexLoginRetry: "다시 시도",
            codexLoginCancel: "취소",
            grokLoginTitle: "Grok (xAI OAuth)",
            grokLoginPending:
                "인증 대기 중… 아래 링크를 열고 코드를 입력한 뒤 승인하세요.\n\n🔗 {url}\n\n코드: {code}\n\n승인하면 자동으로 완료됩니다.",
            grokLoginSuccess: "✅ Grok 로그인 성공!",
            grokLoginFailed: "❌ 로그인 실패: {error}\n\n다시 시도하려면 버튼을 누르세요.",
            grokLoginRetry: "다시 시도",
            grokLoginCancel: "취소",
            menuTitle: "tabyAgent 설정",
            catLanguage: "언어",
            catThinking: "사고 수준",
            catModel: "모델",
            catProvider: "LLM 제공자",
            catApiKey: "API 키",
            catFooter: "답변 통계 푸터",
            catUpdate: "업데이트 알림",
            catNsfw: "NSFW 컨텐츠 제한",
            nsfwPick: "허용할 NSFW 컨텐츠 수준을 선택하세요:",
            nsfwStrict: "허용하지 않음",
            nsfwModerate: "간접 언급만 허용",
            nsfwExplicit: "전체 허용",
            catApproval: "영구적인 행위",
            approvalPick: "영구적이고 되돌릴 수 없는 행위(결제, 계정/데이터 삭제, 외부 발송)를 어떻게 승인할지 설정하세요.",
            thinkingManual: "API가 받는 사고/추론 값을 그대로 입력:",
            footerPick: "답변 아래 토큰/툴 통계 표시:",
            updatePick: "새 버전 확인 후 알림:",
            backMenu: "◀ 메뉴",
            toggleOn: "켜기",
            toggleOff: "끄기",
        },
        ja: {
            welcome: "tabyAgent 設定 — 言語を選んでください:",
            provider: "LLM プロバイダを選んでください:",
            baseURL: "API base URL を送信 (例: https://api.example.com/v1)",
            apiKey: "API キーを送信してください。",
            modelVendorPick: "モデル選択 ({total}件検出)",
            modelVariantPick: "組織選択 ({total}件検出)",
            modelLoading: "プロバイダからモデル一覧を取得中…",
            modelFetchFailed: "モデル一覧を取得できませんでした。モデル名を手入力してください。",
            modelManual: "モデル名を送信してください。",
            prevPage: "◀ 前へ",
            nextPage: "次へ ▶",
            modelBack: "◀ プロバイダ",
            done: "完了",
            invalid: "無効な入力です。ボタンを押すか /config で最初から。",
            busy: "別のチャットで設定中です。",
            manual: "手入力",
            cancel: "キャンセル",
            codexLoginTitle: "Codex (ChatGPT OAuth)",
            codexLoginPending:
                "認証待機中… 以下のリンクを開き、コードを入力して承認してください。\n\n🔗 {url}\n\nコード: {code}\n\n承認すると自動的に完了します。",
            codexLoginSuccess: "✅ ChatGPT ログイン成功！",
            codexLoginFailed: "❌ ログイン失敗: {error}\n\n再試行ボタンを押してください。",
            codexLoginRetry: "再試行",
            codexLoginCancel: "キャンセル",
            grokLoginTitle: "Grok (xAI OAuth)",
            grokLoginPending:
                "認証待機中… 以下のリンクを開き、コードを入力して承認してください。\n\n🔗 {url}\n\nコード: {code}\n\n承認すると自動的に完了します。",
            grokLoginSuccess: "✅ Grok ログイン成功！",
            grokLoginFailed: "❌ ログイン失敗: {error}\n\n再試行ボタンを押してください。",
            grokLoginRetry: "再試行",
            grokLoginCancel: "キャンセル",
            menuTitle: "tabyAgent 設定",
            catLanguage: "言語",
            catThinking: "思考レベル",
            catModel: "モデル",
            catProvider: "LLM プロバイダ",
            catApiKey: "API キー",
            catFooter: "返信統計フッター",
            catUpdate: "更新通知",
            catNsfw: "NSFWコンテンツ制限",
            nsfwPick: "許可するNSFWコンテンツレベルを選んでください:",
            nsfwStrict: "許可しない",
            nsfwModerate: "間接言及のみ許可",
            nsfwExplicit: "全面許可",
            catApproval: "恒久的な行為",
            approvalPick: "恒久的・取り消し不能な行為（決済、アカウント・データ削除、外部送信）の承認方法を選んでください。",
            thinkingPick: "このモデルの /models が返した思考レベル:",
            thinkingManual: "API が受け付ける思考/推論の値をそのまま送信:",
            footerPick: "返信下にトークン/ツール統計を表示:",
            updatePick: "新バージョンを確認して通知:",
            backMenu: "◀ メニュー",
            toggleOn: "オン",
            toggleOff: "オフ",
        },
    };
    return t[lang] || t.en;
}

function uiLang(state) {
    return state.data.language || "en";
}

function isReconfig(state) {
    return state.mode === "reconfig";
}

function onOffLabel(lang, on) {
    if (lang === "ko") return on ? "켜짐" : "꺼짐";
    if (lang === "ja") return on ? "オン" : "オフ";
    return on ? "On" : "Off";
}

function menuKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const cfg = loadUserConfig();
    const kb = new InlineKeyboard();
    kb.text(`${msg.catLanguage}: ${cfg.language || "en"}`, "cfg:cat:language").row();
    kb.text(`${msg.catThinking}: ${thinkingLevelLabel(lang, getThinkingLevel(cfg))}`, "cfg:cat:thinking").row();
    kb.text(`${msg.catModel}: ${cfg.provider?.model || "—"}`, "cfg:cat:model").row();
    kb.text(`${msg.catProvider}: ${PROVIDERS[state.data.providerKey]?.label || cfg.provider?.id || "—"}`, "cfg:cat:provider").row();
    kb.text(`${msg.catFooter}: ${onOffLabel(lang, state.data.showReplyFooter !== false)}`, "cfg:cat:footer").row();
    kb.text(`${msg.catUpdate}: ${onOffLabel(lang, state.data.updateCheckEnabled !== false)}`, "cfg:cat:update").row();
    kb.text(`${msg.catNsfw}: ${nsfwLevelLabel(lang, getNsfwLevel(cfg))}`, "cfg:cat:nsfw").row();
    kb.text(`${msg.catApproval}: ${approvalLevelLabel(lang, getApprovalLevel(cfg))}`, "cfg:cat:approval").row();
    kb.text(msg.done, "cfg:done");
    return kb;
}

function thinkingKeyboard(state, metaOrPid) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const meta = typeof metaOrPid === "string" ? getProviderThinkingMeta(metaOrPid) : metaOrPid;
    const cur = normalizeThinkingLevel(state.data.thinkingLevel, meta);
    const kb = new InlineKeyboard();
    for (const level of meta.levels || []) {
        const mark = level === cur ? "✓ " : "";
        kb.text(`${mark}${thinkingLevelLabel(lang, level)}`, `cfg:think:${level}`).row();
    }
    kb.text(msg.backMenu, "cfg:menu");
    return kb;
}
function footerToggleKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const current = state.data.showReplyFooter ?? true;
    const kb = new InlineKeyboard();
    kb.text(`${current ? "✓ " : ""}${msg.toggleOn}`, "cfg:toggle:footer:on").row();
    kb.text(`${!current ? "✓ " : ""}${msg.toggleOff}`, "cfg:toggle:footer:off").row();
    kb.text(msg.backMenu, "cfg:menu");
    return kb;
}

function updateToggleKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const current = state.data.updateCheckEnabled ?? true;
    const kb = new InlineKeyboard();
    kb.text(`${current ? "✓ " : ""}${msg.toggleOn}`, "cfg:toggle:update:on").row();
    kb.text(`${!current ? "✓ " : ""}${msg.toggleOff}`, "cfg:toggle:update:off").row();
    kb.text(msg.backMenu, "cfg:menu");
    return kb;
}
function nsfwKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const cur = normalizeNsfwLevel(state.data.nsfwLevel);
    const kb = new InlineKeyboard();
    kb.text(`${cur === "strict" ? "✓ " : ""}${msg.nsfwStrict}`, "cfg:nsfw:strict").row();
    kb.text(`${cur === "moderate" ? "✓ " : ""}${msg.nsfwModerate}`, "cfg:nsfw:moderate").row();
    kb.text(`${cur === "explicit" ? "✓ " : ""}${msg.nsfwExplicit}`, "cfg:nsfw:explicit").row();
    kb.text(msg.backMenu, "cfg:menu");
    return kb;
}
function approvalKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const cur = normalizeApprovalLevel(state.data.approvalLevel);
    const kb = new InlineKeyboard();
    for (const level of APPROVAL_LEVELS) {
        kb.text(`${cur === level ? "✓ " : ""}${approvalLevelLabel(lang, level)}`, `cfg:approval:${level}`).row();
    }
    kb.text(msg.backMenu, "cfg:menu");
    return kb;
}
async function showThinkingStep(bot, chatId, state) {
    const lang = uiLang(state);
    const cfg = loadUserConfig();
    const pid = state.data.providerId || cfg.provider?.id || "default";
    const meta = getProviderThinkingMeta(pid);
    state.data.thinkingMeta = meta;
    state.data.thinkingLevel = normalizeThinkingLevel(state.data.thinkingLevel, pid);
    state.step = "thinking";
    saveState(state);
    if (!meta.levels?.length) {
        state.step = "thinking_manual";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(lang).thinkingManual);
        return;
    }
    await replaceStep(bot, chatId, state, texts(lang).thinkingPick, thinkingKeyboard(state, meta));
}

async function showMenuStep(bot, chatId, state) {
    const lang = uiLang(state);
    state.step = "menu";
    saveState(state);
    await replaceStep(bot, chatId, state, texts(lang).menuTitle, menuKeyboard(state));
}
async function returnToMenu(bot, chatId, state) {
    await showMenuStep(bot, chatId, state);
}

async function completeModelSelection(bot, chatId, state, { userMessageId } = {}) {
    if (isReconfig(state)) {
        await applyConfig({ model: state.data.model });
        await clearActivePrompt(bot, chatId, state);
        await deleteMessageSafe(bot, chatId, userMessageId);
        await returnToMenu(bot, chatId, state);
        return;
    }
    await finishWizard(bot, chatId, state, { userMessageId });
}

function languageKeyboard(lang, state = null) {
    const msg = texts(lang);
    const kb = new InlineKeyboard().text("English", "cfg:lang:en").row().text("한국어", "cfg:lang:ko").row().text("日本語", "cfg:lang:ja").row();
    if (state && isReconfig(state)) {
        kb.text(msg.backMenu, "cfg:menu").row();
    }
    return kb;
}

function providerKeyboard(lang, state = null) {
    const msg = texts(lang);
    const kb = new InlineKeyboard()
        .text("OpenAI", "cfg:prov:openai")
        .row()
        .text("OpenRouter", "cfg:prov:openrouter")
        .row()
        .text("Synthetic", "cfg:prov:synthetic")
        .row()
        .text("Ollama (local)", "cfg:prov:ollama")
        .row()
        .text("Ollama Cloud", "cfg:prov:ollamaCloud")
        .row()
        .text("ZenMux", "cfg:prov:zenmux")
        .row()
        .text("Upstage", "cfg:prov:upstage")
        .row()
        .text("Codex OAuth (ChatGPT Plus/Pro)", "cfg:prov:codex")
        .row()
        .text("Grok OAuth", "cfg:prov:grok")
        .row()
        .text("Custom API URL", "cfg:prov:custom")
        .row();
    if (state && isReconfig(state)) {
        kb.text(msg.backMenu, "cfg:menu").row();
    }
    return kb;
}

function modelCount(state) {
    const partition = state.data.modelPartition;
    if (!partition) return 0;
    if (state.data.selectedModelPrefix) {
        return partition.byPrefix?.[state.data.selectedModelPrefix]?.length || 0;
    }
    const items = vendorPickerItems(state);
    return items.length;
}

function vendorPickerItems(state) {
    const partition = {
        flat: state.data.modelPartition?.flat || [],
        prefixes: state.data.modelPartition?.prefixes || [],
        byPrefix: new Map(Object.entries(state.data.modelPartition?.byPrefix || {})),
    };
    return buildVendorPickerItems(partition);
}

function variantPickerItems(state) {
    const prefix = state.data.selectedModelPrefix;
    const list = state.data.modelPartition?.byPrefix?.[prefix] || [];
    return list;
}

function vendorCaption(lang, state) {
    const msg = texts(lang);
    const total = modelCount(state);
    return msg.modelVendorPick.replace("{total}", String(total));
}

function variantCaption(lang, state) {
    const msg = texts(lang);
    const total = modelCount(state);
    return msg.modelVariantPick.replace("{total}", String(total));
}

function trimLabel(label, max = 36) {
    if (label.length <= max) return label;
    return `${label.slice(0, max - 1)}…`;
}

function addPager(kb, msg, page, total, pageCallbackPrefix) {
    const hasPrev = page > 0;
    const hasNext = (page + 1) * MODELS_PER_PAGE < total;
    if (hasPrev || hasNext) {
        if (hasPrev) kb.text(msg.prevPage, `${pageCallbackPrefix}:${page - 1}`);
        if (hasNext) kb.text(msg.nextPage, `${pageCallbackPrefix}:${page + 1}`);
        kb.row();
    }
}

function vendorKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const items = vendorPickerItems(state);
    const page = state.data.modelPage || 0;
    const start = page * MODELS_PER_PAGE;
    const slice = items.slice(start, start + MODELS_PER_PAGE);

    const kb = new InlineKeyboard();
    for (let i = 0; i < slice.length; i++) {
        const globalIdx = start + i;
        const item = slice[i];
        if (item.type === "prefix") {
            const count = state.data.modelPartition?.byPrefix?.[item.prefix]?.length || 0;
            kb.text(trimLabel(`${item.prefix} (${count})`), `cfg:mvidx:${globalIdx}`).row();
        } else {
            kb.text(trimLabel(item.model.label), `cfg:mvidx:${globalIdx}`).row();
        }
    }

    addPager(kb, msg, page, items.length, "cfg:mvpage");
    kb.text(msg.manual, "cfg:model:__manual__").row();
    if (isReconfig(state)) {
        kb.text(msg.backMenu, "cfg:menu").row();
    }
    return kb;
}

function variantKeyboard(state) {
    const lang = uiLang(state);
    const msg = texts(lang);
    const items = variantPickerItems(state);
    const page = state.data.modelPage || 0;
    const start = page * MODELS_PER_PAGE;
    const slice = items.slice(start, start + MODELS_PER_PAGE);

    const kb = new InlineKeyboard();
    for (let i = 0; i < slice.length; i++) {
        const globalIdx = start + i;
        const label = slice[i].suffix || slice[i].label;
        kb.text(trimLabel(label), `cfg:mdidx:${globalIdx}`).row();
    }

    addPager(kb, msg, page, items.length, "cfg:mdpage");
    kb.text(msg.modelBack, "cfg:modelback").row();
    kb.text(msg.manual, "cfg:model:__manual__").row();
    if (isReconfig(state)) {
        kb.text(msg.backMenu, "cfg:menu").row();
    }
    return kb;
}

async function showVendorStep(bot, chatId, state) {
    const lang = uiLang(state);
    state.step = "model_vendor";
    state.data.selectedModelPrefix = null;
    state.data.modelPage = state.data.modelPage || 0;
    saveState(state);
    await replaceStep(bot, chatId, state, vendorCaption(lang, state), vendorKeyboard(state));
}

async function showVariantStep(bot, chatId, state) {
    const lang = uiLang(state);
    state.step = "model_variant";
    state.data.modelPage = 0;
    saveState(state);
    await replaceStep(bot, chatId, state, variantCaption(lang, state), variantKeyboard(state));
}

export function resetOnboarding(chatId) {
    saveState(emptyState(chatId, { mode: "onboarding" }));
}

export async function openConfigWizard(ctx, bot) {
    const chatId = String(ctx.chat.id);
    const prev = loadState();
    if (prev?.activeMessageId) {
        await deleteMessageSafe(bot, chatId, prev.activeMessageId);
    }

    if (isConfigReady()) {
        const seeded = seedWizardDataFromConfig();
        const state = {
            mode: "reconfig",
            step: "menu",
            data: { ...seeded },
            adminChatId: String(chatId),
            activeMessageId: null,
        };
        saveState(state);
        await showMenuStep(bot, chatId, state);
        return;
    }

    resetOnboarding(chatId);
    const state = loadState();
    const lang = "en";
    await replaceStep(bot, chatId, state, texts(lang).welcome, languageKeyboard(lang));
}

async function finishWizard(bot, chatId, state, { userMessageId } = {}) {
    if (hasOwner() && !isApproved(chatId)) {
        const lang = state.data.language || "en";
        await clearActivePrompt(bot, chatId, state);
        await deleteMessageSafe(bot, chatId, userMessageId);
        clearState();
        await sendMessageSafe(bot, chatId, t("auth_denied_command", lang));
        return;
    }

    const cfg = loadUserConfig();
    const modelId = state.data.model || "";
    let provider;
    try {
        provider = providerFromWizardState(state);
    } catch {
        provider = getMergedProvider(cfg);
    }
    const pid = provider.id || cfg.provider?.id || "default";
    const meta = getProviderThinkingMeta(pid);
    await applyConfig({
        language: state.data.language,
        providerId: state.data.providerId,
        providerKey: state.data.providerKey,
        baseURL: state.data.baseURL,
        apiKey: state.data.apiKey,
        model: state.data.model,
        thinkingLevel: state.data.thinkingLevel || meta.defaultLevel,
        thinkingMeta: meta,
    });

    const doneText = texts(state.data.language).done;
    await clearActivePrompt(bot, chatId, state);
    await deleteMessageSafe(bot, chatId, userMessageId);
    clearState();
    if (!isApproved(chatId)) {
        const claimed = claimOwnerIfNone(chatId);
        if (!claimed.ok) {
            await sendMessageSafe(bot, chatId, t("auth_denied_command", state.data.language || "en"));
            return;
        }
    }
    await sendMessageSafe(bot, chatId, doneText);
}

async function sendModelStep(bot, chatId, state) {
    const lang = uiLang(state);
    state.step = "model_loading";
    saveState(state);
    await replaceStep(bot, chatId, state, texts(lang).modelLoading);

    // Codex has no /models endpoint — use a built-in list
    if (state.data.providerId === "codex") {
        const models = CODEX_MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            contextWindow: 200000,
            supportsVision: false,
        }));
        const partition = partitionModelsForPicker(models);
        state.data.availableModels = models;
        state.data.modelPartition = {
            flat: partition.flat,
            prefixes: partition.prefixes,
            byPrefix: Object.fromEntries(partition.byPrefix),
        };
        state.data.modelPage = 0;
        saveState(state);
        await showVendorStep(bot, chatId, state);
        return;
    }

    if (state.data.providerId === "grok") {
        let models = GROK_MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            contextWindow: 500000,
            supportsVision: true,
        }));
        try {
            const live = await fetchGrokModels();
            if (live.length) models = live;
        } catch (err) {
            console.warn("fetchGrokModels failed, using built-in list:", err.message || err);
        }
        const partition = partitionModelsForPicker(models);
        state.data.availableModels = models;
        state.data.modelPartition = {
            flat: partition.flat,
            prefixes: partition.prefixes,
            byPrefix: Object.fromEntries(partition.byPrefix),
        };
        state.data.modelPage = 0;
        saveState(state);
        await showVendorStep(bot, chatId, state);
        return;
    }

    try {
        const provider = providerFromWizardState(state);
        const models = await fetchProviderModels(provider, { useCache: false });
        if (!models.length) {
            state.step = "model_manual";
            saveState(state);
            await replaceStep(bot, chatId, state, texts(lang).modelManual);
            return;
        }
        const partition = partitionModelsForPicker(models);
        state.data.availableModels = models;
        state.data.modelPartition = {
            flat: partition.flat,
            prefixes: partition.prefixes,
            byPrefix: Object.fromEntries(partition.byPrefix),
        };
        state.data.modelPage = 0;
        saveState(state);
        await showVendorStep(bot, chatId, state);
    } catch (err) {
        console.warn("fetchProviderModels failed:", err.message || err);
        state.step = "model_manual";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(lang).modelFetchFailed);
    }
}

async function startCodexLogin(bot, chatId, state) {
    const lang = uiLang(state);
    const msg = texts(lang);

    clearCodexTokens();

    // Abort any previous attempt
    if (state.data.codexAbort) state.data.codexAbort.abort();
    const abort = new AbortController();
    state.data.codexAbort = abort;
    state.step = "codex_login";
    saveState(state);

    let flow;
    try {
        flow = await startDeviceFlow();
    } catch (err) {
        const kb = new InlineKeyboard().text(msg.codexLoginRetry, "cfg:codex:retry").row().text(msg.codexLoginCancel, "cfg:codex:cancel");
        await replaceStep(bot, chatId, state, msg.codexLoginFailed.replace("{error}", err.message), kb);
        return;
    }

    state.data.codexFlow = { deviceAuthId: flow.deviceAuthId, userCode: flow.userCode, intervalMs: flow.intervalMs };
    saveState(state);

    const text = msg.codexLoginPending.replace("{url}", flow.deviceUrl).replace("{code}", flow.userCode);
    const kb = new InlineKeyboard().text(msg.codexLoginCancel, "cfg:codex:cancel");
    await replaceStep(bot, chatId, state, text, kb);

    // Poll in background
    pollDeviceFlow({ deviceAuthId: flow.deviceAuthId, userCode: flow.userCode, intervalMs: flow.intervalMs, signal: abort.signal })
        .then(async () => {
            if (state.data.codexAbort !== abort) return; // superseded
            delete state.data.codexAbort;
            delete state.data.codexFlow;
            saveState(state);
            await clearActivePrompt(bot, chatId, state);
            await sendMessageSafe(bot, chatId, msg.codexLoginSuccess);
            await sendModelStep(bot, chatId, state);
        })
        .catch(async (err) => {
            if (state.data.codexAbort !== abort) return;
            delete state.data.codexAbort;
            delete state.data.codexFlow;
            saveState(state);
            if (err.message === "Login cancelled." || abort.signal.aborted) return;
            const kb = new InlineKeyboard().text(msg.codexLoginRetry, "cfg:codex:retry").row().text(msg.codexLoginCancel, "cfg:codex:cancel");
            await replaceStep(bot, chatId, state, msg.codexLoginFailed.replace("{error}", err.message), kb);
        });
}

async function startGrokLogin(bot, chatId, state) {
    const lang = uiLang(state);
    const msg = texts(lang);

    clearGrokTokens();

    if (grokLoginAbort) grokLoginAbort.abort();
    const abort = new AbortController();
    grokLoginAbort = abort;
    state.step = "grok_login";
    saveState(state);

    let flow;
    try {
        flow = await startGrokDeviceFlow();
    } catch (err) {
        if (grokLoginAbort === abort) grokLoginAbort = null;
        const kb = new InlineKeyboard().text(msg.grokLoginRetry, "cfg:grok:retry").row().text(msg.grokLoginCancel, "cfg:grok:cancel");
        await replaceStep(bot, chatId, state, msg.grokLoginFailed.replace("{error}", err.message), kb);
        return;
    }

    state.data.grokFlow = { deviceCode: flow.deviceCode, userCode: flow.userCode, intervalMs: flow.intervalMs, expiresAt: flow.expiresAt };
    saveState(state);

    const text = msg.grokLoginPending.replace("{url}", flow.deviceUrl).replace("{code}", flow.userCode);
    const kb = new InlineKeyboard().text(msg.grokLoginCancel, "cfg:grok:cancel");
    await replaceStep(bot, chatId, state, text, kb);

    pollGrokDeviceFlow({
        deviceCode: flow.deviceCode,
        intervalMs: flow.intervalMs,
        expiresAt: flow.expiresAt,
        signal: abort.signal,
    })
        .then(async () => {
            if (grokLoginAbort !== abort) return;
            grokLoginAbort = null;
            delete state.data.grokFlow;
            saveState(state);
            await clearActivePrompt(bot, chatId, state);
            await sendMessageSafe(bot, chatId, msg.grokLoginSuccess);
            await sendModelStep(bot, chatId, state);
        })
        .catch(async (err) => {
            if (grokLoginAbort !== abort) return;
            grokLoginAbort = null;
            delete state.data.grokFlow;
            saveState(state);
            if (err.message === "Login cancelled." || abort.signal.aborted) return;
            const failKb = new InlineKeyboard().text(msg.grokLoginRetry, "cfg:grok:retry").row().text(msg.grokLoginCancel, "cfg:grok:cancel");
            await replaceStep(bot, chatId, state, msg.grokLoginFailed.replace("{error}", err.message), failKb);
        });
}

function assertWizardChat(ctx, state) {
    const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat.id);
    if (state.adminChatId && state.adminChatId !== chatId) {
        return { ok: false, chatId, lang: uiLang(state) };
    }
    if (!state.adminChatId) {
        state.adminChatId = chatId;
        saveState(state);
    }
    return { ok: true, chatId, lang: uiLang(state) };
}

async function dismissCallbackPrompt(ctx, bot, chatId, state) {
    const promptId = ctx.callbackQuery?.message?.message_id;
    if (promptId && state.activeMessageId === promptId) {
        state.activeMessageId = null;
        saveState(state);
    }
    await deleteMessageSafe(bot, chatId, promptId);
}

export async function handleConfigWizardCallback(ctx, bot) {
    const data = ctx.callbackQuery.data;
    let state = loadState() || emptyState(ctx.chat.id);

    const access = assertWizardChat(ctx, state);
    if (!access.ok) {
        await ctx.answerCallbackQuery({ text: texts(access.lang).busy, show_alert: true });
        return;
    }
    const { chatId } = access;

    if (data === "cfg:done") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        clearState();
        return;
    }

    if (data === "cfg:menu") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        await showMenuStep(bot, chatId, state);
        return;
    }

    if (data === "cfg:cat:language") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "language";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(uiLang(state)).catLanguage, languageKeyboard(uiLang(state), state));
        return;
    }

    if (data === "cfg:cat:thinking") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        await showThinkingStep(bot, chatId, state);
        return;
    }

    if (data === "cfg:cat:model") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        await sendModelStep(bot, chatId, state);
        return;
    }

    if (data === "cfg:cat:provider") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "provider";
        saveState(state);
        const lang = uiLang(state);
        await replaceStep(bot, chatId, state, texts(lang).provider, providerKeyboard(lang, state));
        return;
    }

    if (data === "cfg:cat:apikey") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "api_key";
        state.data.afterApiKey = "menu";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(uiLang(state)).apiKey);
        return;
    }

    if (data === "cfg:cat:footer") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "footer_toggle";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(uiLang(state)).footerPick, footerToggleKeyboard(state));
        return;
    }

    if (data === "cfg:cat:update") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "update_toggle";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(uiLang(state)).updatePick, updateToggleKeyboard(state));
        return;
    }
    if (data === "cfg:cat:nsfw") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "nsfw_pick";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(uiLang(state)).nsfwPick, nsfwKeyboard(state));
        return;
    }
    if (data === "cfg:cat:approval") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.step = "approval_pick";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(uiLang(state)).approvalPick, approvalKeyboard(state));
        return;
    }
    if (data.startsWith("cfg:approval:")) {
        const level = data.slice("cfg:approval:".length);
        if (!APPROVAL_LEVELS.includes(level)) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.approvalLevel = level;
        await applyConfig({ approvalLevel: level });
        saveState(state);
        await returnToMenu(bot, chatId, state);
        return;
    }
    if (data.startsWith("cfg:think:")) {
        const level = data.slice("cfg:think:".length).toLowerCase();
        const pid = state.data.providerId || loadUserConfig().provider?.id || "default";
        const meta = getProviderThinkingMeta(pid);
        if (!meta.levels.includes(level)) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.thinkingLevel = level;
        await applyConfig({ thinkingLevel: level, providerId: pid });
        saveState(state);
        await returnToMenu(bot, chatId, state);
        return;
    }

    if (data === "cfg:toggle:footer:on" || data === "cfg:toggle:footer:off") {
        const on = data.endsWith(":on");
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.showReplyFooter = on;
        await applyConfig({ showReplyFooter: on });
        saveState(state);
        await returnToMenu(bot, chatId, state);
        return;
    }

    if (data === "cfg:toggle:update:on" || data === "cfg:toggle:update:off") {
        const on = data.endsWith(":on");
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.updateCheckEnabled = on;
        await applyConfig({ updateCheckEnabled: on });
        saveState(state);
        restartUpdateScheduler(bot);
        await returnToMenu(bot, chatId, state);
        return;
    }
    if (data.startsWith("cfg:nsfw:")) {
        const level = data.slice("cfg:nsfw:".length);
        if (!NSFW_LEVELS.includes(level)) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.nsfwLevel = level;
        await applyConfig({ nsfwLevel: level });
        saveState(state);
        await returnToMenu(bot, chatId, state);
        return;
    }

    if (data.startsWith("cfg:lang:")) {
        const language = data.slice("cfg:lang:".length);
        if (!["en", "ko", "ja"].includes(language)) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);

        state.data.language = language;
        saveState(state);
        await applyConfig({ language });
        if (isReconfig(state)) {
            await returnToMenu(bot, chatId, state);
            return;
        }
        state.step = "provider";
        saveState(state);
        await replaceStep(bot, chatId, state, texts(language).provider, providerKeyboard(language));
        return;
    }

    if (data.startsWith("cfg:prov:")) {
        const providerKey = data.slice("cfg:prov:".length);
        const provider = PROVIDERS[providerKey];
        if (!provider) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);

        state.data.providerKey = providerKey;
        state.data.providerId = provider.id;
        delete state.data.afterApiKey;
        if (!provider.custom) {
            state.data.baseURL = "";
        }
        saveState(state);
        await applyConfig({ providerId: provider.id, providerKey });
        const cfg2 = loadUserConfig();
        const pid2 = cfg2.provider?.id || "default";
        const meta2 = getProviderThinkingMeta(pid2);
        state.data.thinkingMeta = meta2;
        state.data.thinkingLevel = normalizeThinkingLevel(cfg2.thinkingLevel, pid2);

        const lang = uiLang(state);
        if (provider.custom) {
            state.step = "base_url";
            saveState(state);
            await replaceStep(bot, chatId, state, texts(lang).baseURL);
        } else if (providerKey === "codex") {
            await startCodexLogin(bot, chatId, state);
        } else if (providerKey === "grok") {
            await startGrokLogin(bot, chatId, state);
        } else if (provider.apiKeyOptional) {
            saveState(state);
            await sendModelStep(bot, chatId, state);
        } else {
            state.step = "api_key";
            saveState(state);
            await replaceStep(bot, chatId, state, texts(lang).apiKey);
        }
        return;
    }

    if (data === "cfg:codex:retry") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        await startCodexLogin(bot, chatId, state);
        return;
    }

    if (data === "cfg:codex:cancel") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        if (state.data.codexAbort) state.data.codexAbort.abort();
        delete state.data.codexAbort;
        delete state.data.codexFlow;
        saveState(state);
        const lang = uiLang(state);
        await replaceStep(bot, chatId, state, texts(lang).provider, providerKeyboard(lang, state));
        return;
    }

    if (data === "cfg:grok:retry") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        await startGrokLogin(bot, chatId, state);
        return;
    }

    if (data === "cfg:grok:cancel") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        if (grokLoginAbort) grokLoginAbort.abort();
        grokLoginAbort = null;
        delete state.data.grokFlow;
        saveState(state);
        const lang = uiLang(state);
        await replaceStep(bot, chatId, state, texts(lang).provider, providerKeyboard(lang, state));
        return;
    }

    if (data === "cfg:modelback") {
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.modelPage = 0;
        await showVendorStep(bot, chatId, state);
        return;
    }

    if (data.startsWith("cfg:mvpage:")) {
        const page = Number.parseInt(data.slice("cfg:mvpage:".length), 10);
        if (!Number.isFinite(page) || page < 0) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.modelPage = page;
        const lang = uiLang(state);
        await replaceStep(bot, chatId, state, vendorCaption(lang, state), vendorKeyboard(state));
        return;
    }

    if (data.startsWith("cfg:mdpage:")) {
        const page = Number.parseInt(data.slice("cfg:mdpage:".length), 10);
        if (!Number.isFinite(page) || page < 0) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.modelPage = page;
        const lang = uiLang(state);
        await replaceStep(bot, chatId, state, variantCaption(lang, state), variantKeyboard(state));
        return;
    }

    if (data.startsWith("cfg:mvidx:")) {
        const idx = Number.parseInt(data.slice("cfg:mvidx:".length), 10);
        const item = vendorPickerItems(state)[idx];
        if (!item) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);

        if (item.type === "flat") {
            state.data.model = item.model.id;
            await completeModelSelection(bot, chatId, state);
            return;
        }

        state.data.selectedModelPrefix = item.prefix;
        await showVariantStep(bot, chatId, state);
        return;
    }

    if (data.startsWith("cfg:mdidx:")) {
        const idx = Number.parseInt(data.slice("cfg:mdidx:".length), 10);
        const picked = variantPickerItems(state)[idx];
        if (!picked) {
            await ctx.answerCallbackQuery();
            return;
        }
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);
        state.data.model = picked.id;
        await completeModelSelection(bot, chatId, state);
        return;
    }

    if (data.startsWith("cfg:model:")) {
        const raw = data.slice("cfg:model:".length);
        await ctx.answerCallbackQuery();
        await dismissCallbackPrompt(ctx, bot, chatId, state);

        if (raw === "__manual__") {
            state.step = "model_manual";
            saveState(state);
            await replaceStep(bot, chatId, state, texts(uiLang(state)).modelManual);
            return;
        }
    }
}

export async function handleConfigWizardText(ctx, bot) {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text.trim();
    let state = loadState();

    if (text === "/config") {
        await openConfigWizard(ctx, bot);
        return;
    }

    if (!state) {
        if (!isConfigReady()) {
            if (hasOwner() && !isApproved(chatId)) {
                const lang = loadUserConfig().language || "en";
                const { code, minutes } = issuePendingCode(chatId);
                await sendMessageSafe(ctx.api, String(ctx.chat.id), t("auth_pending", lang, { code, minutes, approveCmd: getApproveCliHint(code) }));
                return;
            }
            state = emptyState(chatId);
            saveState(state);
            await replaceStep(bot, chatId, state, texts("en").welcome, languageKeyboard("en"));
        }
        return;
    }

    const access = assertWizardChat(ctx, state);
    if (!access.ok) {
        await sendMessageSafe(ctx.api, String(ctx.chat.id), texts(access.lang).busy);
        return;
    }

    const userMessageId = ctx.message.message_id;
    const msg = texts(uiLang(state));

    switch (state.step) {
        case "menu": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            await showMenuStep(bot, chatId, state);
            return;
        }
        case "language": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.welcome}`, languageKeyboard(uiLang(state)));
            return;
        }
        case "provider": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            await replaceStep(bot, chatId, state, msg.provider, providerKeyboard(uiLang(state), state));
            return;
        }
        case "base_url": {
            const baseURL = text.replace(/\/$/, "");
            if (!baseURL.startsWith("http")) {
                await deleteMessageSafe(bot, chatId, userMessageId);
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.baseURL}`);
                return;
            }
            state.data.baseURL = baseURL;
            state.step = "api_key";
            saveState(state);
            await applyConfig({ baseURL });
            await deleteMessageSafe(bot, chatId, userMessageId);
            await replaceStep(bot, chatId, state, msg.apiKey);
            return;
        }
        case "api_key": {
            if (text.length < 8) {
                await deleteMessageSafe(bot, chatId, userMessageId);
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.apiKey}`);
                return;
            }
            state.data.apiKey = text;
            await applyConfig({ apiKey: text });
            await deleteMessageSafe(bot, chatId, userMessageId);
            if (isReconfig(state) && state.data.afterApiKey === "menu") {
                delete state.data.afterApiKey;
                saveState(state);
                await returnToMenu(bot, chatId, state);
                return;
            }
            await sendModelStep(bot, chatId, state);
            return;
        }
        case "model_loading": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            return;
        }
        case "codex_login": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            return;
        }
        case "grok_login": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            return;
        }
        case "model_vendor": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${vendorCaption(uiLang(state), state)}`, vendorKeyboard(state));
            return;
        }
        case "model_variant": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${variantCaption(uiLang(state), state)}`, variantKeyboard(state));
            return;
        }
        case "thinking_manual": {
            if (!text) {
                await deleteMessageSafe(bot, chatId, userMessageId);
                await replaceStep(bot, chatId, state, msg.thinkingManual);
                return;
            }
            state.data.thinkingLevel = text.trim().toLowerCase();
            await applyConfig({ thinkingLevel: state.data.thinkingLevel, thinkingMeta: { levels: [], defaultLevel: state.data.thinkingLevel } });
            await deleteMessageSafe(bot, chatId, userMessageId);
            if (isReconfig(state)) {
                await returnToMenu(bot, chatId, state);
                return;
            }
            await returnToMenu(bot, chatId, state);
            return;
        }
        case "model_manual": {
            if (!text) {
                await deleteMessageSafe(bot, chatId, userMessageId);
                await replaceStep(bot, chatId, state, msg.invalid);
                return;
            }
            state.data.model = text;
            await completeModelSelection(bot, chatId, state, { userMessageId });
            return;
        }
        default:
            state.step = "language";
            saveState(state);
            await deleteMessageSafe(bot, chatId, userMessageId);
            await replaceStep(bot, chatId, state, texts("en").welcome, languageKeyboard("en"));
    }
}
