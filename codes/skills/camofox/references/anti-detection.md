# Anti-Detection Architecture

How camofox-browser implements stealth browsing and bot-evasion behavior.

Related:

- `../SKILL.md`
- `./api-endpoints.md`
- `./cli-commands.md`

Source of truth for development: `AGENTS.md`

## Table of Contents

1. Engine-Level Strategy
2. Fingerprint Lifecycle
3. Camoufox Stealth Surface
4. Session Identity Hygiene
5. Proxy + Geo Behavior
6. Display Modes and Detection Tradeoffs
7. Practical Stealth Playbooks
8. Configuration Checklist
9. Known Limits

---

## 1) Engine-Level Strategy

Camofox-browser uses Camoufox through `camoufox-js` in `src/services/context-pool.ts`.

Key implementation facts:

- Launch path: `launchOptions(...)` from `camoufox-js`
- Fingerprint generation: `generateFingerprint(...)`
- Browser runtime: Playwright Firefox persistent context
- Humanization enabled: `humanize: true`
- Cache enabled: `enable_cache: true`

Design implication:

- Anti-detection is handled in the browser engine layer (Camoufox), not by ad-hoc JavaScript monkey-patching in route handlers.

---

## 2) Fingerprint Lifecycle

For each `userId` context:

1. Profile dir is resolved under `{{CAMOFOX_DATA_DIR}}/profiles/`; Linux/macOS keep the readable default-user directory name, while Windows uses collision-safe hashed internal profile keys (with a fail-closed read path for unambiguous legacy Windows directories)
2. Fingerprint file path: `<profileDir>/fingerprint.json`
3. If fingerprint exists and parses, it is reused
4. Otherwise a new fingerprint is generated and persisted

Why this matters:

- Stable fingerprint continuity across runs reduces suspicious identity churn.
- Different `userId`s naturally isolate browser identity.

Implementation path:

- `src/services/context-pool.ts` (`launchPersistentContext`)

---

## 3) Camoufox Stealth Surface

Camofox-browser delegates low-level anti-fingerprinting to Camoufox.

Capabilities expected from Camoufox engine profile (upstream engine behavior):

- C++ engine-level fingerprint spoofing
- Canvas fingerprint noise/normalization
- WebGL fingerprint masking/normalization
- Navigator/platform surface spoofing
- Font/device fingerprint shaping
- User-agent alignment with generated fingerprint

Project-level note:

- This repository configures and launches Camoufox but does not implement custom per-request JS patches for these surfaces in route code.
- Treat these as Camoufox engine capabilities used by camofox-browser, not bespoke route-layer features.

Why this matters for maintainability:

- Site anti-bot changes usually target JS-level patches first.
- Engine-level behavior remains more consistent than ad-hoc script injection.
- Upgrade path is mostly Camoufox runtime + launch option alignment instead of many fragile page scripts.

---

## 4) Session Identity Hygiene

Stealth failures often come from identity misuse rather than missing features.

Best practices:

- Keep one stable `userId` per target account/workflow
- Do not mix actions across users for same tab
- Reuse persistent profile for long-lived tasks
- Re-snapshot after navigation to avoid stale ref retries

CLI example:

```bash
camofox open https://target.example --user account-a
camofox snapshot --user account-a
camofox click e12 --user account-a
```

API example:

```bash
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"account-a","sessionKey":"default","url":"https://target.example"}'
```

Identity anti-patterns to avoid:

- Rotating `userId` every request on one target account.
- Running login under one `userId` and extraction under another.
- Combining geographically mismatched presets and proxies in same persistent profile.

---

## 5) Proxy + Geo Behavior

Proxy integration in `context-pool.ts`:

- Proxy config source: `PROXY_HOST`, `PROXY_PORT`, `PROXY_USERNAME`, `PROXY_PASSWORD`
- When proxy is active, Camoufox launch options set `geoip: true`

Effect:

- Browser network origin and geo-sensitive fingerprint context can align better.

Preset alignment tip:

- If proxy exits in US-West, use matching locale/timezone preset (for example `us-west`) unless intentionally testing mismatch handling.

Example env:

```bash
export PROXY_HOST='proxy.example.net'
export PROXY_PORT='8080'
export PROXY_USERNAME='user'
export PROXY_PASSWORD='pass'
```

---

## 6) Display Modes and Detection Tradeoffs

Context mode can be toggled per user with:

- `POST /sessions/:userId/toggle-display`

Supported values:

- `true` => headless
- `false` => headed
- `"virtual"` => virtual display mode

Windows x64 support is headless-only. `false` and `"virtual"` are rejected before any Xvfb/VNC process is attempted. Native headed Windows mode is not part of the verified support contract.

Linux fallback behavior:

- If headed mode is requested and no usable display exists, Xvfb virtual display is spawned.

Tradeoffs:

- Headless is resource-efficient but may differ in some target detections.
- Headed/virtual can improve realism in strict environments.
- Toggling display restarts context and invalidates existing tabs.

Debug pattern:

1. run in headless for scale
2. switch selected failing user to `virtual`
3. inspect state
4. switch back after diagnosis

---

## 7) Practical Stealth Playbooks

## A) Regional scraping with stable identity

```bash
camofox open https://target.example --geo us-west --user us-west-bot
camofox snapshot --user us-west-bot
camofox get-text --selector "main" --user us-west-bot
```

## B) Retry-safe interaction loop

```bash
camofox snapshot --user agent1
camofox click e8 --user agent1
camofox wait networkidle --timeout 12000 --user agent1
camofox snapshot --user agent1
```

## C) API-driven macro navigation + extract

```bash
curl -X POST http://localhost:9377/tabs/<tabId>/navigate \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","macro":"@google_search","query":"camoufox anti detection"}'

curl -X GET "http://localhost:9377/tabs/<tabId>/links?userId=agent1&limit=100"
```

Additional extraction routes for stealth workflows:

- `POST /tabs/:tabId/extract-resources`
- `POST /tabs/:tabId/batch-download`
- `POST /tabs/:tabId/resolve-blobs`

Use these instead of aggressive direct DOM scraping loops when possible.

---

## 8) Configuration Checklist

Baseline env:

```bash
export CAMOFOX_HEADLESS=virtual
export CAMOFOX_MAX_SESSIONS=20
export MAX_CONCURRENT_PER_USER=3
export CAMOFOX_MAX_SNAPSHOT_CHARS=80000
```

Optional hardened env:

```bash
export CAMOFOX_API_KEY='<strong-random-key>'
export CAMOFOX_ADMIN_KEY='<strong-random-admin-key>'
```

Proxy env (optional):

```bash
export PROXY_HOST='proxy.example.net'
export PROXY_PORT='8080'
export PROXY_USERNAME='user'
export PROXY_PASSWORD='pass'
```

Runtime checks:

```bash
camofox health --format json
curl http://localhost:9377/health
```

---

## 9) Known Limits

- Detection bypass is probabilistic; no engine/tool guarantees universal bypass.
- Aggressive behavior (high-frequency clicks/navigations) can still trigger anti-bot systems.
- Plugin-defined capabilities may exceed currently wired routes (for example transcript call path mismatch).
- Display mode toggles invalidate tabs, so stale `tabId` reuse can appear as false-positive stealth failure.

---

## Final Notes

- Camofox-browser anti-detection quality depends on both Camoufox engine behavior and operational discipline (stable `userId`, proxy consistency, low-noise interaction patterns).
- Avoid introducing fragile JS anti-detection patches unless absolutely necessary; they are intentionally not the primary model here.
