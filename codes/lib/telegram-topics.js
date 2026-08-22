import { safeTelegramApi, createForumTopicSafe, sendMessageSafe } from "./telegram-api.js";
import { DEFAULT_AGENT_NAME, getMainThreadId, setMainThreadId, topicIconColor } from "./agents-store.js";
import { loadUserConfig } from "./config-loader.js";
import { t } from "./i18n.js";

let topicsEnabledCache = null;
let usersCanCreateTopicsCache = null;

export function getTopicsEnabled() {
    return topicsEnabledCache;
}

export function getTopicsSetupReady() {
    return topicsEnabledCache === true && usersCanCreateTopicsCache === false;
}

export function markTopicsDisabled() {
    topicsEnabledCache = false;
}

export async function refreshTopicsEnabled(bot) {
    const api = bot?.api || bot;
    if (!api) {
        topicsEnabledCache = false;
        usersCanCreateTopicsCache = null;
        return false;
    }
    const res = await safeTelegramApi(() => api.getMe());
    topicsEnabledCache = Boolean(res.ok && res.result?.has_topics_enabled);
    usersCanCreateTopicsCache = res.ok ? Boolean(res.result?.allows_users_to_create_topics) : null;
    return topicsEnabledCache;
}

// 전체는 All Messages라 글을 쓸 수 없다. 메인은 전용 토픽이 필요하다.
export async function ensureMainTopic(bot, chatId) {
    const existing = getMainThreadId();
    if (existing) return existing;
    if (getTopicsEnabled() !== true) {
        await refreshTopicsEnabled(bot);
    }
    if (!getTopicsSetupReady()) return null;

    const created = await createForumTopicSafe(bot, chatId, DEFAULT_AGENT_NAME, { icon_color: topicIconColor(DEFAULT_AGENT_NAME) });
    const threadId = created.result?.message_thread_id;
    if (!created.ok || !threadId) return null;
    setMainThreadId(threadId);
    // 전체와 tabyAgent를 헷갈리지 않도록 생성 직후에만 안내
    const lang = loadUserConfig().language || "en";
    await sendMessageSafe(bot, chatId, t("main_topic_notice", lang), { message_thread_id: threadId });
    return threadId;
}
