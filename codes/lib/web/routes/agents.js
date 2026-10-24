// 에이전트, 폴더, 그룹 방 API.
import { loadUserConfig } from "../../config-loader.js";
import { getCompressOnModelChange } from "../../user-settings.js";
import {
    listAgents,
    addAgent,
    updateAgent as storeUpdateAgent,
    removeAgent,
    getAgent,
    listFolders,
    addFolder,
    updateFolder,
    removeFolder,
    setFoldersOrder,
} from "../../agents-store.js";
import { purgeAgentTodos } from "../../todos/store.js";
import { emit } from "../bus.js";
import { purgeAgentComputer } from "../computer.js";
import { requestAgentStop } from "../../agent/session.js";
import { cancelQueuedAgentWork } from "../../agent-queue.js";
import { askSessionCompression, publicAgent } from "./settings.js";
import { addGroup, listGroups, removeGroup, updateGroup } from "../../groups-store.js";
import { ensureConversation, getConversationMeta } from "../conversations.js";
import { stopGroup } from "../group-turns.js";

// 그룹 방을 클라이언트에 내려줄 때의 공개 모양. 읽은 위치(cursors)는 서버 내부용이다.
function publicGroup(g) {
    const meta = getConversationMeta(g.id);
    return {
        id: g.id,
        name: g.name,
        members: g.members,
        createdAt: g.createdAt,
        preview: typeof meta?.preview === "string" ? meta.preview : "",
    };
}

export function registerAgentsRoutes(router) {
    const agentsPayload = () => ({ agents: listAgents().map(publicAgent), folders: listFolders(), groups: listGroups().map(publicGroup) });

    router.add("GET", "/api/agents", (ctx) => {
        ctx.json200(agentsPayload());
    });

    router.add("POST", "/api/agents", async (ctx) => {
        const body = await ctx.json();
        const result = addAgent({
            name: body.name,
            persona: body.persona,
            modelPreset: body.modelPreset,
            model: body.model,
            thinkingLevel: body.thinkingLevel,
            color: body.color,
            backgroundTasks: body.backgroundTasks,
        });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ ...agentsPayload(), agent: publicAgent(result.agent) });
    });

    router.add("PATCH", "/api/agents/:id", async (ctx) => {
        const body = await ctx.json();
        // 쓰는 모델은 프리셋과 예전 모델 오버라이드로 정해진다. 둘 중 하나라도 바뀌면 모델이 바뀐 것이다.
        const modelOf = (a) => `${a?.modelPreset || ""}|${String(a?.model || "").trim()}`;
        const prevModel = modelOf(getAgent(ctx.params.id));
        const result = storeUpdateAgent(ctx.params.id, {
            name: body.name,
            persona: body.persona,
            modelPreset: body.modelPreset,
            model: body.model,
            thinkingLevel: body.thinkingLevel,
            color: body.color,
            backgroundTasks: body.backgroundTasks,
            folder: body.folder,
        });
        if (result.error) return ctx.json400(result.error);
        // 봇별 모델 오버라이드가 바뀌면 그 봇의 세션 압축 여부를 묻는다.
        const userConfig = loadUserConfig();
        if (
            (body.model !== undefined || body.modelPreset !== undefined) &&
            modelOf(result.agent) !== prevModel &&
            result.agent?.uuid &&
            getCompressOnModelChange(userConfig)
        ) {
            askSessionCompression(userConfig.language || "en", [result.agent.uuid]);
        }
        ctx.json200({ ...agentsPayload(), agent: publicAgent(result.agent) });
    });

    router.add("DELETE", "/api/agents/:id", (ctx) => {
        // 마지막으로 남은 봇은 삭제할 수 없다.
        const result = removeAgent(ctx.params.id);
        if (result.error === "last_agent") return ctx.json400("last_agent");
        if (result.error) return ctx.json404();
        if (result.agent?.uuid) {
            try {
                cancelQueuedAgentWork(result.agent.uuid);
                requestAgentStop(result.agent.uuid);
            } catch (err) {
                console.error(`tabyBot: stopping deleted agent failed (${result.agent.uuid}):`, err?.message || err);
            }
        }
        // 삭제된 봇의 컴퓨터 자원(브라우저 세션·프로필·PTY)을 해제한다.
        void purgeAgentComputer(ctx.params.id).catch((err) =>
            console.error(`tabyBot: agent computer purge failed (${ctx.params.id}):`, err?.message || err),
        );
        if (purgeAgentTodos(ctx.params.id).changed) emit({ type: "todos_changed" });
        emit({ type: "conversations_changed" });
        ctx.json200(agentsPayload());
    });

    // 그룹 방: 이름과 멤버(에이전트 uuid, 둘 이상). 멤버 순서가 멘션 없을 때 답하는 순서다.
    router.add("POST", "/api/groups", async (ctx) => {
        const body = await ctx.json();
        const result = addGroup({ name: body.name, members: body.members });
        if (result.error) return ctx.json400(result.error);
        ensureConversation(result.group.id);
        emit({ type: "conversations_changed" });
        ctx.json200({ ...agentsPayload(), group: publicGroup(result.group) });
    });

    router.add("PATCH", "/api/groups/:id", async (ctx) => {
        const body = await ctx.json();
        const result = updateGroup(ctx.params.id, { name: body.name, members: body.members });
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emit({ type: "conversations_changed" });
        ctx.json200({ ...agentsPayload(), group: publicGroup(result.group) });
    });

    router.add("DELETE", "/api/groups/:id", (ctx) => {
        stopGroup(ctx.params.id);
        const result = removeGroup(ctx.params.id);
        if (result.error) return ctx.json404();
        emit({ type: "conversations_changed" });
        ctx.json200(agentsPayload());
    });

    router.add("POST", "/api/folders", async (ctx) => {
        const body = await ctx.json();
        const result = addFolder({ name: body.name });
        if (result.error) return ctx.json400(result.error);
        ctx.json200({ ...agentsPayload(), folder: result.folder });
    });

    router.add("PATCH", "/api/folders/:id", async (ctx) => {
        const body = await ctx.json();
        const result = updateFolder(ctx.params.id, { name: body.name });
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        ctx.json200(agentsPayload());
    });

    router.add("DELETE", "/api/folders/:id", (ctx) => {
        const result = removeFolder(ctx.params.id);
        if (result.error) return ctx.json404();
        ctx.json200(agentsPayload());
    });

    // 폴더 표시 순서를 통째로 바꾼다. 사이드바 드래그/▲▼ 이동이 여기로 쓴다.
    router.add("POST", "/api/folders/order", async (ctx) => {
        const body = await ctx.json();
        const result = setFoldersOrder(body.ids);
        if (result.error) return ctx.json400(result.error);
        ctx.json200(agentsPayload());
    });
}
