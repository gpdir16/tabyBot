import crypto from "node:crypto";
import { emit } from "../web/bus.js";
import { clearTodoWaiting, markTodoWaiting } from "../todos/store.js";
import { createSecret, findSecretIdByName, updateSecret } from "../secrets/store.js";
import { placeholderFor } from "../secrets/vault.js";

const pendingAsks = new Map();

// 질문에 답하는 대신 채팅을 보냈을 때의 취소 사유. 그 메시지가 바로 다음에 대화에 들어간다.
export const ASK_CANCEL_USER_MESSAGE = "user_sent_message";
const USER_MESSAGE_NOTE =
    "The user did not answer. They sent a new chat message instead, which follows. Read it and follow it; it may change or cancel what you were doing. Do not re-ask the same question unless that message still needs it.";

function settle(entry, result) {
    if (entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    pendingAsks.delete(entry.key);
    if (entry.todoId && clearTodoWaiting(entry.todoId, entry.id)) emit({ type: "todos_changed" });
    entry.resolve(result);
    return true;
}

const SECRET_SAVED = "__SECRET_SAVED__";
const SECRET_MASK = "••••••••";

function settleAndNotify(entry, result) {
    if (!settle(entry, result)) return false;
    // 시크릿 질문의 답은 값이 아니라 저장 표시뿐이다. 이벤트에는 마스크만 싣는다.
    const answer = result === SECRET_SAVED ? SECRET_MASK : String(result ?? "");
    emit({ type: "ask_resolved", conversationId: entry.key, askId: entry.id, answer });
    return true;
}

export function resolvePendingAskByAskId(askId, { choiceIndex = null, text = "" } = {}) {
    for (const entry of pendingAsks.values()) {
        if (entry.id !== String(askId)) continue;
        if (entry.secret) return settleSecretAsk(entry, text);
        return settleAsk(entry, choiceIndex, text);
    }
    return null;
}

// 시크릿 질문: 입력값을 금고에 저장만 하고 모델에는 저장 사실만 알린다. 값이 잘못되면 SecretError를 던진다.
function settleSecretAsk(entry, value) {
    if (entry.settled) return null;
    // 같은 이름이 이미 있으면 그 시크릿의 값을 바꾸고, 없으면 새로 만든다.
    const existing = findSecretIdByName(entry.secret.name);
    if (existing) updateSecret(existing, { value: String(value ?? "") });
    entry.secret.id = existing || createSecret({ name: entry.secret.name, value: String(value ?? "") });
    return settleAndNotify(entry, SECRET_SAVED) ? SECRET_MASK : null;
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

// 아직 답을 기다리는 질문 목록. 새로고침·재접속한 화면이 카드를 되살리는 데 쓴다.
export function listPendingAsks() {
    return [...pendingAsks.values()]
        .filter((e) => !e.settled)
        .map((e) => ({
            conversationId: e.key,
            askId: e.id,
            question: e.question,
            options: e.options,
            expiresAt: new Date(e.expiresAt).toISOString(),
            todoId: e.todoId || undefined,
            secret: e.secret?.name,
        }));
}

export function cancelPendingAsk(sessionKey, reason = "aborted") {
    const entry = pendingAsks.get(String(sessionKey));
    if (!entry) return false;
    return settleAndNotify(entry, `__CANCELLED__:${reason}`);
}

export function askUser({ sessionKey, question, options = [], timeoutMs = 120_000, todoId = null, secret = null }) {
    const key = String(sessionKey);
    cancelPendingAsk(key, "superseded");

    const entry = {
        key,
        id: crypto.randomBytes(6).toString("hex"),
        question: String(question),
        options: options.map((o) => String(o)),
        expiresAt: Date.now() + timeoutMs,
        todoId: todoId ? String(todoId) : null,
        secret: secret ? { name: secret.name, id: null } : null,
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
    if (entry.todoId && markTodoWaiting(entry.todoId, { askId: entry.id, question: entry.question, convId: key })) emit({ type: "todos_changed" });
    emit({
        type: "ask",
        conversationId: key,
        askId: entry.id,
        question: entry.question,
        options: entry.options,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        todoId: entry.todoId || undefined,
        secret: entry.secret?.name,
    });

    return promise.then((raw) => {
        if (raw === SECRET_SAVED) return { ok: true, saved: true, name: entry.secret.name, placeholder: placeholderFor(entry.secret.id) };
        if (raw === "__TIMEOUT__") return { error: "timeout", text: null };
        if (raw === `__CANCELLED__:${ASK_CANCEL_USER_MESSAGE}`) return { error: ASK_CANCEL_USER_MESSAGE, text: null, note: USER_MESSAGE_NOTE };
        if (typeof raw === "string" && raw.startsWith("__CANCELLED__:")) return { error: raw.slice(14), text: null };
        return { text: raw };
    });
}
