import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { loadProviderConfig } from "../config-loader.js";
import { fetchProviderModels, findModelContextWindow, findModelVisionSupport } from "./models.js";
import { writeJsonAtomic } from "../atomic-file.js";

const META_PATH = path.join(USER_DIR, "temp", "model-meta.json");
const DEFAULT_CONTEXT = 128000;

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

export function saveModelMeta(meta) {
    writeJsonAtomic(META_PATH, meta);
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
    if (cached.model === provider.model && cached.contextWindow != null && cached.supportsVision != null) {
        return cached;
    }

    let contextWindow = defaultContext;
    // Copilot "auto"는 모델 목록에 없는 가상 라우팅 id — 요청마다 큐레이션된
    // 비전 모델 풀에서 고른다. false로 두면 첨부/스크린샷이 조용히 버려진다.
    let supportsVision = provider.model === "auto" ? true : findModelVisionSupport(null, provider.model);
    try {
        const models = await fetchProviderModels(provider);
        const fromList = findModelContextWindow(models, provider.model);
        if (fromList) contextWindow = fromList;
        supportsVision = provider.model === "auto" ? models.some((m) => m?.supportsVision !== false) : findModelVisionSupport(models, provider.model);
    } catch {
        // keep defaults
    }

    const meta = {
        model: provider.model,
        contextWindow,
        supportsVision,
        fetchedAt: new Date().toISOString(),
    };
    saveModelMeta(meta);
    return meta;
}
