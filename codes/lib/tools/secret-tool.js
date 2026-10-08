// secret_request 도구: 에이전트가 필요한 시크릿을 사용자에게 요청한다.
// 사용자는 마스킹된 입력칸에 값을 넣고, 값은 금고에만 저장된다. 모델은 저장 여부와 자리표시자만 받는다.
import { askUser, cancelPendingAsk } from "../agent/user-ask.js";

const SECRET_REQUEST_DESCRIPTION = [
    "Ask the user to provide a secret (password, API key, token) that you need but is not in the Stored secrets list.",
    "The user types it into a masked field and it goes straight into the encrypted vault. You never receive the value, only whether it was saved and its {{secret:ID}} placeholder.",
    "Never ask the user to type a secret into the chat.",
].join(" ");

export const secretToolDefinitions = [
    {
        type: "function",
        function: {
            name: "secret_request",
            description: SECRET_REQUEST_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description:
                            "Plain-language label the user sees, in the user's language, e.g. 'GitHub token' or 'Netflix password'. If a secret with this label already exists, its value is replaced.",
                    },
                    timeout: { type: "number", description: "Seconds to wait (default 180, max 600)" },
                },
                required: ["name"],
            },
        },
    },
];

export function executeSecretRequest(_name, args, ctx) {
    if (!ctx?.sessionKey) return { error: "No active session. secret_request only works during a user message turn" };

    const name = String(args?.name ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (!name || name.length > 60) return { error: "name is required (a short label, up to 60 characters)" };

    const timeoutSec = Math.min(Math.max(Number(args?.timeout) || 180, 10), 600);
    const askPromise = askUser({
        sessionKey: ctx.sessionKey,
        question: name,
        timeoutMs: timeoutSec * 1000,
        todoId: ctx.todoId || null,
        secret: { name },
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
