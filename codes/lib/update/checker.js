import { loadAgentConfig } from "../config-loader.js";
import { isDockerRuntime } from "../runtime.js";
import { getLastNotifiedVersion, getRunningVersion, getWatchStartedAt, saveUpdateState, setLastNotifiedVersion } from "./store.js";

const GHCR_ACCEPT =
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json";

function normalizeImageName(name) {
    return String(name || "")
        .trim()
        .replace(/^https?:\/\/ghcr\.io\/v2\//, "")
        .replace(/^ghcr\.io\//, "");
}

function updateConfig() {
    return loadAgentConfig().updateCheck ?? {};
}

export function normalizeVersion(tag) {
    return String(tag || "")
        .trim()
        .replace(/^v/i, "")
        .split("-")[0];
}

export function isSemverTag(tag) {
    return /^(v)?\d+\.\d+(\.\d+)?([\w.-]*)?$/i.test(String(tag || "").trim());
}

export function compareSemver(a, b) {
    const pa = normalizeVersion(a)
        .split(".")
        .map((n) => Number(n) || 0);
    const pb = normalizeVersion(b)
        .split(".")
        .map((n) => Number(n) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
    }
    return 0;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "tabyagent-update-checker",
        },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
}

export async function fetchReleases(repo) {
    const data = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=20`);
    if (!Array.isArray(data)) return [];
    return data.filter((r) => !r.draft && !r.prerelease && isSemverTag(r.tag_name));
}

async function fetchGhcrToken(imageName) {
    const scope = `repository:${imageName}:pull`;
    const url = `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.token || null;
}

export async function isImagePublished(imageName, tag) {
    const token = await fetchGhcrToken(imageName);
    if (!token) return false;

    const encoded = encodeURIComponent(String(tag));
    const url = `https://ghcr.io/v2/${imageName}/manifests/${encoded}`;
    const res = await fetch(url, {
        method: "HEAD",
        headers: {
            Accept: GHCR_ACCEPT,
            Authorization: `Bearer ${token}`,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
}

export function candidateImageTags(tagName) {
    const tag = String(tagName || "").trim();
    if (!tag) return [];
    const bare = tag.replace(/^v/i, "");
    const prefixed = /^v/i.test(tag) ? null : `v${tag}`;
    return [...new Set([tag, bare !== tag ? bare : null, prefixed].filter(Boolean))];
}

async function imageReadyForRelease(imageName, tagName) {
    for (const candidate of candidateImageTags(tagName)) {
        if (await isImagePublished(imageName, candidate)) return true;
    }
    return false;
}

function pickHigherVersion(a, b) {
    if (!a) return b;
    if (!b) return a;
    return compareSemver(a, b) >= 0 ? a : b;
}

function syncBaseline(lastNotified, running) {
    const baseline = pickHigherVersion(lastNotified, running);
    if (!baseline) return null;

    if (!lastNotified || compareSemver(baseline, lastNotified) > 0) {
        setLastNotifiedVersion(baseline);
    }
    return baseline;
}

function ensureWatchStarted() {
    const existing = getWatchStartedAt();
    if (existing) return existing;

    const watchStartedAt = new Date().toISOString();
    saveUpdateState({ watchStartedAt });
    return watchStartedAt;
}

function releasesAfterWatch(releases, watchStartedAt) {
    const since = new Date(watchStartedAt).getTime();
    return releases.filter((r) => new Date(r.published_at).getTime() > since);
}

async function pickReadyRelease(releases, imageName) {
    const sorted = [...releases].sort((a, b) => compareSemver(b.tag_name, a.tag_name));
    for (const release of sorted) {
        if (await imageReadyForRelease(imageName, release.tag_name)) {
            return release;
        }
    }
    return null;
}

async function pickUpdateRelease(releases, imageName) {
    if (!releases.length) return null;
    if (isDockerRuntime()) {
        return pickReadyRelease(releases, imageName);
    }
    const sorted = [...releases].sort((a, b) => compareSemver(a.tag_name, b.tag_name));
    return sorted[sorted.length - 1];
}

function buildUpdatePayload(release, installScriptUrl, currentVersion) {
    return {
        tagName: release.tag_name,
        releaseUrl: release.html_url,
        installScript: `curl -fsSL ${installScriptUrl} | bash`,
        currentVersion,
    };
}

export async function checkForUpdate() {
    const cfg = updateConfig();
    if (cfg.enabled === false) return null;

    const githubRepo = cfg.githubRepo || "gpdir16/tabyAgent";
    const imageName = normalizeImageName(cfg.imageName || "ghcr.io/gpdir16/tabyagent");
    const installScriptUrl = cfg.installScriptUrl || `https://raw.githubusercontent.com/${githubRepo}/main/scripts/install.sh`;

    const releases = await fetchReleases(githubRepo);
    if (!releases.length) return null;

    const running = getRunningVersion();
    const lastNotified = getLastNotifiedVersion();
    const baseline = syncBaseline(lastNotified, running);

    if (baseline) {
        const newer = releases.filter((r) => compareSemver(r.tag_name, baseline) > 0).sort((a, b) => compareSemver(a.tag_name, b.tag_name));

        const ready = await pickUpdateRelease(newer, imageName);
        if (!ready || compareSemver(ready.tag_name, baseline) <= 0) return null;
        return buildUpdatePayload(ready, installScriptUrl, baseline);
    }

    const watchStartedAt = ensureWatchStarted();
    const watched = releasesAfterWatch(releases, watchStartedAt);
    if (!watched.length) return null;

    const ready = await pickUpdateRelease(watched, imageName);
    if (!ready) return null;
    const current = running || lastNotified;
    if (current && compareSemver(ready.tag_name, current) <= 0) return null;
    return buildUpdatePayload(ready, installScriptUrl, running || lastNotified || "—");
}
