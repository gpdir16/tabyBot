// 시스템 프롬프트 동적 영역 중 세션 중에 바뀔 수 있는 항목(설정, 목록, 메모리). 이 항목은 세션을 시작할 때 값으로
// 고정하고, 바뀌면 다음 사용자 메시지 앞 블록에 새 값을 싣는다(prompt-state.js). 시스템 프롬프트가 한 글자라도
// 바뀌면 그 뒤 대화 기록 전체의 프롬프트 캐시가 깨지기 때문이다. 경로·실행 환경처럼 세션 중에 바뀌지 않는 값만
// 시스템 프롬프트에 그대로 둔다.
// 다른 모듈을 가져오지 않는다. sanitize-messages.js가 이 파일을 쓰므로 순환 참조를 만들지 않게 둔다.

// 순서는 블록에 적는 순서다(system.txt에 나오는 순서). 제목은 system.txt의 해당 절 제목을 따르고, 따로 제목이 없는
// 항목은 내용을 설명하는 이름을 쓴다.
export const VOLATILE_PROMPT_SECTIONS = [
    { key: "NSFW_POLICY", title: "NSFW content policy" },
    { key: "APPROVAL_POLICY", title: "Permanent-action approval" },
    { key: "SKILLS_LIST", title: "Available skills" },
    { key: "SECRETS_LIST", title: "Stored secrets" },
    { key: "AGENT_MEMORY_FILES_LIST", title: "Bot memory topic files" },
    { key: "AGENT_IDENTITY", title: "Current agent" },
    { key: "PEER_AGENTS", title: "Other agents (this session)" },
    { key: "RUNTIME_INFO", title: "Runtime" },
    { key: "AGENT_MEMORY", title: "Agent memory (this agent only)" },
    { key: "MEMORY", title: "Current memory.md" },
    { key: "PAST_SESSIONS_LIST", title: "Past sessions (4 most recently archived)" },
    { key: "TODO_LIST", title: "Todos: Open" },
    { key: "TODO_SUGGEST_LIST", title: "Todos: Pending suggestions" },
    { key: "SCHEDULE_JOBS", title: "Todos: Your automations" },
];

const UPDATE_INTRO =
    "[context update: these sections changed after the system prompt was written. Each one replaces the matching system prompt section.]";

// 사용자 메시지에 저장된 stateUpdate({ base, vars })를 블록 글로 만든다. 저장된 값만 쓰므로 다시 만들어도 같은 글이 나온다.
export function formatStateUpdate(update) {
    const vars = update?.vars;
    if (!vars || typeof vars !== "object") return "";
    const parts = [];
    for (const { key, title } of VOLATILE_PROMPT_SECTIONS) {
        if (!Object.hasOwn(vars, key)) continue;
        const value = String(vars[key] ?? "").trim();
        parts.push(`### ${title}\n${value || "(empty)"}`);
    }
    return parts.length ? `${UPDATE_INTRO}\n\n${parts.join("\n\n")}` : "";
}
