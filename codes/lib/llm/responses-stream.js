// OpenAI/Grok/Codex Responses API SSE에서 function_call 인자를 조립한다.
// done 이벤트는 item.call_id가 아니라 item_id + arguments를 보낸다.

function pickArgs(...candidates) {
    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) return value;
        if (value && typeof value === "object") return JSON.stringify(value);
    }
    return null;
}

function eventItemId(evt) {
    return evt?.item_id || evt?.item?.id || null;
}

function eventCallId(evt) {
    return evt?.call_id || evt?.item?.call_id || null;
}

export function createResponsesStreamState(onTextDelta) {
    return {
        content: "",
        usage: null,
        toolCalls: [],
        onTextDelta,
        byId: new Map(),
        byIndex: new Map(),
        argBuffers: Object.create(null),
    };
}

function remember(state, tc, itemId, callId, outputIndex) {
    if (itemId) state.byId.set(itemId, tc);
    if (callId) state.byId.set(callId, tc);
    if (typeof outputIndex === "number") state.byIndex.set(outputIndex, tc);
}

function resolveToolCall(state, evt) {
    const itemId = eventItemId(evt);
    const callId = eventCallId(evt);
    if (itemId && state.byId.has(itemId)) return state.byId.get(itemId);
    if (callId && state.byId.has(callId)) return state.byId.get(callId);
    if (typeof evt.output_index === "number" && state.byIndex.has(evt.output_index)) {
        return state.byIndex.get(evt.output_index);
    }
    return null;
}

function upsertFunctionCall(state, item, extraArgs, outputIndex) {
    if (!item || (item.type && item.type !== "function_call")) return null;

    const itemId = item.id || null;
    const callId = item.call_id || null;
    let tc =
        (itemId && state.byId.get(itemId)) ||
        (callId && state.byId.get(callId)) ||
        (typeof outputIndex === "number" ? state.byIndex.get(outputIndex) : null) ||
        null;

    const args = pickArgs(extraArgs, item.arguments) || tc?.function?.arguments || "{}";

    if (!tc) {
        tc = {
            id: callId || itemId,
            type: "function",
            function: { name: item.name, arguments: args },
        };
        if (tc.id && item.name) state.toolCalls.push(tc);
        else return null;
    } else {
        if (item.name) tc.function.name = item.name;
        if (callId) tc.id = callId;
        const next = pickArgs(extraArgs, item.arguments);
        if (next) tc.function.arguments = next;
    }

    remember(state, tc, itemId, callId, outputIndex);
    return tc;
}

function appendArgDelta(state, evt) {
    const itemId = eventItemId(evt);
    const callId = eventCallId(evt);
    const key = itemId || callId || (typeof evt.output_index === "number" ? `idx:${evt.output_index}` : null);
    if (!key || typeof evt.delta !== "string") return;

    state.argBuffers[key] = (state.argBuffers[key] || "") + evt.delta;

    let tc = resolveToolCall(state, evt);
    if (!tc && state.toolCalls.length === 1) tc = state.toolCalls[0];
    if (!tc) return;

    tc.function.arguments = state.argBuffers[key];
    remember(state, tc, itemId, callId, evt.output_index);
}

function applyArgDone(state, evt) {
    const itemId = eventItemId(evt);
    const args = pickArgs(evt.arguments, evt.item?.arguments, itemId ? state.argBuffers[itemId] : null);
    let tc = resolveToolCall(state, evt);

    if (!tc && evt.name) {
        tc = upsertFunctionCall(
            state,
            {
                type: "function_call",
                id: itemId,
                call_id: eventCallId(evt),
                name: evt.name,
                arguments: args || "{}",
            },
            args,
            evt.output_index,
        );
        return;
    }

    if (tc && args) {
        tc.function.arguments = args;
        remember(state, tc, itemId, eventCallId(evt), evt.output_index);
    }
}

function applyCompletedOutput(state, evt) {
    if (evt.response?.usage || evt.usage) state.usage = evt.response?.usage || evt.usage;
    const outputItems = evt.response?.output || evt.output || [];
    for (const item of outputItems) {
        if (item?.type === "function_call") {
            upsertFunctionCall(state, item);
        }
    }
}

export function applyResponsesStreamEvent(state, evt) {
    if (!evt || typeof evt !== "object") return;
    const type = evt.type || evt.event_type || evt.event;
    if (!type) return;

    if (type === "response.output_text.delta" && evt.delta) {
        state.content += evt.delta;
        if (state.onTextDelta) state.onTextDelta(evt.delta, state.content);
        return;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
        if (evt.item?.type === "function_call") {
            upsertFunctionCall(state, evt.item, null, evt.output_index);
        }
        return;
    }

    if (type === "response.function_call_arguments.delta") {
        appendArgDelta(state, evt);
        return;
    }

    if (type === "response.function_call_arguments.done") {
        applyArgDone(state, evt);
        return;
    }

    if (type === "response.completed" || type === "response.done") {
        applyCompletedOutput(state, evt);
        return;
    }

    // 스트림 실패/불완전 응답을 무시하면 잘린 도구 인자가 그대로 실행된다.
    // 끝까지 소비한 뒤 에러로 던져 턴을 실패로 확정한다.
    if (type === "response.failed" || type === "response.incomplete" || type === "error") {
        const detail =
            evt.response?.error?.message || evt.error?.message || evt.response?.incomplete_details?.reason || evt.message || evt.code || type;
        state.streamError = `Responses stream ${type}: ${detail}`;
    }
}

function flushArgBuffers(state) {
    for (const [key, buf] of Object.entries(state.argBuffers)) {
        const args = pickArgs(buf);
        if (!args) continue;
        const tc = state.byId.get(key) || (key.startsWith("idx:") ? state.byIndex.get(Number(key.slice(4))) : null);
        if (tc && (!tc.function.arguments || tc.function.arguments === "{}")) {
            tc.function.arguments = args;
        }
    }

    const pending = Object.values(state.argBuffers).map(pickArgs).filter(Boolean);
    if (
        state.toolCalls.length === 1 &&
        pending.length === 1 &&
        (!state.toolCalls[0].function.arguments || state.toolCalls[0].function.arguments === "{}")
    ) {
        state.toolCalls[0].function.arguments = pending[0];
    }
}

export async function consumeResponsesStream(res, signal, onTextDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const state = createResponsesStreamState(onTextDelta);

    for (;;) {
        if (signal?.aborted) {
            const err = new Error("Stopped by user.");
            err.name = "AbortError";
            throw err;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            // SSE 스펙상 data: 뒤 공백은 선택 — 공백 없는 프레임도 받는다.
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).replace(/^ /, "");
            if (data === "[DONE]") continue;
            try {
                applyResponsesStreamEvent(state, JSON.parse(data));
            } catch {
                // 조각난 SSE JSON은 건너뛴다
            }
        }
    }

    flushArgBuffers(state);
    if (state.streamError) throw new Error(state.streamError);
    return { content: state.content, usage: state.usage, toolCalls: state.toolCalls };
}
