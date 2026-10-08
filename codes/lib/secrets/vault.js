// 시크릿 주입과 마스킹. 모델은 시크릿을 {{secret:<UUID>}}로만 가리키고, 실행 직전에 값으로 바뀐다.
// 터미널은 값을 환경 변수로만 넘기고, 다른 도구는 인자 문자열에 값을 직접 넣는다.
// 출력에 섞인 값은 {{secret:<UUID>}}로 되돌려, 모델 컨텍스트에는 항상 id만 남는다.
import { getSecretValues, listSecrets } from "./store.js";

const PLACEHOLDER_RE = /\{\{secret:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/g;

// 값을 직접 치환해 넣는 도구. terminal_run은 셸 인용 문제 때문에 환경 변수로 넘긴다.
const INJECT_TOOLS = (name) => name === "xvfb_gui" || name === "file_patch" || name.startsWith("mcp__");

export const placeholderFor = (id) => `{{secret:${id}}}`;

// 터미널에서 쓰는 내부 환경 변수 이름. 사용자와 모델에게는 노출하지 않는다.
const envNameFor = (id) => `TABY_SECRET_${id.replaceAll("-", "")}`;

function availableHint() {
    const list = listSecrets();
    return list.length ? `Available secrets: ${list.map((s) => `${placeholderFor(s.id)} (${s.name})`).join(", ")}` : "No secrets are stored.";
}

function refsIn(text) {
    return [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

function walkStrings(value, fn, depth = 0) {
    if (depth > 20) return value;
    if (typeof value === "string") return fn(value);
    if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn, depth + 1));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn, depth + 1);
        return out;
    }
    return value;
}

// 도구 인자의 자리표시자를 실행 직전에 값으로 바꾼다. 반환된 args/env는 도구 실행에만 쓰고 모델·기록에는 넘기지 않는다.
// 알 수 없는 이름이 있으면 { error }로 도구 실행 자체를 막는다.
export function prepareToolSecrets(toolName, args) {
    const isTerminal = toolName === "terminal_run";
    if (!isTerminal && !INJECT_TOOLS(toolName)) return { args, env: null };

    const used = new Set();
    walkStrings(args, (s) => {
        for (const id of refsIn(s)) used.add(id);
        return s;
    });
    if (!used.size) return { args, env: null };

    const values = new Map(getSecretValues().map((s) => [s.id, s.value]));
    const missing = [...used].filter((id) => !values.has(id));
    if (missing.length)
        return { error: `Unknown secret: ${missing.join(", ")}. ${availableHint()}. Ask the user with secret_request if it is missing.` };

    // 터미널은 참조한 시크릿만 환경 변수로 넘기고 명령에는 변수 참조만 넣는다. 값이 명령 문자열에 없어 따옴표·$가 든 값도 안전하다.
    if (isTerminal) {
        const env = {};
        const command = String(args.command ?? "").replace(PLACEHOLDER_RE, (_, id) => {
            env[envNameFor(id)] = values.get(id);
            return `\${${envNameFor(id)}}`;
        });
        return { args: { ...args, command }, env };
    }
    return { args: walkStrings(args, (s) => s.replace(PLACEHOLDER_RE, (_, id) => values.get(id))), env: null };
}

// 마스킹에 쓸 변형: 원문, JSON 이스케이프, URL 인코딩, base64(패딩 유무).
function variantsOf(value) {
    const set = new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]);
    // echo/printf로 줄바꿈이 붙은 채 base64가 되는 흔한 경우까지 잡는다.
    for (const raw of [value, `${value}\n`]) {
        const b64 = Buffer.from(raw, "utf8").toString("base64");
        set.add(b64);
        set.add(b64.replace(/=+$/, ""));
    }
    return [...set].filter(Boolean);
}

// 너무 짧은 값(PIN 같은 것)을 아무 데나 치환하면 출력이 망가진다. 앞뒤가 영숫자가 아닌 독립된 토큰일 때만 마스킹한다.
const SHORT_LENGTH = 4;
const boundaryRe = (v) => new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");

let compiled = { source: null, rules: [] };

function rules() {
    const source = getSecretValues();
    if (compiled.source === source) return compiled.rules;
    const list = [];
    for (const { id, value } of source) {
        for (const v of variantsOf(value)) list.push({ needle: v, label: placeholderFor(id), re: v.length < SHORT_LENGTH ? boundaryRe(v) : null });
    }
    // 긴 것부터 바꿔 짧은 값이 긴 값의 일부를 먼저 깨지 않게 한다.
    list.sort((a, b) => b.needle.length - a.needle.length);
    compiled = { source, rules: list };
    return list;
}

// split은 캡처 그룹을 결과에 끼워 넣으므로 그룹이 정확히 하나여야 홀수 칸이 자리표시자가 된다.
const PLACEHOLDER_SPLIT_RE = /(\{\{secret:[0-9a-f-]{36}\}\})/;

function redactPlain(text, list) {
    let out = text;
    for (const { needle, label, re } of list) {
        if (re) out = out.replace(re, label);
        else if (out.includes(needle)) out = out.split(needle).join(label);
    }
    return out;
}

export function redactText(text) {
    if (typeof text !== "string" || !text) return text;
    const list = rules();
    if (!list.length) return text;
    // 이미 마스킹된 자리표시자는 건드리지 않는다. 짧은 값이 그 안의 id 조각을 깨면 안 된다.
    return text
        .split(PLACEHOLDER_SPLIT_RE)
        .map((part, i) => (i % 2 ? part : redactPlain(part, list)))
        .join("");
}

// 객체·배열 안의 모든 문자열을 마스킹한다. 이미지 페이로드(__image)는 건드리지 않는다.
export function redactDeep(value, depth = 0) {
    if (!rules().length || depth > 20) return value;
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = k === "__image" ? v : redactDeep(v, depth + 1);
        return out;
    }
    return value;
}

// 시스템 프롬프트의 "Stored secrets" 본문. 사용자가 붙인 이름과 id만 싣는다.
export function formatSecretsForPrompt() {
    const list = listSecrets();
    if (!list.length) return "- (none)";
    return list.map((s) => `- ${s.name}: \`${placeholderFor(s.id)}\``).join("\n");
}
