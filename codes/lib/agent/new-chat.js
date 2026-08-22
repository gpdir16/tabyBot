import { loadUserConfig } from "../config-loader.js";
import { runAgent } from "./loop.js";
import { clearChatHistory, loadChatHistory } from "./chat-history.js";
import { t } from "../i18n.js";
import { memoryFilePath } from "../path-labels.js";

export function memoryFlushPrompt(lang) {
    const memoryPath = memoryFilePath();
    const prompts = {
        ko: `[시스템 · /new]
사용자가 새 대화를 시작했습니다. 이전 **활성** 스레드는 이미 새 세션 파일로 교체되었고, 이전 세션 JSON은 \`user/temp/chat-…/sessions/\`에 **보관**되었습니다.

**1. memory.md 갱신**
\`file_read\`로 memory.md를 먼저 확인한 뒤 \`file_patch\`로 추가·갱신하세요.
- 이미 memory.md에 있는 내용은 중복하지 마세요.
- 일시적인 잡담, 추측, 중복, 불필요한 세부사항은 **넣지 마세요**.
- 사용자 선호, 진행 중인 작업, 중요 결정 등 장기적으로 유용한 것만 간결히 남기세요.
- 주제별로 정리할 내용(예: 보유 주식 목록, 프로젝트 상태)은 memory.md에 넣지 말고 \`memory/<주제>.md\` 파일을 만들거나 갱신하세요. 현재 파일 목록은 시스템 프롬프트의 Memory files에 표시됩니다. 새 파일은 \`terminal_run\`(\`mkdir -p memory && touch memory/<주제>.md\`)으로 만들고, 내용이 바뀌면 갱신하고 주제가 더 이상 필요 없으면 삭제하세요.

**2. 스킬 생성 (해당할 때만)**
아래 조건 중 하나 이상이면 \`skill-author\` 스킬(\`skills_read skill-author\`)을 읽고, \`user/skills/<slug>/SKILL.md\`에 스킬을 만드세요:
- 도구 호출 5회 이상이 사용된 비자발적 워크플로
- 오류에서 회복한 경로 (실패 후 해결책을 찾음)
- 사용자가 정정한 지식 (다음에 같은 실수를 반복하지 않도록)
- 반복될 가능성이 높은 비자명적 다단계 작업

스킬을 만들 **필요가 없으면** 만들지 마세요. 일회성 질문, 인사, 단일 명령 작업은 스킬 대상이 아닙니다.

**중요:** 사용자가 자기개선을 요청한 것이 아닙니다. 최종 응답에서 "메모리를 업데이트했습니다", "스킬을 만들었습니다" 등의 언급을 **하지 마세요**. 완료하면 오직 \`__SILENT__\` 만 답하세요.`,
        en: `[System · /new]
The user started a new chat. The previous **active** thread has already been rotated to a new session file; older session JSON remains **archived** under \`user/temp/chat-…/sessions/\`.

Review this conversation and perform self-improvement. Two things:

**1. Update memory.md**
Read memory.md with \`file_read\` first, then add or update with \`file_patch\`.
- Do not duplicate what is already in memory.md.
- Do **not** add transient chit-chat, guesses, duplicates, or unnecessary detail.
- Keep only durable items: preferences, ongoing work, important decisions — briefly.
- For topic-shaped facts (e.g. stock holdings list, project status), do not put them in memory.md — create or update a \`memory/<topic>.md\` file instead. Current files are listed under "Memory files" in the system prompt. Create new files with \`terminal_run\` (\`mkdir -p memory && touch memory/<topic>.md\`); update files when facts change; delete files whose topic no longer applies.

**2. Create a skill (only when warranted)**
If any of the following apply, read the \`skill-author\` skill (\`skills_read skill-author\`) and create a skill at \`user/skills/<slug>/SKILL.md\`:
- An involuntary workflow with 5+ tool calls
- Recovery from an error (found a solution after a failure)
- Knowledge corrected by the user (to avoid repeating the same mistake)
- A non-trivial multi-step task likely to recur

Do **not** create a skill when none of these apply. One-off questions, greetings, single-command tasks are not skill candidates.

**Important:** The user did not ask you to self-improve. Do **not** mention "I updated memory", "I created a skill", or similar in any final reply. When done, reply with ONLY: \`__SILENT__\``,
        ja: `[システム · /new]
ユーザーが新しい会話を始めました。以前の**アクティブ**スレッドはすでに新しいセッションファイルに切り替わり、以前のセッション JSON は \`user/temp/chat-…/sessions/\` に**保管**されています。

この会話を振り返り、自己改善を行ってください。二つのこと:

**1. memory.md の更新**
まず \`file_read\` で memory.md を確認し、\`file_patch\` で追加・更新してください。
- memory.md に既にある内容は重複させないでください。
- 一時的な雑談、推測、重複、不要な詳細は **入れないでください**。
- 好み、進行中の作業、重要な決定など、長期的に有用なものだけを簡潔に残してください。
- トピックごとに整理する内容(例: 保有株リスト、プロジェクト状態)は memory.md に入れず、\`memory/<トピック>.md\` ファイルを作成・更新してください。現在のファイル一覧はシステムプロンプトの Memory files に表示されます。新規ファイルは \`terminal_run\`(\`mkdir -p memory && touch memory/<トピック>.md\`)で作成し、内容が変わったら更新し、トピックが不要になったら削除してください。

**2. スキル作成 (該当する場合のみ)**
以下のいずれかが当てはまる場合、\`skill-author\` スキル(\`skills_read skill-author\`)を読み、\`user/skills/<slug>/SKILL.md\` にスキルを作成してください:
- ツール呼び出し5回以上の非自発的ワークフロー
- エラーからの回復 (失敗後に解決策を発見)
- ユーザーが訂正した知識 (同じミスを繰り返さないため)
- 繰り返される可能性の高い非自明な多段階タスク

該当しない場合はスキルを作成しないでください。一回限りの質問、挨拶、単一コマンドのタスクはスキル対象ではありません。

**重要:** ユーザーは自己改善を要求していません。最終応答で「メモリを更新しました」「スキルを作成しました」などの言及は**しないでください**。完了したら \`__SILENT__\` のみ返答してください。`,
    };
    return prompts[lang] || prompts.en;
}

export async function handleNewChat(bot, chatId) {
    const lang = loadUserConfig().language || "en";

    // Snapshot the conversation BEFORE clearing, then rotate to a fresh session immediately.
    const priorHistory = loadChatHistory(chatId);

    try {
        clearChatHistory(chatId);
    } catch (err) {
        console.error("Clear chat history failed:", err?.stack || err);
    }

    // Detached self-improvement: runs in the background, never blocks the user.
    // Uses the snapshot so it works on the archived conversation regardless of
    // what the user does in the new session. No chatId passed to runAgent —
    // tools stay read-only on disk history; no session/abort, silent and unstoppable.
    void runSelfImprovement(bot, lang, priorHistory).catch((err) => {
        console.error("Background self-improvement failed:", err?.stack || err);
    });

    return t("new_chat_ok", lang);
}

async function runSelfImprovement(bot, lang, history) {
    // Skip when there was nothing to review.
    if (!history?.length) return;

    try {
        const result = await runAgent(memoryFlushPrompt(lang), {
            bot,
            history,
        });
        if (result?.error && result.error !== "stopped_by_user") {
            console.error("Self-improvement ended with:", result.error, result.errorDetail || "");
        }
    } catch (err) {
        console.error("Self-improvement error:", err?.stack || err);
    }
}
