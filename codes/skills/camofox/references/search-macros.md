# Search and Macros

Camofox has two different search systems that often get mixed up: CLI search engines and API navigation macros.

Related:

- `../SKILL.md`
- `./cli-commands.md`
- `./api-endpoints.md`
- `./scripting.md`

Source of truth for development: `AGENTS.md`

## Table of Contents

1. Two separate systems
2. CLI search (`camofox search`) — 8 engines
3. API macros (`@macro query`) — 14 macros
4. CLI-only vs API-only vs both
5. Examples
6. Common pitfalls

---

## 1) Two separate systems

### System A: CLI search

- Implemented in `src/cli/commands/content.ts`
- Command shape: `camofox search "query" --engine <engine> [tabId] --user <user>`
- Engine list is fixed to 8 values

### System B: API macros

- Defined in `src/utils/macros.ts`
- Used through navigation APIs (`/tabs/:tabId/navigate`) with `macro` + `query`
- Pattern: navigate to `@google_search query` (resolved to URL server-side)

---

## 2) CLI search (`camofox search`) — 8 engines

Supported CLI `--engine` values:

1. `google`
2. `youtube`
3. `amazon`
4. `bing`
5. `reddit`
6. `duckduckgo`
7. `github`
8. `stackoverflow`

Example:

```bash
camofox search "playwright intercept response" --engine google --user research
```

---

## 3) API macros (`@macro query`) — 14 macros

From `src/utils/macros.ts`:

1. `@google_search`
2. `@youtube_search`
3. `@amazon_search`
4. `@reddit_search`
5. `@reddit_subreddit`
6. `@wikipedia_search`
7. `@twitter_search`
8. `@yelp_search`
9. `@spotify_search`
10. `@netflix_search`
11. `@linkedin_search`
12. `@instagram_search`
13. `@tiktok_search`
14. `@twitch_search`

Example API call using macro + query:

```bash
curl -sS -X POST "http://127.0.0.1:9377/tabs/$TAB_ID/navigate" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "research",
    "macro": "@google_search",
    "query": "camoufox launch options"
  }'
```

---

## 4) CLI-only vs API-only vs both

| Target        | CLI search engine | API macro                             | Classification |
| ------------- | ----------------- | ------------------------------------- | -------------- |
| Google        | `google`          | `@google_search`                      | both           |
| YouTube       | `youtube`         | `@youtube_search`                     | both           |
| Amazon        | `amazon`          | `@amazon_search`                      | both           |
| Reddit        | `reddit`          | `@reddit_search`, `@reddit_subreddit` | both           |
| Bing          | `bing`            | —                                     | CLI-only       |
| DuckDuckGo    | `duckduckgo`      | —                                     | CLI-only       |
| GitHub        | `github`          | —                                     | CLI-only       |
| StackOverflow | `stackoverflow`   | —                                     | CLI-only       |
| Wikipedia     | —                 | `@wikipedia_search`                   | API-only       |
| Twitter/X     | —                 | `@twitter_search`                     | API-only       |
| Yelp          | —                 | `@yelp_search`                        | API-only       |
| Spotify       | —                 | `@spotify_search`                     | API-only       |
| Netflix       | —                 | `@netflix_search`                     | API-only       |
| LinkedIn      | —                 | `@linkedin_search`                    | API-only       |
| Instagram     | —                 | `@instagram_search`                   | API-only       |
| TikTok        | —                 | `@tiktok_search`                      | API-only       |
| Twitch        | —                 | `@twitch_search`                      | API-only       |

---

## 5) Examples

### CLI search with explicit engine

```bash
camofox search "typescript union narrowing" --engine stackoverflow --user research
```

### CLI search on existing tab

```bash
TAB_ID="$(camofox open "https://example.com" --user research --format plain)"
camofox search "web scraping legal basics" "$TAB_ID" --engine duckduckgo --user research
```

### API macro navigation

```bash
curl -sS -X POST "http://127.0.0.1:9377/tabs/$TAB_ID/navigate" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "research",
    "macro": "@reddit_subreddit",
    "query": "machinelearning"
  }'
```

---

## 6) Common pitfalls

- `camofox search` does not accept macro names like `@google_search`.
- Macro coverage is larger than CLI engine coverage.
- CLI `reddit` and API `@reddit_search` are not identical URLs (`/search` vs `/search.json`).
- If macro expansion fails, `/tabs/:tabId/navigate` can still use direct `url` when provided.

---

## 7) Raw HTTP search (no browser)

When only quick result links/snippets are needed — e.g. finding a URL before opening it — DuckDuckGo's HTML endpoint works over plain `curl` in `terminal_run`, no browser tab:

```bash
curl -sS -A "Mozilla/5.0" "https://html.duckduckgo.com/html/?q=<urlencoded query>"
```

Prefer this over Google scraping (consent walls/bot blocks). For interactive browsing or result clicking, use `camofox search --engine duckduckgo` instead.
