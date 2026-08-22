import "./load-install-env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isManagedInstallEntry, isDockerContainer } from "./install-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DERIVED_CODES_DIR = path.resolve(__dirname, "..");
const DERIVED_APP_ROOT = path.resolve(DERIVED_CODES_DIR, "..");

const MANAGED_INSTALL = isManagedInstallEntry();
const IS_DOCKER = isDockerContainer();

function resolvePathEnv(envKey, derived) {
    const raw = process.env[envKey]?.trim();
    if (!raw) return derived;
    const resolved = path.resolve(raw);
    if (MANAGED_INSTALL) return resolved;
    // Dev/checkout run: ignore managed-install path env leaked from the shell.
    return resolved === derived ? resolved : derived;
}

export const CODES_DIR = resolvePathEnv("CODES_DIR", DERIVED_CODES_DIR);
export const APP_ROOT = resolvePathEnv("APP_ROOT", DERIVED_APP_ROOT);
export const USER_DIR = resolvePathEnv("USER_DIR", path.join(DERIVED_APP_ROOT, "user"));
export const DOWNLOAD_DIR = path.join(USER_DIR, "download");
export const CONFIG_DIR = resolvePathEnv("CONFIG_DIR", path.join(DERIVED_CODES_DIR, "config"));
export const SKILLS_SYSTEM_DIR = path.join(CODES_DIR, "skills");
export const TEMPLATES_USER_DIR = path.join(CODES_DIR, "templates", "user");
const HOME_DIR = process.env.HOME || "/root";
export const AGENTS_SKILLS_LINK = path.join(HOME_DIR, ".agents", "skills");

function resolveWorkspaceDir() {
    const defaultDir = "/workspace";
    if (MANAGED_INSTALL || IS_DOCKER) {
        const fromEnv = process.env.WORKSPACE_DIR?.trim();
        return fromEnv ? path.resolve(fromEnv) : defaultDir;
    }
    const hostWs = process.env.HOST_WORKSPACE?.trim();
    if (hostWs) return path.resolve(hostWs);
    const fromEnv = process.env.WORKSPACE_DIR?.trim();
    if (!fromEnv) return defaultDir;
    const resolved = path.resolve(fromEnv);
    return resolved === defaultDir && !fs.existsSync(resolved) ? defaultDir : resolved;
}

export const WORKSPACE_DIR = resolveWorkspaceDir();

let workspaceEnabledCache;

export function isWorkspaceEnabled() {
    if (workspaceEnabledCache !== undefined) return workspaceEnabledCache;
    if (process.env.WORKSPACE_ENABLED !== "1") {
        workspaceEnabledCache = false;
        return false;
    }
    // Dev/checkout: ignore workspace flags leaked from a managed-install shell unless HOST_WORKSPACE is set too.
    if (!MANAGED_INSTALL && !IS_DOCKER) {
        const hostWs = process.env.HOST_WORKSPACE?.trim();
        if (!hostWs) {
            workspaceEnabledCache = false;
            return false;
        }
    }
    try {
        workspaceEnabledCache = fs.existsSync(WORKSPACE_DIR) && fs.statSync(WORKSPACE_DIR).isDirectory();
    } catch {
        workspaceEnabledCache = false;
    }
    return workspaceEnabledCache;
}

export function getReadRoots() {
    const roots = [USER_DIR, CODES_DIR, "/tmp"];
    if (isWorkspaceEnabled()) roots.push(WORKSPACE_DIR);
    return roots;
}

export function getWriteRoots() {
    const roots = [USER_DIR, "/tmp"];
    if (isWorkspaceEnabled()) roots.push(WORKSPACE_DIR);
    return roots;
}

export function isAllowedFilePath(resolved, { write = false } = {}) {
    const roots = write ? getWriteRoots() : getReadRoots();
    for (const root of roots) {
        const r = path.resolve(root);
        if (resolved === r || resolved.startsWith(`${r}${path.sep}`)) return true;
    }
    return false;
}

export function formatAllowedPaths({ write = false } = {}) {
    const parts = write ? [USER_DIR, "/tmp"] : [USER_DIR, CODES_DIR, "/tmp"];
    if (isWorkspaceEnabled()) parts.push(WORKSPACE_DIR);
    return parts.join(", ");
}

export function resolveAgentPath(rawPath) {
    const trimmed = rawPath?.trim();
    if (!trimmed) return null;
    let base;
    if (path.isAbsolute(trimmed)) {
        base = trimmed;
    } else if (isWorkspaceEnabled() && (trimmed === "workspace" || trimmed.startsWith(`workspace${path.sep}`))) {
        const rel = trimmed === "workspace" ? "" : trimmed.slice("workspace".length + 1);
        base = rel ? path.join(WORKSPACE_DIR, rel) : WORKSPACE_DIR;
    } else {
        base = path.join(USER_DIR, trimmed);
    }
    return path.normalize(path.resolve(base));
}
