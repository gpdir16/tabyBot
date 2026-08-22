---
name: visualization
description: Deploy interactive HTML visualizations (quiz, what-if explorer, decision tree, or custom) to a live URL via Cloudflare Workers. Use when the user needs an interactive, clickable visual aid — choices, buttons, sliders, causal "if this then that" explorers, or step-by-step decision flows. Not for plain charts or static images.
---

# Interactive Visualization

Deploy single-file interactive HTML to a live HTTPS URL using **Cloudflare Workers temporary deploy** — no account, no login, no server to run. The user taps the link, it opens in Telegram's in-app browser, full interactivity.

## When to use

- **Quiz / assessment** — choices, instant feedback, score (like ChatGPT interactive widgets)
- **What-if explorer** — sliders/selections drive live causal results (like Gemini visualizations: "if X changes, Y becomes…")
- **Decision tree** — step-by-step choices leading to leaf outcomes
- **Custom** — any self-contained interactive HTML the agent writes from scratch

## Two modes

### 1. Template mode (preferred when a template fits)

Call **`viz_create`** with a `template` type and a `config` object. The tool injects your config into the template engine and writes a ready-to-deploy HTML file. You never touch HTML directly.

```
viz_create(template="quiz", config={
  title: "...",
  description: "...",
  questions: [
    { q: "...", options: ["A","B","C","D"], answer: 0, explain: "..." },
    ...
  ],
  passRatio: 0.7,
  passText: "...",
  failText: "..."
})
```

Templates available:

| template        | use case                          | config shape                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quiz`          | multiple-choice quiz with scoring | `{title, description, questions:[{q, options[], answer, explain}], passRatio, passText, failText}`                                                                                                                                                                                                                                                                   |
| `causal`        | sliders/selects → live outputs    | `{title, description, inputs:[{id, label, type:"range"\|"select", min, max, step, default, unit, options[]}], outputs:[{id, label}], evaluate:"JS function body as string"}` — select `options` can be `["단리","복리"]` (strings) or `[{v:"a",l:"A"},{v:"b",l:"B"}]` (objects). `tier` in evaluate return must be one of: `"good"`, `"warn"`, `"bad"`, `"neutral"`. |
| `decision-tree` | branching choices → leaf results  | `{title, description, start, nodes:{id:{type:"question"\|"leaf", text, choices:[{label,next}], detail}}}`                                                                                                                                                                                                                                                            |

**`causal` evaluate**: the `evaluate` field is a string of JS function body. It receives `s` (state object with input id→value), returns an object keyed by output id → `{value, tier, trace}`. Example:

```
evaluate: "const r = Math.min(0.95, 0.3 + s.hours * 0.05); return { retention: {value: Math.round(r*100)+'%', tier: r>0.7?'good':'bad', trace: 'hours=' + s.hours} };"
```

### 2. Custom mode

When no template fits, write a complete self-contained HTML file with `file_patch`:

- Inline all CSS in `<style>`, all JS in `<script>`.
- No external resources (no CDN, no fonts, no images via URL).
- Dark theme, mobile-first, touch-friendly (Telegram in-app browser).
- Keep under 5 MiB (Cloudflare Workers static asset limit).

## Deploy

After `viz_create` (or writing custom HTML), deploy with `terminal_run`:

```bash
mkdir -p /tmp/viz-deploy && cp <output-path> /tmp/viz-deploy/index.html
```

Create `wrangler.toml`:

```toml
name = "viz-<short-hash>"
compatibility_date = "2024-09-01"

[assets]
directory = "."
```

Deploy:

```bash
cd /tmp/viz-deploy && npx wrangler deploy --temporary
```

Output contains the live URL:

```
Deployed viz-xxxx triggers https://viz-xxxx.workers.dev
```

**Send that URL to the user** in your reply as a clickable link.

### Important notes

- **60-minute expiry**: unclaimed temporary deployments are deleted after 60 minutes. For conversational visual aids, temporary is exactly right.
- **Rate limits**: Cloudflare limits how quickly temporary accounts can be created. If you hit a rate limit, wait and retry.
- **Account caching**: Wrangler caches the temporary account and reuses it for subsequent `--temporary` deploys within the same session.
- **No login required**: `--temporary` explicitly bypasses all auth. If wrangler says "rerun with --temporary", add the flag.
- **`--temporary` errors if already authenticated**: If `wrangler login` was previously run, `--temporary` returns an error. In that case just use `wrangler deploy` normally.

## Workflow summary

```
viz_create(template, config) → terminal_run(wrangler deploy --temporary) → reply with URL
```

## Behavior rules

1. **Always verify the deploy succeeded** — check wrangler output for the `https://*.workers.dev` URL before telling the user it's live.
2. **Include the URL in your reply** as a clickable link: `[퀴즈 풀러 가기](https://viz-xxxx.workers.dev)`.
3. **One visualization per deploy** — don't cram multiple unrelated widgets into one HTML file.
4. **Keep config realistic** — use real content from the conversation, not placeholder text.
5. **Korean content** — if the user's language is `ko`, write UI text in Korean. The templates default to Korean UI labels.
6. **Mobile-first** — Telegram in-app browser is mobile. Tap targets ≥ 44px, no hover-only interactions, no horizontal scroll.
