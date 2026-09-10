import { addScheduleJob, getScheduleJob, listScheduleJobs, removeScheduleJob, updateScheduleJob } from "../scheduling/store.js";
import { queueScheduleJobNow, reloadScheduleJobs } from "../scheduling/scheduler.js";
import { schedulingListDescription } from "../path-labels.js";
import { defaultTimeZone } from "../scheduling/time.js";
import { isValidId } from "../web/conversations.js";

export const SCHEDULED_TURN_MARKER = "[tabybot-scheduled]";

export const scheduleToolDefinitions = [
    {
        type: "function",
        function: {
            name: "schedule_list",
            description: schedulingListDescription(),
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "schedule_create",
            description:
                "Create a scheduling job. Provide exactly one of: cron (5-field, e.g. 30 8 * * 1-5), every (interval, e.g. 5m/2h/1d, min 60s), or at (one-shot ISO datetime). Uses IANA timezone (default server TZ). Runs when idle; waits if that conversation is mid-turn. Results post into conversationId (defaults to this conversation).",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Short label" },
                    prompt: {
                        type: "string",
                        description:
                            "Self-contained instruction for the agent when the job fires. Include what to check, what counts as a finding, and whether to speak when nothing happened (default: stay silent unless there is something to tell).",
                    },
                    cron: { type: "string", description: "5-field cron in the job timezone, e.g. 0 9 * * 1-5" },
                    every: { type: "string", description: 'Interval like "5m", "2h", "1d", "60s"' },
                    at: { type: "string", description: 'One-shot ISO datetime, e.g. "2026-09-11T08:00"' },
                    timezone: {
                        type: "string",
                        description: `IANA timezone (default ${defaultTimeZone()})`,
                    },
                    conversationId: {
                        type: "string",
                        description: "Conversation to post into. Defaults to the current conversation.",
                    },
                    fireImmediately: {
                        type: "boolean",
                        description: "Also queue a run right after creating the job (default false)",
                    },
                    enabled: { type: "boolean" },
                },
                required: ["name", "prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "schedule_update",
            description: "Update a scheduling job in place (name, prompt, schedule, timezone, enabled, conversation).",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    prompt: { type: "string" },
                    cron: { type: "string" },
                    every: { type: "string" },
                    at: { type: "string" },
                    timezone: { type: "string" },
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
            name: "schedule_delete",
            description: "Delete a scheduling job by id.",
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
            name: "schedule_run",
            description: "Run a scheduling job once now (test). Does not consume a one-shot at-job or change nextRunAt.",
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

export async function executeScheduleTool(name, args, ctx = {}) {
    switch (name) {
        case "schedule_list":
            return { timezone: defaultTimeZone(), jobs: listScheduleJobs() };
        case "schedule_create": {
            const result = addScheduleJob({
                name: args?.name,
                prompt: args?.prompt,
                cron: args?.cron,
                every: args?.every,
                at: args?.at,
                timezone: args?.timezone,
                conversationId: defaultConversationId(args, ctx),
                agentId: ctx?.agentId || "",
                fireImmediately: args?.fireImmediately,
                enabled: args?.enabled,
            });
            if (result.error) return result;
            const reload = reloadScheduleJobs();
            return { ok: true, job: result.job, reload };
        }
        case "schedule_update": {
            const result = updateScheduleJob(args?.id, {
                name: args?.name,
                prompt: args?.prompt,
                cron: args?.cron,
                every: args?.every,
                at: args?.at,
                timezone: args?.timezone,
                conversationId: isValidId(String(args?.conversationId || "").trim()) ? String(args.conversationId).trim() : undefined,
                fireImmediately: args?.fireImmediately,
                enabled: args?.enabled,
            });
            if (result.error) return result;
            const reload = reloadScheduleJobs();
            return { ok: true, job: result.job, reload };
        }
        case "schedule_delete": {
            const result = removeScheduleJob(args?.id);
            const reload = reloadScheduleJobs();
            return { ...result, reload };
        }
        case "schedule_run": {
            const job = getScheduleJob(args?.id);
            if (!job) return { error: "job not found" };
            return queueScheduleJobNow(job);
        }
        default:
            return { error: `Unknown schedule tool: ${name}` };
    }
}
