// user_ask 도구: 에이전트가 작업 중 사용자에게 질문하고 답변을 기다린다.
// 사용자가 직접 정해야 하는 선택(옵션 고르기, 선호도, 진행 방향)에 쓰고,
// 외부 사이드이펙트(메일 발송, 결제, 계정 삭제 등) 승인 요청에도 사용한다.
import { askUser, cancelPendingAsk } from "../agent/user-ask.js";

const USER_ASK_DESCRIPTION = [
    "Ask the user a question and wait for their answer (inline buttons + free text).",
    "Use when you need a decision or input only the user can give: which option to pick, a preference, missing materials, or anything ambiguous that blocks progress.",
    "Also works during scheduled todo runs — while you wait, the todo shows a 'needs answer' badge so the user can see you are blocked.",
    "Pass a clear question and short options (e.g. ['승인', '취소']). The user can also type a custom answer. The wait times out (max 600s), so ask only what truly blocks you.",
].join(" ");

export const userAskToolDefinitions = [
    {
        type: "function",
        function: {
            name: "user_ask",
            description: USER_ASK_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The question to ask the user (clear and specific)" },
                    options: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional button labels (max 8). The user can also type a free-text answer.",
                    },
                    timeout: { type: "number", description: "Seconds to wait for an answer (default 120, max 600)" },
                },
                required: ["question"],
            },
        },
    },
];

export async function executeUserAskTool(_name, args, ctx) {
    if (!ctx?.sessionKey) {
        return { error: "No active session — user_ask only works during a user message turn" };
    }

    const question = String(args?.question ?? "").trim();
    if (!question) return { error: "question is required" };

    const options = Array.isArray(args?.options) ? args.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (options.length > 8) return { error: "options must be at most 8" };

    const timeoutSec = Math.min(Math.max(Number(args?.timeout) || 120, 10), 600);
    const askPromise = askUser({
        sessionKey: ctx.sessionKey,
        question,
        options,
        timeoutMs: timeoutSec * 1000,
        todoId: ctx.todoId || null,
    });

    const signal = ctx?.signal;
    if (!signal) return askPromise;

    return new Promise((resolve) => {
        const onAbort = () => {
            cancelPendingAsk(ctx.sessionKey, "aborted");
            resolve({ error: "aborted" });
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        askPromise.then(
            (r) => {
                signal.removeEventListener("abort", onAbort);
                resolve(r);
            },
            (err) => {
                signal.removeEventListener("abort", onAbort);
                resolve({ error: err?.message || String(err) });
            },
        );
    });
}
