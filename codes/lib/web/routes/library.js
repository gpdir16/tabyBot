// 스킬 목록과 MCP 서버 설정 API.
import fs from "node:fs";
import path from "node:path";
import { USER_DIR } from "../../paths.js";
import { writeFileAtomic } from "../../atomic-file.js";
import { collectAvailableSkills, resolveSkillPath } from "../../skills-catalog.js";
import { loadMcpConfig, saveMcpConfig } from "../../config-loader.js";
import { getMcpServerStatus, syncMcpServers, validServerEntry } from "../../mcp/servers.js";

// ── 스킬 목록 관리 API. ──

function registerSkillsRoutes(router) {
    // 스킬 이름은 디렉터리 이름으로 쓰인다. 경로 탈출 문자를 허용하지 않는다.
    const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

    function skillsPayload() {
        return {
            skills: collectAvailableSkills().map((s) => ({
                name: s.name,
                summary: s.summary,
                source: s.source,
                builtin: s.source === "system",
            })),
        };
    }

    router.add("GET", "/api/skills", (ctx) => {
        ctx.json200(skillsPayload());
    });

    router.add("GET", "/api/skills/:name", (ctx) => {
        const name = ctx.params.name;
        if (!SKILL_NAME_RE.test(name)) return ctx.json400("invalid_skill_name");
        const found = resolveSkillPath(name, ctx.query.source || null);
        if (!found) return ctx.json404();
        let content = "";
        try {
            content = fs.readFileSync(found.skillFile, "utf8");
        } catch (err) {
            return ctx.json400(err?.message || String(err));
        }
        ctx.json200({ name, source: found.source, builtin: found.source === "system", content });
    });

    router.add("POST", "/api/skills", async (ctx) => {
        const body = await ctx.json();
        const name = String(body?.name || "").trim();
        const content = String(body?.content ?? "");
        if (!SKILL_NAME_RE.test(name)) return ctx.json400("invalid_skill_name");
        if (!content.trim()) return ctx.json400("empty_skill");
        // 새 스킬은 항상 사용자 스킬 디렉터리에 만든다. 같은 이름의 시스템/공유 스킬이 있으면 거절.
        if (resolveSkillPath(name, null)) return ctx.json409("skill_exists");
        try {
            writeFileAtomic(path.join(USER_DIR, "skills", name, "SKILL.md"), content);
        } catch (err) {
            return ctx.json400(err?.message || String(err));
        }
        ctx.json200({ ...skillsPayload(), skill: { name, source: "user" } });
    });

    router.add("PUT", "/api/skills/:name", async (ctx) => {
        const name = ctx.params.name;
        if (!SKILL_NAME_RE.test(name)) return ctx.json400("invalid_skill_name");
        const body = await ctx.json();
        const found = resolveSkillPath(name, body?.source || null);
        if (!found) return ctx.json404();
        if (found.source === "system") return ctx.json400("skill_builtin");
        const content = String(body?.content ?? "");
        if (!content.trim()) return ctx.json400("empty_skill");
        try {
            writeFileAtomic(found.skillFile, content);
        } catch (err) {
            return ctx.json400(err?.message || String(err));
        }
        ctx.json200({ ...skillsPayload(), skill: { name, source: found.source } });
    });

    router.add("DELETE", "/api/skills/:name", (ctx) => {
        const name = ctx.params.name;
        if (!SKILL_NAME_RE.test(name)) return ctx.json400("invalid_skill_name");
        const found = resolveSkillPath(name, ctx.query.source || null);
        if (!found) return ctx.json404();
        if (found.source === "system") return ctx.json400("skill_builtin");
        try {
            fs.rmSync(path.dirname(found.skillFile), { recursive: true, force: true });
        } catch (err) {
            return ctx.json400(err?.message || String(err));
        }
        ctx.json200(skillsPayload());
    });
}

// ── MCP 서버 설정(user/mcp.json) API. ──

function registerMcpRoutes(router) {
    // env 값은 비밀일 수 있어 목록에는 키 이름만 보낸다. 수정은 부분 패치 의미:
    // 값 null = 그 키 삭제, 문자열 = 그 키 설정, 미언급 키 = 유지.
    function mcpPayload() {
        const status = getMcpServerStatus();
        const raw = loadMcpConfig()?.servers;
        const list = Array.isArray(raw) ? raw : [];
        return {
            servers: list.map((s) => ({
                name: typeof s?.name === "string" ? s.name : "",
                command: typeof s?.command === "string" ? s.command : "",
                args: Array.isArray(s?.args) ? s.args.map(String) : [],
                envKeys: s?.env && typeof s.env === "object" && !Array.isArray(s.env) ? Object.keys(s.env) : [],
                status: status[s?.name] || { connected: false },
            })),
        };
    }

    // body를 검증된 서버 항목으로 바꾼다. prev가 있으면 누락 필드는 기존 값을 이어 받는다.
    function normalizeMcpEntry(body, prev) {
        const name = String(body?.name ?? prev?.name ?? "").trim();
        const command = String(body?.command ?? prev?.command ?? "").trim();
        const args =
            body?.args !== undefined ? (Array.isArray(body.args) ? body.args.map(String) : null) : Array.isArray(prev?.args) ? prev.args : [];
        if (args === null) return { error: "invalid_args" };
        const entry = { name, command };
        if (args.length) entry.args = args;
        const env = prev?.env && typeof prev.env === "object" && !Array.isArray(prev.env) ? { ...prev.env } : {};
        if (body?.env !== undefined) {
            if (!body.env || typeof body.env !== "object" || Array.isArray(body.env)) return { error: "invalid_env" };
            for (const [k, v] of Object.entries(body.env)) {
                const key = String(k).trim();
                if (!key) return { error: "invalid_env_key" };
                if (v === null) delete env[key];
                else env[key] = String(v);
            }
        }
        if (Object.keys(env).length) entry.env = env;
        if (!validServerEntry(entry)) return { error: "invalid_server" };
        return { entry };
    }

    // 저장 뒤 연결 동기화는 백그라운드로 한다. stdio 접속 타임아웃(최대 20초) 동안
    // 응답을 붙잡아 두지 않는다. 상태는 다음 GET에서 반영된다.
    function saveMcpAndSync(conf) {
        saveMcpConfig(conf);
        void syncMcpServers().catch((err) => console.error("tabyBot: MCP sync failed:", err?.message || err));
    }

    router.add("GET", "/api/mcp", (ctx) => {
        ctx.json200(mcpPayload());
    });

    router.add("POST", "/api/mcp", async (ctx) => {
        const body = await ctx.json();
        const result = normalizeMcpEntry(body, null);
        if (result.error) return ctx.json400(result.error);
        const conf = loadMcpConfig();
        const list = Array.isArray(conf.servers) ? conf.servers : [];
        if (list.some((s) => s?.name === result.entry.name)) return ctx.json409("mcp_exists");
        conf.servers = [...list, result.entry];
        saveMcpAndSync(conf);
        ctx.json200(mcpPayload());
    });

    router.add("PUT", "/api/mcp/:name", async (ctx) => {
        const conf = loadMcpConfig();
        const list = Array.isArray(conf.servers) ? conf.servers : [];
        const idx = list.findIndex((s) => s?.name === ctx.params.name);
        if (idx < 0) return ctx.json404();
        const body = await ctx.json();
        // 이름 변경은 지원하지 않는다. URL의 이름이 정본이다.
        const result = normalizeMcpEntry({ ...body, name: ctx.params.name }, list[idx]);
        if (result.error) return ctx.json400(result.error);
        list[idx] = result.entry;
        conf.servers = list;
        saveMcpAndSync(conf);
        ctx.json200(mcpPayload());
    });

    router.add("DELETE", "/api/mcp/:name", (ctx) => {
        const conf = loadMcpConfig();
        const list = Array.isArray(conf.servers) ? conf.servers : [];
        const next = list.filter((s) => s?.name !== ctx.params.name);
        if (next.length === list.length) return ctx.json404();
        conf.servers = next;
        saveMcpAndSync(conf);
        ctx.json200(mcpPayload());
    });
}

export function registerLibraryRoutes(router) {
    registerSkillsRoutes(router);
    registerMcpRoutes(router);
}
