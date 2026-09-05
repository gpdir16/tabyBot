# Snapshot Refs (`[eN]`) and Pagination

How Camofox assigns, uses, and invalidates element refs in accessibility snapshots.

Related:

- `../SKILL.md`
- `./api-endpoints.md`

Source of truth: `AGENTS.md`

## Table of Contents

1. Overview
2. Ref Format (`eN`, not `@eN`)
3. How Refs Are Assigned
4. Ref Lifecycle and Invalidation
5. Interaction Rules (Always Re-snapshot)
6. CSS Selector Fallback
7. Snapshot Pagination (`offset`, `nextOffset`)
8. Compact vs Full Output
9. Examples

---

## 1) Overview

Camofox snapshots are accessibility-tree based. Interactive nodes are labeled with short refs like `e1`, `e2`, `e3` that can be used in actions such as click/type.

Important conventions:

- Ref prefix is `e` (example: `e7`)
- Do **not** use `@e7` syntax
- Refs are ephemeral and tied to the current DOM/accessibility tree state

---

## 2) Ref Format (`[eN]`, not `@eN`)

Ref IDs are generated as:

- `e1`, `e2`, `e3`, ...

In snapshots, refs are shown in brackets beside annotated interactive nodes:

- `- button "Sign in" [e1]`
- `- textbox "Email" [e2]`

This differs from ecosystems that annotate as `@eN`. In camofox-browser, use plain `eN` in:

- CLI commands (`camofox click e5`)
- API payloads (`{ "ref": "e5" }`)

---

## 3) How Refs Are Assigned

Implementation path:

- `src/services/tab.ts` → `buildRefs(...)`

Assignment model:

1. Capture accessibility snapshot via Playwright `ariaSnapshot()` from `body`
2. Parse lines in order
3. Keep only interactive roles (`button`, `link`, `textbox`, `checkbox`, ...)
4. Skip problematic patterns/roles (for example `combobox`, date/calendar/picker patterns)
5. Assign refs sequentially in discovery order (`e1`, `e2`, ...)
6. Track duplicates by role+name occurrence (`nth`) so refs map stably within that snapshot

Practical consequence:

- Ref numbering is positional and snapshot-specific, not a durable element ID.

---

## 4) Ref Lifecycle and Invalidation

Refs are invalidated whenever the interactive tree changes meaningfully, including:

- Navigation (`navigate`, `back`, `forward`, `refresh`)
- Clicks that mutate DOM/layout
- Form submit/route transitions
- Modal open/close or hydration changes

In code paths, refs are rebuilt after many operations. Error text explicitly warns:

- "Refs reset after navigation - call snapshot first."

---

## 5) Interaction Rules (Always Re-snapshot)

Safe workflow:

1. `snapshot`
2. choose `eN`
3. action (`click`/`type`/...)
4. `snapshot` again

Do not chain many `eN` interactions from an old snapshot after page state changes.

---

## 6) CSS Selector Fallback

Most action endpoints accept either:

- `ref` (preferred for robust, model-readable actions), or
- `selector` (CSS fallback)

Use selector fallback when:

- A needed element is not assigned a ref
- Ref set changed unexpectedly
- You need highly specific targeting (e.g. nth-child or data attribute)

Examples:

- `POST /tabs/:tabId/click` with `{ "ref": "e8" }` or `{ "selector": "#submit" }`
- `POST /tabs/:tabId/type` with `{ "ref": "e3", "text": "..." }`

---

## 7) Snapshot Pagination (`offset`, `nextOffset`)

Large snapshots can be windowed using `src/utils/snapshot.ts`:

- `windowSnapshot(yaml, offset, maxChars, tailChars)`

Behavior:

- `offset=0`: returns head chunk + preserved tail section
- `offset>0`: returns a middle window from that character offset
- Tail is always appended so pagination/navigation links remain visible
- Returns metadata: `truncated`, `totalChars`, `hasMore`, `nextOffset`

Meaning of fields:

- `offset`: effective window start used
- `hasMore=true`: more snapshot text remains
- `nextOffset`: pass this value in the next request/window call

Typical loop:

1. request snapshot with `offset=0`
2. if `hasMore`, request with returned `nextOffset`
3. repeat until `hasMore=false`

---

## 8) Compact vs Full Output

Two practical output modes are common in clients/tooling:

- **Full output**
    - Full annotated snapshot body + metadata
    - Best for detailed extraction or debugging

- **Compact output**
    - Metadata plus a shorter/selected view
    - Best for quick agent loops and lower token usage

In either mode, refs remain `eN` (annotated as `[eN]` in snapshot lines) and pagination metadata (`offset`, `nextOffset`, `hasMore`) should be preserved when available.

---

## 9) Examples

### CLI action loop (recommended)

```bash
camofox open https://example.com --user demo
camofox snapshot --user demo
camofox click e4 --user demo
camofox snapshot --user demo
```

### API snapshot + click

```bash
curl "http://localhost:9377/tabs/$TAB_ID/snapshot?userId=demo"

curl -X POST "http://localhost:9377/tabs/$TAB_ID/click" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","ref":"e4"}'
```

### Selector fallback

```bash
curl -X POST "http://localhost:9377/tabs/$TAB_ID/type" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","selector":"input[name=q]","text":"playwright"}'
```

### Pagination concept (window utility)

```text
Response 1: { truncated: true, hasMore: true, nextOffset: 75000 }
Response 2: request with offset=75000
...
```
