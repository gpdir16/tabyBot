---
name: browser
description: Browse the web with your own persistent stealth browser through the browser_* tools. Use for reading pages, searching, filling forms, logging in, downloads, and getting past Cloudflare checks.
---

# Browser

You have your own browser profile. Cookies and logins persist across sessions, and in Docker the user can watch it live in the computer view. Drive it only through the `browser_*` tools.

## Tools

- `browser_open`: open a URL in a new tab. Returns `tab_id`, url, title, and a snapshot
- `browser_navigate`: go to a URL, or `back` / `forward` / `reload`, in the current tab
- `browser_snapshot`: read the page as an accessibility tree with refs (`[e12]`), paged by `offset`
- `browser_click`: click a ref or CSS selector; or x and y from a screenshot with the real mouse; or `target: "turnstile"`
- `browser_type`: type into an input (replaces its value); `submit: true` presses Enter after
- `browser_press`: press a key (Enter, Escape, Tab, ArrowDown, Control+a)
- `browser_scroll`: scroll the page, or inside a scrollable element with `ref` / `selector`
- `browser_screenshot`: look at the tab as an image
- `browser_wait`: wait until a selector exists or text appears
- `browser_eval`: run JavaScript in the page and get the value
- `browser_tabs`: list your tabs; `close` closes the ones you pass

`tab_id` is optional everywhere. Without it, the tool uses the tab you used last.

## The loop

1. `browser_open` the first page. For the next page in the same task, `browser_navigate` the same tab instead of opening another.
2. Read the snapshot in the result and pick the element by its ref.
3. Act with `browser_click`, `browser_type`, `browser_press`, or `browser_scroll`. The result already holds the new url, title, and snapshot. Do not call `browser_snapshot` just to check what happened.
4. Repeat. Refs are renumbered whenever the page changes, so use refs from the latest result only.

## Waiting

- Every tool that can change the page waits until it is ready (up to 10 seconds) before it returns. Never add sleeps.
- When content arrives later than that (search results, chat replies, infinite lists, a "processing" screen), call `browser_wait` with a selector or text you expect, instead of polling the snapshot.

## Reading

- A result snapshot holds the first 6000 characters. When it says it was truncated, call `browser_snapshot` with the `offset` it gives.
- For structured data (tables, lists of links, prices), `browser_eval` an expression that returns JSON, e.g. `[...document.querySelectorAll("h3")].map((h) => h.innerText)`. Keep it to reading. Click and type with refs, since those act like a person and fire the page's own events.
- The snapshot does not show images, canvas, cross-origin iframes, or overlays. When a click "succeeds" but nothing changes, a button stays disabled, or the page needs visual judgment, use `browser_screenshot`.

## Targets refs cannot reach

- Checkboxes and buttons inside cross-origin iframes (CAPTCHA, payment, and login widgets), closed shadow roots, and canvas: take `browser_screenshot`, then `browser_click` with x and y in pixels from that image. A real mouse clicks there and a new screenshot comes back. This needs the Docker display.
- Cloudflare "Verify you are human" or "Performing security verification": call `browser_click` with `target: "turnstile"` and no coordinates right away. One click usually passes. If it has not, `browser_wait` for a few seconds on text from the real page, or take a screenshot, before clicking again.

## Logins

- The profile keeps its cookies, so check whether you are already logged in before typing a password.
- Type stored secrets as placeholders: `browser_type` with `text: "{{secret:ID}}"`. The runtime fills in the value; results show the placeholder again.

## Search

- Open a search engine with the query in the URL, e.g. `browser_open` `https://duckduckgo.com/?q=<urlencoded query>`, then click a result by ref.
- When you only need result links or snippets, the HTML endpoint works without a tab: `terminal_run` `curl -sS -A "Mozilla/5.0" "https://html.duckduckgo.com/html/?q=<urlencoded query>"`. Prefer DuckDuckGo over scraping Google, which shows consent walls and bot blocks.

## Downloads

A click that starts a download lists it under `downloads` in the result, with `download_folder`. The file appears in that folder when the download finishes.

## Closing tabs

- Every open tab keeps using memory and CPU, even in the background. When a task is done, close the tabs it opened with `browser_tabs` and `close` before your final reply.
- Keep a tab only when unfinished work will come back to it (a half-filled form, a login waiting for a code) or the user asked to keep it open.
- Closing a tab does not log you out. Cookies and logins stay in the profile.

## Errors

- "Tab ... is not open": the tab was closed. The error lists the open tabs; pick one or `browser_open` again.
- "Unknown ref": the page changed after the snapshot you used. Use refs from the latest result.
