// 그룹 방의 턴 진행: 사용자 메시지 하나가 토론 하나를 열고, 규칙(group-policy.js)에 따라 멤버를 차례로 돌린다.
// - 1라운드는 멘션한 멤버(없거나 @all이면 전원)가 답한다. 할 말이 없으면 __SILENT__로 넘긴다.
// - 2라운드부터는 다른 멤버가 답에서 부른 멤버만 답한다. 한 라운드가 조용하거나 상한(3라운드, 발언 10개)에 닿으면 끝난다.
// - 사용자가 직접 부른 멤버, 다른 멤버가 불러 기다리는 멤버는 침묵할 수 없다(침묵하면 루프가 되돌려 답을 받는다).
// - 토론 중에 사용자가 보낸 말은 지금 답하는 멤버에게 끼워 넣고(그 멤버를 불렀거나 아무도 부르지 않았을 때),
//   그 멤버의 차례가 끝나면 남은 차례를 버리고 새 메시지로 토론을 다시 연다.
// 에이전트마다 이 방에서 쓰는 자기 세션이 있고(groups-store.js), 차례가 오면 지난 차례 뒤의 발화를 받는다.
// 에이전트 세션의 기록은 방의 화면 기록에 옮겨 적는다(사용자 메시지 빼고).
import { getAgentByUuid } from "../agents-store.js";
import { cloneStoredMessage, loadChatHistory, newMessageId, userMessageIdsOf } from "../agent/chat-history.js";
import { replaceChatHistory } from "../agent/history/sessions.js";
import { writePreview } from "../agent/history/preview.js";
import { GROUP_SILENCE_HINTS, beginAgentSession, endAgentSession, enqueueAgentMessage, requestAgentStop } from "../agent/session.js";
import { ASK_CANCEL_USER_MESSAGE, cancelPendingAsk } from "../agent/user-ask.js";
import { loadUserConfig } from "../config-loader.js";
import { getGroup, listGroups, memberSessionKey, setGroupCursor } from "../groups-store.js";
import { formatAgentError, t } from "../i18n.js";
import { markUserActivity } from "../user-activity.js";
import { emit } from "./bus.js";
import { toDisplayTurns } from "./conversations.js";
import {
    FIRST_CATCH_UP_TURNS,
    calledBy,
    catchUpText,
    firstRound,
    formatLines,
    mustReply,
    newDiscussion,
    nextRound,
    pendingCalls,
    recordTurn,
} from "./group-policy.js";
import { runTurn } from "./turns.js";

const NOTICE_DETAIL_CHARS = 200;

// 방마다 지금 진행 중인 실행: { discussion, current, stopped, restart, seed }
// restart: 토론 중에 온 사용자 메시지(새 토론을 연다). seed: 그 메시지를 끼워 받은 멤버의 답(새 토론의 첫 발언으로 친다).
const runs = new Map();

function agentName(uuid) {
    return getAgentByUuid(uuid)?.name || "Agent";
}

function membersOf(group) {
    return group.members.map((uuid) => ({ uuid, name: agentName(uuid) }));
}

function lang() {
    return loadUserConfig().language || "en";
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

// 방의 안내 줄(응답 실패, 상한 도달). 에이전트에게는 넘기지 않는다.
function appendNotice(groupId, text) {
    const at = new Date().toISOString();
    const turns = loadChatHistory(groupId);
    turns.push({ id: newMessageId(), at, notice: true, messages: [{ role: "notice", content: text, at }] });
    writeGroupTurns(groupId, turns);
    emit({ type: "turns_changed", conversationId: groupId });
}

// 에이전트 세션에서 이번 실행의 기록을 방의 화면 기록에 옮겨 적는다. 사용자 메시지(지난 발화 묶음, 끼워 넣은 말)는 빼고
// 에이전트의 발화와 도구 기록만 남긴다. 보이는 발화가 없으면(침묵) 적지 않고, 적어 둔 것이 있으면 걷어 낸다.
function mirrorRun(groupId, turnId, speaker, messages, { final, result }) {
    const turns = loadChatHistory(groupId);
    const idx = turns.findIndex((turn) => turn?.id === turnId);
    const record = {
        id: turnId,
        speaker,
        // 에이전트가 나중에 지워져도 기록에서 누가 말했는지 보이게 이름을 함께 남긴다.
        speakerName: agentName(speaker),
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

// 방의 턴 하나를 화자별 발화로 바꾼다. 에이전트의 질문 카드는 질문만 남기고, 에이전트가 보낸 파일 이름도 싣는다.
function turnEntries(turn) {
    if (turn?.notice) return [];
    const display = toDisplayTurns([turn])[0];
    if (!display) return [];
    const who = turn.speaker ? getAgentByUuid(turn.speaker)?.name || turn.speakerName || "Agent" : "User";
    const entries = [];
    for (const m of display.messages) {
        if (m.role === "ask") entries.push({ who: `${who} (asked the user)`, text: m.question });
        else if (m.role === "user" || m.role === "assistant") {
            const files = (m.attachments || []).map((a) => a.name);
            const text = String(m.content || "").trim();
            if (text || files.length) entries.push({ who, text, files });
        }
    }
    const delivered = (turn.attachments || []).map((a) => a?.name).filter(Boolean);
    if (delivered.length) {
        if (entries.length) entries.at(-1).files = [...(entries.at(-1).files || []), ...delivered];
        else entries.push({ who, text: "", files: delivered });
    }
    return entries;
}

// 사용자가 보낸 첨부(이미지 등)는 그 발화를 처음 받는 에이전트의 메시지에 함께 싣는다.
function userAttachmentsOf(turns) {
    return turns.filter((turn) => !turn.speaker).flatMap((turn) => turn.messages.flatMap((m) => (m.role === "user" ? m.attachments || [] : [])));
}

// 에이전트가 이번 차례에 사용자에게 보인 글(멘션을 찾는 데 쓴다).
function visibleTextOf(result) {
    if (!result) return "";
    const said = (result.turnMessages || [])
        .filter((m) => m?.role === "assistant")
        .flatMap((m) => toDisplayTurns([{ messages: [m] }])[0]?.messages || [])
        .map((m) => m.content || "");
    return said.join("\n").trim();
}

/* ── 차례 진행 ─────────────────────────────────────────── */

// 침묵을 되돌릴 때의 안내: 누가 이 멤버를 기다리는지에 맞춘다.
function silenceHintFor(d, uuid) {
    if (d.addressed.has(uuid)) return GROUP_SILENCE_HINTS.user;
    if (pendingCalls(d).includes(uuid)) return GROUP_SILENCE_HINTS.member;
    return GROUP_SILENCE_HINTS.unanswered;
}

// 멤버 하나의 차례. 지난 차례 뒤의 발화를 모아 그 멤버의 세션에서 한 턴을 돌린다.
// 돌려주는 값: { skipped } 또는 { result, visible, text }.
async function runMember(groupId, group, d, agentUuid, run) {
    const agent = getAgentByUuid(agentUuid);
    if (!agent) return { skipped: true };
    const sessionKey = memberSessionKey(groupId, agentUuid);
    const turns = loadChatHistory(groupId);
    const cursor = group.cursors[agentUuid];
    const start = Number.isInteger(cursor) && cursor >= 0 ? Math.min(cursor, turns.length) : Math.max(0, turns.length - FIRST_CATCH_UP_TURNS);
    const fresh = turns.slice(start).filter((turn) => turn.speaker !== agentUuid);
    const entries = fresh.flatMap(turnEntries);
    // 지난 차례 뒤로 새로 볼 것이 없으면 건너뛴다(끼워 받은 메시지에 이미 답한 멤버 등).
    if (!entries.length) return { skipped: true };

    // 세션을 먼저 열어 둔다. 발화를 모은 뒤에 온 사용자 메시지는 이 세션의 대기열로 들어간다.
    loadChatHistory(sessionKey);
    beginAgentSession(sessionKey);
    setGroupCursor(groupId, agentUuid, turns.length);

    const must = mustReply(d, agentUuid);
    const caller = calledBy(d, agentUuid);
    const waitingOn = d.addressed.has(agentUuid) ? "user" : pendingCalls(d).includes(agentUuid) && caller ? agentName(caller) : null;
    const others = group.members
        .filter((uuid) => uuid !== agentUuid)
        .map((uuid) => ({ name: agentName(uuid), persona: getAgentByUuid(uuid)?.persona }));
    const turnId = newMessageId();
    let leftover = false;
    const result = await runTurn({
        sessionKey,
        agentId: agent.id,
        userText: catchUpText({
            groupName: group.name,
            me: { name: agent.name },
            others,
            lines: formatLines(entries),
            caller: waitingOn,
            mustReply: must,
        }),
        attachments: userAttachmentsOf(fresh),
        quietEmpty: !must,
        silenceHint: silenceHintFor(d, agentUuid),
        mirror: (messages, opts) => mirrorRun(groupId, turnId, agentUuid, messages, opts),
        // 끝나기 직전에 와서 이 멤버가 읽지 못한 사용자 메시지: 다음 차례에 다시 받게 커서를 되돌린다.
        // 새 토론은 dispatchGroupMessage가 이미 예약해 두었다.
        onLeftover(messages) {
            leftover = true;
            const ids = new Set(messages.map((m) => m.id));
            const all = loadChatHistory(groupId);
            const first = all.findIndex((turn) => userMessageIdsOf(turn.messages).some((id) => ids.has(id)));
            if (first >= 0) setGroupCursor(groupId, agentUuid, first);
        },
    });
    // 끼워 받은 사용자 메시지는 이 차례에서 이미 읽었다. 다음 차례에 같은 메시지를 또 받지 않게 커서를 끝으로 옮긴다.
    if (!leftover) setGroupCursor(groupId, agentUuid, loadChatHistory(groupId).length);
    if (run.injected === agentUuid && leftover) run.injected = null;
    const text = visibleTextOf(result);
    const visible = !result?.error && Boolean(text || result?.deliveredAttachments?.length);
    return { result, visible, text };
}

function failureDetail(result) {
    const raw = result?.errorDetail ? formatAgentError(new Error(result.errorDetail), lang()) : t(result?.error || "agent_error", lang());
    const line = String(raw || "")
        .split("\n")[0]
        .trim();
    return line.length > NOTICE_DETAIL_CHARS ? `${line.slice(0, NOTICE_DETAIL_CHARS)}…` : line;
}

// 토론 중에 온 사용자 메시지로 새 토론을 연다. 누가 답할지는 가장 최근 메시지로 정한다(최신 지시가 앞선다).
// 그 메시지를 끼워 받아 이미 답한 멤버는 첫 발언으로 친다.
function openRestartedDiscussion(run, group) {
    const { text } = run.restart;
    run.restart = null;
    const members = membersOf(group);
    const d = newDiscussion(firstRound(text, members));
    const seed = run.seed;
    run.seed = null;
    if (seed && d.queue.includes(seed.uuid)) {
        d.queue = d.queue.filter((uuid) => uuid !== seed.uuid);
        recordTurn(d, seed.uuid, { visible: seed.visible, text: seed.text, members });
    }
    run.discussion = d;
}

async function runGroup(groupId, run) {
    const session = beginAgentSession(groupId);
    emit({ type: "conversations_changed" });
    try {
        while (!run.stopped && !session.isAborted()) {
            const group = getGroup(groupId);
            if (!group) break;
            if (run.restart) openRestartedDiscussion(run, group);
            const d = run.discussion;
            if (!d) break;

            if (!d.queue.length) {
                const next = nextRound(d);
                if (!next.done) continue;
                if (next.capped) {
                    const names = pendingCalls(d)
                        .filter((uuid) => group.members.includes(uuid))
                        .map(agentName)
                        .join(", ");
                    if (names) appendNotice(groupId, t("group_capped", lang(), { names }));
                }
                run.discussion = null;
                continue;
            }

            const uuid = d.queue.shift();
            if (!group.members.includes(uuid) || d.failed.has(uuid)) continue;
            run.current = uuid;
            run.injected = null;
            const out = await runMember(groupId, group, d, uuid, run);
            run.current = null;
            // 지워지는 에이전트라 멈춘 차례: 실패도 중단도 아니다. 그 답은 버리고 다음 차례로 간다.
            if (run.dropped === uuid) {
                run.dropped = null;
                continue;
            }
            if (out.skipped) continue;
            const { result, visible, text } = out;
            if (run.stopped || result?.error === "stopped_by_user") break;

            if (result?.error) {
                d.failed.add(uuid);
                appendNotice(groupId, t("group_member_failed", lang(), { name: agentName(uuid), detail: failureDetail(result) }));
            }
            // 새 사용자 메시지가 와 있으면 이 답은 새 토론의 첫 발언으로 넘기고, 지금 토론은 버린다.
            if (run.restart) {
                if (run.injected === uuid) run.seed = { uuid, visible, text };
                continue;
            }
            recordTurn(d, uuid, { visible, text, members: membersOf(group) });
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

    const run = runs.get(groupId);
    if (run) {
        // 지금 답하는 멤버를 불렀거나 아무도 부르지 않았으면 그 멤버에게 바로 끼워 넣는다. 질문을 기다리던 중이면 기다림을 끝낸다.
        const { responders } = firstRound(message.text, membersOf(group));
        if (run.current && responders.includes(run.current)) {
            const key = memberSessionKey(groupId, run.current);
            if (enqueueAgentMessage(key, { ...message, text: `[Group chat: ${group.name}] User: ${message.text}` })) {
                cancelPendingAsk(key, ASK_CANCEL_USER_MESSAGE);
                run.injected = run.current;
            }
        }
        // 이 멤버의 차례가 끝나면 남은 차례를 버리고 새 메시지로 토론을 다시 연다.
        run.restart = { text: message.text };
        return { id: message.id, queued: true };
    }
    const next = {
        discussion: newDiscussion(firstRound(message.text, membersOf(group))),
        current: null,
        stopped: false,
        restart: null,
        seed: null,
        injected: null,
    };
    runs.set(groupId, next);
    void runGroup(groupId, next);
    return { id: message.id, queued: false };
}

// 멈춤: 남은 차례를 비우고 지금 답하는 멤버를 멈춘다.
export function stopGroup(groupId) {
    const run = runs.get(groupId);
    if (!run) return false;
    run.stopped = true;
    run.discussion = null;
    run.restart = null;
    requestAgentStop(groupId);
    if (run.current) requestAgentStop(memberSessionKey(groupId, run.current));
    else emit({ type: "turn_done", conversationId: groupId, text: null, stats: null, error: null, stopped: true });
    return true;
}

// 재시작 복구 대상: 모든 방의 멤버 세션. 이어 돌린 턴도 방의 화면 기록에 옮겨 적는다.
export function memberSessionsForRecovery() {
    return listGroups().flatMap((group) =>
        group.members
            .map((agentUuid) => ({ agentUuid, agent: getAgentByUuid(agentUuid) }))
            .filter(({ agent }) => agent)
            .map(({ agentUuid, agent }) => {
                const turnId = newMessageId();
                return {
                    sessionKey: memberSessionKey(group.id, agentUuid),
                    agentId: agent.id,
                    mirror: (messages, opts) => mirrorRun(group.id, turnId, agentUuid, messages, opts),
                };
            }),
    );
}

// 에이전트를 지우기 직전에 부른다. 그 에이전트가 있던 방에서 지금 답하고 있으면 멈추고, 남은 차례에서 뺀다.
// 이름은 지우기 전에 받아 둔다(지운 뒤에는 찾을 수 없다).
export function prepareAgentRemoval(agentUuid) {
    for (const [groupId, run] of runs) {
        const d = run.discussion;
        if (d) {
            d.queue = d.queue.filter((uuid) => uuid !== agentUuid);
            d.failed.add(agentUuid);
        }
        // 지금 답하는 중이면 그 멤버만 멈춘다. 방의 실행은 다음 차례로 이어간다(runGroup이 dropped를 본다).
        if (run.current === agentUuid) {
            run.dropped = agentUuid;
            requestAgentStop(memberSessionKey(groupId, agentUuid));
        }
    }
}

// 에이전트를 지운 뒤: 남은 방마다 "○○이(가) 나갔어요" 안내를 남긴다. 지워진 방은 실행도 멈춘다.
export function afterAgentRemoved(name, touched) {
    for (const { id, removed } of touched) {
        if (removed) {
            stopGroup(id);
            continue;
        }
        appendNotice(id, t("group_member_left", lang(), { name }));
    }
}
