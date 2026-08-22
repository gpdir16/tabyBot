import fs from "node:fs";
import path from "node:path";
import { CODES_DIR } from "./paths.js";
import { isDockerContainer, resolveManagedInstallHome } from "./install-paths.js";

const IS_DOCKER = isDockerContainer();

function shellQuote(value) {
    const text = String(value ?? "");
    if (!/[ \t'"\\$`!#*&?;<>()|]/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function shellCommandPrefix(command) {
    const text = String(command ?? "").trim();
    if (!text) return "docker";
    if (!/\s/.test(text)) return shellQuote(text);
    if (text === "sudo docker") return text;
    if (text.startsWith("sudo ")) {
        return `sudo ${shellQuote(text.slice(5).trim())}`;
    }
    return shellQuote(text);
}

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

export function getApproveCliHint(code = "{code}") {
    if (IS_DOCKER) {
        const dockerShell = shellCommandPrefix(process.env.TABYAGENT_DOCKER_SHELL || "docker");
        const home = process.env.TABYAGENT_HOME?.trim();
        if (home && fs.existsSync(path.join(home, "tabyagent"))) {
            return `tabyagent approve ${code}`;
        }
        if (home) {
            return `${dockerShell} compose -f ${shellQuote(path.join(home, "docker-compose.yml"))} exec -T tabyagent approve ${code}`;
        }
        return `${dockerShell} compose exec -T tabyagent approve ${code}`;
    }
    if (isManagedLocalInstall()) {
        const home = resolveManagedInstallHome(process.argv[1], CODES_DIR);
        if (fs.existsSync(path.join(home, "tabyagent"))) {
            return `tabyagent approve ${code}`;
        }
    }
    const cliJs = path.join(CODES_DIR, "cli.js");
    const nodeBin = process.env.TABYAGENT_NODE?.trim() || "node";
    return `${shellQuote(nodeBin)} ${shellQuote(cliJs)} approve ${code}`;
}
