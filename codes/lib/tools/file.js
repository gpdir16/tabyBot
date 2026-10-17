import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import { countMessagesTokens, countTokens, getContextWindow } from "../agent/context.js";
import { resolveExistingAgentPath } from "../paths.js";
import { filePathParamDescription, filePatchDescription, fileReadDescription } from "../path-labels.js";
import { isSecretStorePath } from "../secrets/store.js";

function resolveFilePath(rawPath) {
    return resolveExistingAgentPath(rawPath);
}

function getMaxFileReadTokens(messages, modelMeta) {
    const window = getContextWindow(modelMeta);
    const used = countMessagesTokens(messages || []);
    const remaining = Math.max(0, window - used);
    const half = Math.floor(remaining * 0.5);
    return Math.max(0, half - 1);
}

const fileReadCache = new Map();

// file_read는 전체 파일을 메모리에 올리므로 상한을 둔다. 큰 파일은
// terminal_run(sed/head/tail)으로 페이지 단위 읽기를 안내한다.
const MAX_READ_BYTES = 8 * 1024 * 1024;

// 이미지 파일은 글자 대신 그림으로 보여 준다. 브라우저(camofox) 스크린샷을 모델이 직접 확인하는 유일한
// 길이라, 이게 없으면 접근성 스냅샷에 안 잡히는 것(다른 도메인 iframe, 캔버스, 덮개 창)을 못 본다.
const VIEWABLE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
// Claude API가 받는 이미지 한 장의 상한(5MB)에 맞춘다.
const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024;

function readImageFile(resolved, stat, ctx) {
    if (ctx?.modelMeta?.supportsVision !== true) return { error: "The current model cannot view images.", path: resolved };
    if (stat.size > MAX_VIEW_IMAGE_BYTES) {
        return {
            error: `image too large to view (${(stat.size / 1048576).toFixed(1)} MB > 5 MB). Take a viewport screenshot instead of a full-page one, or shrink it first.`,
            path: resolved,
        };
    }
    return { ok: true, path: resolved, imageBytes: stat.size, note: "The image is attached right after this result.", __image: resolved };
}

function splitLines(text) {
    if (!text) return [];
    const lines = text.split("\n");
    if (text.endsWith("\n") && lines.length > 0) lines.pop();
    return lines;
}

function joinLines(lines, { trailingNewline = false } = {}) {
    if (!lines.length) return trailingNewline ? "\n" : "";
    let out = lines.join("\n");
    if (trailingNewline) out += "\n";
    return out;
}

function formatLineNumbered(lines, startLine) {
    const width = String(startLine + lines.length - 1).length;
    return lines.map((line, i) => `${String(startLine + i).padStart(width, " ")}|${line}`).join("\n");
}

function sliceByLineRange(lines, startLine, endLine) {
    const start = Math.max(1, startLine ?? 1);
    const end = endLine == null ? lines.length : Math.min(lines.length, endLine);
    if (start > lines.length) return { start, end: start - 1, slice: [] };
    return { start, end, slice: lines.slice(start - 1, end) };
}

function truncateToTokenBudget(text, maxTokens) {
    if (maxTokens <= 0) {
        return { text: "", tokens: 0, truncated: true };
    }
    const lines = text.split("\n");
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const chunk = lines.slice(0, mid).join("\n");
        if (countTokens(chunk) <= maxTokens) lo = mid;
        else hi = mid - 1;
    }
    const kept = lines.slice(0, lo).join("\n");
    return {
        text: kept,
        tokens: countTokens(kept),
        truncated: lo < lines.length,
    };
}

const nullableInteger = (description) => ({
    description,
    anyOf: [{ type: "integer" }, { type: "null" }],
});

export const fileToolDefinitions = [
    {
        type: "function",
        function: {
            name: "file_read",
            description: fileReadDescription(),
            strict: true,
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: {
                        type: "string",
                        description: filePathParamDescription(),
                    },
                    startLine: nullableInteger("First line to read (1-based). Null if unused."),
                    endLine: nullableInteger("Last line to read (1-based, inclusive). Null if unused."),
                    limit: nullableInteger("Number of lines from startLine. Null if unused."),
                },
                required: ["path", "startLine", "endLine", "limit"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "file_patch",
            description: filePatchDescription(),
            strict: true,
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: {
                        type: "string",
                        description: filePathParamDescription(),
                    },
                    diff: {
                        type: "string",
                        description: "Unified diff (---/+++/@@ hunks). Use context lines, lines to remove (-), and lines to add (+).",
                    },
                },
                required: ["path", "diff"],
            },
        },
    },
];

function recordFileSnapshot(ctx, resolvedPath, content) {
    ctx.fileSnapshots?.set(resolvedPath, content);
}

export function executeFileRead(args, ctx) {
    const resolved = resolveFilePath(args?.path);
    if (!resolved) return { error: "path is required" };
    if (isSecretStorePath(resolved)) return { error: "The secret vault files are off limits. Use {{secret:NAME}} placeholders instead." };
    if (!fs.existsSync(resolved)) return { error: "file not found", path: resolved };
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { error: "not a file", path: resolved };
    if (VIEWABLE_IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) return readImageFile(resolved, stat, ctx);
    if (stat.size > MAX_READ_BYTES) {
        return {
            error: `file too large for file_read (${(stat.size / 1048576).toFixed(1)} MB > 8 MB). Use terminal_run with 'sed -n "START,ENDp" <path>' or head/tail to page through it.`,
            path: resolved,
        };
    }

    const maxTokens = getMaxFileReadTokens(ctx.messages, ctx.modelMeta);
    if (maxTokens <= 0) {
        return {
            error: "No context budget left for file_read (must stay under 50% of remaining window)",
            maxTokens: 0,
        };
    }

    const startLine = args?.startLine;
    let endLine = args?.endLine;
    const limit = args?.limit;
    if (limit != null && startLine != null) {
        endLine = startLine + Math.max(0, limit) - 1;
    } else if (limit != null) {
        endLine = limit;
    }

    // Re-read dedup. Same path + range + mtime within one turn returns a stub.
    const cacheKey = `${resolved}:${startLine ?? 1}:${endLine ?? "end"}:${stat.mtimeMs}`;
    if (fileReadCache.has(cacheKey)) {
        const prev = fileReadCache.get(cacheKey);
        return {
            path: resolved,
            startLine: prev.start,
            endLine: prev.end,
            totalLines: prev.totalLines,
            content: `[Already read in this turn. Content suppressed to save context. Re-read with a different startLine/endLine if you need it again, or use the previous result.]`,
            deduped: true,
        };
    }

    const head = Buffer.alloc(Math.min(8000, stat.size));
    const fd = fs.openSync(resolved, "r");
    try {
        fs.readSync(fd, head, 0, head.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (head.includes(0)) {
        return { error: "not a text file", path: resolved };
    }

    const content = fs.readFileSync(resolved, "utf8");
    recordFileSnapshot(ctx, resolved, content);

    const lines = splitLines(content);
    const totalLines = lines.length;
    const requestedStart = Math.max(1, startLine ?? 1);
    const requestedEnd = endLine == null ? totalLines : Math.min(totalLines, endLine);

    const { start, end, slice } = sliceByLineRange(lines, requestedStart, requestedEnd);
    const joined = formatLineNumbered(slice, start);

    const { text, tokens, truncated } = truncateToTokenBudget(joined, maxTokens);
    const returnedLineCount = text ? text.split("\n").length : 0;

    const notes = [];
    if (truncated)
        notes.push(
            `Output truncated to fit context budget (${totalLines} total lines). Use startLine=${start + returnedLineCount} to read the next page.`,
        );

    fileReadCache.set(cacheKey, { start, end, totalLines });

    return {
        path: resolved,
        startLine: start,
        endLine: truncated && returnedLineCount > 0 ? start + returnedLineCount - 1 : end,
        totalLines,
        content: text,
        tokens,
        maxTokens,
        truncated,
        ...(notes.length ? { note: notes.join(" ") } : {}),
    };
}

export function clearFileReadCache() {
    fileReadCache.clear();
}

// @@ 머리의 줄 번호·줄 수는 위치를 찾는 힌트로만 쓴다. 모델은 줄 수를 자주 틀리게 적으므로 실제 적용은
// 문맥(" ")·삭제("-") 줄의 내용으로 한다. 공백 없이 적힌 빈 줄은 빈 문맥 줄로 본다(모델이 흔히 이렇게 쓴다).
function parseUnifiedDiff(diffText) {
    const lines = diffText.replace(/\r\n/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const hunks = [];
    let currentHunk = null;
    for (const line of lines) {
        if (line.startsWith("@@")) {
            if (currentHunk) hunks.push(currentHunk);
            const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+\d+(?:,\d+)?\s*@@/);
            currentHunk = { oldStart: m ? parseInt(m[1], 10) : null, lines: [] };
        } else if (currentHunk) {
            if (line === "\\ No newline at end of file") continue;
            if (line === "") {
                currentHunk.lines.push(" ");
                continue;
            }
            const prefix = line[0];
            if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
            currentHunk.lines.push(line);
        }
    }
    if (currentHunk) hunks.push(currentHunk);
    return hunks;
}

// file_read가 붙이는 "  12|" 접두어. 모델이 diff에 그대로 베껴 오는 일이 있다.
const LINE_NUMBER_PREFIX = /^\s*\d+\|/;

function findBlock(fileLines, block, sameLine) {
    const found = [];
    for (let i = 0; i + block.length <= fileLines.length; i++) {
        let ok = true;
        for (let j = 0; j < block.length; j++) {
            if (!sameLine(fileLines[i + j], block[j])) {
                ok = false;
                break;
            }
        }
        if (ok) found.push(i);
    }
    return found;
}

const exactLine = (a, b) => a === b;
const looseLine = (a, b) => a.trimEnd() === b.trimEnd();

function previewLines(lines) {
    const shown = lines.slice(0, 3).map((l) => JSON.stringify(l.length > 120 ? `${l.slice(0, 120)}…` : l));
    return shown.join(", ") + (lines.length > 3 ? ` … (${lines.length} lines)` : "");
}

function applyHunk(fileLines, hunk, index, offset) {
    let oldLines = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).map((l) => l.slice(1));
    let newLines = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).map((l) => l.slice(1));
    const expected = hunk.oldStart == null ? null : Math.max(0, hunk.oldStart - 1 + offset);

    // 삭제·문맥 줄이 없는 순수 추가(빈 파일 채우기 포함)는 머리의 위치에 넣는다.
    if (!oldLines.length) {
        const at = Math.min(fileLines.length, expected ?? fileLines.length);
        return { ok: true, result: [...fileLines.slice(0, at), ...newLines, ...fileLines.slice(at)], offset: offset + newLines.length };
    }

    let found = findBlock(fileLines, oldLines, exactLine);
    if (!found.length) found = findBlock(fileLines, oldLines, looseLine);
    if (!found.length && oldLines.every((l) => l === "" || LINE_NUMBER_PREFIX.test(l))) {
        const strip = (l) => l.replace(LINE_NUMBER_PREFIX, "");
        oldLines = oldLines.map(strip);
        newLines = newLines.map(strip);
        found = findBlock(fileLines, oldLines, exactLine);
        if (!found.length) found = findBlock(fileLines, oldLines, looseLine);
    }
    if (!found.length) {
        return {
            ok: false,
            error: `Hunk ${index + 1}: its context/removed lines were not found in the file: ${previewLines(oldLines)}. Copy them exactly from the latest file_read, without the "N|" line-number prefix, and include a few unchanged lines around the change.`,
        };
    }
    if (found.length > 1 && expected == null) {
        return {
            ok: false,
            error: `Hunk ${index + 1}: its lines match ${found.length} places in the file. Add more unchanged context lines or a "@@ -LINE" header so the place is unique.`,
        };
    }
    // 같은 내용이 여러 곳에 있으면 머리의 줄 번호에 가장 가까운 곳에 적용한다.
    const at = expected == null ? found[0] : found.reduce((best, i) => (Math.abs(i - expected) < Math.abs(best - expected) ? i : best));
    const result = [...fileLines.slice(0, at), ...newLines, ...fileLines.slice(at + oldLines.length)];
    return { ok: true, result, offset: offset + (at - (expected ?? at)) + newLines.length - oldLines.length };
}

export function executeFilePatch(args, ctx = {}) {
    const resolved = resolveFilePath(args?.path);
    if (!resolved) return { error: "path is required" };
    if (isSecretStorePath(resolved)) return { error: "The secret vault files are off limits. Use {{secret:NAME}} placeholders instead." };
    if (!fs.existsSync(resolved)) return { error: "file not found", path: resolved };

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { error: "not a file", path: resolved };

    // 빈 파일("")도 읽은 기록으로 친다. 예전에는 빈 내용이 거짓으로 걸려, touch로 만든 파일을 채울 수 없었다.
    const snapshot = ctx.fileSnapshots?.get(resolved);
    if (snapshot === undefined) {
        return { error: "Must file_read this path in this turn before patching." };
    }

    const currentContent = fs.readFileSync(resolved, "utf8");
    if (currentContent !== snapshot) {
        return { error: "File changed since last read. Re-read it before patching." };
    }

    const hunks = parseUnifiedDiff(args?.diff || "");
    if (!hunks.length) return { error: "No valid hunks in diff" };

    const fileLines = splitLines(currentContent);
    let resultLines = fileLines;
    let offset = 0;
    // 줄 번호가 없는 머리(@@ 만 쓴 경우)는 적힌 순서대로 둔다.
    const sorted = hunks.some((h) => h.oldStart == null) ? hunks : [...hunks].sort((a, b) => a.oldStart - b.oldStart);
    for (const [index, hunk] of sorted.entries()) {
        const applied = applyHunk(resultLines, hunk, index, offset);
        if (!applied.ok) return applied;
        resultLines = applied.result;
        offset = applied.offset;
    }
    const newContent = joinLines(resultLines, { trailingNewline: currentContent.endsWith("\n") });
    // 부분 쓰기 상태가 남지 않도록 원자적으로 교체한다.
    writeFileAtomic(resolved, newContent);
    ctx.fileSnapshots?.set(resolved, newContent);

    return {
        ok: true,
        path: resolved,
        linesWritten: resultLines.length,
    };
}
