// JSON/텍스트 영속화는 tmp+rename으로 쓴다 — 도중 크래시가 나도
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
