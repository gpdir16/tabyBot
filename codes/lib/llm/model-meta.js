import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../paths.js";
import { loadProviderConfig } from "../config-loader.js";
import { fetchProviderModels, findModelContextWindow, findModelVisionSupport } from "./models.js";

const META_PATH = path.join(USER_DIR, "temp", "model-meta.json");
const DEFAULT_CONTEXT = 128000;

export function loadModelMeta() {
    if (!fs.existsSync(META_PATH)) {
        return { contextWindow: DEFAULT_CONTEXT, model: null, supportsVision: false };
    }
    try {
        return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    } catch (err) {
        console.error(`tabyAgent: invalid model meta cache:`, err.message);
        return { contextWindow: DEFAULT_CONTEXT, model: null, supportsVision: false };
    }
}

export function saveModelMeta(meta) {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
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
    let supportsVision = findModelVisionSupport(null, provider.model);
    try {
        const models = await fetchProviderModels(provider);
        const fromList = findModelContextWindow(models, provider.model);
        if (fromList) contextWindow = fromList;
        supportsVision = findModelVisionSupport(models, provider.model);
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
