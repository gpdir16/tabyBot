import { addSuggestion, completeTodo, getTodo, listTodos, offerHandoff, withdrawHandoff } from "../todos/store.js";
import { emit } from "../web/bus.js";

function emitChanged() {
    emit({ type: "todos_changed" });
}

const scheduleParams = {
    cron: { type: "string", description: "5-field cron in the item timezone, e.g. 0 0 * * * for daily midnight" },
    every: { type: "string", description: 'Interval like "2h" or "1d"' },
    at: { type: "string", description: 'One-shot ISO datetime, e.g. "2026-09-12T08:00"' },
    timezone: { type: "string", description: "IANA timezone, e.g. Asia/Tokyo" },
};

export const todoToolDefinitions = [
    {
        type: "function",
        function: {
            name: "todo_list",
            description: "List the user's todos and pending suggestions. These are the user's tasks, not your work plan.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "todo_suggest",
            description: "Propose adding, editing, or deleting a user todo. The user must approve it in the UI. Never write the list directly.",
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

export async function executeTodoTool(name, args, ctx = {}) {
    const agentId = ctx.agentId;
    if (!agentId) return { error: "no agent in this turn" };

    switch (name) {
        case "todo_list":
            return listTodos();
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
