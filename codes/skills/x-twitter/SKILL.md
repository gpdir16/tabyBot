---
name: x-twitter
description: Fetch X/Twitter posts, threads, replies, profiles, and search results via the FxTwitter (FxEmbed) API and mirror domains. Use whenever an x.com or twitter.com link appears, or the user asks about X/Twitter content — direct scraping of x.com hits login walls and blocks.
---

# X / Twitter access

Direct scraping of `x.com` / `twitter.com` fails (login walls, blocks). Two working paths, in order:

1. **FxTwitter REST API** (preferred) — unofficial JSON API, no auth, read-only. Base: `https://api.fxtwitter.com`
2. **Mirror domains** — for full-page rendering or when the API is down

Call endpoints with `terminal_run` + `curl` (or Python `httpx`/`urllib`).

## API rules

- GET only. No API key, no login, no cookies — guest public data only.
- Always send a `User-Agent` (e.g. `-A "tabyBot/1.0"`). Empty UA gets blocked.
- Timeout 20s. Retry only on `429` / `502` / `503`, max 3 tries, backoff 1s → 2s → 4s.
- **Every response JSON has a `code` field — check `code === 200`, not just the HTTP status.** HTTP 200 with `code !== 200` is a failure.
- ~1000 req/min per IP on paper; search gets throttled much earlier.
- Public posts only — protected/suspended accounts and deleted posts return 401/404.
- `fxtwitter.com` the website is deprecated/gone; the `api.fxtwitter.com` subdomain still works.

## Extract the tweet id

Supported inputs: bare numeric id, or a status URL on `x.com`, `twitter.com`, `fxtwitter.com`, `fixupx.com`, `twittpr.com`.

```
(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|twittpr\.com)/[^/]+/status/(\d+)
```

Capture group 1 is the `tweet_id`. The handle is not needed for lookups.

## Endpoints

| Need                                | Call                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| Single post + metrics               | `GET /2/status/{id}`                                      |
| Author's thread (upward self-chain) | `GET /2/thread/{id}`                                      |
| Thread + other users' replies       | `GET /2/conversation/{id}?ranking_mode=likes\|recency`    |
| Keyword search                      | `GET /2/search?q=...&feed=latest\|top\|media&count=1-100` |
| Profile                             | `GET /2/profile/{handle}` — `handle` or `id:<numeric>`    |
| User timeline                       | `GET /2/profile/{handle}/statuses?count=&cursor=`         |
| User media only                     | `GET /2/profile/{handle}/media`                           |
| Quotes / reposting users            | `GET /2/status/{id}/quotes` · `/2/status/{id}/reposts`    |

Common query params: `lang` (translation target, e.g. `ko`), `cursor` (from prior `cursor.bottom`), `count` (1–100), `about_account=1`.

```bash
curl -sS -A "tabyBot/1.0" "https://api.fxtwitter.com/2/status/1548602399862013953?lang=ko"
curl -sS -A "tabyBot/1.0" "https://api.fxtwitter.com/2/search?q=from%3Aelonmusk&feed=latest&count=20"
curl -sS -A "tabyBot/1.0" "https://api.fxtwitter.com/2/conversation/1548602399862013953?ranking_mode=recency"
curl -sS -A "tabyBot/1.0" "https://api.fxtwitter.com/2/profile/elonmusk"
```

Success is `code: 200` plus the root key (`status` / `results` / `user`).

### Useful `status` fields

`id`, `url`, `text`, `created_at`, `created_timestamp`, `likes`, `reposts`, `quotes`, `replies`, `views` (may be null), `lang`, `author.{name,screen_name,avatar_url}`, `replying_to`, `quote` (or tombstone), `poll`, `media.photos[]`, `media.videos[]`, `article` (X Articles).

### Pagination & search notes

- `cursor.bottom` present → same path + `?cursor=`. Null/empty → done. Keep to ~5 pages max.
- `/2/conversation` page 2+ can return HTTP 404 — known bug; return what was collected and stop.
- Search `q` accepts X web operators (`from:`, `#tag`, `"exact phrase"`, `min_faves:`, `since:`) — best-effort, not guaranteed.
- Search is recent/popular results, **not** a full archive. It fails more than single-post lookups: on `502` / `search_unavailable` say the search upstream failed, and fall back to `/2/status/{id}` if a URL/id is known.
- User timeline extras: `with_replies` (truthy), `groupthreads`, `since` (unix ts; 204 = nothing new).
- Default to one page (~20 items); fetch more only if the user asks.

## Routing

| User input                         | Endpoint                                                          |
| ---------------------------------- | ----------------------------------------------------------------- |
| URL or numeric id                  | `/2/status/{id}`                                                  |
| "thread / 타래 / 스레드"           | `/2/thread/{id}`, then `/2/conversation` if replies needed        |
| "replies / 답글 / 댓글"            | `/2/conversation/{id}` (`ranking_mode=recency` for chronological) |
| "search / 찾아 / 최근글" + keyword | `/2/search`                                                       |
| `@handle` or "profile / 프로필"    | `/2/profile/{handle}`                                             |
| "their posts / 그 계정 글"         | `/2/profile/{handle}/statuses`                                    |

## Mirror domains (fallback / page view)

When the API can't help (need the rendered page, media embed, or API down), rewrite the host instead of browser-automating x.com:

- `x.com` → `fixupx.com` (or `xfixup.com`)
- `twitter.com` → `twittpr.com`
- Further fallbacks: `fixvx.com`, `yt-dlp`, or `camofox` on a mirror page — try the next when one 404s/blocks.

## Don'ts

- Never mix official `api.x.com` schemas with this API.
- Never mix the legacy `/{handle}/status/{id}` form (root key `tweet`) with v2 `/2/...` (root key `status`) — use v2 only.
- No bulk search crawling; no cookies or account credentials — this API only serves guest-public data.
- Don't report success on `code !== 200` even when HTTP is 200.

## Error mapping

| code/HTTP   | meaning               |
| ----------- | --------------------- |
| 400         | bad request           |
| 401         | private or restricted |
| 404         | not found             |
| 429         | rate limited          |
| 500/502/503 | upstream error        |

## Limits — relay honestly to the user

- Unofficial proxy; can break or shut down without notice.
- Search is not a full archive; replies may be partial.
- Protected accounts and deleted posts are unreachable.
