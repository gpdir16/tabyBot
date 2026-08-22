import fs from "node:fs";
import path from "node:path";
import { countMessagesTokens, countTokens, getContextWindow } from "../agent/context.js";
import { formatAllowedPaths, isAllowedFilePath, resolveAgentPath } from "../paths.js";
import { filePathParamDescription, filePatchDescription, fileReadDescription } from "../path-labels.js";

function resolveFilePath(rawPath, { write = false } = {}) {
    const resolved = resolveAgentPath(rawPath);
    if (!resolved) return null;
    return isAllowedFilePath(resolved, { write }) ? resolved : null;
}

function getMaxFileReadTokens(messages, modelMeta, model) {
    const window = getContextWindow(modelMeta);
    const used = countMessagesTokens(messages || [], model);
    const remaining = Math.max(0, window - used);
    const half = Math.floor(remaining * 0.5);
    return Math.max(0, half - 1);
}

const fileReadCache = new Map();

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

function truncateToTokenBudget(text, maxTokens, model) {
    if (maxTokens <= 0) {
        return { text: "", tokens: 0, truncated: true };
    }
    const lines = text.split("\n");
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const chunk = lines.slice(0, mid).join("\n");
        if (countTokens(chunk, model) <= maxTokens) lo = mid;
        else hi = mid - 1;
    }
    const kept = lines.slice(0, lo).join("\n");
    return {
        text: kept,
        tokens: countTokens(kept, model),
        truncated: lo < lines.length,
    };
}

export const fileToolDefinitions = [
    {
        type: "function",
        function: {
            name: "file_read",
            description: fileReadDescription(),
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: filePathParamDescription(),
                    },
                    startLine: { type: "integer", description: "First line to read (1-based, default 1)" },
                    endLine: { type: "integer", description: "Last line to read (1-based, inclusive)" },
                    limit: { type: "integer", description: "Number of lines from startLine (alternative to endLine)" },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "file_patch",
            description: filePatchDescription(),
            parameters: {
                type: "object",
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

export async function executeFileRead(args, ctx) {
    const resolved = resolveFilePath(args?.path, { write: false });
    if (!resolved) return { error: `path not allowed or missing (readable: ${formatAllowedPaths()})` };
    if (!fs.existsSync(resolved)) return { error: "file not found", path: resolved };
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { error: "not a file", path: resolved };

    const model = ctx.model || "gpt-4o-mini";
    const maxTokens = getMaxFileReadTokens(ctx.messages, ctx.modelMeta, model);
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

    // Re-read dedup — same path + range + mtime within one turn returns a stub.
    const cacheKey = `${resolved}:${startLine ?? 1}:${endLine ?? "end"}:${stat.mtimeMs}`;
    if (fileReadCache.has(cacheKey)) {
        const prev = fileReadCache.get(cacheKey);
        return {
            path: resolved,
            startLine: prev.start,
            endLine: prev.end,
            totalLines: prev.totalLines,
            content: `[Already read in this turn — content suppressed to save context. Re-read with a different startLine/endLine if you need it again, or use the previous result.]`,
            deduped: true,
        };
    }

    const content = fs.readFileSync(resolved, "utf8");
    recordFileSnapshot(ctx, resolved, content);

    const lines = splitLines(content);
    const totalLines = lines.length;
    const requestedStart = Math.max(1, startLine ?? 1);
    const requestedEnd = endLine == null ? totalLines : Math.min(totalLines, endLine);

    const { start, end, slice } = sliceByLineRange(lines, requestedStart, requestedEnd);
    const joined = formatLineNumbered(slice, start);

    const { text, tokens, truncated } = truncateToTokenBudget(joined, maxTokens, model);
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

function parseUnifiedDiff(diffText) {
    const lines = diffText.replace(/\r\n/g, "\n").split("\n");
    const hunks = [];
    let currentHunk = null;
    for (const line of lines) {
        if (line.startsWith("@@")) {
            if (currentHunk) hunks.push(currentHunk);
            const m = line.match(/@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
            if (!m) continue;
            currentHunk = {
                oldStart: parseInt(m[1], 10),
                oldCount: m[2] ? parseInt(m[2], 10) : 1,
                newStart: parseInt(m[3], 10),
                newCount: m[4] ? parseInt(m[4], 10) : 1,
                lines: [],
            };
        } else if (currentHunk) {
            if (line === "\\ No newline at end of file") continue;
            if (line === "") continue;
            const prefix = line[0];
            if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
            currentHunk.lines.push(line);
        }
    }
    if (currentHunk) hunks.push(currentHunk);
    return hunks;
}

function applyHunk(fileLines, hunk, offset = 0) {
    const result = [...fileLines];
    const oldLines = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).map((l) => l.slice(1));
    const newLines = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).map((l) => l.slice(1));
    const startPos = hunk.oldStart - 1 + offset;
    const oldSlice = result.slice(startPos, startPos + hunk.oldCount);
    if (oldSlice.join("\n") !== oldLines.join("\n")) {
        return { ok: false, error: "Context mismatch — file changed since last read. Re-read the file first." };
    }
    result.splice(startPos, hunk.oldCount, ...newLines);
    return { ok: true, result, offset: offset + newLines.length - hunk.oldCount };
}

export async function executeFilePatch(args, ctx = {}) {
    const resolved = resolveFilePath(args?.path, { write: true });
    if (!resolved) return { error: `path not allowed or missing (writable: ${formatAllowedPaths({ write: true })})` };
    if (!fs.existsSync(resolved)) return { error: "file not found", path: resolved };

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { error: "not a file", path: resolved };

    const snapshot = ctx.fileSnapshots?.get(resolved);
    if (!snapshot) {
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
    const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
    for (const hunk of sorted) {
        const applied = applyHunk(resultLines, hunk, offset);
        if (!applied.ok) return applied;
        resultLines = applied.result;
        offset = applied.offset;
    }
    const newContent = joinLines(resultLines, { trailingNewline: currentContent.endsWith("\n") });
    fs.writeFileSync(resolved, newContent, "utf8");
    ctx.fileSnapshots?.set(resolved, newContent);

    return {
        ok: true,
        path: resolved,
        linesWritten: resultLines.length,
    };
}
