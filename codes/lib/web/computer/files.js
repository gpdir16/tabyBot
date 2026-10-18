// 봇 컴퓨터의 파일 탭 API: 컨테이너 안의 실제 폴더·파일을 읽는다.
// 경로는 에이전트 도구와 같은 규칙(절대 경로 또는 USER_DIR 기준 상대 경로)을 따른다.
// 시크릿 금고 파일은 목록·읽기·존재 확인에서 모두 숨긴다.
import fs from "node:fs";
import path from "node:path";
import { USER_DIR, resolveAgentPath } from "../../paths.js";
import { isSecretStorePath } from "../../secrets/store.js";

const MAX_ROWS = 2000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_RESOLVE_PATHS = 100;
const MAX_PATH_LENGTH = 4096;

const MIME = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
};

// 인라인으로 열어도 스크립트가 실행되지 않는 타입만 브라우저에 그대로 보낸다.
const INLINE_OK = /^(image\/(?:png|jpeg|gif|webp)|application\/pdf|video\/|audio\/)/i;

function resolveIncoming(rawPath) {
    const raw = String(rawPath ?? "").trim();
    if (!raw) return USER_DIR;
    if (raw.length > MAX_PATH_LENGTH) return null;
    if (raw === "~") return process.env.HOME || "/root";
    if (raw.startsWith("~/")) return path.join(process.env.HOME || "/root", raw.slice(2));
    return resolveAgentPath(raw);
}

function statOrNull(fullPath) {
    if (!fullPath || isSecretStorePath(fullPath)) return null;
    try {
        return fs.statSync(fullPath);
    } catch {
        return null;
    }
}

function kindOf(stat) {
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
}

function entryOf(dir, name) {
    const full = path.join(dir, name);
    const stat = statOrNull(full);
    if (!stat) return null;
    return {
        name,
        path: full,
        kind: kindOf(stat),
        size: stat.isFile() ? stat.size : null,
        mtime: new Date(stat.mtimeMs).toISOString(),
    };
}

function listDirectory(dir) {
    const names = fs.readdirSync(dir).slice(0, MAX_ROWS);
    const entries = [];
    for (const name of names) {
        const entry = entryOf(dir, name);
        if (entry) entries.push(entry);
    }
    entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    return entries;
}

function contentDisposition(inline, name) {
    return `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`;
}

function sendFile(ctx, fullPath, stat) {
    const inline = ctx.query.inline === "1" && INLINE_OK.test(MIME[path.extname(fullPath).toLowerCase()] || "");
    const type = MIME[path.extname(fullPath).toLowerCase()] || "application/octet-stream";
    ctx.res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Content-Disposition": contentDisposition(inline, path.basename(fullPath)),
        "Cache-Control": "private, no-store",
    });
    if (ctx.req.method === "HEAD") {
        ctx.res.end();
        return;
    }
    fs.createReadStream(fullPath)
        .on("error", () => ctx.res.destroy())
        .pipe(ctx.res);
}

export function registerComputerFileRoutes(router) {
    // 폴더 목록. path가 파일이면 목록 대신 그 파일의 정보만 돌려준다(링크 확인용).
    router.add("GET", "/api/computer/files", (ctx) => {
        const full = resolveIncoming(ctx.query.path);
        if (!full) return ctx.json400("invalid_path");
        const stat = statOrNull(full);
        if (!stat) return ctx.json404();
        if (stat.isFile()) {
            return ctx.json200({
                path: full,
                home: USER_DIR,
                parent: path.dirname(full),
                kind: "file",
                name: path.basename(full),
                size: stat.size,
                mtime: new Date(stat.mtimeMs).toISOString(),
                entries: [],
            });
        }
        if (!stat.isDirectory()) return ctx.json400("not_a_directory");
        let entries;
        try {
            entries = listDirectory(full);
        } catch (err) {
            return ctx.json400(err?.code || "read_failed");
        }
        ctx.json200({
            path: full,
            home: USER_DIR,
            parent: full === path.parse(full).root ? null : path.dirname(full),
            kind: "dir",
            entries,
        });
    });

    // 텍스트 미리보기. 바이너리는 binary=true만 알리고 본문은 보내지 않는다.
    router.add("GET", "/api/computer/files/text", (ctx) => {
        const full = resolveIncoming(ctx.query.path);
        if (!full) return ctx.json400("invalid_path");
        const stat = statOrNull(full);
        if (!stat?.isFile()) return ctx.json404();
        let fd;
        try {
            fd = fs.openSync(full, "r");
            const head = Buffer.alloc(Math.min(8000, stat.size));
            if (head.length) fs.readSync(fd, head, 0, head.length, 0);
            if (head.includes(0)) return ctx.json200({ path: full, size: stat.size, binary: true });
            const readBytes = Math.min(stat.size, MAX_TEXT_BYTES);
            const buf = Buffer.alloc(readBytes);
            if (readBytes) fs.readSync(fd, buf, 0, readBytes, 0);
            ctx.json200({
                path: full,
                name: path.basename(full),
                size: stat.size,
                truncated: stat.size > readBytes,
                text: buf.toString("utf8"),
            });
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
        }
    });

    // 원본 바이트(이미지·PDF·다운로드). 스크립트 실행 가능한 형식은 항상 첨부로 내려간다.
    router.add("GET", "/api/computer/files/raw", (ctx) => {
        const full = resolveIncoming(ctx.query.path);
        if (!full) return ctx.json400("invalid_path");
        const stat = statOrNull(full);
        if (!stat?.isFile()) return ctx.json404();
        sendFile(ctx, full, stat);
    });

    // 클릭 가능한 파일 링크 판별: 실제로 존재하는 경로만 true.
    router.add("POST", "/api/computer/files/resolve", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        const list = Array.isArray(body?.paths) ? body.paths.slice(0, MAX_RESOLVE_PATHS) : [];
        const results = list.map((raw) => {
            const input = String(raw ?? "").slice(0, MAX_PATH_LENGTH);
            const full = resolveIncoming(input);
            const stat = statOrNull(full);
            return {
                path: input,
                resolved: full || null,
                exists: Boolean(stat),
                kind: stat ? kindOf(stat) : null,
            };
        });
        ctx.json200({ results });
    });
}
