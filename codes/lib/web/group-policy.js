// 그룹 방의 토론 규칙. 저장이나 모델 호출 없이 입력만 보고 정한다(group-turns.js가 쓴다).
// - 사용자 메시지 하나가 토론 하나를 연다. 1라운드는 멘션한 멤버(없거나 @all이면 전원)가 차례로 답한다.
// - 2라운드부터는 다른 멤버가 답에서 @이름으로 불렀는데 그 뒤로 아직 말하지 않은 멤버만 답한다.
// - 한 라운드가 통째로 조용하면 끝난다. 3라운드를 다 돌거나 멤버 발언이 10개가 되어도 끝난다.

export const MAX_ROUNDS = 3;
export const MAX_MESSAGES = 10;
// 차례마다 넘기는 새 발화 묶음의 상한. 압축 대상이 아닌 블록이라 넘치면 막을 길이 없다.
export const CATCH_UP_MAX_CHARS = 32_000;
export const CATCH_UP_MAX_LINE_CHARS = 8_000;
// 처음 차례가 온 멤버에게 넘기는 지난 발화 수(턴 단위).
export const FIRST_CATCH_UP_TURNS = 20;
const PERSONA_SNIPPET_CHARS = 160;

const EVERYONE = new Set(["all", "everyone"]);

// 멘션을 찾기 전에 인용과 코드를 지운다. 코드 블록, 인라인 코드, 인용 줄(>), 따옴표 안의 "@이름"은 부른 것이 아니다.
function stripQuoted(text) {
    return String(text || "")
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/`[^`\n]*`/g, " ")
        .split("\n")
        .filter((line) => !/^\s*>/.test(line))
        .join("\n")
        .replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」/g, " ");
}

// "@이름" 뒤가 글자나 숫자가 아니어야 한다. 앞이 글자면 메일 주소 같은 것이라 뺀다.
function findMention(lower, needle) {
    let i = lower.indexOf(needle);
    while (i !== -1) {
        const before = i > 0 ? lower[i - 1] : "";
        const after = lower.slice(i + needle.length, i + needle.length + 1);
        if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return i;
        i = lower.indexOf(needle, i + 1);
    }
    return -1;
}

// 글에서 부른 멤버. members: [{ uuid, name }]. 돌려주는 값: { uuids(글에 나온 순서), everyone }.
// 긴 이름부터 맞춰 "봇"과 "봇2"를 가린다. 한 번 맞춘 자리는 짧은 이름이 다시 쓰지 않는다.
export function parseMentions(text, members) {
    const body = stripQuoted(text);
    if (!body.includes("@")) return { uuids: [], everyone: false };
    let lower = body.toLowerCase();
    const hits = [];
    const sorted = [...members].filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
    for (const { uuid, name } of sorted) {
        const needle = `@${name.toLowerCase()}`;
        const at = findMention(lower, needle);
        if (at === -1) continue;
        hits.push({ uuid, at });
        lower = lower.slice(0, at) + " ".repeat(needle.length) + lower.slice(at + needle.length);
    }
    let everyone = false;
    for (const word of EVERYONE) if (findMention(lower, `@${word}`) !== -1) everyone = true;
    hits.sort((a, b) => a.at - b.at);
    return { uuids: [...new Set(hits.map((h) => h.uuid))], everyone };
}

// 라운드마다 순서를 한 칸씩 돌린다(같은 멤버가 늘 먼저 말하지 않게).
export function rotate(list, round) {
    if (!list.length) return [];
    const k = round % list.length;
    return [...list.slice(k), ...list.slice(0, k)];
}

// 사용자 메시지가 연 토론의 1라운드 응답자와, 사용자가 직접 부른 멤버.
export function firstRound(text, members) {
    const memberUuids = members.map((m) => m.uuid);
    const { uuids, everyone } = parseMentions(text, members);
    if (everyone || !uuids.length) return { responders: memberUuids, addressed: everyone ? memberUuids : [] };
    return { responders: uuids, addressed: uuids };
}

// 토론 상태. spoke: 이번 토론에서 말한 순서대로의 uuid, calls: 누가 누구를 불렀는지 [{ from, to, at }].
export function newDiscussion({ responders, addressed }) {
    return {
        round: 0,
        queue: [...responders],
        addressed: new Set(addressed),
        spoke: [],
        calls: [],
        spokeThisRound: 0,
        failed: new Set(),
        messages: 0,
    };
}

// 한 멤버의 차례가 끝났다. 말했으면(visible) 그 글에서 부른 멤버를 기록한다.
export function recordTurn(d, uuid, { visible, text = "", members }) {
    if (!visible) return;
    d.messages += 1;
    d.spokeThisRound += 1;
    d.spoke.push(uuid);
    const at = d.spoke.length;
    const { uuids, everyone } = parseMentions(text, members);
    const targets = everyone ? members.map((m) => m.uuid) : uuids;
    for (const to of targets) if (to !== uuid) d.calls.push({ from: uuid, to, at });
}

// 불렸는데 그 뒤로 말하지 않은 멤버(부른 순서대로). 실패한 멤버는 뺀다.
// call.at은 부른 발언까지의 발언 수라서, 그 뒤(spoke[at..])에 이름이 있으면 답한 것이다.
export function pendingCalls(d) {
    const out = [];
    for (const call of d.calls) {
        if (d.failed.has(call.to) || out.includes(call.to)) continue;
        if (d.spoke.indexOf(call.to, call.at) === -1) out.push(call.to);
    }
    return out;
}

// 라운드가 끝났을 때 다음 할 일. { done: true, reason } 또는 { done: false, queue }.
// reason: "settled"(조용히 끝남), "max_rounds", "max_messages". 상한에 걸렸는데 불린 멤버가 남았으면 capped=true.
export function nextRound(d) {
    if (d.messages >= MAX_MESSAGES) return { done: true, reason: "max_messages", capped: pendingCalls(d).length > 0 };
    if (d.spokeThisRound === 0) return { done: true, reason: "settled", capped: false };
    const pending = pendingCalls(d);
    if (!pending.length) return { done: true, reason: "settled", capped: false };
    if (d.round + 1 >= MAX_ROUNDS) return { done: true, reason: "max_rounds", capped: true };
    d.round += 1;
    d.spokeThisRound = 0;
    d.queue = rotate(pending, d.round);
    return { done: false, queue: d.queue };
}

// 이 차례에서 침묵을 허락하는지. 사용자가 직접 부른 멤버와, 다른 멤버가 불러 기다리는 멤버는 침묵할 수 없다.
// 1라운드에서 아무도 아직 말하지 않았고 이 멤버가 마지막 차례면 침묵할 수 없다(사용자 메시지에 아무도 답하지 않는 일을 막는다).
export function mustReply(d, uuid) {
    if (d.addressed.has(uuid) || pendingCalls(d).includes(uuid)) return true;
    return d.round === 0 && d.spokeThisRound === 0 && d.queue.length === 0;
}

// 이 멤버를 부른 사람: "user"(사용자가 직접), 멤버 uuid(다른 멤버가), 또는 null.
export function calledBy(d, uuid) {
    if (d.addressed.has(uuid)) return "user";
    const call = [...d.calls].reverse().find((c) => c.to === uuid);
    return call ? call.from : null;
}

/* ── 차례마다 넘기는 블록 ─────────────────────────────────── */

// 다른 사람의 글을 한 화자의 줄로 안전하게 넣는다. 둘째 줄부터 들여써서 "User: …"처럼 보이는 줄을 만들 수 없게 하고,
// 시스템 블록처럼 보이는 머리(예: "[Group chat:")는 인용 표시로 바꾼다.
const CONTROL_OPENERS = /^\s*\[(?=(group chat|tabybot|system|scheduled|automatic|recovery|context|summary)\b)/i;

export function quoteBody(text, maxChars = CATCH_UP_MAX_LINE_CHARS) {
    let body = String(text || "").trim();
    let cut = false;
    if (body.length > maxChars) {
        body = body.slice(0, maxChars);
        cut = true;
    }
    const lines = body.split("\n").map((line) => (CONTROL_OPENERS.test(line) ? line.replace("[", "[quoted ") : line));
    return lines.join("\n    ") + (cut ? " … [truncated]" : "");
}

// entries: [{ who, text, files? }] 오래된 것부터. 새것부터 채워 상한을 넘기 전까지만 넣는다.
export function formatLines(entries, maxChars = CATCH_UP_MAX_CHARS) {
    const out = [];
    let used = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        const files = (e.files || []).filter(Boolean);
        const line = `${e.who}: ${quoteBody(e.text)}${files.length ? ` [attached: ${files.join(", ")}]` : ""}`;
        if (out.length && used + line.length > maxChars) {
            out.unshift(`(${i + 1} earlier message${i ? "s" : ""} omitted)`);
            return out;
        }
        out.unshift(line);
        used += line.length + 1;
    }
    return out;
}

function personaSnippet(persona) {
    const line = String(persona || "")
        .split("\n")
        .map((s) => s.trim())
        .find(Boolean);
    if (!line) return "";
    return line.length > PERSONA_SNIPPET_CHARS ? `${line.slice(0, PERSONA_SNIPPET_CHARS)}…` : line;
}

// 차례 블록. me/others: { name, persona }. caller: "user" | 멤버 이름 | null. mustReply: 침묵 금지 여부.
export function catchUpText({ groupName, me, others, lines, caller, mustReply: must }) {
    const roster = others.map((o) => {
        const p = personaSnippet(o.persona);
        return `- ${o.name}${p ? `: ${p}` : ""}`;
    });
    let ask;
    if (caller === "user") ask = "The user addressed you directly. Reply in this room.";
    else if (caller) ask = `${caller} mentioned you and is waiting on you. Reply in this room.`;
    else if (must)
        ask =
            "No one has answered the user yet. Reply in this room. If another member is a better fit to start on this, you may hand it to them with @name and one line on what you need instead of answering it all yourself.";
    else
        ask =
            "No one mentioned you, so you do not have to answer. If another member is a better fit to start on this, leave it to them: reply with ONLY __SILENT__, or hand it to them with @name. Reply yourself only if you are the best fit or you add something new.";
    return [
        `[Group chat: ${groupName}]`,
        `You are ${me.name}. Other members:`,
        ...(roster.length ? roster : ["- (none)"]),
        "",
        "New messages since your last turn (oldest first):",
        ...(lines.length ? lines.map((l) => `  ${l}`) : ["  (none)"]),
        "",
        ask,
    ].join("\n");
}
