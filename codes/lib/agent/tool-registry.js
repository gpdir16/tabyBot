import { fileToolDefinitions, executeFileRead, executeFilePatch } from "../tools/file.js";
import { configToolDefinitions, executeConfigTool } from "../tools/config-tool.js";
import { skillsToolDefinitions, executeSkillsTool } from "../tools/skills.js";
import { terminalToolDefinitions, executeTerminalTool } from "../tools/terminal.js";
import { cronToolDefinitions, executeCronTool } from "../tools/cron-tool.js";
import { sendFileToolDefinitions, executeSendFileTool } from "../tools/send-file-tool.js";
import { userAskToolDefinitions, executeUserAskTool } from "../tools/user-ask-tool.js";
import { vizToolDefinitions, executeVizTool } from "../tools/visualization.js";
import { xvfbGuiToolDefinitions, executeXvfbGuiTool } from "../tools/xvfb-gui.js";
import { consultAgentToolDefinitions, executeConsultAgent } from "../tools/consult-agent.js";
import { listAgents } from "../agents-store.js";
import { getDynamicMcpToolDefinitions, invokeMcpTool, syncMcpServers, disconnectMcpServers } from "../mcp/servers.js";
import { stopCronScheduler } from "../cron/scheduler.js";
import { stopUpdateScheduler } from "../update/scheduler.js";
import { sanitizeTextForLlm } from "../llm/sanitize-messages.js";
import { isDockerRuntime } from "../runtime.js";

export async function initTools() {
    await syncMcpServers();
}

export async function shutdownTools() {
    stopCronScheduler();
    stopUpdateScheduler();
    await disconnectMcpServers();
}

export async function getAllToolDefinitions() {
    await syncMcpServers();
    return [
        ...fileToolDefinitions,
        ...configToolDefinitions,
        ...skillsToolDefinitions,
        ...cronToolDefinitions,
        ...terminalToolDefinitions,
        ...sendFileToolDefinitions,
        ...userAskToolDefinitions,
        ...(listAgents().length ? consultAgentToolDefinitions : []),
        ...vizToolDefinitions,
        ...(isDockerRuntime() ? xvfbGuiToolDefinitions : []),
        ...getDynamicMcpToolDefinitions(),
    ];
}

export async function executeTool(name, args, ctx = {}) {
    try {
        if (name === "file_read") return await executeFileRead(args, ctx);
        if (name === "file_patch") return await executeFilePatch(args, ctx);
        if (name === "config_set") return await executeConfigTool(name, args);
        if (name.startsWith("skills_")) return await executeSkillsTool(name, args);
        if (name.startsWith("cron_")) return await executeCronTool(name, args);
        if (name === "terminal_run" || name === "bg_status" || name === "bg_list" || name === "bg_kill") {
            return await executeTerminalTool(name, args, ctx);
        }
        if (name === "telegram_send_file") return await executeSendFileTool(name, args, ctx);
        if (name === "user_ask") return await executeUserAskTool(name, args, ctx);
        if (name === "consult_agent") return await executeConsultAgent(name, args, ctx);
        if (name === "viz_create") return await executeVizTool(name, args);
        if (name.startsWith("mcp__")) return await invokeMcpTool(name, args);
        if (name === "xvfb_gui") return await executeXvfbGuiTool(name, args, ctx);
        return { error: `Unknown tool: ${name}` };
    } catch (err) {
        return { error: err?.message || String(err) };
    }
}

export function toolResultContent(result) {
    if (result && typeof result === "object" && result.__image) {
        const { __image, ...stripped } = result;
        return sanitizeTextForLlm(JSON.stringify(stripped) ?? "");
    }
    return sanitizeTextForLlm(JSON.stringify(result) ?? "");
}
