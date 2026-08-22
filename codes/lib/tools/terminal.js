import { exec, spawn } from "node:child_process";
import { loadAgentConfig } from "../config-loader.js";
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

function appendTruncated(buf, text) {
    const s = String(text || "");
    if (!s) return buf;
    const next = (buf || "") + s;
    if (next.length <= MAX_BG_BUFFER) return next;
    return `${next.slice(0, MAX_BG_BUFFER)}\n…[truncated]`;
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

    child.on("close", (code) => {
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

export async function executeTerminalTool(name, args, { signal } = {}) {
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
    const env = { ...process.env, HOME: isDockerRuntime() ? USER_DIR : process.env.HOME || USER_DIR };

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

    return new Promise((resolve) => {
        let stoppedByUser = false;
        const child = exec(
            command,
            {
                cwd,
                timeout: timeoutMs,
                maxBuffer: maxChars * 2,
                shell: "/bin/sh",
                env,
            },
            (err, stdout, stderr) => {
                signal?.removeEventListener("abort", onAbort);
                const out = truncate(stdout || "", maxChars);
                const errOut = truncate(stderr || "", maxChars);
                const ok = !err;
                const exitCode = err && typeof err.code === "number" ? err.code : ok ? 0 : 1;
                if (stoppedByUser) {
                    resolve({
                        ok: false,
                        cwd,
                        aborted: true,
                        exitCode: exitCode || child.exitCode || 1,
                        stdout: out,
                        stderr: errOut || "Stopped by user.",
                    });
                    return;
                }
                resolve({
                    ok,
                    cwd,
                    exitCode,
                    stdout: out,
                    stderr: errOut,
                });
            },
        );

        const onAbort = () => {
            stoppedByUser = true;
            child.kill("SIGTERM");
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) => {
            signal?.removeEventListener("abort", onAbort);
            resolve({
                ok: false,
                cwd,
                exitCode: err.code ?? 1,
                stdout: "",
                stderr: truncate(err.message || "", maxChars),
            });
        });
    });
}
