import { DEFAULT_AGENT_ID, findAgentByNameOrId, getAgent } from "../agents-store.js";

export const consultAgentToolDefinitions = [
    {
        type: "function",
        function: {
            name: "consult_agent",
            description:
                "Ask another named agent to handle a self-contained task and return its answer. Use when a specialist agent is a better fit. Do not consult yourself. Nested consults are rejected.",
            parameters: {
                type: "object",
                properties: {
                    agent: {
                        type: "string",
                        description: "Target agent id or display name",
                    },
                    task: {
                        type: "string",
                        description: "Self-contained task. Include all facts the other agent needs.",
                    },
                },
                required: ["agent", "task"],
            },
        },
    },
];

export async function executeConsultAgent(_name, args, ctx = {}) {
    if (ctx.consultDepth) {
        return { error: "consult_agent cannot be nested" };
    }

    const query = String(args?.agent ?? "").trim();
    const task = String(args?.task ?? "").trim();
    if (!query) return { error: "agent is required" };
    if (!task) return { error: "task is required" };

    const lowered = query.toLowerCase();
    const target =
        lowered === DEFAULT_AGENT_ID || lowered === "tabyagent"
            ? { id: DEFAULT_AGENT_ID, name: "tabyAgent", persona: "" }
            : getAgent(query) || findAgentByNameOrId(query);
    if (!target) return { error: `unknown agent: ${query}` };
    if (target.id === (ctx.agentId || DEFAULT_AGENT_ID)) {
        return { error: "cannot consult yourself" };
    }

    ctx.onStatusPhase?.("tools", `consult:${target.name}`);

    const { runAgent } = await import("../agent/loop.js");
    const prompt = [
        `Another agent asked you to handle this task.`,
        `Reply with the result only. Do not greet the user. Do not call consult_agent.`,
        "-----",
        task,
    ].join("\n");

    const result = await runAgent(prompt, {
        chatId: ctx.chatId,
        sessionKey: `${ctx.sessionKey || ctx.chatId}:consult:${target.id}`,
        threadId: ctx.threadId,
        agentId: target.id,
        bot: ctx.bot,
        persistHistory: false,
        history: [],
        consultDepth: 1,
        session: ctx.signal
            ? {
                  signal: ctx.signal,
                  isAborted: () => Boolean(ctx.signal.aborted),
                  drainPendingMessages: () => [],
              }
            : null,
    });

    if (result?.error && result.error !== "stopped_by_user") {
        return {
            agent: target.name,
            agentId: target.id,
            error: result.error,
            detail: result.errorDetail || null,
            text: result.text || null,
        };
    }

    return {
        agent: target.name,
        agentId: target.id,
        text: result.text || "",
        silent: Boolean(result.silent),
    };
}
