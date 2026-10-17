// 시스템 프롬프트의 자주 바뀌는 항목(prompt-sections.js)을 세션마다 고정해 프롬프트 캐시를 지킨다.
// - 세션에서 처음 프롬프트를 만들 때 그 값을 스냅샷으로 대화 폴더의 prompt-base.json에 적고, 시스템 프롬프트는 이 값으로 만든다.
// - 모델이 이미 아는 값 = 스냅샷 + 기록 속 사용자 메시지들의 stateUpdate. 지금 값이 이와 다른 항목만 이번 사용자 메시지의
//   stateUpdate로 싣는다. 블록은 API로 보낼 때 그 메시지 앞에 붙는다(sanitize-messages.js).
// - 압축으로 새 세션이 시작되면 스냅샷을 새로 잡는다. 압축은 어차피 기록을 바꿔 캐시가 새로 시작된다.
import crypto from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../atomic-file.js";
import { conversationDir, loadManifest } from "./history/files.js";
import { VOLATILE_PROMPT_SECTIONS } from "./prompt-sections.js";

const BASE_FILE = "prompt-base.json";

export function pickVolatileVars(vars) {
    const out = {};
    for (const { key } of VOLATILE_PROMPT_SECTIONS) out[key] = String(vars[key] ?? "");
    return out;
}

// 스냅샷이 지금 등록된 항목을 모두 갖고 있는가. 항목이 새로 등록되기 전에 만든 스냅샷이면 새로 잡는다(캐시는 한 번 새로 시작).
function coversAllSections(vars) {
    return Boolean(vars) && typeof vars === "object" && VOLATILE_PROMPT_SECTIONS.every(({ key }) => typeof vars[key] === "string");
}

// 활성 세션의 스냅샷. 없거나 다른 세션 것이면 지금 값으로 새로 적는다. 대화 폴더가 없으면(봇이 아닌 실행) null.
function loadOrCreateBase(chatId, currentVars) {
    const root = conversationDir(chatId);
    const sessionId = loadManifest(chatId)?.activeSessionId;
    if (!root || !sessionId) return null;
    const filePath = path.join(root, BASE_FILE);
    const saved = readJsonFile(filePath, null);
    if (saved?.sessionId === sessionId && typeof saved.id === "string" && coversAllSections(saved.vars)) {
        return saved;
    }
    const base = { sessionId, id: crypto.randomUUID(), at: new Date().toISOString(), vars: pickVolatileVars(currentVars) };
    try {
        writeJsonAtomic(filePath, base);
    } catch (err) {
        console.warn(`tabyBot: prompt base save failed: ${err?.message || err}`);
        return null;
    }
    return base;
}

// 모델이 이미 받은 값: 스냅샷 위에 같은 스냅샷을 기준으로 실린 갱신을 순서대로 덮는다.
function knownVars(base, historyMessages) {
    const known = { ...base.vars };
    for (const m of historyMessages) {
        const update = m?.role === "user" ? m.stateUpdate : null;
        if (update?.base !== base.id || !update.vars || typeof update.vars !== "object") continue;
        Object.assign(known, update.vars);
    }
    return known;
}

// 시스템 프롬프트에 넣을 값과 이번 사용자 메시지에 실을 갱신. chatId가 없으면 지금 값을 그대로 쓴다.
export function resolvePromptState(chatId, currentVars, historyMessages) {
    const base = chatId ? loadOrCreateBase(chatId, currentVars) : null;
    if (!base) return { systemVars: currentVars, stateUpdate: null };

    const known = knownVars(base, historyMessages);
    const changed = {};
    for (const { key } of VOLATILE_PROMPT_SECTIONS) {
        if (String(known[key] ?? "") !== currentVars[key]) changed[key] = currentVars[key];
    }
    const systemVars = { ...currentVars, ...base.vars };
    return { systemVars, stateUpdate: Object.keys(changed).length ? { base: base.id, vars: changed } : null };
}
