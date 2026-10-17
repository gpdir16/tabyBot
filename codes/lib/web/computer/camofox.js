// camofox 브라우저 서버 연동: 프로필·탭 스냅샷·REST 호출.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { writeFileAtomic } from "../../atomic-file.js";
import * as display from "../../computer/display.js";
import { USER_DIR } from "../../paths.js";

let camofoxBin; // "yes" | null | undefined(미확인)

export function runFile(file, args, env, timeoutMs = 45_000) {
    return new Promise((resolve) => {
        execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err && typeof err.code === "number" ? err.code : err ? -1 : 0,
                stdout: (stdout || "").toString(),
                stderr: (stderr || "").toString(),
            });
        });
    });
}

export async function hasCamofox() {
    if (camofoxBin === undefined) {
        const r = await display.run("command -v camofox", { timeout: 5_000 });
        camofoxBin = r.ok && r.stdout.trim() ? true : null;
    }
    return camofoxBin === true;
}

export function normalizeUrl(url) {
    const u = String(url || "").trim();
    if (!u) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u;
    return `https://${u}`;
}

// camofox는 http(s)만 허용한다. 빈 창(about:blank)은 차단되므로 기본 페이지를 둔다.
export const DEFAULT_URL = "https://start.duckduckgo.com/";

function camofoxBase() {
    return `http://${process.env.CAMOFOX_HOST || "127.0.0.1"}:${process.env.CAMOFOX_PORT || "9377"}`;
}

export function camofoxProfilesDir() {
    return process.env.CAMOFOX_PROFILES_DIR || path.join(USER_DIR, "camofox", "profiles");
}

// Firefox 세션 복원을 켠다. 브라우저가 재시작돼도 이전 탭/창을 그대로 되살린다.
// user.js는 실행 때마다 prefs.js에 병합되므로 프로필 생성 전에 미리 써둬도 된다.
export function ensureProfilePrefs(user) {
    try {
        const dir = path.join(camofoxProfilesDir(), user);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "user.js");
        const body = ['user_pref("browser.startup.page", 3);', 'user_pref("browser.sessionstore.resume_from_crash", true);', ""].join("\n");
        if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) writeFileAtomic(file, body);
    } catch {
        // 프로필 설정을 쓰지 못해도 기본 설정으로 계속 진행한다
    }
    upgradeProfileCompat(user);
}

/* ── 프로필 버전 표시: camofox-browser는 프로필 폴더의 compatibility.json에 만든 Camoufox 버전을
   적어 두고, 설치된 버전과 다르면 그 프로필(로그인 포함)을 통째로 거부한다. 밖에서는
   "Internal server error"로만 보여 브라우저 전체가 고장 난 것처럼 된다. 이미지를 다시 빌드하면
   Camoufox가 최신으로 받아지므로 업데이트할 때마다 이 일이 생긴다. Firefox 프로필은 상위 버전으로는
   스스로 옮겨 가므로, 올라간 경우에만 표시를 현재 버전으로 고쳐 로그인을 살린다. ── */
function camoufoxCacheDirs() {
    const homes = [...new Set([process.env.HOME, os.homedir(), USER_DIR].filter(Boolean))];
    return homes.map((home) => {
        if (process.platform === "darwin") return path.join(home, "Library", "Caches", "camoufox");
        if (process.platform === "win32") return path.join(home, "AppData", "Local", "camoufox", "camoufox", "Cache");
        return path.join(home, ".cache", "camoufox");
    });
}

// camofox-browser가 비교하는 형식("156.0.1-beta.39")과 같게 만든다. 못 읽으면 "".
function installedCamoufoxVersion() {
    for (const dir of camoufoxCacheDirs()) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8"));
            if (v?.version && v?.release) return `${v.version}-${v.release}`;
        } catch {
            // 이 경로에 설치돼 있지 않으면 다음 후보를 본다
        }
    }
    return "";
}

function isNewerVersion(a, b) {
    const x = String(a).match(/\d+/g)?.map(Number) || [];
    const y = String(b).match(/\d+/g)?.map(Number) || [];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
}

export function upgradeProfileCompat(user, current = installedCamoufoxVersion()) {
    if (!current) return;
    const file = path.join(camofoxProfilesDir(), user, "compatibility.json");
    try {
        const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
        const from = envelope?.data?.camoufoxVersion;
        if (envelope?.version !== 1 || !from || !isNewerVersion(current, from)) return;
        const data = { ...envelope.data, camoufoxVersion: current, upgradedFrom: from, upgradedAt: new Date().toISOString() };
        writeFileAtomic(file, JSON.stringify({ ...envelope, data }, null, 2));
        blog("profile compat upgraded", { user, from, to: current });
    } catch {
        // 표시 파일이 없으면 camofox가 처음 열 때 만들고, 깨졌으면 camofox가 직접 오류를 낸다
    }
}

// 부팅 때 모든 프로필을 맞춘다. 에이전트의 terminal_run은 이 모듈을 거치지 않고 camofox CLI를 바로 부른다.
export function upgradeAllProfilesCompat() {
    const current = installedCamoufoxVersion();
    if (!current) return;
    let users = [];
    try {
        users = fs
            .readdirSync(camofoxProfilesDir(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        // 프로필 폴더가 아직 없으면 맞출 것도 없다
    }
    for (const user of users) upgradeProfileCompat(user, current);
}

// 이전 실행에서 남긴 세션 저장 파일이 있는가: 있으면 재기동 시 탭이 복원된다.
export function hasStoredSession(user) {
    const dir = path.join(camofoxProfilesDir(), user);
    return (
        fs.existsSync(path.join(dir, "sessionstore.jsonlz4")) ||
        fs.existsSync(path.join(dir, "sessionstore-backups", "recovery.jsonlz4")) ||
        fs.existsSync(path.join(dir, "sessionstore-backups", "previous.jsonlz4"))
    );
}

/* ── 탭 스냅샷: 정상 종료 시엔 Firefox가 세션 복원을 건너뛰므로
   마지막으로 열려 있던 URL을 직접 저장해 재기동 때 다시 연다 ── */
export function tabSnapshotFile(user) {
    return path.join(USER_DIR, "camofox", "last-tabs", `${user}.json`);
}

export function readTabSnapshot(user) {
    try {
        const urls = JSON.parse(fs.readFileSync(tabSnapshotFile(user), "utf8"));
        return Array.isArray(urls) ? urls.filter((u) => /^https?:\/\//.test(u)) : [];
    } catch {
        return [];
    }
}

function writeTabSnapshot(user, urls) {
    try {
        const file = tabSnapshotFile(user);
        const body = JSON.stringify(urls);
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) return;
        writeFileAtomic(file, body);
    } catch {
        // 탭 스냅샷은 복원 편의용이라 저장하지 못해도 계속 진행한다
    }
}

export async function camofoxApi(apiPath, opts = {}) {
    const res = await fetch(`${camofoxBase()}${apiPath}`, {
        ...opts,
        signal: AbortSignal.timeout(opts.timeoutMs || 15_000),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

// 브라우저 결정 경로는 전부 로그를 남긴다. 세션이 언제/왜 재생성됐는지 추적용.
export function blog(msg, extra) {
    console.log(`[computer] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
}

// 서버/세션 상태를 직접 HTTP로 판정한다. CLI 출력 파싱은 경고 문구·타임아웃에 취약하다.
export async function camofoxServerUp() {
    const h = await camofoxApi("/health", { timeoutMs: 4_000 }).catch(() => null);
    return h?.ok ? h.json || null : null;
}

export async function camofoxUserTabs(user) {
    const t = await camofoxApi(`/tabs?userId=${encodeURIComponent(user)}`, { timeoutMs: 6_000 }).catch(() => null);
    return t?.ok && Array.isArray(t.json?.tabs) ? t.json.tabs : null;
}

// 브라우저가 살아있는 동안 유저별 열린 탭 URL을 주기적으로 저장한다.
async function snapshotAllTabs() {
    try {
        const h = await camofoxApi("/health", { timeoutMs: 5_000 });
        const users = h.json?.activeUserIds;
        if (!Array.isArray(users)) return;
        for (const user of users) {
            const t = await camofoxApi(`/tabs?userId=${encodeURIComponent(user)}`, { timeoutMs: 5_000 });
            const urls = (t.json?.tabs || []).map((x) => x.url).filter((u) => /^https?:\/\//.test(u));
            if (urls.length) writeTabSnapshot(user, urls);
        }
    } catch {
        // camofox가 응답하지 않으면 정리할 세션을 알 수 없어 건너뛴다
    }
}

let tabSnapTimer = null;

export function startTabSnapshotter() {
    if (tabSnapTimer) return;
    tabSnapTimer = setInterval(() => void snapshotAllTabs(), 15_000);
    tabSnapTimer.unref?.();
    void snapshotAllTabs();
}
