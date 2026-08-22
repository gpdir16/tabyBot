import { addCronJob, listCronJobs, removeCronJob, updateCronJob } from "../cron/store.js";
import { reloadCronSchedules } from "../cron/scheduler.js";
import { cronListDescription } from "../path-labels.js";

export const cronToolDefinitions = [
    {
        type: "function",
        function: {
            name: "cron_list",
            description: cronListDescription(),
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "cron_add",
            description:
                "Add a cron job (standard cron syntax, server timezone). Runs only when the agent is idle; waits if a user turn is in progress.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    schedule: { type: "string", description: "e.g. 0 9 * * * for 09:00 daily" },
                    prompt: { type: "string", description: "Instruction for the agent when the job fires" },
                    chatId: { type: "string", description: "Telegram chat id to notify" },
                },
                required: ["name", "schedule", "prompt", "chatId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cron_remove",
            description: "Remove a cron job by id.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cron_set_enabled",
            description: "Enable or disable a cron job by id.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    enabled: { type: "boolean" },
                },
                required: ["id", "enabled"],
            },
        },
    },
];

export async function executeCronTool(name, args) {
    switch (name) {
        case "cron_list":
            return { jobs: listCronJobs() };
        case "cron_add": {
            const job = addCronJob(args || {});
            const reload = reloadCronSchedules();
            return { ok: true, job, reload };
        }
        case "cron_remove": {
            const result = removeCronJob(args?.id);
            const reload = reloadCronSchedules();
            return { ...result, reload };
        }
        case "cron_set_enabled": {
            const job = updateCronJob(args?.id, { enabled: args?.enabled });
            if (!job) return { error: "job not found" };
            const reload = reloadCronSchedules();
            return { ok: true, job, reload };
        }
        default:
            return { error: `Unknown cron tool: ${name}` };
    }
}
