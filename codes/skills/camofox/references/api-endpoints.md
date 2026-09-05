# Camofox API Endpoints (Core Routes)

Complete core route reference from:

- `src/routes/core.ts`

Related:

- `../SKILL.md`
- `./cli-commands.md`

Source of truth for the route catalog below: the live handlers in `src/routes/core.ts`

## OpenAPI Documentation

The API is documented using OpenAPI 3.1.0 with interactive documentation:

- **Interactive API Docs**: `GET /api/docs` — Swagger UI for exploring and testing API endpoints
- **OpenAPI Spec**: `GET /openapi.json` — Machine-readable OpenAPI 3.1.0 specification

The OpenAPI spec provides:

- Request/response schemas with validation rules
- Authentication requirements (bearer auth)
- Representative coverage of core endpoints
- Live request testing via Swagger UI

The docs routes live in `src/routes/docs.ts` and sit outside the core route catalog below. Use `/api/docs` when you need interactive API exploration or detailed request/response examples.

## Table of Contents

1. Core Routes (`core.ts`)
2. Endpoint Notes
3. Auth & Security Notes
4. `userId` Requirement Matrix
5. End-to-End API Flows

---

## 1) Core Routes (`core.ts`) — 47

Base URL: `http://localhost:9377`

## Cookie endpoints

### 1. `POST /sessions/:userId/cookies`

Import cookies into user context.

Body:

```json
{
    "cookies": [
        /* Cookie objects */
    ],
    "tabId": "optional-tab-id"
}
```

Response: `{ ok: true, userId, count }`
Notes:

- Validates array size and cookie shape
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 2. `GET /tabs/:tabId/cookies?userId=...`

Export cookies from tab context.
Response: `Cookie[]`
Auth: bearer required when `CAMOFOX_API_KEY` is set

## Health/presets/tab lifecycle

### 3. `GET /health`

Service health and pool metadata.

### 4. `GET /presets`

Returns available geo presets.

### 5. `POST /tabs`

Create tab.

Body:

```json
{
    "userId": "agent1",
    "sessionKey": "default",
    "listItemId": "optional-legacy",
    "url": "https://example.com",
    "preset": "japan",
    "locale": "ja-JP",
    "timezoneId": "Asia/Tokyo",
    "geolocation": { "latitude": 35.6895, "longitude": 139.6917 },
    "viewport": { "width": 1280, "height": 720 }
}
```

Response: `{ tabId, url }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 6. `GET /tabs?userId=...`

List tabs for user.
Response: `{ running: true, tabs: [...] }`

## Navigation and interaction

### 7. `POST /tabs/:tabId/navigate`

Body: `{ userId, url }` or `{ userId, macro, query }`
Response: `{ ok: true, url }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 8. `GET /tabs/:tabId/snapshot?userId=...`

Accessibility snapshot.
Response includes snapshot text and refs metadata.

### 9. `POST /tabs/:tabId/wait`

Body: `{ userId, timeout?, waitForNetwork? }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 10. `POST /tabs/:tabId/click`

Body: `{ userId, ref? , selector? }`
Response may include recent downloads metadata when click triggers download.
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 11. `POST /tabs/:tabId/type`

Body: `{ userId, ref?, selector?, text }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 12. `POST /tabs/:tabId/press`

Body: `{ userId, key }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 13. `POST /tabs/:tabId/scroll`

Body: `{ userId, direction?: "up"|"down"|"left"|"right", amount?: number }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 14. `POST /tabs/:tabId/scroll-element`

Body:

```json
{
    "userId": "agent1",
    "selector": "optional",
    "ref": "optional",
    "deltaX": 0,
    "deltaY": 400,
    "scrollTo": { "top": 1200, "left": 0 }
}
```

Auth: bearer required when `CAMOFOX_API_KEY` is set

### 15. `POST /tabs/:tabId/evaluate`

Body: `{ userId, expression, timeout? }`
Limits:

- JSON body limit `64kb`
- Expression length max `65536`
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 16. `POST /tabs/:tabId/evaluate-extended`

Body: `{ userId, expression, timeout? }`
Extended behavior:

- Timeout range `100..300000` ms
- Rate limited per user
- 64KB expression limit
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 17. `POST /tabs/:tabId/back`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 18. `POST /tabs/:tabId/forward`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 19. `POST /tabs/:tabId/refresh`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

## Console & Error Capture

### 20. `GET /tabs/:tabId/console`

Query:

- `userId` (required)
- optional `type`, `limit`
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 21. `GET /tabs/:tabId/errors`

Query:

- `userId` (required)
- optional `limit`
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 22. `POST /tabs/:tabId/console/clear`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

## Tracing

### 23. `POST /tabs/:tabId/trace/start`

Body: `{ userId, screenshots?, snapshots? }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 24. `POST /tabs/:tabId/trace/stop`

Body: `{ userId, path? }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 25. `POST /tabs/:tabId/trace/chunk/start`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 26. `POST /tabs/:tabId/trace/chunk/stop`

Body: `{ userId, path? }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 27. `GET /tabs/:tabId/trace/status`

Query: `userId`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 28. `GET /sessions/:userId/traces`

Lists managed trace ZIPs for a user.
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 29. `GET /sessions/:userId/traces/:filename`

Downloads a managed trace ZIP for a user.
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 30. `DELETE /sessions/:userId/traces/:filename`

Deletes a managed trace ZIP for a user.
Auth: bearer required when `CAMOFOX_API_KEY` is set

## Extraction and stats

### 31. `GET /tabs/:tabId/links`

Query:

- `userId` (required)
- `limit`, `offset`
- `scope`, `extension`, `downloadOnly`

### 32. `GET /tabs/:tabId/screenshot`

Query: `userId`, optional `fullPage=true`
Returns PNG bytes.

### 33. `GET /tabs/:tabId/images`

Query:

- `userId` (required)
- optional `selector`, `extensions`, `resolveBlobs`, `triggerLazyLoad`
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 34. `GET /tabs/:tabId/stats`

Query: `userId`
Response includes `visitedUrls`, `toolCalls`, `refsCount`.

## Tab/session deletion

### 35. `DELETE /tabs/:tabId`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 36. `DELETE /tabs/group/:listItemId`

Body: `{ userId }`
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 37. `DELETE /sessions/:userId`

Closes all sessions and cleans downloads for user.
Auth: bearer required when `CAMOFOX_API_KEY` is set

### 38. `POST /sessions/:userId/toggle-display`

Body: `{ headless: true|false|"virtual" }`
Notes:

- Restarts user context
- Existing tabs become invalid
- Can return `vncUrl` in non-headless modes
- Windows x64 supports `headless: true` only; `false` and `"virtual"` return HTTP 400 before Linux-only Xvfb/VNC processes are attempted
  Auth: bearer required when `CAMOFOX_API_KEY` is set

## Download management

### 39. `GET /tabs/:tabId/downloads`

Query:

- `userId` (required)
- optional filters: `status`, `extension`, `mimeType`, `minSize`, `maxSize`, `sort`, `limit`, `offset`

### 40. `GET /users/:userId/downloads`

Optional same filters as tab download listing.

### 41. `GET /downloads/:downloadId`

Query: `userId` (required)

### 42. `GET /downloads/:downloadId/content`

Query: `userId` (required)
Streams file content if completed.

### 43. `DELETE /downloads/:downloadId`

`userId` accepted from body or query.
Auth: bearer required when `CAMOFOX_API_KEY` is set

## Resource extraction/download helpers

### 44. `POST /tabs/:tabId/extract-resources`

Body options include:

- `userId` (required)
- `selector`, `types`, `extensions`, `resolveBlobs`, `triggerLazyLoad`
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 45. `POST /tabs/:tabId/extract-structured`

Body options include:

- `userId` (required)
- `schema` (required structured extraction schema)
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 46. `POST /tabs/:tabId/batch-download`

Body:

- `userId` (required)
- plus batch download options
  Timeout allows longer-running operations (up to 300s wrapper).
  Auth: bearer required when `CAMOFOX_API_KEY` is set

### 47. `POST /tabs/:tabId/resolve-blobs`

Body:

```json
{ "userId": "agent1", "urls": ["blob:..."] }
```

Constraints:

- `urls` required array
- max 25 URLs

---

## 2) Endpoint Notes

- All tab-bound operations require matching `userId` context for tab lookup.
- `DELETE /tabs/:tabId` takes `userId` in body (not path/query requirement).
- Snapshot refs are ephemeral; reacquire after navigation or major interaction.
- Extended evaluate can return `429` (rate limit) and `408` (timeout).

Important mismatch note:

- The route `POST /youtube/transcript` is not registered.

---

## 3) Auth & Security Notes

- Bearer API key checks are conditional on `CAMOFOX_API_KEY` across protected core routes; use the per-endpoint Auth notes above as the detailed matrix.
- Session display toggle invalidates existing tabs by restarting context.

---

## 4) `userId` Requirement Matrix

`userId` usage varies by route shape (path, query, or body).

| Endpoint                                    | `userId` location |
| ------------------------------------------- | ----------------- |
| `POST /sessions/:userId/cookies`            | path (`:userId`)  |
| `GET /tabs/:tabId/cookies`                  | query             |
| `GET /health`                               | none              |
| `GET /presets`                              | none              |
| `POST /tabs`                                | body              |
| `GET /tabs`                                 | query             |
| `POST /tabs/:tabId/navigate`                | body              |
| `GET /tabs/:tabId/snapshot`                 | query             |
| `POST /tabs/:tabId/wait`                    | body              |
| `POST /tabs/:tabId/click`                   | body              |
| `POST /tabs/:tabId/type`                    | body              |
| `POST /tabs/:tabId/press`                   | body              |
| `POST /tabs/:tabId/scroll`                  | body              |
| `POST /tabs/:tabId/scroll-element`          | body              |
| `POST /tabs/:tabId/evaluate`                | body              |
| `POST /tabs/:tabId/evaluate-extended`       | body              |
| `POST /tabs/:tabId/back`                    | body              |
| `POST /tabs/:tabId/forward`                 | body              |
| `POST /tabs/:tabId/refresh`                 | body              |
| `GET /tabs/:tabId/console`                  | query             |
| `GET /tabs/:tabId/errors`                   | query             |
| `POST /tabs/:tabId/console/clear`           | body              |
| `POST /tabs/:tabId/trace/start`             | body              |
| `POST /tabs/:tabId/trace/stop`              | body              |
| `POST /tabs/:tabId/trace/chunk/start`       | body              |
| `POST /tabs/:tabId/trace/chunk/stop`        | body              |
| `GET /tabs/:tabId/trace/status`             | query             |
| `GET /sessions/:userId/traces`              | path              |
| `GET /sessions/:userId/traces/:filename`    | path              |
| `DELETE /sessions/:userId/traces/:filename` | path              |
| `GET /tabs/:tabId/links`                    | query             |
| `GET /tabs/:tabId/images`                   | query             |
| `GET /tabs/:tabId/screenshot`               | query             |
| `GET /tabs/:tabId/stats`                    | query             |
| `DELETE /tabs/:tabId`                       | body              |
| `DELETE /tabs/group/:listItemId`            | body              |
| `DELETE /sessions/:userId`                  | path              |
| `POST /sessions/:userId/toggle-display`     | path              |
| `GET /tabs/:tabId/downloads`                | query             |
| `GET /users/:userId/downloads`              | path              |
| `GET /downloads/:downloadId`                | query             |
| `GET /downloads/:downloadId/content`        | query             |
| `DELETE /downloads/:downloadId`             | body or query     |
| `POST /tabs/:tabId/extract-resources`       | body              |
| `POST /tabs/:tabId/extract-structured`      | body              |
| `POST /tabs/:tabId/batch-download`          | body              |
| `POST /tabs/:tabId/resolve-blobs`           | body              |

---

## 5) End-to-End API Flows

### Flow A: Open → Snapshot → Click

```bash
# create tab
TAB_JSON=$(curl -s -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","sessionKey":"default","url":"https://example.com"}')

# snapshot
curl -s "http://localhost:9377/tabs/<tabId>/snapshot?userId=agent1"

# click by ref
curl -s -X POST http://localhost:9377/tabs/<tabId>/click \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","ref":"e8"}'
```

### Flow B: Macro navigation

```bash
curl -X POST http://localhost:9377/tabs/<tabId>/navigate \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","macro":"@google_search","query":"camoufox browser"}'
```

### Flow C: Download inspection

```bash
curl "http://localhost:9377/users/agent1/downloads?limit=50&offset=0"
curl "http://localhost:9377/downloads/<downloadId>?userId=agent1"
curl "http://localhost:9377/downloads/<downloadId>/content?userId=agent1" -o artifact.bin
```

### Flow D: Toggle display mode for debugging

```bash
curl -X POST http://localhost:9377/sessions/agent1/toggle-display \
  -H 'Content-Type: application/json' \
  -d '{"headless":"virtual"}'
```

Post-condition:

- Existing tabs are invalidated; create/open a new tab.
