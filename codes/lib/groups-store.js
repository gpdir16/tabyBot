// 그룹 대화방: 여러 에이전트와 사용자가 한 방에서 대화한다. 저장은 user/groups.json.
// 방의 화면 기록은 user/session/groups/<그룹 id>/에, 에이전트마다 이 방에서 쓰는 자기 세션은
// user/session/groups/<그룹 id>/members/<에이전트 uuid>/에 있다. 에이전트 세션의 키는 memberSessionKey로 만든다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSION_DIR, USER_DIR } from "./paths.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-file.js";
import { getAgentByUuid, listAgents, listFolders } from "./agents-store.js";

const GROUPS_PATH = path.join(USER_DIR, "groups.json");
const GROUPS_ROOT = path.join(SESSION_DIR, "groups");

const MAX_GROUPS = 20;
const MAX_NAME = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMBER_KEY_RE = /^group:([0-9a-f-]{36}):([0-9a-f-]{36})$/;

let cache = null;
let cacheMtime = -1;

function statMtime() {
    try {
        return fs.statSync(GROUPS_PATH).mtimeMs;
    } catch {
        return -1;
    }
}

function normalizeName(name) {
    return String(name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NAME);
}

// 지금 있는 에이전트만 남긴다. 순서 = 멤버를 넣은 순서(멘션이 없을 때 답하는 순서).
function normalizeMembers(raw) {
    const alive = new Set(listAgents().map((a) => a.uuid));
    const out = [];
    for (const uuid of Array.isArray(raw) ? raw : []) {
        const id = String(uuid || "");
        if (alive.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
}

function readAll() {
    const mtime = statMtime();
    if (cache && mtime === cacheMtime) return cache;
    const raw = readJsonFile(GROUPS_PATH, { groups: [] });
    cache = (Array.isArray(raw?.groups) ? raw.groups : []).filter((g) => g && UUID_RE.test(String(g.id || "")));
    cacheMtime = mtime;
    return cache;
}

function writeAll(groups) {
    writeJsonAtomic(GROUPS_PATH, { groups });
    cache = groups;
    cacheMtime = statMtime();
}

// 멤버 목록은 읽을 때마다 지금 있는 에이전트로 거른다(지워진 에이전트는 빠진다).
// 폴더도 지금 있는 폴더만 인정한다. 지워진 폴더를 가리키는 방은 미분류로 본다.
function publicShape(g) {
    const folder = String(g.folder || "");
    return {
        id: g.id,
        name: g.name,
        members: normalizeMembers(g.members),
        folder: folder && listFolders().some((f) => f.id === folder) ? folder : "",
        createdAt: g.createdAt || null,
        cursors: g.cursors && typeof g.cursors === "object" ? { ...g.cursors } : {},
    };
}

export function listGroups() {
    return readAll().map(publicShape);
}

export function getGroup(id) {
    const g = readAll().find((x) => x.id === id);
    return g ? publicShape(g) : null;
}

export function isGroupId(id) {
    return typeof id === "string" && UUID_RE.test(id) && readAll().some((g) => g.id === id);
}

export function addGroup({ name, members }) {
    const groups = readAll().slice();
    if (groups.length >= MAX_GROUPS) return { error: "too_many_groups" };
    const clean = normalizeName(name);
    if (!clean) return { error: "name_required" };
    const list = normalizeMembers(members);
    if (list.length < 2) return { error: "need_two_members" };
    const group = { id: crypto.randomUUID(), name: clean, members: list, createdAt: new Date().toISOString(), cursors: {} };
    groups.push(group);
    writeAll(groups);
    return { group: publicShape(group) };
}

export function updateGroup(id, patch) {
    const groups = readAll().slice();
    const idx = groups.findIndex((g) => g.id === id);
    if (idx < 0) return { error: "not_found" };
    const next = { ...groups[idx] };
    if (patch.name !== undefined) {
        const clean = normalizeName(patch.name);
        if (!clean) return { error: "name_required" };
        next.name = clean;
    }
    if (patch.members !== undefined) {
        const list = normalizeMembers(patch.members);
        if (list.length < 2) return { error: "need_two_members" };
        next.members = list;
    }
    if (patch.folder !== undefined) {
        const folderId = String(patch.folder || "");
        if (folderId && !listFolders().some((f) => f.id === folderId)) return { error: "folder_not_found" };
        next.folder = folderId;
    }
    groups[idx] = next;
    writeAll(groups);
    return { group: publicShape(next) };
}

// 방을 지운다. 대화 기록 폴더는 남겨 둔다(지우면 되살릴 수 없는 기록이다).
export function removeGroup(id) {
    const groups = readAll();
    if (!groups.some((g) => g.id === id)) return { error: "not_found" };
    writeAll(groups.filter((g) => g.id !== id));
    return { ok: true };
}

// 에이전트가 이 방의 화면 기록을 어디까지 읽었는지(턴 개수). 그 뒤의 발화만 다음 차례에 전한다.
export function setGroupCursor(id, agentUuid, count) {
    const groups = readAll().slice();
    const idx = groups.findIndex((g) => g.id === id);
    if (idx < 0) return;
    groups[idx] = { ...groups[idx], cursors: { ...(groups[idx].cursors || {}), [agentUuid]: count } };
    writeAll(groups);
}

// ── 에이전트가 이 방에서 쓰는 자기 세션 ──

export function memberSessionKey(groupId, agentUuid) {
    return `group:${groupId}:${agentUuid}`;
}

// 에이전트 세션 키면 { groupId, agentUuid }, 아니면 null.
export function parseMemberKey(key) {
    const m = MEMBER_KEY_RE.exec(String(key || ""));
    if (!m || !isGroupId(m[1]) || !getAgentByUuid(m[2])) return null;
    return { groupId: m[1], agentUuid: m[2] };
}

export function groupDir(groupId) {
    return path.join(GROUPS_ROOT, groupId);
}

export function memberDir(groupId, agentUuid) {
    return path.join(GROUPS_ROOT, groupId, "members", agentUuid);
}

// 에이전트가 들어 있는 방들(대화 검색이 그 방의 기록도 찾게 할 때 쓴다).
export function groupsOfAgent(agentUuid) {
    return listGroups().filter((g) => g.members.includes(agentUuid));
}
