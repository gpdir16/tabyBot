import { addSuggestion, addTodo, completeTodo, getTodo, listTodos, offerHandoff, removeTodo, updateTodo, withdrawHandoff } from "../todos/store.js";
import { queueTodoNow } from "../todos/scheduler.js";
import { getAgent } from "../agents-store.js";
import { isValidId } from "../web/conversations.js";
import { defaultTimeZone } from "../scheduling/time.js";
import { emit } from "../web/bus.js";

function emitChanged() {
    emit({ type: "todos_changed" });
}

const scheduleParams = {
    cron: { type: "string", description: "5-field cron in the item timezone, e.g. 0 0 * * * for daily midnight" },
    every: { type: "string", description: 'Interval like "2h" or "1d" (min 60s)' },
    at: { type: "string", description: 'One-shot ISO datetime, e.g. "2026-09-12T08:00"' },
    timezone: { type: "string", description: `IANA timezone, e.g. Asia/Tokyo (default ${defaultTimeZone()})` },
};

export const todoToolDefinitions = [
    {
        type: "function",
        function: {
            name: "todo_list",
            description:
                "List the user's todos, your own automations (scheduled jobs on your list), and pending suggestions. The user's tasks are not your work plan.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_add",
            description:
                "Add an automation to YOUR list. It is a scheduled job you run yourself, and it needs no user approval. Requires exactly one trigger: cron / every / at. Results post to conversationId (default: this thread). The user sees it in the Automations section of the Agents list and can pause/edit/delete it. For the user's own task list, use todo_suggest instead.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Short label" },
                    prompt: {
                        type: "string",
                        description:
                            "Self-contained instruction to follow when it fires: what to check, what counts as a finding, whether to speak when nothing happened (default: stay silent unless there is something to tell).",
                    },
                    ...scheduleParams,
                    conversationId: {
                        type: "string",
                        description: "Bot thread id (agent uuid) to post results into. Defaults to the current thread.",
                    },
                    fireImmediately: { type: "boolean", description: "Also queue a run right after creating (default false)" },
                    enabled: { type: "boolean" },
                },
                required: ["title", "prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_update",
            description:
                "Update one of YOUR automations in place (title, prompt, schedule, timezone, enabled to pause/resume, conversationId, fireImmediately). This works only on your own list. User todos need todo_suggest.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    prompt: { type: "string" },
                    ...scheduleParams,
                    conversationId: { type: "string" },
                    fireImmediately: { type: "boolean" },
                    enabled: { type: "boolean" },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_delete",
            description: "Delete one of YOUR automations by id.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_run",
            description: "Run one of YOUR automations once now (test). Does not consume a one-shot or change nextRunAt.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_suggest",
            description:
                "Propose adding, editing, or deleting a user todo. The user must approve it in the UI. Never write the user's list directly.",
            parameters: {
                type: "object",
                properties: {
                    kind: { type: "string", description: "add, edit, or delete" },
                    id: { type: "string", description: "Existing todo id (required for edit/delete)" },
                    title: { type: "string" },
                    reason: { type: "string", description: "Why you are proposing this. Shown to the user." },
                    prompt: { type: "string", description: "If a bot later does this, what it should do." },
                    clearSchedule: { type: "boolean", description: "For edit: remove the existing schedule entirely" },
                    ...scheduleParams,
                },
                required: ["kind", "reason"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_offer",
            description:
                "Offer to do an existing user todo (handoff). Other bots may also offer. The user chooses who, if anyone, takes it. Call this when the task is something you can actually perform with your tools.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Todo id" },
                    reason: { type: "string", description: "Short why you can do this. Shown next to your name." },
                    prompt: { type: "string", description: "Instruction you will follow when the user accepts and the item fires." },
                },
                required: ["id", "reason"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_withdraw",
            description:
                "Withdraw your handoff offer on a todo. This only removes your offer. It does not unassign a task the user already gave you.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_complete",
            description: "Mark a todo done only when the user said they finished it.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
];

function defaultConversationId(args, ctx) {
    const requested = String(args?.conversationId || "").trim();
    if (isValidId(requested)) return requested;
    const current = String(ctx?.sessionKey || ctx?.chatId || "").trim();
    if (isValidId(current)) return current;
    return "";
}

// 자기 리스트 항목만 만질 수 있다. 유저 리스트는 제안 경로로 안내.
function ownItem(id, agentId) {
    const item = getTodo(id);
    if (!item) return { err: "not_found" };
    const list = item.list || "user";
    if (list === "user") return { err: "user_list_item" };
    if (list !== agentId) return { err: "not_found" };
    return { item };
}

// 일정 관련 인자(cron/every/at/timezone)를 그대로 골라낸다.
const scheduleArgs = (args) => ({ cron: args?.cron, every: args?.every, at: args?.at, timezone: args?.timezone });

// 자기 리스트의 항목을 찾는다. 못 찾거나 유저 항목이면 { error }.
function ownItemOrError(id, agentId) {
    const { item, err } = ownItem(id, agentId);
    if (err === "user_list_item") return { error: "user todos need todo_suggest" };
    if (!item) return { error: "not_found" };
    return { item };
}

// todo_update에서 conversationId: 비우면 연결 해제(""), 유효하지 않은 값은 무시(undefined).
function conversationIdForUpdate(args) {
    if (args?.conversationId == null) return undefined;
    const value = String(args.conversationId).trim();
    if (!value) return "";
    return isValidId(value) ? value : undefined;
}

// 항목을 바꾼 도구 결과: 오류가 없으면 변경 이벤트를 내보낸다.
function emitIfOk(result) {
    if (!result.error) emitChanged();
    return result;
}

const TODO_TOOL_HANDLERS = {
    todo_list(_args, _ctx, agentId) {
        const { items, suggestions, recovered } = listTodos();
        return {
            todos: items.filter((row) => (row.list || "user") === "user"),
            automations: items.filter((row) => (row.list || "user") === agentId),
            suggestions,
            recovered,
        };
    },

    todo_add(args, ctx, agentId) {
        const given = [args?.cron, args?.every, args?.at].filter((v) => v != null && String(v).trim() !== "").length;
        if (given !== 1) return { error: "Provide exactly one of cron, every, or at." };
        const result = addTodo({
            title: args?.title ?? args?.name,
            prompt: args?.prompt,
            ...scheduleArgs(args),
            list: agentId,
            conversationId: defaultConversationId(args, ctx),
            enabled: args?.enabled,
            fireImmediately: args?.fireImmediately,
            createdBy: "agent",
        });
        if (result.error) return result;
        emitChanged();
        return { ok: true, item: result.item };
    },

    todo_update(args, _ctx, agentId) {
        const owned = ownItemOrError(args?.id, agentId);
        if (owned.error) return owned;
        const result = updateTodo(
            owned.item.id,
            {
                title: args?.title != null ? args.title : undefined,
                prompt: args?.prompt,
                ...scheduleArgs(args),
                conversationId: conversationIdForUpdate(args),
                fireImmediately: args?.fireImmediately,
                enabled: args?.enabled,
            },
            { editedBy: "agent" },
        );
        if (result.error) return result;
        emitChanged();
        return { ok: true, item: result.item };
    },

    todo_delete(args, _ctx, agentId) {
        const owned = ownItemOrError(args?.id, agentId);
        if (owned.error) return owned;
        const result = removeTodo(owned.item.id);
        emitChanged();
        return result;
    },

    todo_run(args, _ctx, agentId) {
        const owned = ownItemOrError(args?.id, agentId);
        if (owned.error) return owned;
        const { item } = owned;
        if (item.status !== "open") return { error: "not_open" };
        const agent = getAgent(item.assigneeId || item.list);
        if (!agent) return { error: "agent_not_found" };
        return queueTodoNow(agent, item);
    },

    todo_suggest(args, _ctx, agentId) {
        const kind = String(args?.kind || "add");
        const clearSchedule = args?.clearSchedule === true;
        const result = addSuggestion({
            kind,
            targetId: args?.id,
            agentId,
            title: args?.title,
            reason: args?.reason,
            prompt: args?.prompt,
            ...scheduleArgs(args),
            patch:
                kind === "edit"
                    ? {
                          title: args?.title,
                          prompt: args?.prompt,
                          ...scheduleArgs(args),
                          clearWhen: clearSchedule,
                          kind: clearSchedule ? "none" : undefined,
                      }
                    : null,
        });
        if (!result.error) emitChanged();
        return result.error ? result : { ok: true, suggested: true, suggestion: result.suggestion };
    },

    todo_offer(args, _ctx, agentId) {
        return emitIfOk(offerHandoff(args?.id, { agentId, reason: args?.reason, prompt: args?.prompt }));
    },

    todo_withdraw(args, _ctx, agentId) {
        return emitIfOk(withdrawHandoff(args?.id, agentId));
    },

    todo_complete(args) {
        if (!getTodo(args?.id)) return { error: "not_found" };
        return emitIfOk(completeTodo(args.id));
    },
};

export async function executeTodoTool(name, args, ctx = {}) {
    const agentId = ctx.agentId;
    if (!agentId) return { error: "no agent in this turn" };
    const handler = Object.hasOwn(TODO_TOOL_HANDLERS, name) ? TODO_TOOL_HANDLERS[name] : null;
    if (!handler) return { error: `Unknown todo tool: ${name}` };
    return handler(args, ctx, agentId);
}
