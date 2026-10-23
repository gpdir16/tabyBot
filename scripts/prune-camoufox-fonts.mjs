// Docker 이미지 빌드 때 Camoufox 번들 폰트 중 리눅스 지문이 쓰지 않는 파일을 지운다.
// 사용법: node prune-camoufox-fonts.mjs <camoufox 설치 폴더> <camoufox-js 폴더>
//
// Camoufox는 OS 위장용으로 윈도우, 맥, 리눅스 폰트를 2GB 넘게 싣고 다닌다. 지문 OS가 리눅스면
// fonts/groups.json의 readBy.lin 그룹만 읽고, 그중에서도 camoufox-js 허용 목록(mappings/fonts.config.js의 lin)에
// 든 패밀리만 페이지에 보인다. 허용 목록 밖의 폰트는 글자 대체에도 쓰이지 않는다(전체, 리눅스 그룹만,
// 허용 목록만 남긴 세 경우의 화면이 픽셀 단위로 같았다). camofox-browser는 CAMOFOX_OS가 없으면
// 호스트 OS(도커에서는 리눅스)로 지문을 만들므로 이미지에는 리눅스 허용 폰트만 남긴다.
// 목록이나 fc-scan을 못 쓰면 아무것도 지우지 않는다.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [installDir, camoufoxJsDir] = process.argv.slice(2);
const fontsDir = path.join(installDir || "", "fonts");

function skip(reason) {
    console.warn(`prune-camoufox-fonts: skipped (${reason})`);
    process.exit(0);
}

if (!installDir || !camoufoxJsDir) skip("usage: prune-camoufox-fonts.mjs <camoufox dir> <camoufox-js dir>");

let groups;
let allowed;
try {
    groups = JSON.parse(fs.readFileSync(path.join(fontsDir, "groups.json"), "utf8"));
    const config = await import(pathToFileURL(path.join(camoufoxJsDir, "dist", "mappings", "fonts.config.js")).href);
    allowed = new Set(config.default?.lin || []);
} catch (err) {
    skip(err.message);
}
const linGroups = new Set(groups?.readBy?.lin || []);
if (!linGroups.size || !allowed.size) skip("no linux font groups or allow list");

function families(file) {
    const out = execFileSync("fc-scan", ["--format", "%{family}\n", file], { encoding: "utf8" });
    return out
        .split(/[\n,]/)
        .map((name) => name.trim())
        .filter(Boolean);
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

// 먼저 지울 목록을 다 만든 뒤 지운다. 도중에 fc-scan이 실패하면 아무것도 지우지 않은 채 끝난다.
const drop = [];
const keep = [];
try {
    for (const group of groups.groups || []) {
        const dir = path.join(fontsDir, group);
        if (!fs.existsSync(dir)) continue;
        if (!linGroups.has(group)) {
            drop.push(dir);
            continue;
        }
        for (const file of walk(dir)) {
            (families(file).some((name) => allowed.has(name)) ? keep : drop).push(file);
        }
    }
} catch (err) {
    skip(`fc-scan failed: ${err.message}`);
}
if (!keep.length) skip("no font file matched the allow list");

let freed = 0;
const sizeOf = (target) => (fs.statSync(target).isDirectory() ? walk(target).reduce((n, f) => n + fs.statSync(f).size, 0) : fs.statSync(target).size);
for (const target of drop) {
    freed += sizeOf(target);
    fs.rmSync(target, { recursive: true, force: true });
}
console.log(`prune-camoufox-fonts: kept ${keep.length} files, freed ${(freed / 1048576).toFixed(0)} MB`);
