# Media Extraction, Batch Download, and YouTube Transcript

Source-verified reference for extraction and download tooling in camofox-browser.

Related:

- `../SKILL.md`
- `./api-endpoints.md`

Source of truth: `AGENTS.md`

## Table of Contents

1. Overview
2. YouTube Transcript Extraction
3. Resource Extraction Endpoint
4. Batch Download Concurrency Model
5. Blob Resolution Endpoint
6. CLI `camofox download` Status
7. Cookie Export/Import for Authenticated Downloads
8. Examples

---

## 1) Overview

Media workflows in this repository are split into:

- transcript extraction logic (`src/services/youtube.ts`)
- scoped DOM resource extraction (`src/services/resource-extractor.ts`)
- concurrent batch downloading (`src/services/batch-downloader.ts`)
- routes in `src/routes/core.ts`

---

## 2) YouTube Transcript Extraction

Implementation: `src/services/youtube.ts`

Pipeline:

1. Validate/normalize YouTube URL and language
2. Try `yt-dlp` first when available
3. Fallback to browser capture of timedtext responses

### Primary mode: `yt-dlp`

Service behavior:

- probes known binary paths (`yt-dlp`, `/usr/local/bin/yt-dlp`, `/usr/bin/yt-dlp`)
- requests subtitles (`--write-sub`, `--write-auto-sub`)
- supports subtitle formats (`json3`, `vtt`, `srv3`)
- parses transcript into normalized plain text

### Fallback mode: browser transcript capture

When `yt-dlp` is unavailable or fails, browser mode can:

- open video in internal context
- observe `/api/timedtext` responses
- parse transcript body

### Availability note (important)

Server routes currently do **not** register a public transcript endpoint:

- no `POST /youtube/transcript` route in `src/routes/core.ts`

Result:

- There is **no public server API route** for transcript extraction at this time.

---

## 3) Resource Extraction Endpoint

Registered endpoint:

- `POST /tabs/:tabId/extract-resources`

Body options:

- `userId` (required)
- `selector` (default: `body`)
- `types` (`images`, `links`, `media`, `documents`)
- `extensions` filter list
- `resolveBlobs` (resolve blob URLs to data URLs)
- `triggerLazyLoad` (attempt to trigger lazy media)

Extraction behavior highlights:

- normalizes URL types (`http`, `https`, `blob`, `data`)
- captures metadata (filename, mime, dimensions, alt/text)
- tracks blob URLs for optional resolution
- returns grouped resources + totals + extraction metadata

---

## 4) Batch Download Concurrency Model

Service implementation:

- `src/services/batch-downloader.ts`

Concurrency mechanism:

- internal semaphore (`createSemaphore(max)`)
- bounded parallel processing of candidate resources
- configurable concurrency (`config.maxBatchConcurrency` + request override)

Route wiring:

- active route: `POST /tabs/:tabId/batch-download`

Also referenced in planning/integration discussions as:

- `POST /downloads/batch` (concept alias)

In this codebase’s route registration, the tab-scoped endpoint is the one currently exposed.

Supported resource sources:

- `http(s)` resources via request context fetch
- `blob:` URLs (requires `resolveBlobs=true`)
- `data:` URIs

Safety limits:

- max files per batch
- max download size
- max blob/data URI size
- per-item status tracking (`pending` → `completed`/`failed`)

---

## 5) Blob Resolution Endpoint

Registered endpoint:

- `POST /tabs/:tabId/resolve-blobs`

Request:

```json
{ "userId": "agent1", "urls": ["blob:..."] }
```

Constraints:

- `urls` must be array
- maximum 25 entries per request

Response shape:

- per-url resolution result
- resolved payload includes data URL/base64 + mime type

Use this when extracted resources include non-fetchable `blob:` links.

---

## 6) CLI `camofox download` Status

CLI command exists:

- `camofox download [url] [--path <dir>] [--user <user>]`

Current status:

- stub/placeholder command
- prints guidance message
- does not execute direct download flow in current CLI/server wiring

Use instead:

- `camofox downloads` for listing tracked downloads
- API batch endpoint for actual extraction+download workflow

---

## 7) Cookie Export/Import for Authenticated Downloads

Authenticated media extraction often requires a logged-in browser context.

Supported endpoints:

- import cookies: `POST /sessions/:userId/cookies`
- export cookies: `GET /tabs/:tabId/cookies?userId=...`

CLI helpers:

- `camofox cookie import <file> [tabId] --user <user>`
- `camofox cookie export [tabId] --path <file> --user <user>`

Typical auth workflow:

1. import login cookies
2. navigate/auth-check on protected page
3. extract resources
4. run batch download in same `userId` context

---

## 8) Examples

### A) Extract resources from product gallery

```bash
curl -X POST "http://localhost:9377/tabs/$TAB_ID/extract-resources" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "demo",
    "selector": "main",
    "types": ["images","media","documents"],
    "triggerLazyLoad": true
  }'
```

### B) Batch download extracted assets

```bash
curl -X POST "http://localhost:9377/tabs/$TAB_ID/batch-download" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "demo",
    "selector": "main",
    "types": ["images","documents"],
    "concurrency": 4,
    "maxFiles": 50,
    "resolveBlobs": true
  }'
```

### C) Resolve blobs explicitly

```bash
curl -X POST "http://localhost:9377/tabs/$TAB_ID/resolve-blobs" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","urls":["blob:https://site/..." ]}'
```

### D) Cookie bootstrap before protected downloads

```bash
camofox cookie import ./cookies.json --user demo
camofox open https://example.com/protected --user demo
camofox snapshot --user demo
```
