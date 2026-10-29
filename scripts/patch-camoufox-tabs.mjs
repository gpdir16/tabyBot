// Docker 이미지 빌드 때 camoufox.cfg 끝에 camoufox-tabs.cfg(새 페이지를 탭으로 여는 패치)를 붙인다.
// 사용법: node patch-camoufox-tabs.mjs <camoufox 설치 폴더>
//
// 패치는 juggler의 TargetRegistry.js 함수를 바꿔 끼운다. Camoufox를 올리면서 그 코드 모양이 바뀌면
// 패치는 브라우저 안에서 조용히 실패하고 다시 페이지마다 창이 뜨므로, 붙이기 전에 기대는 코드가 그대로인지
// omni.ja에서 직접 읽어 확인하고 다르면 빌드를 멈춘다.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ENTRY = "modules/juggler/TargetRegistry.js";
// 패치가 부르거나 바꿔 끼우는 코드
const EXPECTED = [
    "export class TargetRegistry",
    "export class PageTarget",
    "async _newPageInternal({browserContextId})",
    "this._browserToTarget.get(browser)",
    "browserContext.userContextId",
    "hasFailedToOverrideTimezone()",
    "'TabOpen'",
    "async updateViewportSize()",
    "this._window.resizeBy(",
];
const MARKER = "tabyBot: 새 페이지를 새 창이 아니라";

function fail(reason) {
    console.error(`patch-camoufox-tabs: ${reason}`);
    process.exit(1);
}

const [installDir] = process.argv.slice(2);
if (!installDir) fail("usage: patch-camoufox-tabs.mjs <camoufox dir>");

// omni.ja는 zip이다. 항목 하나만 읽으면 되므로 로컬 헤더를 이름으로 찾는다.
function readJarEntry(file, name) {
    const buf = fs.readFileSync(file);
    const nameBuf = Buffer.from(name);
    for (let i = buf.indexOf(nameBuf); i >= 0; i = buf.indexOf(nameBuf, i + 1)) {
        const header = i - 30;
        if (header < 0 || buf.readUInt32LE(header) !== 0x04034b50 || buf.readUInt16LE(header + 26) !== nameBuf.length) continue;
        // 크기가 데이터 뒤에 따로 적히는 형식이면 로컬 헤더의 크기가 0이라 읽을 수 없다
        if (buf.readUInt16LE(header + 6) & 0x08) fail(`${name} uses a data descriptor`);
        const method = buf.readUInt16LE(header + 8);
        const size = buf.readUInt32LE(header + 18);
        const start = header + 30 + nameBuf.length + buf.readUInt16LE(header + 28);
        const data = buf.subarray(start, start + size);
        if (method === 0) return data.toString("utf8");
        if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
        fail(`${name} uses unsupported compression ${method}`);
    }
    fail(`${name} not found in ${file}`);
}

const source = readJarEntry(path.join(installDir, "omni.ja"), ENTRY);
const missing = EXPECTED.filter((snippet) => !source.includes(snippet));
if (missing.length) fail(`juggler changed, update camoufox-tabs.cfg (missing: ${missing.join(" | ")})`);

const cfgFile = path.join(installDir, "camoufox.cfg");
const cfg = fs.readFileSync(cfgFile, "utf8");
if (cfg.includes(MARKER)) {
    console.log("patch-camoufox-tabs: already applied");
} else {
    fs.appendFileSync(cfgFile, fs.readFileSync(new URL("./camoufox-tabs.cfg", import.meta.url), "utf8"));
    console.log("patch-camoufox-tabs: applied");
}
