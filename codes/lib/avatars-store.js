// 에이전트와 그룹 대화방의 프로필 사진. user/avatars/<uuid>.<확장자>에 하나씩 둔다(에이전트는 uuid, 그룹은 방 id).
// 기록(agents.json, groups.json)에는 내용 해시만 버전으로 남긴다. 사진이 바뀌면 주소(?v=)도 바뀌어 브라우저가 오래 캐시해도 된다.
// 미리 준비해 둔 사진은 codes/public/assets/avatars/에 넣는다. 고르면 그 사진을 받아 같은 방법으로 저장한다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CODES_DIR, USER_DIR } from "./paths.js";
import { writeFileAtomic } from "./atomic-file.js";

const AVATARS_DIR = path.join(USER_DIR, "avatars");
const PRESETS_DIR = path.join(CODES_DIR, "public", "assets", "avatars");
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 웹 화면은 256px 정사각형 PNG로 줄여 올린다. 한도는 API를 바로 부르는 경우를 위한 것이다.
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

// 형식은 바이트 앞부분으로 가린다. 브라우저가 스크립트로 실행할 수 있는 형식(svg 등)은 받지 않는다.
const FORMATS = [
    { ext: "png", mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(PNG_MAGIC) },
    { ext: "jpg", mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: "gif", mime: "image/gif", test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6)) },
    {
        ext: "webp",
        mime: "image/webp",
        test: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
    },
];

function fileOf(key, format) {
    return path.join(AVATARS_DIR, `${key}.${format.ext}`);
}

export function isAvatarKey(key) {
    return KEY_RE.test(String(key || ""));
}

// 사진을 저장하고 버전(내용 해시 앞 12자)을 돌려준다. 다른 형식으로 있던 옛 사진은 지운다.
export function saveAvatar(key, buffer) {
    if (!isAvatarKey(key)) return { error: "not_found" };
    const format = FORMATS.find((f) => f.test(buffer));
    if (!format) return { error: "invalid_image" };
    writeFileAtomic(fileOf(key, format), buffer);
    for (const f of FORMATS) {
        if (f !== format) fs.rmSync(fileOf(key, f), { force: true });
    }
    return { version: crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12) };
}

export function removeAvatar(key) {
    if (!isAvatarKey(key)) return;
    for (const f of FORMATS) fs.rmSync(fileOf(key, f), { force: true });
}

// 내려줄 사진 파일: { file, mime, size } 또는 null.
export function avatarFile(key) {
    if (!isAvatarKey(key)) return null;
    for (const f of FORMATS) {
        const file = fileOf(key, f);
        try {
            const stat = fs.statSync(file);
            if (stat.isFile()) return { file, mime: f.mime, size: stat.size };
        } catch {
            // 이 형식으로는 저장되어 있지 않다
        }
    }
    return null;
}

// 미리 준비해 둔 사진 목록(파일 이름 순): [{ name, href }]. 정적 파일이라 주소는 /assets/avatars/<파일>?v=<버전>이다.
// 버전은 정적 파일 서버(web/http/static.js)와 같은 내용 해시 앞 12자라 브라우저가 오래 캐시해도 된다.
// 확장자가 받는 형식(png, jpg, gif, webp)인 파일만 보인다.
const presetVersions = new Map(); // 파일 경로 → { mtimeMs, size, version }
function presetVersion(file) {
    const stat = fs.statSync(file);
    const hit = presetVersions.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.version;
    const version = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
    presetVersions.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, version });
    return version;
}

export function listAvatarPresets() {
    let names;
    try {
        names = fs.readdirSync(PRESETS_DIR);
    } catch {
        // 폴더가 없으면 고를 것도 없다
        return [];
    }
    const exts = new Set([...FORMATS.map((f) => `.${f.ext}`), ".jpeg"]);
    return names
        .filter((name) => !name.startsWith(".") && exts.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((name) => ({
            name: path.basename(name, path.extname(name)),
            href: `/assets/avatars/${encodeURIComponent(name)}?v=${presetVersion(path.join(PRESETS_DIR, name))}`,
        }));
}
