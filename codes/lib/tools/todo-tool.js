import { addSuggestion, addTodo, completeTodo, getTodo, listTodos, offerHandoff, removeTodo, updateTodo, withdrawHandoff } from "../todos/store.js";
import { queueTodoNow } from "../todos/scheduler.js";
import { getAgent } from "../agents-store.js";
import { isValidId } from "../web/conversations.js";
import { defaultTimeZone } from "../scheduling/time.js";
import { emit } from "../web/bus.js";

export const SCHEDULED_TURN_MARKER = "[tabybot-scheduled]";

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
                "Add an automation to YOUR list — a scheduled job you run yourself, no user approval needed. Requires exactly one trigger: cron / every / at. Results post to conversationId (default: this thread). The user sees it under Agents → Automations and can pause/edit/delete it. For the user's own task list, use todo_suggest instead.",
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
                "Update one of YOUR automations in place (title, prompt, schedule, timezone, enabled to pause/resume, conversationId, fireImmediately). Only your own list — user todos need todo_suggest.",
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
            description: "Withdraw your handoff offer on a todo. Only removes your offer — it does not unassign a task the user already gave you.",
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

export async function executeTodoTool(name, args, ctx = {}) {
    const agentId = ctx.agentId;
    if (!agentId) return { error: "no agent in this turn" };

    switch (name) {
        case "todo_list": {
            const { items, suggestions, recovered } = listTodos();
            return {
                todos: items.filter((row) => (row.list || "user") === "user"),
                automations: items.filter((row) => (row.list || "user") === agentId),
                suggestions,
                recovered,
            };
        }
        case "todo_add": {
            const given = [args?.cron, args?.every, args?.at].filter((v) => v != null && String(v).trim() !== "").length;
            if (given !== 1) return { error: "Provide exactly one of cron, every, or at." };
            const result = addTodo({
                title: args?.title ?? args?.name,
                prompt: args?.prompt,
                cron: args?.cron,
                every: args?.every,
                at: args?.at,
                timezone: args?.timezone,
                list: agentId,
                conversationId: defaultConversationId(args, ctx),
                enabled: args?.enabled,
                fireImmediately: args?.fireImmediately,
                createdBy: "agent",
            });
            if (result.error) return result;
            emitChanged();
            return { ok: true, item: result.item };
        }
        case "todo_update": {
            const { item, err } = ownItem(args?.id, agentId);
            if (err === "user_list_item") return { error: "user todos need todo_suggest" };
            if (!item) return { error: "not_found" };
            const result = updateTodo(
                item.id,
                {
                    title: args?.title != null ? args.title : undefined,
                    prompt: args?.prompt,
                    cron: args?.cron,
                    every: args?.every,
                    at: args?.at,
                    timezone: args?.timezone,
                    conversationId: (() => {
                        if (args?.conversationId == null) return undefined;
                        const v = String(args.conversationId).trim();
                        if (!v) return "";
                        return isValidId(v) ? v : undefined;
                    })(),
                    fireImmediately: args?.fireImmediately,
                    enabled: args?.enabled,
                },
                { editedBy: "agent" },
            );
            if (result.error) return result;
            emitChanged();
            return { ok: true, item: result.item };
        }
        case "todo_delete": {
            const { item, err } = ownItem(args?.id, agentId);
            if (err === "user_list_item") return { error: "user todos need todo_suggest" };
            if (!item) return { error: "not_found" };
            const result = removeTodo(item.id);
            emitChanged();
            return result;
        }
        case "todo_run": {
            const { item, err } = ownItem(args?.id, agentId);
            if (err === "user_list_item") return { error: "user todos need todo_suggest" };
            if (!item) return { error: "not_found" };
            if (item.status !== "open") return { error: "not_open" };
            const agent = getAgent(item.assigneeId || item.list);
            if (!agent) return { error: "agent_not_found" };
            return queueTodoNow(agent, item);
        }
        case "todo_suggest": {
            const kind = String(args?.kind || "add");
            const result = addSuggestion({
                kind,
                targetId: args?.id,
                agentId,
                title: args?.title,
                reason: args?.reason,
                prompt: args?.prompt,
                cron: args?.cron,
                every: args?.every,
                at: args?.at,
                timezone: args?.timezone,
                patch:
                    kind === "edit"
                        ? {
                              title: args?.title,
                              prompt: args?.prompt,
                              cron: args?.cron,
                              every: args?.every,
                              at: args?.at,
                              timezone: args?.timezone,
                              clearWhen: args?.clearSchedule === true,
                              kind: args?.clearSchedule === true ? "none" : undefined,
                          }
                        : null,
            });
            if (!result.error) emitChanged();
            return result.error ? result : { ok: true, suggested: true, suggestion: result.suggestion };
        }
        case "todo_offer": {
            const result = offerHandoff(args?.id, {
                agentId,
                reason: args?.reason,
                prompt: args?.prompt,
            });
            if (!result.error) emitChanged();
            return result;
        }
        case "todo_withdraw": {
            const result = withdrawHandoff(args?.id, agentId);
            if (!result.error) emitChanged();
            return result;
        }
        case "todo_complete": {
            const existing = getTodo(args?.id);
            if (!existing) return { error: "not_found" };
            const result = completeTodo(args.id);
            if (!result.error) emitChanged();
            return result;
        }
        default:
            return { error: `Unknown todo tool: ${name}` };
    }
}
