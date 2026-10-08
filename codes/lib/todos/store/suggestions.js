// 에이전트 제안(추가/수정/삭제)의 접수·승인·거절과 할 일 넘기기(제안·수락), 담당 해제.
import { getAgent } from "../../agents-store.js";
import { isValidTimeZone } from "../../scheduling/time.js";
import { MAX_PROMPT, MAX_REASON, MAX_SUGGESTIONS, MAX_TITLE, SUGGEST_KINDS, clip, newId, readStore, writeStore } from "./persist.js";
import { addTodo, getTodo, publicSuggestion, publicTodo, updateTodo, voidRun } from "./items.js";

// ── 에이전트 제안(추가/수정/삭제)의 접수·승인·거절. ──

export function addSuggestion(input = {}) {
    const store = readStore();
    const kind = SUGGEST_KINDS.has(input.kind) ? input.kind : "add";
    const title = clip(input.title, MAX_TITLE);
    if (kind === "add" && !title) return { error: "title_required" };
    if (kind !== "add" && !input.targetId) return { error: "target_required" };
    if (kind !== "add") {
        const target = store.items.find((row) => row.id === input.targetId);
        if (target && (target.list || "user") !== "user") return { error: "not_a_user_todo" };
    }
    const dupe = store.suggestions.find(
        (row) =>
            row.kind === kind &&
            row.agentId === clip(input.agentId, 24) &&
            row.title === title &&
            String(row.targetId || "") === String(input.targetId || ""),
    );
    const patch = (() => {
        const p = input.patch;
        if (!p || typeof p !== "object" || Array.isArray(p)) return null;
        const out = {};
        if (p.title != null) out.title = clip(p.title, MAX_TITLE);
        if (p.prompt != null) out.prompt = clip(p.prompt, MAX_PROMPT);
        if (p.cron != null) out.cron = clip(p.cron, 120);
        if (p.every != null) out.every = clip(p.every, 24);
        if (p.at != null) out.at = clip(p.at, 40);
        if (p.timezone != null) out.timezone = clip(p.timezone, 64);
        if (p.kind != null) out.kind = clip(p.kind, 12);
        if (p.clearWhen === true) out.clearWhen = true;
        return Object.keys(out).length ? out : null;
    })();
    if (dupe) {
        dupe.reason = clip(input.reason, MAX_REASON);
        dupe.patch = patch ?? dupe.patch;
        dupe.cron = input.cron != null ? String(input.cron) : dupe.cron;
        dupe.every = input.every != null ? String(input.every) : dupe.every;
        dupe.at = input.at != null ? String(input.at) : dupe.at;
        dupe.timezone = input.timezone != null ? String(input.timezone) : dupe.timezone;
        dupe.prompt = clip(input.prompt, MAX_PROMPT) || dupe.prompt;
        dupe.createdAt = new Date().toISOString();
        writeStore(store);
        return { suggestion: publicSuggestion(dupe) };
    }
    if (store.suggestions.length >= MAX_SUGGESTIONS) return { error: "too_many_suggestions" };
    const row = {
        id: newId(),
        kind,
        targetId: kind === "add" ? null : clip(input.targetId, 32),
        agentId: clip(input.agentId, 24),
        title,
        reason: clip(input.reason, MAX_REASON),
        patch,
        cron: input.cron != null ? String(input.cron) : "",
        every: input.every != null ? String(input.every) : "",
        at: input.at != null ? String(input.at) : "",
        timezone: input.timezone != null ? String(input.timezone) : "",
        prompt: clip(input.prompt, MAX_PROMPT),
        createdAt: new Date().toISOString(),
    };
    store.suggestions.push(row);
    writeStore(store);
    return { suggestion: publicSuggestion(row) };
}

export function approveSuggestion(id, { fallbackTimeZone } = {}) {
    const suggestion = readStore().suggestions.find((row) => row.id === id);
    if (!suggestion) return { error: "not_found" };
    const tz = isValidTimeZone(fallbackTimeZone) ? fallbackTimeZone : "";

    if (suggestion.kind === "add") {
        const result = addTodo({
            title: suggestion.title,
            prompt: suggestion.prompt,
            cron: suggestion.cron || undefined,
            every: suggestion.every || undefined,
            at: suggestion.at || undefined,
            timezone: suggestion.timezone || tz,
            createdBy: "agent",
        });
        if (result.error) return result;

        const store = readStore();
        store.suggestions = store.suggestions.filter((row) => row.id !== id);
        const item = store.items.find((row) => row.id === result.item.id);
        if (item && suggestion.agentId && getAgent(suggestion.agentId)) {
            item.offers = Array.isArray(item.offers) ? item.offers : [];
            item.offers.push({
                agentId: suggestion.agentId,
                reason: clip(suggestion.reason, MAX_REASON),
                prompt: clip(suggestion.prompt, MAX_PROMPT),
                createdAt: new Date().toISOString(),
            });
        }
        writeStore(store);
        return { item: getTodo(result.item.id) };
    }

    const targetExists = readStore().items.some((row) => row.id === suggestion.targetId);
    if (!targetExists) return { error: "target_missing" };

    if (suggestion.kind === "delete") {
        const store = readStore();
        store.items = store.items.filter((row) => row.id !== suggestion.targetId);
        store.suggestions = store.suggestions.filter((row) => row.targetId !== suggestion.targetId);
        writeStore(store);
        return { removed: true, targetId: suggestion.targetId };
    }

    const patch = suggestion.patch && typeof suggestion.patch === "object" ? suggestion.patch : {};
    const hasWhenPatch =
        patch.cron != null ||
        patch.every != null ||
        patch.at != null ||
        patch.timezone != null ||
        patch.clearWhen ||
        patch.kind != null ||
        Boolean(suggestion.cron || suggestion.every || suggestion.at || suggestion.timezone);
    const result = updateTodo(
        suggestion.targetId,
        {
            title: patch.title != null ? patch.title : undefined,
            prompt: patch.prompt != null ? patch.prompt : undefined,
            cron: patch.cron != null ? patch.cron : suggestion.cron || undefined,
            every: patch.every != null ? patch.every : suggestion.every || undefined,
            at: patch.at != null ? patch.at : suggestion.at || undefined,
            timezone: patch.timezone != null ? patch.timezone : suggestion.timezone || (hasWhenPatch ? tz : "") || undefined,
            clearWhen: patch.clearWhen,
            kind: patch.kind,
        },
        { whenMode: "apply", editedBy: "agent" },
    );
    if (result.error) return result;
    const store = readStore();
    store.suggestions = store.suggestions.filter((row) => row.id !== id);
    writeStore(store);
    return result;
}

export function rejectSuggestion(id) {
    const store = readStore();
    const before = store.suggestions.length;
    store.suggestions = store.suggestions.filter((row) => row.id !== id);
    if (store.suggestions.length === before) return { error: "not_found" };
    writeStore(store);
    return { rejected: true };
}

// ── 할 일 넘기기(제안·수락)와 담당 해제, 에이전트 삭제 시 정리. ──

export function offerHandoff(todoId, { agentId, reason, prompt } = {}) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    if ((item.list || "user") !== "user") return { error: "not_a_user_todo" };
    if (item.status !== "open") return { error: "not_open" };
    if (!getAgent(agentId)) return { error: "agent_not_found" };
    if (item.assigneeId === agentId) return { error: "already_assigned" };
    const now = new Date().toISOString();
    item.offers = Array.isArray(item.offers) ? item.offers : [];
    const existing = item.offers.find((row) => row.agentId === agentId);
    if (existing) {
        existing.reason = clip(reason, MAX_REASON);
        existing.prompt = clip(prompt, MAX_PROMPT);
        existing.createdAt = now;
    } else {
        item.offers.push({
            agentId,
            reason: clip(reason, MAX_REASON),
            prompt: clip(prompt, MAX_PROMPT),
            createdAt: now,
        });
    }
    writeStore(store);
    return { item: publicTodo(item) };
}

export function withdrawHandoff(todoId, agentId) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    const before = (item.offers || []).length;
    item.offers = (item.offers || []).filter((row) => row.agentId !== agentId);
    if (item.offers.length === before) return { error: "offer_not_found" };
    writeStore(store);
    return { item: publicTodo(item) };
}

export function acceptHandoff(todoId, agentId) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    if (item.status !== "open") return { error: "not_open" };
    const offer = (item.offers || []).find((row) => row.agentId === agentId);
    if (!offer) return { error: "offer_not_found" };
    if (!getAgent(agentId)) {
        item.offers = (item.offers || []).filter((row) => row.agentId !== agentId);
        writeStore(store);
        return { error: "agent_not_found" };
    }
    item.assigneeId = agentId;
    if (offer.prompt) item.prompt = offer.prompt;
    item.offers = (item.offers || []).filter((row) => row.agentId !== agentId);
    voidRun(item);
    item.updatedAt = new Date().toISOString();
    writeStore(store);
    return { item: publicTodo(item) };
}

export function clearAssignee(todoId) {
    const store = readStore();
    const item = store.items.find((row) => row.id === todoId);
    if (!item) return { error: "not_found" };
    if (!item.assigneeId) return { item: publicTodo(item) };
    item.assigneeId = null;
    voidRun(item);
    item.updatedAt = new Date().toISOString();
    writeStore(store);
    return { item: publicTodo(item) };
}

export function purgeAgentTodos(agentId) {
    const store = readStore();
    let changed = false;
    const kept = store.items.filter((row) => (row.list || "user") !== agentId);
    if (kept.length !== store.items.length) {
        store.items = kept;
        changed = true;
    }
    for (const item of store.items) {
        if (item.assigneeId === agentId) {
            item.assigneeId = null;
            voidRun(item);
            changed = true;
        }
        if (Array.isArray(item.offers) && item.offers.length) {
            const next = item.offers.filter((o) => o.agentId !== agentId);
            if (next.length !== item.offers.length) {
                item.offers = next;
                changed = true;
            }
        }
    }
    const next = store.suggestions.filter((row) => row.agentId !== agentId);
    if (next.length !== store.suggestions.length) {
        store.suggestions = next;
        changed = true;
    }
    if (changed) writeStore(store);
    return { changed };
}
