# Session Management

Session management in camofox-browser is based on `userId` isolation and a persistent context pool, not an agent-style `--session` flag.

Related:

- `../SKILL.md`
- `./api-endpoints.md`
- `./cli-commands.md`
- `./authentication.md`

Source of truth for development: `AGENTS.md`

## Table of Contents

1. Isolation model (`userId`, not `--session`)
2. Context pool and max sessions
3. CLI session commands (`save`, `load`, `list`, `delete`)
4. API session endpoints
5. Concurrent usage model
6. Cleanup behavior
7. Practical examples

---

## 1) Isolation model (`userId`, not `--session`)

For camofox-browser, identity isolation is keyed by `userId`.

- CLI commands resolve user identity through `--user <user>`
- Server APIs use `userId` in body/query/path
- Tab lookup uses both `tabId` and `userId`

Important: do **not** document or rely on `--session` for camofox-browser behavior. That belongs to agent-browser conventions, not this server/CLI pair.

```bash
camofox open "https://example.com" --user acct-a
camofox snapshot --user acct-a
```

---

## 2) Context pool and max sessions

`src/services/context-pool.ts` manages persistent Playwright contexts per user.

- Pool key: normalized `userId`
- Capacity: `CAMOFOX_MAX_SESSIONS` (default `50`)
- Overflow policy: LRU eviction of least recently used non-launching context
- Profile directory root: `{{CAMOFOX_DATA_DIR}}/profiles`; Linux/macOS retain readable default-user names and Windows uses collision-safe hashed internal keys, while unambiguous legacy Windows directories remain readable in place

Operational details:

- First request for a user creates a persistent context
- Later requests for the same user reuse that context
- If a context closes unexpectedly, it is removed and relaunched on next access
- Context options are seeded on first launch; later conflicting seed options are ignored for that active user context

---

## 3) CLI session commands (`save`, `load`, `list`, `delete`)

Implemented in `src/cli/commands/session.ts`.

### `camofox session save <name> [tabId] --user <user>`

- Reads cookies from `GET /tabs/:tabId/cookies?userId=...`
- Saves to `{{CAMOFOX_DATA_DIR}}/sessions/<name>.json` using mode `0600`
- Stores: `sessionName`, `userId`, `tabId`, `savedAt`, `cookies`

```bash
camofox session save acct-a-login --user acct-a
```

### `camofox session load <name> [tabId] --user <user>`

- Loads local session JSON
- Primary restore path: `POST /sessions/:userId/cookies`
- Legacy fallback on 404: `POST /tabs/:tabId/restore-cookies`

```bash
camofox session load acct-a-login --user acct-a
```

### `camofox session list`

- Lists saved files in `{{CAMOFOX_DATA_DIR}}/sessions`
- Returns name, file size, and modified timestamp
- Supports `--format json|text|plain`

```bash
camofox session list --format text
```

### `camofox session delete <name> [--force]`

- Deletes local saved session file
- Prompts for confirmation unless `--force`

```bash
camofox session delete acct-a-login --force
```

Session name validation: `^[a-zA-Z0-9._-]+$`

---

## 4) API session endpoints

From `src/routes/core.ts`:

- `POST /sessions/:userId/cookies`
- `GET /tabs/:tabId/cookies?userId=...`
- `DELETE /sessions/:userId`
- `POST /sessions/:userId/toggle-display`

Cookie import rules (`POST /sessions/:userId/cookies`):

- `cookies` must be an array
- max `500` cookies/request
- each cookie must include `name`, `value`, `domain`
- API key auth is enforced when `CAMOFOX_API_KEY` is set

`DELETE /sessions/:userId` closes sessions and also triggers download metadata cleanup for that user.

---

## 5) Concurrent usage model

Concurrency controls are layered:

1. Context pool cap: max sessions from `CAMOFOX_MAX_SESSIONS` (default `50`)
2. Per-user operation limit: `withUserLimit(userId, maxConcurrentPerUser, ...)`
3. Per-tab serialization: `withTabLock(tabId, ...)`

This lets multiple users run concurrently while keeping same-tab operations ordered and same-user operation pressure bounded.

---

## 6) Cleanup behavior

Cleanup happens through multiple paths:

- explicit close via `DELETE /sessions/:userId`
- LRU eviction in context pool when max contexts exceeded
- display mode toggle restart (`/sessions/:userId/toggle-display`) which invalidates existing tabs
- process shutdown (`closeAll`) cleanup

What persists by design:

- profile directories under `{{CAMOFOX_DATA_DIR}}/profiles/...`
- local saved session files until deleted

---

## 7) Practical examples

### Save and restore auth cookies

```bash
camofox open "https://app.example.com/login" --user acct-main
camofox session save acct-main-login --user acct-main

camofox open "https://app.example.com" --user acct-main
camofox session load acct-main-login --user acct-main
```

### Multi-user concurrent workflow

```bash
camofox open "https://news.ycombinator.com" --user feed-a
camofox open "https://github.com/trending" --user feed-b
```

### Explicit runtime cleanup

```bash
curl -X DELETE "http://127.0.0.1:9377/sessions/acct-main"
```

Downloads cleanup:

- Session close path calls user download cleanup helpers

---

## 9) Operational tips

### Keep identities stable

Use deterministic `userId` naming (`job-20260304-a`) to avoid accidental context sharing.

### Recreate tabs after display toggles

`toggle-display` restarts contexts, so previous `tabId`s become invalid.

### Use session save/load for cookie workflows

For auth continuity between runs:

```bash
camofox session save checkout-auth --user buyer
# later
camofox session load checkout-auth --user buyer
```

### Prefer explicit cleanup for long-running automation

```bash
curl -X DELETE "http://127.0.0.1:9377/sessions/my-bot"
```

### Know what persists where

- In-memory: live tab groups, refs, op counters
- On disk: browser profile + CLI session files

---

If you are authoring new automation features, align with these session boundaries and keep `userId` explicit in all API and CLI integration points.
