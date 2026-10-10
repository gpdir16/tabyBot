// user_say 도구: 작업 중 사용자에게 보여 줄 메시지 한 건을 명시적으로 게시한다.
import { emit } from "../web/bus.js";

const USER_SAY_DESCRIPTION = [
    "Deliver one chat message to the user mid-task, without ending your turn.",
    "Text written next to tool calls is internal and never reaches the user. This tool is the ONLY way to speak mid-task.",
    "Good reasons: a warning before an irreversible action (what will change), a blocker only the user can resolve (for questions that need an answer, use user_ask), a finding that cannot wait for the final reply, or a brief progress note at meaningful milestones during long multi-step work.",
    "Keep it sparse. Skip mechanical step narration ('clicked', 'retrying', 'page loaded') and do not post one per tool call.",
].join(" ");

export const userSayToolDefinitions = [
    {
        type: "function",
        function: {
            name: "user_say",
            description: USER_SAY_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The message to deliver to the user (Markdown allowed)" },
                },
                required: ["text"],
            },
        },
    },
];

export function executeUserSayTool(args, ctx) {
    const text = String(args?.text ?? "").trim();
    if (!text) return { error: "text is required" };

    // 라이브 화면의 중간 발화 버블로 즉시 전달: 기록은 세션 메시지의
    // user_say 호출에서 표시 텍스트를 추출해 저장본과 동일하게 보인다.
    if (ctx?.sessionKey) {
        emit({ type: "say", conversationId: ctx.sessionKey, text });
    }
    return { ok: true, delivered: true };
}
