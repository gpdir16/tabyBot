import path from "node:path";
import { CODES_DIR } from "./paths.js";
import { isDockerContainer, resolveManagedInstallHome } from "./install-paths.js";

const IS_DOCKER = isDockerContainer();

export function isManagedLocalInstall() {
    if (IS_DOCKER) return false;
    const home = resolveManagedInstallHome(process.argv[1], CODES_DIR);
    if (!home) return false;
    return path.resolve(CODES_DIR) === path.resolve(path.join(home, "app", "codes"));
}

export function shouldLinkAgentsSkillsDir() {
    return IS_DOCKER || isManagedLocalInstall();
}

export function isDockerRuntime() {
    return IS_DOCKER;
}
