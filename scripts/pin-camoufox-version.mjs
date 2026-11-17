// Docker 빌드 때 camoufox-js가 받을 브라우저 릴리스를 고정한다.
// camoufox-js는 지원 범위(>=beta.19, <1)의 "최신" 릴리스를 받으므로, 위쪽에서 새 릴리스가 나오면
// juggler 코드가 바뀌어 tabyBot의 탭 패치가 깨진다. 지원 상한을 고정 릴리스 바로 다음으로 낮춰
// 특정 릴리스만 선택되게 한다. camoufox-js의 fetch 로직(애드온·GeoIP 포함)은 그대로 쓴다.
// 사용법: node pin-camoufox-version.mjs <camoufox-js 폴더> <고정할 release>  (예: beta.42)
import fs from "node:fs";
import path from "node:path";

function fail(reason) {
    console.error(`pin-camoufox-version: ${reason}`);
    process.exit(1);
}

const [dir, release] = process.argv.slice(2);
if (!dir || !release) fail("usage: node pin-camoufox-version.mjs <camoufox-js dir> <release>");

// Version.isSupported()는 release < MAX_VERSION 이므로 상한은 고정 릴리스의 다음 번호로 둔다.
const m = /^(beta\.)(\d+)$/.exec(release);
if (!m) fail(`unsupported release '${release}' (expected beta.N)`);
const maxRelease = `${m[1]}${Number(m[2]) + 1}`;

const file = path.join(dir, "dist", "__version__.js");
const source = fs.readFileSync(file, "utf8");
const pattern = /static MAX_VERSION = "[^"]*";/;
if (!pattern.test(source)) fail("MAX_VERSION not found, update this script");

const next = source.replace(pattern, `static MAX_VERSION = "${maxRelease}";`);
if (next === source) fail("no change made");
fs.writeFileSync(file, next);
console.log(`pin-camoufox-version: pinned ${release} (MAX_VERSION=${maxRelease})`);
