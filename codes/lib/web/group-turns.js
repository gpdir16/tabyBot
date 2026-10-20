// 그룹 방의 턴 진행: 사용자 메시지를 받아 어느 에이전트가 답할지 정하고, 차례로 돌린다.
// - 멘션한 에이전트가 답한다. 멘션이 없으면 멤버 전원이 차례로 보고, 할 말이 없으면 __SILENT__로 넘어간다.
// - 에이전트가 답에서 다른 멤버를 멘션하면 그 멤버가 이어서 답한다. 횟수로 끊지 않는다(멈춤 버튼으로만 멈춘다).
// - 에이전트가 답하는 중에 사용자가 보낸 말은 그 에이전트의 다음 라운드에 끼워 넣는다.
// 에이전트마다 이 방에서 쓰는 자기 세션이 있고(groups-store.js), 차례가 오면 지난 차례 뒤의 발화를 받는다.
// 에이전트 세션의 기록은 방의 화면 기록에 옮겨 적는다(사용자 메시지 빼고).
import { getAgentByUuid } from "../agents-store.js";
import { cloneStoredMessage, loadChatHistory, newMessageId, userMessageIdsOf } from "../agent/chat-history.js";
import { replaceChatHistory } from "../agent/history/sessions.js";
import { writePreview } from "../agent/history/preview.js";
import { beginAgentSession, endAgentSession, enqueueAgentMessage, requestAgentStop } from "../agent/session.js";
import { ASK_CANCEL_USER_MESSAGE, cancelPendingAsk } from "../agent/user-ask.js";
import { getGroup, memberSessionKey, setGroupCursor } from "../groups-store.js";
import { markUserActivity } from "../user-activity.js";
import { emit } from "./bus.js";
import { toDisplayTurns } from "./conversations.js";
import { runTurn } from "./turns.js";

// 처음 차례가 온 에이전트에게 넘기는 지난 발화 수(턴 단위).
const FIRST_CATCH_UP_TURNS = 20;

// 방마다 지금 진행 중인 차례: { queue: [{ agentUuid, mentioned }], current }
const runs = new Map();

function agentName(uuid) {
    return getAgentByUuid(uuid)?.name || "Agent";
}

// 글에서 멘션된 멤버(uuid). "@이름" 뒤가 글자나 숫자가 아니어야 한다. 긴 이름부터 맞춰 "봇"과 "봇2"를 가린다.
export function mentionedMembers(text, group) {
    const body = String(text || "");
    if (!body.includes("@")) return [];
    const members = group.members.map((uuid) => ({ uuid, name: agentName(uuid) })).sort((a, b) => b.name.length - a.name.length);
    const found = [];
    const lower = body.toLowerCase();
    for (const { uuid, name } of members) {
        const needle = `@${name.toLowerCase()}`;
        let i = lower.indexOf(needle);
        while (i !== -1) {
            const after = body.slice(i + needle.length, i + needle.length + 1);
            if (!/[\p{L}\p{N}_]/u.test(after)) {
                if (!found.includes(uuid)) found.push(uuid);
                break;
            }
            i = lower.indexOf(needle, i + 1);
        }
    }
    // 글에 나온 순서대로 답하게 한다.
    return found.sort((a, b) => lower.indexOf(`@${agentName(a).toLowerCase()}`) - lower.indexOf(`@${agentName(b).toLowerCase()}`));
}

/* ── 방의 화면 기록 ─────────────────────────────────────── */

function writeGroupTurns(groupId, turns) {
    replaceChatHistory(groupId, turns);
    writePreview(groupId, turns);
}

function appendUserTurn(groupId, message) {
    const turns = loadChatHistory(groupId);
    turns.push({
        at: message.at,
        messages: [
            {
                role: "user",
                id: message.id,
                content: message.text,
                at: message.at,
                ...(message.attachments.length ? { attachments: message.attachments } : {}),
            },
        ],
    });
    writeGroupTurns(groupId, turns);
}

// 에이전트 세션에서 이번 실행의 기록을 방의 화면 기록에 옮겨 적는다. 사용자 메시지(지난 발화 묶음, 끼워 넣은 말)는 빼고
// 에이전트의 발화와 도구 기록만 남긴다. 보이는 발화가 없으면(침묵) 적지 않고, 적어 둔 것이 있으면 걷어 낸다.
function mirrorRun(groupId, turnId, speaker, messages, { final, result }) {
    const turns = loadChatHistory(groupId);
    const idx = turns.findIndex((turn) => turn?.id === turnId);
    const record = {
        id: turnId,
        speaker,
        at: idx >= 0 ? turns[idx].at : new Date().toISOString(),
        messages: messages.filter((m) => m?.role !== "user").map(cloneStoredMessage),
    };
    if (final && result?.stats) record.stats = result.stats;
    if (final && result?.deliveredAttachments?.length) record.attachments = result.deliveredAttachments;
    const visible = toDisplayTurns([record]).length > 0;
    if (!visible) {
        if (idx < 0) return;
        turns.splice(idx, 1);
    } else if (idx >= 0) turns[idx] = record;
    else turns.push(record);
    writeGroupTurns(groupId, turns);
}

/* ── 지난 차례 뒤의 발화 묶음 ─────────────────────────────── */

// 방의 턴 하나를 "이름: 발화" 줄들로 바꾼다. 에이전트의 질문 카드는 질문만 남긴다.
function turnLines(turn) {
    const display = toDisplayTurns([turn])[0];
    if (!display) return [];
    const who = turn.speaker ? agentName(turn.speaker) : "User";
    const lines = [];
    for (const m of display.messages) {
        if (m.role === "ask") lines.push(`${who} (asked the user): ${m.question}`);
        else if (m.role === "user" || m.role === "assistant") {
            const files = (m.attachments || []).map((a) => a.name).filter(Boolean);
            const text = String(m.content || "").trim();
            if (text || files.length) lines.push(`${who}: ${text}${files.length ? ` [attached: ${files.join(", ")}]` : ""}`);
        }
    }
    return lines;
}

function catchUpText(group, agentUuid, turns, mentioned) {
    const others = group.members.filter((uuid) => uuid !== agentUuid).map(agentName);
    const lines = turns.flatMap(turnLines);
    return [
        `[Group chat: ${group.name}]`,
        `Members: you (${agentName(agentUuid)}), ${others.join(", ")}, and the user.`,
        "New messages since your last turn:",
        ...(lines.length ? lines : ["(none)"]),
        "",
        mentioned
            ? "You were mentioned. Reply in this room."
            : "No one mentioned you. Reply only if you add something the others have not covered. Otherwise reply with ONLY __SILENT__.",
    ].join("\n");
}

// 사용자가 보낸 첨부(이미지 등)는 그 발화를 처음 받는 에이전트의 메시지에 함께 싣는다.
function userAttachmentsOf(turns) {
    return turns.filter((turn) => !turn.speaker).flatMap((turn) => turn.messages.flatMap((m) => (m.role === "user" ? m.attachments || [] : [])));
}

/* ── 차례 진행 ─────────────────────────────────────────── */

function enqueueResponder(run, agentUuid, mentioned) {
    const queued = run.queue.find((item) => item.agentUuid === agentUuid);
    if (queued) queued.mentioned ||= mentioned;
    else run.queue.push({ agentUuid, mentioned });
}

// 에이전트 하나의 차례. 지난 차례 뒤의 발화를 모아 그 에이전트의 세션에서 한 턴을 돌린다.
function runMember(groupId, group, { agentUuid, mentioned }) {
    const agent = getAgentByUuid(agentUuid);
    if (!agent) return null;
    const sessionKey = memberSessionKey(groupId, agentUuid);
    // 세션을 먼저 열어 둔다. 지난 발화를 모은 뒤에 온 사용자 메시지는 이 세션의 대기열로 들어간다.
    loadChatHistory(sessionKey);
    beginAgentSession(sessionKey);
    const turns = loadChatHistory(groupId);
    const cursor = group.cursors[agentUuid];
    const start = Number.isInteger(cursor) && cursor >= 0 ? Math.min(cursor, turns.length) : Math.max(0, turns.length - FIRST_CATCH_UP_TURNS);
    const fresh = turns.slice(start).filter((turn) => turn.speaker !== agentUuid);
    setGroupCursor(groupId, agentUuid, turns.length);
    const turnId = newMessageId();
    const run = runs.get(groupId);
    return runTurn({
        sessionKey,
        agentId: agent.id,
        userText: catchUpText(group, agentUuid, fresh, mentioned),
        attachments: userAttachmentsOf(fresh),
        quietEmpty: !mentioned,
        mirror: (messages, opts) => mirrorRun(groupId, turnId, agentUuid, messages, opts),
        // 끝나기 직전에 와서 이 에이전트가 읽지 못한 사용자 메시지: 다음 차례에 다시 받게 한다.
        onLeftover(leftover) {
            const ids = new Set(leftover.map((m) => m.id));
            const all = loadChatHistory(groupId);
            const first = all.findIndex((turn) => userMessageIdsOf(turn.messages).some((id) => ids.has(id)));
            if (first >= 0) setGroupCursor(groupId, agentUuid, first);
            if (run && !run.stopped)
                enqueueResponder(
                    run,
                    agentUuid,
                    leftover.some((m) => mentionedMembers(m.text, group).includes(agentUuid)),
                );
        },
    });
}

// 에이전트가 이번 차례에 사용자에게 보인 글(멘션을 찾는 데 쓴다).
function visibleTextOf(result) {
    if (!result) return "";
    const said = (result.turnMessages || [])
        .filter((m) => m?.role === "assistant")
        .flatMap((m) => toDisplayTurns([{ messages: [m] }])[0]?.messages || [])
        .map((m) => m.content || "");
    return said.join("\n");
}

async function runGroup(groupId, run) {
    const session = beginAgentSession(groupId);
    emit({ type: "conversations_changed" });
    try {
        while (run.queue.length && !run.stopped && !session.isAborted()) {
            const next = run.queue.shift();
            const group = getGroup(groupId);
            if (!group) break;
            if (!group.members.includes(next.agentUuid)) continue;
            run.current = next.agentUuid;
            const result = await runMember(groupId, group, next);
            run.current = null;
            if (run.stopped || result?.error === "stopped_by_user") break;
            if (result?.error) continue;
            // 이 에이전트가 멘션한 다른 멤버가 이어서 답한다.
            for (const uuid of mentionedMembers(visibleTextOf(result), group)) {
                if (uuid !== next.agentUuid) enqueueResponder(run, uuid, true);
            }
        }
    } catch (err) {
        console.error("Group turn error:", err?.stack || err);
    } finally {
        runs.delete(groupId);
        endAgentSession(groupId);
        emit({ type: "conversations_changed" });
    }
}

// 그룹 방에 온 사용자 메시지 한 건. 같은 id가 이미 기록에 있으면(재전송) 아무것도 하지 않는다.
export function dispatchGroupMessage({ groupId, id = null, userText, attachments = [] }) {
    markUserActivity();
    const group = getGroup(groupId);
    const message = { id: id || newMessageId(), text: String(userText || "").trim(), attachments, at: new Date().toISOString() };
    if (!group) return { id: message.id, duplicate: true };
    if (loadChatHistory(groupId).some((turn) => userMessageIdsOf(turn.messages).includes(message.id))) return { id: message.id, duplicate: true };
    appendUserTurn(groupId, message);

    const mentioned = mentionedMembers(message.text, group);
    const responders = mentioned.length ? mentioned : group.members;
    const run = runs.get(groupId);
    if (run) {
        // 지금 답하는 에이전트에게는 바로 끼워 넣는다. 질문을 기다리던 중이면 기다림을 끝낸다.
        let injectedTo = null;
        if (run.current) {
            const key = memberSessionKey(groupId, run.current);
            if (enqueueAgentMessage(key, { ...message, text: `[Group chat: ${group.name}] User: ${message.text}` })) {
                cancelPendingAsk(key, ASK_CANCEL_USER_MESSAGE);
                injectedTo = run.current;
            }
        }
        for (const uuid of responders) if (uuid !== injectedTo) enqueueResponder(run, uuid, mentioned.length > 0);
        return { id: message.id, queued: true };
    }
    const next = { queue: [], current: null, stopped: false };
    for (const uuid of responders) enqueueResponder(next, uuid, mentioned.length > 0);
    runs.set(groupId, next);
    void runGroup(groupId, next);
    return { id: message.id, queued: false };
}

// 멈춤: 남은 차례를 비우고 지금 답하는 에이전트를 멈춘다.
export function stopGroup(groupId) {
    const run = runs.get(groupId);
    if (!run) return false;
    run.stopped = true;
    run.queue = [];
    requestAgentStop(groupId);
    if (run.current) requestAgentStop(memberSessionKey(groupId, run.current));
    else emit({ type: "turn_done", conversationId: groupId, text: null, stats: null, error: null, stopped: true });
    return true;
}

export function isGroupRunning(groupId) {
    return runs.has(groupId);
}
