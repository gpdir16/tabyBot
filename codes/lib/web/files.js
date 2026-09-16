// 파일 저장소: 업로드와 에이전트 전송 파일을 id로 관리한다.
// 바이트는 USER_DIR/temp/web-files/store/<id>/<name> 에 보관하며, API는 id로만 접근한다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { USER_DIR } from "../paths.js";
import { writeJsonAtomic } from "../atomic-file.js";

const ROOT = path.join(USER_DIR, "temp", "web-files");
const STORE_DIR = path.join(ROOT, "store");
const INDEX_PATH = path.join(ROOT, "index.json");
const UPLOADS_DIR = path.join(USER_DIR, "uploads");

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB

const EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip",
};

export class UploadTooLargeError extends Error {
    constructor(maxBytes = MAX_UPLOAD_BYTES) {
        super("payload too large");
        this.code = "UPLOAD_TOO_LARGE";
        this.maxBytes = maxBytes;
    }
}

export class EmptyUploadError extends Error {
    constructor() {
        super("empty_upload");
        this.code = "EMPTY_UPLOAD";
    }
}

function readIndex() {
    try {
        const data = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
        return data && typeof data === "object" ? data : {};
    } catch {
        return {};
    }
}

function writeIndex(index) {
    fs.mkdirSync(ROOT, { recursive: true });
    writeJsonAtomic(INDEX_PATH, index);
}

function sanitizeFileName(originalName = "") {
    const base = path.basename(String(originalName || "").replace(/\\/g, "/"));
    const cleaned = base
        .replace(/[^\p{L}\p{N}._\- ()[\]]+/gu, "_")
        .replace(/^\.+$/, "")
        .slice(0, 120)
        .trim();
    return cleaned || "upload";
}

function resolveStoredPath(id, name) {
    const named = path.join(STORE_DIR, id, name);
    if (fs.existsSync(named) && fs.statSync(named).isFile()) return named;
    const legacy = path.join(STORE_DIR, id);
    if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) return legacy;
    return null;
}

// 에이전트가 file_read("uploads/이름") 으로 열 수 있게 사용자 홈에 올린다.
function publishAgentUpload(id, storePath, safeName) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    let uploadName = safeName;
    let dest = path.join(UPLOADS_DIR, uploadName);
    if (fs.existsSync(dest)) {
        try {
            if (fs.realpathSync(dest) === fs.realpathSync(storePath)) {
                return { uploadName, uploadPath: dest, relPath: path.join("uploads", uploadName) };
            }
        } catch {
            // 다른 파일이 같은 이름을 쓰고 있으면 id를 붙인다
        }
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        uploadName = `${base}-${String(id).slice(0, 8)}${ext}`;
        dest = path.join(UPLOADS_DIR, uploadName);
        if (fs.existsSync(dest)) {
            try {
                if (fs.realpathSync(dest) === fs.realpathSync(storePath)) {
                    return { uploadName, uploadPath: dest, relPath: path.join("uploads", uploadName) };
                }
            } catch {
                // continue
            }
        }
    }
    try {
        fs.symlinkSync(storePath, dest);
    } catch {
        fs.copyFileSync(storePath, dest);
    }
    return { uploadName, uploadPath: dest, relPath: path.join("uploads", uploadName) };
}

function commitEntry(entry) {
    const index = readIndex();
    index[entry.id] = entry;
    writeIndex(index);
    return entry;
}

// 요청 바디를 메모리에 올리지 않고 디스크로 흘린다. 한도는 1GB.
export async function saveUploadStream(req, mimeType, originalName = "", limitBytes = MAX_UPLOAD_BYTES) {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limitBytes) {
        throw new UploadTooLargeError(limitBytes);
    }

    const id = crypto.randomBytes(8).toString("hex");
    const safeName = sanitizeFileName(originalName);
    const dir = path.join(STORE_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const destPath = path.join(dir, safeName);

    let size = 0;
    const counter = new Transform({
        transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > limitBytes) {
                cb(new UploadTooLargeError(limitBytes));
                return;
            }
            cb(null, chunk);
        },
    });

    try {
        await pipeline(req, counter, fs.createWriteStream(destPath));
    } catch (err) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // 부분 파일 정리 실패는 업로드 실패를 가리지 않는다
        }
        if (err?.code === "UPLOAD_TOO_LARGE" || err instanceof UploadTooLargeError) {
            throw err instanceof UploadTooLargeError ? err : new UploadTooLargeError(limitBytes);
        }
        throw err;
    }

    if (!size) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        throw new EmptyUploadError();
    }

    const published = publishAgentUpload(id, destPath, safeName);
    return commitEntry({
        id,
        name: safeName,
        mime: String(mimeType || "application/octet-stream"),
        size,
        kind: "upload",
        createdAt: new Date().toISOString(),
        uploadName: published.uploadName,
    });
}

// 에이전트가 만든 파일을 저장소로 복사해 다운로드 가능하게 한다.
// 스트림 복사라 큰 파일이 이벤트 루프를 막지 않는다.
export async function registerProducedFile(filePath, caption = "") {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_UPLOAD_BYTES) {
        throw new Error(`file too large to send (${(stat.size / 1073741824).toFixed(1)} GB > 1 GB)`);
    }
    const id = crypto.randomBytes(8).toString("hex");
    const ext = path.extname(filePath).toLowerCase();
    const name = sanitizeFileName(path.basename(filePath));
    const dir = path.join(STORE_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    try {
        await pipeline(fs.createReadStream(filePath), fs.createWriteStream(path.join(dir, name)));
    } catch (err) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // 부분 복사 정리 실패는 원래 에러를 가리지 않는다
        }
        throw err;
    }
    return commitEntry({
        id,
        name,
        mime: EXT_MIME[ext] || "application/octet-stream",
        size: stat.size,
        kind: "file",
        caption: String(caption || "").slice(0, 1024),
        createdAt: new Date().toISOString(),
    });
}

export function getFile(id) {
    if (!/^[0-9a-f]{16}$/.test(String(id || ""))) return null;
    const entry = readIndex()[id];
    if (!entry) return null;
    const filePath = resolveStoredPath(id, entry.name);
    if (!filePath) return null;
    const published = publishAgentUpload(id, filePath, entry.uploadName || entry.name);
    return {
        ...entry,
        filePath,
        uploadPath: published.uploadPath,
        relPath: published.relPath,
    };
}

export function publicAttachment(file) {
    if (!file) return null;
    return {
        id: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size,
        url: `/api/files/${file.id}`,
        ...(file.caption ? { caption: file.caption } : {}),
    };
}

export function storedAttachment(file) {
    const pub = publicAttachment(file);
    if (!pub) return null;
    return {
        ...pub,
        filePath: file.uploadPath || file.filePath,
        ...(file.relPath ? { relPath: file.relPath } : {}),
    };
}
