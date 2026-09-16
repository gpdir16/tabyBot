import { spawn } from "node:child_process";
import { loadAgentConfig } from "../config-loader.js";
import { camofoxUser, camofoxEnv } from "../computer/camofox-user.js";
import { USER_DIR, resolveAgentPath } from "../paths.js";
import { isDockerRuntime } from "../runtime.js";
import { terminalCwdParamDescription, terminalRunDescription } from "../path-labels.js";

function resolveCwd(cwd) {
    const resolved = resolveAgentPath(cwd);
    return resolved || USER_DIR;
}

function truncate(text, maxChars) {
    if (!text || text.length <= maxChars) return text || "";
    return `${text.slice(0, maxChars)}\n…[truncated]`;
}

export const terminalToolDefinitions = [
    {
        type: "function",
        function: {
            name: "terminal_run",
            description: terminalRunDescription(),
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Shell command to run" },
                    cwd: {
                        type: "string",
                        description: terminalCwdParamDescription(),
                    },
                    background: {
                        type: "boolean",
                        description:
                            "If true, start the command as a background job and return immediately with its jobId/pid instead of waiting. Use for long builds, servers, or anything that would exceed the foreground timeout. Check progress later with bg_status (poll periodically), list with bg_list, stop with bg_kill.",
                    },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "bg_status",
            description:
                "Check the status and accumulated output of a background job started with terminal_run (background=true). Returns whether it is still running, its exit code if finished, and stdout/stderr collected so far.",
            parameters: {
                type: "object",
                properties: {
                    jobId: { type: "string", description: "Job id returned by terminal_run (e.g. bg1)." },
                },
                required: ["jobId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "bg_list",
            description: "List all background jobs started with terminal_run (background=true), with their status, pid, exit code, and elapsed time.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "bg_kill",
            description: "Stop a background job started with terminal_run (background=true). Kills the process tree of the job.",
            parameters: {
                type: "object",
                properties: {
                    jobId: { type: "string", description: "Job id returned by terminal_run (e.g. bg1)." },
                },
                required: ["jobId"],
            },
        },
    },
];

const MAX_BG_BUFFER = 200_000;

const backgroundJobs = new Map();
let nextJobId = 1;

function appendTruncated(buf, text, limit = MAX_BG_BUFFER) {
    const s = String(text || "");
    if (!s) return buf;
    const next = (buf || "") + s;
    if (next.length <= limit) return next;
    return `${next.slice(0, limit)}\n…[truncated]`;
}

function startBackgroundJob(command, cwd, env) {
    const jobId = `bg${nextJobId++}`;
    const job = {
        jobId,
        cmd: command,
        cwd,
        pid: null,
        status: "starting",
        exitCode: null,
        stdout: "",
        stderr: "",
        startedAt: Date.now(),
        completedAt: null,
    };
    backgroundJobs.set(jobId, job);

    const child = spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    job.pid = child.pid;
    job.status = "running";

    child.stdout.on("data", (d) => {
        job.stdout = appendTruncated(job.stdout, d.toString());
    });
    child.stderr.on("data", (d) => {
        job.stderr = appendTruncated(job.stderr, d.toString());
    });

    // close가 아니라 exit으로 상태를 본다 — 손자 프로세스가 파이프를 잡고 있어도
    // 셸이 죽으면 잡 상태가 완료로 바뀐다(출력 수집은 파이프가 열린 동안 계속).
    child.on("exit", (code) => {
        if (job.status === "killed") return; // bg_kill이 이미 상태를 확정함
        job.status = "completed";
        job.exitCode = code;
        job.completedAt = Date.now();
    });
    child.on("error", (err) => {
        if (job.status !== "completed") job.status = "error";
        job.stderr = appendTruncated(job.stderr, String(err?.message || err));
        job.completedAt = Date.now();
    });

    return job;
}

function formatJob(job, maxChars) {
    const running = job.status === "running" || job.status === "starting";
    const elapsed = ((running ? Date.now() : job.completedAt || Date.now()) - job.startedAt) / 1000;
    return {
        jobId: job.jobId,
        cmd: job.cmd,
        cwd: job.cwd,
        pid: job.pid,
        status: job.status,
        exitCode: job.exitCode,
        running,
        elapsedSeconds: Math.round(elapsed * 10) / 10,
        stdout: truncate(job.stdout, maxChars),
        stderr: truncate(job.stderr, maxChars),
    };
}

function killProcessTree(pid) {
    try {
        process.kill(-pid, "SIGTERM"); // 음수 pid = 프로세스 그룹 전체 킬
    } catch {
        try {
            process.kill(pid, "SIGTERM");
        } catch {}
    }
    setTimeout(() => {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            try {
                process.kill(pid, "SIGKILL");
            } catch {}
        }
    }, 2000);
}

function executeBackgroundTool(name, args, { maxChars } = {}) {
    if (name === "bg_list") {
        const jobs = [...backgroundJobs.values()].map((j) => formatJob(j, maxChars));
        return { ok: true, count: jobs.length, jobs };
    }

    const jobId = args?.jobId;
    if (!jobId) return { error: "jobId is required" };
    const job = backgroundJobs.get(String(jobId));
    if (!job) return { error: `No background job with id '${jobId}'. Use bg_list to see available jobs.` };

    if (name === "bg_status") {
        return { ok: true, ...formatJob(job, maxChars) };
    }

    if (name === "bg_kill") {
        if (job.status === "running" || job.status === "starting") {
            killProcessTree(job.pid);
            job.status = "killed";
            job.completedAt = Date.now();
        }
        return {
            ok: true,
            jobId: job.jobId,
            status: job.status,
            message: `Job ${job.jobId} ${job.status === "killed" ? "killed" : "already finished"}.`,
        };
    }

    return { error: `Unknown terminal tool: ${name}` };
}

export async function executeTerminalTool(name, args, { signal, agentId } = {}) {
    if (!["terminal_run", "bg_status", "bg_list", "bg_kill"].includes(name)) {
        return { error: `Unknown terminal tool: ${name}` };
    }

    const agent = loadAgentConfig();
    if (agent.terminalEnabled === false) {
        return { error: "Terminal is disabled in agent config" };
    }

    const maxChars = agent.terminalMaxOutputChars ?? 32_000;

    if (name !== "terminal_run") {
        return executeBackgroundTool(name, args, { maxChars });
    }

    const command = args?.command?.trim();
    if (!command) return { error: "command is required" };

    const cwd = resolveCwd(args?.cwd);
    const env = camofoxEnv({ ...process.env, HOME: isDockerRuntime() ? USER_DIR : process.env.HOME || USER_DIR });
    // --user 생략한 camofox 호출이 웹 컴퓨터 뷰와 같은 봇 프로필을 쓰게 한다.
    if (agentId) env.CAMOFOX_CLI_USER = camofoxUser(agentId);

    if (signal?.aborted) {
        return { ok: false, cwd, aborted: true, exitCode: null, stdout: "", stderr: "Stopped by user." };
    }

    if (args?.background) {
        const job = startBackgroundJob(command, cwd, env);
        return {
            ok: true,
            background: true,
            jobId: job.jobId,
            pid: job.pid,
            cwd,
            message: `Started in background as job ${job.jobId} (pid ${job.pid}). Check with bg_status(jobId="${job.jobId}") or bg_list; stop with bg_kill.`,
        };
    }

    const timeoutMs = agent.terminalTimeoutMs ?? 120_000;

    // exec 대신 detached spawn: 자식이 자기 프로세스 그룹을 갖게 해서
    // 타임아웃/중단 시 트리 전체를 죽인다. exec 콜백은 stdio EOF(close)를 기다려
    // 파이프를 물고 있는 손자 프로세스가 있으면 영원히 resolve되지 않는다.
    return new Promise((resolve) => {
        let stoppedByUser = false;
        let timedOut = false;
        let settled = false;
        let stdout = "";
        let stderr = "";
        const cap = maxChars * 2;

        const child = spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        if (!child.pid) {
            resolve({ ok: false, cwd, exitCode: 1, stdout: "", stderr: "Failed to spawn shell" });
            return;
        }

        let graceTimer = null;
        const cleanup = () => {
            clearTimeout(timer);
            clearTimeout(graceTimer);
            signal?.removeEventListener("abort", onAbort);
        };

        const finish = (exitCode) => {
            if (settled) return;
            settled = true;
            cleanup();
            const out = truncate(stdout, maxChars);
            const errOut = truncate(stderr, maxChars);
            if (stoppedByUser) {
                resolve({ ok: false, cwd, aborted: true, exitCode: exitCode ?? 1, stdout: out, stderr: errOut || "Stopped by user." });
                return;
            }
            if (timedOut) {
                resolve({
                    ok: false,
                    cwd,
                    timedOut: true,
                    exitCode: exitCode ?? 1,
                    stdout: out,
                    stderr: errOut || `Timed out after ${timeoutMs}ms. Rerun with background=true for long-running commands.`,
                });
                return;
            }
            const ok = exitCode === 0;
            resolve({ ok, cwd, exitCode: exitCode ?? 1, stdout: out, stderr: errOut });
        };

        const killTree = () => killProcessTree(child.pid);

        const onAbort = () => {
            stoppedByUser = true;
            killTree();
        };

        const timer = setTimeout(() => {
            timedOut = true;
            killTree();
        }, timeoutMs);

        // 프로세스가 exit했는데 손자가 파이프를 물고 있어 close가 안 오는 경우에도
        // 3초 유예 뒤 결과를 확정한다(모은 출력까지만 반환).
        child.on("exit", (code) => {
            graceTimer = setTimeout(() => finish(code), 3000);
            graceTimer.unref?.();
        });
        child.on("close", (code) => finish(code));
        child.on("error", (err) => {
            stderr = appendTruncated(stderr, err.message || String(err));
            finish(err.code ?? 1);
        });

        child.stdout.on("data", (d) => {
            stdout = appendTruncated(stdout, d.toString(), cap);
        });
        child.stderr.on("data", (d) => {
            stderr = appendTruncated(stderr, d.toString(), cap);
        });

        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
