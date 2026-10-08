// 할 일 API.
import { getAgent } from "../../agents-store.js";
import {
    acceptHandoff,
    addTodo,
    approveSuggestion,
    clearAssignee,
    completeTodo,
    getTodo,
    listTodos,
    reopenTodo,
    rejectSuggestion,
    removeTodo,
    updateTodo,
} from "../../todos/store.js";
import { queueTodoNow } from "../../todos/scheduler.js";
import { emit } from "../bus.js";

export function registerTodosRoutes(router) {
    function todoPayload() {
        return listTodos();
    }

    function emitTodos() {
        emit({ type: "todos_changed" });
    }

    router.add("GET", "/api/todos", (ctx) => {
        ctx.json200(todoPayload());
    });

    router.add("POST", "/api/todos", async (ctx) => {
        const body = await ctx.json().catch(() => null);
        if (body == null || typeof body !== "object" || Array.isArray(body)) return ctx.json400("invalid_json");
        const result = addTodo({ ...body, createdBy: "user" });
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("PATCH", "/api/todos/:todoId", async (ctx) => {
        const body = await ctx.json().catch(() => null);
        if (body == null || typeof body !== "object" || Array.isArray(body)) return ctx.json400("invalid_json");
        const result = updateTodo(ctx.params.todoId, body);
        if (result.error === "not_found") return ctx.json404();
        if (result.error === "conflict") return ctx.json409("conflict");
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("DELETE", "/api/todos/:todoId", (ctx) => {
        const result = removeTodo(ctx.params.todoId);
        if (result.error) return ctx.json404();
        emitTodos();
        ctx.json200(todoPayload());
    });

    router.add("POST", "/api/todos/:todoId/complete", (ctx) => {
        const result = completeTodo(ctx.params.todoId);
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/:todoId/reopen", (ctx) => {
        const result = reopenTodo(ctx.params.todoId);
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/suggestions/:id/approve", async (ctx) => {
        const body = await ctx.json().catch(() => null);
        const result = approveSuggestion(ctx.params.id, { fallbackTimeZone: body?.timezone });
        if (result.error === "not_found") return ctx.json404();
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), ...result });
    });

    router.add("POST", "/api/todos/suggestions/:id/reject", (ctx) => {
        const result = rejectSuggestion(ctx.params.id);
        if (result.error) return ctx.json404();
        emitTodos();
        ctx.json200(todoPayload());
    });

    router.add("POST", "/api/todos/:todoId/handoff/:agentId", (ctx) => {
        const result = acceptHandoff(ctx.params.todoId, ctx.params.agentId);
        if (result.error === "not_found") return ctx.json404();
        if (result.error === "offer_not_found") return ctx.json400("offer_not_found");
        if (result.error) return ctx.json400(result.error);
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/:todoId/unassign", (ctx) => {
        const result = clearAssignee(ctx.params.todoId);
        if (result.error) return ctx.json404();
        emitTodos();
        ctx.json200({ ...todoPayload(), item: result.item });
    });

    router.add("POST", "/api/todos/:todoId/run", (ctx) => {
        const item = getTodo(ctx.params.todoId);
        if (!item) return ctx.json404();
        if (item.status !== "open") return ctx.json400("not_open");
        const agent = item.executor?.id ? getAgent(item.executor.id) : null;
        if (!agent) return ctx.json400("not_assigned");
        const queued = queueTodoNow(agent, item);
        if (queued.error) return ctx.json400(queued.error);
        ctx.json200({ ok: true, ...todoPayload() });
    });
}
