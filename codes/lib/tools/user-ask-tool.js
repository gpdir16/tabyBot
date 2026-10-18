// user_ask 도구: 에이전트가 작업 중 사용자에게 질문하고 답변을 기다린다.
// 사용자가 직접 정해야 하는 선택(옵션 고르기, 선호도, 진행 방향)에 쓰고,
// 외부 사이드이펙트(메일 발송, 결제, 계정 삭제 등) 승인 요청에도 사용한다.
import { askUser, attachAskToToolCall, cancelPendingAsk } from "../agent/user-ask.js";

const USER_ASK_DESCRIPTION = [
    "Ask the user a question and wait for their answer (inline buttons + free text).",
    "Use when you need a decision or input only the user can give: which option to pick, a preference, missing materials, or anything ambiguous that blocks progress.",
    "Also works during scheduled todo runs. While you wait, the todo shows a 'needs answer' badge so the user can see you are blocked.",
    "Keep `question` to the question itself. Do not put explanations, findings, status updates, or conversation history in it; send those first with `user_say`, then ask a short, self-contained question. Markdown is supported in the question, but keep it focused.",
    "Pass short options (e.g. ['승인', '취소']). The user can also type a custom answer. The wait times out (max 600s), so ask only what truly blocks you.",
].join(" ");

// 모델이 질문 칸에 배경 설명을 함께 넣는 경우가 있다. 빈 줄로 나뉜 문단 중
// 마지막 물음표 문단(없으면 마지막 문단)을 질문으로 보고, 나머지는 앞선 발화로 분리한다.
export function splitAskQuestion(raw) {
    const text = String(raw || "").trim();
    if (!text) return { question: "", preamble: "" };
    const parts = text
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length < 2) return { question: text, preamble: "" };
    let questionIndex = -1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (/[?？]/.test(parts[i])) {
            questionIndex = i;
            break;
        }
    }
    if (questionIndex < 0) questionIndex = parts.length - 1;
    return {
        question: parts[questionIndex],
        preamble: parts.filter((_, i) => i !== questionIndex).join("\n\n"),
    };
}

export const userAskToolDefinitions = [
    {
        type: "function",
        function: {
            name: "user_ask",
            description: USER_ASK_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description:
                            "The question itself only: short and self-contained. Put any context, explanation, or status update in a preceding user_say call, not here. Markdown is allowed.",
                    },
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

export function executeUserAskTool(_name, args, ctx) {
    if (!ctx?.sessionKey) {
        return { error: "No active session. user_ask only works during a user message turn" };
    }

    const split = splitAskQuestion(args?.question);
    if (!split.question) return { error: "question is required" };

    const options = Array.isArray(args?.options) ? args.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (options.length > 8) return { error: "options must be at most 8" };

    const timeoutSec = Math.min(Math.max(Number(args?.timeout) || 120, 10), 600);
    const askPromise = askUser({
        sessionKey: ctx.sessionKey,
        question: split.question,
        options,
        timeoutMs: timeoutSec * 1000,
        todoId: ctx.todoId || null,
        onCreate: (ask) => attachAskToToolCall(ctx, { ...ask, ...(split.preamble ? { preamble: split.preamble } : {}) }),
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
