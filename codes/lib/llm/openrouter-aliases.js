// OpenRouter의 별칭 모델(~작성자/…-latest)이 실제로 넘겨 준 모델을 기억한다.
// 별칭은 OpenRouter가 서빙 프로바이더 목록을 비워 주므로, 고정 선택지는 실제 모델의 목록으로 보여 준다.
// 실제 모델은 답을 받을 때 응답의 model 값으로 알게 된다(따로 요청하지 않는다).
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../atomic-file.js";
import { USER_DIR } from "../paths.js";

const FILE = path.join(USER_DIR, "temp", "openrouter-aliases.json");

let cache = null;

function load() {
    if (!cache) {
        const raw = readJsonFile(FILE, {});
        cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    }
    return cache;
}

export function isOpenRouterAlias(model) {
    return String(model || "").startsWith("~");
}

// 별칭이 마지막으로 넘겨 준 실제 모델 id. 아직 답을 받은 적이 없으면 "".
export function resolvedOpenRouterModel(alias) {
    return String(load()[alias]?.model || "");
}

export function recordOpenRouterAlias(alias, model) {
    const target = String(model || "").trim();
    if (!isOpenRouterAlias(alias) || !target || isOpenRouterAlias(target)) return;
    const all = load();
    if (all[alias]?.model === target) return;
    cache = { ...all, [alias]: { model: target, at: new Date().toISOString() } };
    writeJsonAtomic(FILE, cache);
}
