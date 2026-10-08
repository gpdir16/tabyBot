// JSON/텍스트 영속화는 tmp+rename으로 쓴다. 도중 크래시가 나도
// 기존 파일이 반쯤 쓰인 상태로 남지 않는다.
import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(filePath, data, { mode } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, mode ? { encoding: "utf8", mode } : "utf8");
    fs.renameSync(tmp, filePath);
}

export function writeJsonAtomic(filePath, data, opts = {}) {
    writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`, opts);
}

// JSON 파일을 읽는다. 없거나 깨졌으면 fallback. 깨진 파일은 label을 주면 오류로 남기고 아니면 조용히 넘어간다.
export function readJsonFile(filePath, fallback = null, { label = "" } = {}) {
    if (!filePath) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        if (label && err?.code !== "ENOENT") console.error(`tabyBot: invalid ${label}:`, err.message);
        return fallback;
    }
}
