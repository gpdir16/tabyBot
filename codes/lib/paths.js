import "./load-install-env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isManagedInstallEntry } from "./install-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DERIVED_CODES_DIR = path.resolve(__dirname, "..");
const DERIVED_APP_ROOT = path.resolve(DERIVED_CODES_DIR, "..");

const MANAGED_INSTALL = isManagedInstallEntry();
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
export const SESSION_DIR = path.join(USER_DIR, "session");
export const CONFIG_DIR = resolvePathEnv("CONFIG_DIR", path.join(DERIVED_CODES_DIR, "config"));
export const SKILLS_SYSTEM_DIR = path.join(CODES_DIR, "skills");
export const TEMPLATES_USER_DIR = path.join(CODES_DIR, "templates", "user");
const HOME_DIR = process.env.HOME || "/root";
export const AGENTS_SKILLS_LINK = path.join(HOME_DIR, ".agents", "skills");

export function resolveAgentPath(rawPath) {
    const trimmed = rawPath?.trim();
    if (!trimmed) return null;
    let base;
    if (path.isAbsolute(trimmed)) {
        base = trimmed;
    } else {
        base = path.join(USER_DIR, trimmed);
    }
    return path.normalize(path.resolve(base));
}
