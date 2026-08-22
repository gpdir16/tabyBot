import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";
import { USER_DIR } from "./paths.js";
import { loadUserConfig } from "./config-loader.js";
import { isConfigReady, openConfigWizard } from "./onboarding.js";
import { deleteMessageSafe, sendMessageSafe, createForumTopicSafe, deleteForumTopicSafe, editForumTopicSafe } from "./telegram-api.js";
import { extractThreadId, telegramThreadOpts } from "./agent-route.js";
import { getTopicsSetupReady, refreshTopicsEnabled, ensureMainTopic } from "./telegram-topics.js";
import {
    DEFAULT_AGENT_ID,
    DEFAULT_AGENT_NAME,
    addAgent,
    canAddAgent,
    findAgentByThread,
    getAgent,
    listAgents,
    removeAgent,
    topicIconColor,
    updateAgent,
} from "./agents-store.js";

const STATE_PATH = path.join(USER_DIR, "temp", "agents-wizard.json");

function texts(lang) {
    const t = {
        en: {
            title: "All agents",
            intro: "You can add agents used only for a specific task or role.\nEach gets its own session and memory, and they can also collaborate with other agents or use the shared memory.",
            defaultName: "Default tabyAgent",
            add: "+ Add agent",
            topicsOff:
                "In @BotFather: your bot → Bot Settings → Threads Settings\n1. Turn on Threaded Mode\n2. Turn on Disallow users to create new threads\n\nIf setting 2 is off, Telegram’s thread layout can conflict with tabyAgent and conversations can get tangled. If you turn on setting 1, you must also turn on setting 2.",
            namePrompt: "Send a name for the new agent (shown as the topic title).",
            personaPrompt: "Briefly describe what this agent should do.",
            renamePrompt: "Send the new name.",
            personaEditPrompt: "Briefly describe what this agent should do.",
            detailTitle: "Agent: {name}",
            rename: "Rename",
            editPersona: "Edit role",
            delete: "Delete",
            deleteConfirm: "Delete “{name}”? Its topic and private memory will be removed.",
            deleteYes: "Yes, delete",
            createFailed: "Could not create the Telegram topic: {error}",
            tooMany: "You already have the maximum number of extra agents.",
            backList: "◀ All agents",
            done: "Done",
            invalid: "Invalid input. Tap a button or send /agents to restart.",
        },
        ko: {
            title: "모든 에이전트",
            intro: "특정 작업이나 역할에만 쓰이는 에이전트를 추가할수 있습니다.\n개별적인 세션, 메모리가 생기며 다른 에이전트와 협동하거나 공통 메모리를 사용하는 등의 작업도 추가로 수행할수 있습니다.",
            defaultName: "기본 tabyAgent",
            add: "+ 에이전트 추가",
            topicsOff:
                "@BotFather → 봇 → Bot Settings → Threads Settings\n1. Threaded Mode 켜기\n2. Disallow users to create new threads 켜기\n\n2번 설정을 활성화하지 않으면 텔레그램 쓰레드 구조와 tabyAgent가 충돌해 대화가 꼬일수 있습니다. 1번 설정을 활성화한 경우 2번 설정도 반드시 활성화하세요.",
            namePrompt: "새 에이전트 이름을 보내주세요. 토픽 제목으로 쓰입니다.",
            personaPrompt: "이 에이전트가 수행할 작업이 무엇인지 간단하게 설명해주세요",
            renamePrompt: "새 이름을 보내주세요.",
            personaEditPrompt: "이 에이전트가 수행할 작업이 무엇인지 간단하게 설명해주세요",
            detailTitle: "에이전트: {name}",
            rename: "이름 바꾸기",
            editPersona: "역할 바꾸기",
            delete: "삭제",
            deleteConfirm: "“{name}”을(를) 삭제할까요? 토픽과 전용 메모리가 제거됩니다.",
            deleteYes: "삭제",
            createFailed: "텔레그램 토픽을 만들지 못했습니다: {error}",
            tooMany: "추가 에이전트 한도에 도달했습니다.",
            backList: "◀ 모든 에이전트",
            done: "완료",
            invalid: "잘못된 입력입니다. 버튼을 누르거나 /agents 로 다시 시작하세요.",
        },
        ja: {
            title: "すべてのエージェント",
            intro: "特定の作業や役割だけに使うエージェントを追加できます。\n個別のセッションとメモリができ、他のエージェントと協働したり共有メモリを使ったりもできます。",
            defaultName: "デフォルト tabyAgent",
            add: "+ エージェントを追加",
            topicsOff:
                "@BotFather → ボット → Bot Settings → Threads Settings\n1. Threaded Mode をオン\n2. Disallow users to create new threads をオン\n\n2 をオンにしないと、Telegram のスレッド構造と tabyAgent が衝突して会話が乱れます。1 をオンにしたら 2 も必ずオンにしてください。",
            namePrompt: "新しいエージェント名を送ってください。トピック名になります。",
            personaPrompt: "このエージェントが行う作業を簡単に説明してください",
            renamePrompt: "新しい名前を送ってください。",
            personaEditPrompt: "このエージェントが行う作業を簡単に説明してください",
            detailTitle: "エージェント: {name}",
            rename: "名前を変更",
            editPersona: "役割を変更",
            delete: "削除",
            deleteConfirm: "“{name}” を削除しますか？トピックと専用メモリが削除されます。",
            deleteYes: "削除する",
            createFailed: "Telegram トピックを作成できませんでした: {error}",
            tooMany: "追加エージェントの上限です。",
            backList: "◀ すべてのエージェント",
            done: "完了",
            invalid: "無効な入力です。ボタンを押すか /agents で最初から。",
        },
    };
    return t[lang] || t.en;
}

function lang() {
    return loadUserConfig().language || "en";
}

function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
}

function loadState() {
    if (!fs.existsSync(STATE_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    } catch (err) {
        console.error("tabyAgent: invalid agents wizard state:", err.message);
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

export function isAgentsWizardActive(chatId) {
    const state = loadState();
    return Boolean(state?.adminChatId === String(chatId) && state?.step);
}

async function replaceStep(bot, chatId, state, text, keyboard) {
    await deleteMessageSafe(bot, chatId, state.activeMessageId);
    state.activeMessageId = null;
    const opts = { ...telegramThreadOpts(state.threadId), ...(keyboard ? { reply_markup: keyboard } : {}) };
    const sent = await sendMessageSafe(bot, chatId, text, opts);
    state.activeMessageId = sent.messageIds[0] ?? null;
    saveState(state);
}

function listKeyboard() {
    const msg = texts(lang());
    const kb = new InlineKeyboard();
    kb.text(msg.defaultName, "ag:v:main").row();
    for (const agent of listAgents()) {
        kb.text(agent.name, `ag:v:${agent.id}`).row();
    }
    if (canAddAgent()) kb.text(msg.add, "ag:add").row();
    kb.text(msg.done, "ag:done");
    return kb;
}

function detailKeyboard(agentId) {
    const msg = texts(lang());
    const kb = new InlineKeyboard();
    if (agentId !== DEFAULT_AGENT_ID) {
        kb.text(msg.rename, `ag:ren:${agentId}`).row();
        kb.text(msg.editPersona, `ag:per:${agentId}`).row();
        kb.text(msg.delete, `ag:del:${agentId}`).row();
    }
    kb.text(msg.backList, "ag:list");
    return kb;
}

function detailText(agentId) {
    const msg = texts(lang());
    if (agentId === DEFAULT_AGENT_ID) {
        return `${fill(msg.detailTitle, { name: DEFAULT_AGENT_NAME })}\n\n${msg.intro}`;
    }
    const agent = getAgent(agentId);
    if (!agent) return msg.title;
    const role = agent.persona ? `\n\n${agent.persona}` : "";
    return `${fill(msg.detailTitle, { name: agent.name })}${role}`;
}

async function showList(bot, chatId, state) {
    const msg = texts(lang());
    state.step = "list";
    delete state.draftName;
    delete state.editId;
    saveState(state);
    await replaceStep(bot, chatId, state, `${msg.title}\n\n${msg.intro}`, listKeyboard());
}

export async function openAgentsWizard(ctx, bot) {
    const chatId = String(ctx.chat.id);
    if (!isConfigReady()) {
        await openConfigWizard(ctx, bot);
        return;
    }

    const prev = loadState();
    if (prev?.activeMessageId) {
        await deleteMessageSafe(bot, chatId, prev.activeMessageId);
    }

    const state = {
        step: "list",
        adminChatId: chatId,
        threadId: findAgentByThread(extractThreadId(ctx))?.threadId ?? null,
        activeMessageId: null,
    };
    saveState(state);
    await refreshTopicsEnabled(bot);
    await ensureMainTopic(bot, chatId);
    await showList(bot, chatId, state);
}

async function createAgent(bot, chatId, name, persona) {
    const msg = texts(lang());
    if (!canAddAgent()) return { error: msg.tooMany };
    const created = await createForumTopicSafe(bot, chatId, name, { icon_color: topicIconColor(name) });
    if (!created.ok) return { error: fill(msg.createFailed, { error: created.error || "unknown" }) };
    const threadId = created.result?.message_thread_id;
    if (!threadId) return { error: fill(msg.createFailed, { error: "no thread id" }) };
    const added = addAgent({ name, persona, threadId });
    if (added.error) {
        await deleteForumTopicSafe(bot, chatId, threadId);
        return { error: added.error === "too_many" ? msg.tooMany : fill(msg.createFailed, { error: added.error }) };
    }
    return { agent: added.agent };
}

export async function handleAgentsWizardCallback(ctx, bot) {
    const data = String(ctx.callbackQuery?.data || "");
    const state = loadState();
    const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || "");
    if (!state || state.adminChatId !== chatId) {
        await ctx.answerCallbackQuery();
        return;
    }

    const msg = texts(lang());
    await ctx.answerCallbackQuery();

    if (data === "ag:done") {
        await deleteMessageSafe(bot, chatId, state.activeMessageId);
        clearState();
        return;
    }
    if (data === "ag:list") {
        await showList(bot, chatId, state);
        return;
    }
    if (data === "ag:add") {
        if (!canAddAgent()) {
            await showList(bot, chatId, state);
            return;
        }
        await refreshTopicsEnabled(bot);
        if (!getTopicsSetupReady()) {
            state.step = "list";
            saveState(state);
            await replaceStep(bot, chatId, state, msg.topicsOff, new InlineKeyboard().text(msg.backList, "ag:list"));
            return;
        }
        await ensureMainTopic(bot, chatId);
        state.step = "name";
        saveState(state);
        await replaceStep(bot, chatId, state, msg.namePrompt);
        return;
    }
    if (data.startsWith("ag:v:")) {
        const id = data.slice("ag:v:".length);
        state.step = "detail";
        state.editId = id;
        saveState(state);
        await replaceStep(bot, chatId, state, detailText(id), detailKeyboard(id));
        return;
    }
    if (data.startsWith("ag:ren:")) {
        const id = data.slice("ag:ren:".length);
        if (!getAgent(id)) return;
        state.step = "rename";
        state.editId = id;
        saveState(state);
        await replaceStep(bot, chatId, state, msg.renamePrompt);
        return;
    }
    if (data.startsWith("ag:per:")) {
        const id = data.slice("ag:per:".length);
        if (!getAgent(id)) return;
        state.step = "persona_edit";
        state.editId = id;
        saveState(state);
        await replaceStep(bot, chatId, state, msg.personaEditPrompt);
        return;
    }
    if (data.startsWith("ag:del:")) {
        const id = data.slice("ag:del:".length);
        const agent = getAgent(id);
        if (!agent) return;
        state.step = "delete_confirm";
        state.editId = id;
        saveState(state);
        const kb = new InlineKeyboard().text(msg.deleteYes, `ag:ok:${id}`).row().text(msg.backList, `ag:v:${id}`);
        await replaceStep(bot, chatId, state, fill(msg.deleteConfirm, { name: agent.name }), kb);
        return;
    }
    if (data.startsWith("ag:ok:")) {
        const id = data.slice("ag:ok:".length);
        const removed = removeAgent(id);
        if (removed.agent?.threadId) {
            await deleteForumTopicSafe(bot, chatId, removed.agent.threadId);
        }
        await showList(bot, chatId, state);
    }
}

export async function handleAgentsWizardText(ctx, bot) {
    const chatId = String(ctx.chat.id);
    const state = loadState();
    if (!state || state.adminChatId !== chatId) return false;

    const text = ctx.message.text.trim();
    const userMessageId = ctx.message.message_id;
    const msg = texts(lang());

    if (text === "/agents" || text.startsWith("/agents@")) {
        await openAgentsWizard(ctx, bot);
        return true;
    }

    switch (state.step) {
        case "name": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            const named = text.replace(/^[-–—]+$/, "").trim();
            if (!named || named.length > 32) {
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.namePrompt}`);
                return true;
            }
            state.draftName = named;
            state.step = "persona";
            saveState(state);
            await replaceStep(bot, chatId, state, msg.personaPrompt);
            return true;
        }
        case "persona": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            const persona = text.trim();
            if (!persona || persona === "-" || persona === "—") {
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.personaPrompt}`);
                return true;
            }
            const created = await createAgent(bot, chatId, state.draftName, persona);
            if (created.error) {
                state.step = "list";
                saveState(state);
                await replaceStep(bot, chatId, state, created.error, listKeyboard());
                return true;
            }
            await showList(bot, chatId, state);
            return true;
        }
        case "rename": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            const updated = updateAgent(state.editId, { name: text });
            if (updated.error) {
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.renamePrompt}`);
                return true;
            }
            if (updated.agent?.threadId) {
                await editForumTopicSafe(bot, chatId, updated.agent.threadId, { name: updated.agent.name });
            }
            state.step = "detail";
            saveState(state);
            await replaceStep(bot, chatId, state, detailText(state.editId), detailKeyboard(state.editId));
            return true;
        }
        case "persona_edit": {
            await deleteMessageSafe(bot, chatId, userMessageId);
            const persona = text.trim();
            if (!persona || persona === "-" || persona === "—") {
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.personaEditPrompt}`);
                return true;
            }
            const updated = updateAgent(state.editId, { persona });
            if (updated.error) {
                await replaceStep(bot, chatId, state, `${msg.invalid}\n\n${msg.personaEditPrompt}`);
                return true;
            }
            state.step = "detail";
            saveState(state);
            await replaceStep(bot, chatId, state, detailText(state.editId), detailKeyboard(state.editId));
            return true;
        }
        default: {
            await deleteMessageSafe(bot, chatId, userMessageId);
            if (state.step === "detail" || state.step === "delete_confirm") {
                await replaceStep(bot, chatId, state, detailText(state.editId || DEFAULT_AGENT_ID), detailKeyboard(state.editId || DEFAULT_AGENT_ID));
            } else {
                await showList(bot, chatId, state);
            }
            return true;
        }
    }
}
