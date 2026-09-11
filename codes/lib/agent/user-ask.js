import crypto from "node:crypto";
import { emit } from "../web/bus.js";

const pendingAsks = new Map();

function settle(entry, result) {
    if (entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    pendingAsks.delete(entry.key);
    entry.resolve(result);
    return true;
}

function settleAndNotify(entry, result) {
    if (!settle(entry, result)) return false;
    emit({ type: "ask_resolved", conversationId: entry.key, askId: entry.id, answer: String(result ?? "") });
    return true;
}

export function resolvePendingAskByAskId(askId, { choiceIndex = null, text = "" } = {}) {
    for (const entry of pendingAsks.values()) {
        if (entry.id === String(askId)) return settleAsk(entry, choiceIndex, text);
    }
    return null;
}

function settleAsk(entry, choiceIndex, text) {
    let answer;
    if (choiceIndex !== null && Number.isInteger(choiceIndex)) {
        answer = entry.options[choiceIndex] ?? String(text || "").trim();
    } else {
        answer = String(text || "").trim();
    }
    if (!answer) return null;
    return settleAndNotify(entry, answer) ? answer : null;
}

export function cancelPendingAsk(sessionKey, reason = "aborted") {
    const entry = pendingAsks.get(String(sessionKey));
    if (!entry) return false;
    return settleAndNotify(entry, `__CANCELLED__:${reason}`);
}

export function askUser({ sessionKey, question, options = [], timeoutMs = 120_000 }) {
    const key = String(sessionKey);
    cancelPendingAsk(key, "superseded");

    const entry = {
        key,
        id: crypto.randomBytes(6).toString("hex"),
        question: String(question),
        options: options.map((o) => String(o)),
        expiresAt: Date.now() + timeoutMs,
        settled: false,
        resolve: null,
        timer: null,
    };

    const promise = new Promise((resolve) => {
        entry.resolve = resolve;
    });

    entry.timer = setTimeout(() => {
        settleAndNotify(entry, "__TIMEOUT__");
    }, timeoutMs);

    pendingAsks.set(key, entry);
    emit({
        type: "ask",
        conversationId: key,
        askId: entry.id,
        question: entry.question,
        options: entry.options,
        expiresAt: new Date(entry.expiresAt).toISOString(),
    });

    return promise.then((raw) => {
        if (raw === "__TIMEOUT__") return { error: "timeout", text: null };
        if (typeof raw === "string" && raw.startsWith("__CANCELLED__:")) return { error: raw.slice(14), text: null };
        return { text: raw };
    });
}
