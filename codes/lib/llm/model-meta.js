import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { loadProviderConfig } from "../config-loader.js";
import { fetchProviderModels, findModelContextWindow, findModelVisionSupport } from "./models.js";
import { writeJsonAtomic } from "../atomic-file.js";

const META_PATH = path.join(USER_DIR, "temp", "model-meta.json");
const DEFAULT_CONTEXT = 128000;
// 목록에서 크기를 얻지 못해 기본값으로 둔 정보는 이만큼 지나면 다시 받아 본다.
const GUESSED_RETRY_MS = 60 * 60 * 1000;

export function loadModelMeta() {
    if (!fs.existsSync(META_PATH)) {
        return { contextWindow: DEFAULT_CONTEXT, model: null, supportsVision: false };
    }
    try {
        return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    } catch (err) {
        console.error(`tabyBot: invalid model meta cache:`, err.message);
        return { contextWindow: DEFAULT_CONTEXT, model: null, supportsVision: false };
    }
}

function saveModelMeta(meta) {
    writeJsonAtomic(META_PATH, meta);
}

// 제공자가 응답과 함께 실제 컨텍스트 크기를 알려 주면 쓰고 있는 값과 캐시를 그 값으로 고침.
export function rememberContextWindow(meta, contextWindow) {
    if (!(contextWindow > 0) || meta.contextWindow === contextWindow) return;
    meta.contextWindow = contextWindow;
    const cached = loadModelMeta();
    // 응답이 알려 준 크기는 추정이 아니므로 다시 받아 덮지 않는다.
    if (cached.model === meta.model) saveModelMeta({ ...cached, contextWindow, guessed: false });
}

export async function ensureModelMeta(provider) {
    let defaultContext = DEFAULT_CONTEXT;
    try {
        const p = loadProviderConfig(provider.id);
        if (p.defaultContextWindow) defaultContext = p.defaultContextWindow;
    } catch {
        // keep default
    }

    const cached = loadModelMeta();
    // 같은 모델 id라도 프로바이더가 다르면 크기가 다를 수 있다.
    const retryGuess = cached.guessed && !(Date.now() - Date.parse(cached.fetchedAt || 0) < GUESSED_RETRY_MS);
    if (
        cached.model === provider.model &&
        cached.providerId === provider.id &&
        cached.contextWindow != null &&
        cached.supportsVision != null &&
        !retryGuess
    ) {
        return cached;
    }

    let contextWindow = defaultContext;
    let guessed = true;
    // Copilot "auto"는 모델 목록에 없는 가상 라우팅 id: 요청마다 큐레이션된
    // 비전 모델 풀에서 고른다. false로 두면 첨부/스크린샷이 조용히 버려진다.
    let supportsVision = provider.model === "auto" ? true : findModelVisionSupport(null, provider.model);
    try {
        const models = await fetchProviderModels(provider);
        const fromList = findModelContextWindow(models, provider.model);
        if (fromList) {
            contextWindow = fromList;
            guessed = false;
        }
        supportsVision = provider.model === "auto" ? models.some((m) => m?.supportsVision !== false) : findModelVisionSupport(models, provider.model);
    } catch {
        // keep defaults
    }

    const meta = {
        model: provider.model,
        providerId: provider.id,
        contextWindow,
        supportsVision,
        fetchedAt: new Date().toISOString(),
    };
    if (guessed) meta.guessed = true;
    saveModelMeta(meta);
    return meta;
}
