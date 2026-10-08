import { fileToolDefinitions, executeFileRead, executeFilePatch } from "../tools/file.js";
import { configToolDefinitions, executeConfigTool } from "../tools/config-tool.js";
import { skillsToolDefinitions, executeSkillsTool } from "../tools/skills.js";
import { terminalToolDefinitions, executeTerminalTool } from "../tools/terminal.js";
import { todoToolDefinitions, executeTodoTool } from "../tools/todo-tool.js";
import { stopTodoScheduler } from "../todos/scheduler.js";
import { sendFileToolDefinitions, executeSendFileTool } from "../tools/send-file-tool.js";
import { userAskToolDefinitions, executeUserAskTool } from "../tools/user-ask-tool.js";
import { secretToolDefinitions, executeSecretRequest } from "../tools/secret-tool.js";
import { prepareToolSecrets, redactDeep, redactText } from "../secrets/vault.js";
import { userSayToolDefinitions, executeUserSayTool } from "../tools/user-say-tool.js";
import { vizToolDefinitions, executeVizTool } from "../tools/visualization.js";
import { xvfbGuiToolDefinitions, executeXvfbGuiTool } from "../tools/xvfb-gui.js";
import { consultAgentToolDefinitions, executeConsultAgent } from "../tools/consult-agent.js";
import { sessionSearchToolDefinitions, executeSessionSearchTool } from "../tools/session-search.js";
import { listAgents } from "../agents-store.js";
import { getDynamicMcpToolDefinitions, invokeMcpTool, syncMcpServers, disconnectMcpServers } from "../mcp/servers.js";
import { stopUpdateScheduler } from "../update/scheduler.js";
import { stopDreamingScheduler } from "../dreaming/scheduler.js";
import { stopProactiveScheduler } from "../proactive.js";
import { sanitizeTextForLlm } from "../llm/sanitize-messages.js";
import { isDockerRuntime } from "../runtime.js";

export async function initTools() {
    // MCP 연결은 백그라운드로 한다. 죽은 서버 하나가 웹 UI 부팅을 막지 않게 한다.
    // 첫 턴의 getAllToolDefinitions이 같은 진행 중 sync를 await한다.
    void syncMcpServers();
}

export async function shutdownTools() {
    stopTodoScheduler();
    stopUpdateScheduler();
    stopDreamingScheduler();
    stopProactiveScheduler();
    await disconnectMcpServers();
}

export async function getAllToolDefinitions() {
    await syncMcpServers();
    return [
        ...fileToolDefinitions,
        ...configToolDefinitions,
        ...skillsToolDefinitions,
        ...todoToolDefinitions,
        ...terminalToolDefinitions,
        ...sendFileToolDefinitions,
        ...userAskToolDefinitions,
        ...secretToolDefinitions,
        ...userSayToolDefinitions,
        ...sessionSearchToolDefinitions,
        ...(listAgents().length ? consultAgentToolDefinitions : []),
        ...vizToolDefinitions,
        ...(isDockerRuntime() ? xvfbGuiToolDefinitions : []),
        ...getDynamicMcpToolDefinitions(),
    ];
}

// 모델이 쓴 {{secret:NAME}}을 실행 직전에만 값으로 바꾸고, 결과에 섞인 값은 자리표시자로 되돌린다.
export async function executeTool(name, args, ctx = {}) {
    try {
        const prepared = prepareToolSecrets(name, args);
        if (prepared.error) return { error: prepared.error };
        const result = await runTool(name, prepared.args, prepared.env ? { ...ctx, secretEnv: prepared.env } : ctx);
        return redactDeep(result);
    } catch (err) {
        return { error: redactText(err?.message || String(err)) };
    }
}

async function runTool(name, args, ctx) {
    try {
        if (name === "file_read") return await executeFileRead(args, ctx);
        if (name === "file_patch") return await executeFilePatch(args, ctx);
        if (name === "config_set") return await executeConfigTool(name, args);
        if (name.startsWith("skills_")) return await executeSkillsTool(name, args);
        if (name.startsWith("todo_")) return await executeTodoTool(name, args, ctx);
        if (name === "terminal_run" || name === "bg_status" || name === "bg_list" || name === "bg_kill") {
            return await executeTerminalTool(name, args, ctx);
        }
        if (name === "send_file") return await executeSendFileTool(name, args, ctx);
        if (name === "user_ask") return await executeUserAskTool(name, args, ctx);
        if (name === "secret_request") return await executeSecretRequest(name, args, ctx);
        if (name === "user_say") return await executeUserSayTool(args, ctx);
        if (name === "consult_agent") return await executeConsultAgent(name, args, ctx);
        if (name === "session_search") return await executeSessionSearchTool(name, args);
        if (name === "viz_create") return await executeVizTool(name, args);
        if (name.startsWith("mcp__")) return await invokeMcpTool(name, args, ctx);
        if (name === "xvfb_gui") return await executeXvfbGuiTool(name, args, ctx);
        return { error: `Unknown tool: ${name}` };
    } catch (err) {
        return { error: redactText(err?.message || String(err)) };
    }
}

export function toolResultContent(result) {
    if (result && typeof result === "object" && result.__image) {
        const { __image, ...stripped } = result;
        return sanitizeTextForLlm(JSON.stringify(stripped) ?? "");
    }
    return sanitizeTextForLlm(JSON.stringify(result) ?? "");
}
