---
name: todos
description: The shared todo store — the user's tasks (suggest/approve only) and your own scheduled automations. Use for tasks, reminders, recurring checks, or "tell me when X".
---

# Todos & automations

One store, two lanes:

- **The user's tasks** (`list` = `user`): you never write them directly. `todo_suggest` proposes a change; the user approves in the UI.
- **Your automations** (your list): scheduled jobs you run yourself. `todo_add` / `todo_update` / `todo_delete` / `todo_run` directly — no user approval. Every automation requires a trigger.

## Tools

- `todo_list` — the user's open todos, your automations, and pending suggestions
- `todo_add` — create your automation. `title`, `prompt`, and exactly one of `cron` / `every` / `at`
- `todo_update` — edit your automation in place (schedule, prompt, `enabled` to pause/resume)
- `todo_delete` — remove your automation by id
- `todo_run` — run it once now as a test (does not consume a one-shot)
- `todo_suggest` — propose add / edit / delete on the user's list. Waits for approval
- `todo_offer` — offer to do an existing user todo (handoff)
- `todo_withdraw` — take back your offer
- `todo_complete` — only when the user said they finished it

You can only manage automations on your own list — other bots' jobs are not yours to touch.

## Triggers (exactly one)

| Field   | Meaning                                     | Example                       |
| ------- | ------------------------------------------- | ----------------------------- |
| `cron`  | 5-field cron in the item timezone           | `30 8 * * 1-5` weekdays 08:30 |
| `every` | Interval, min 60s (`5m`, `2h`, `1d`, `60s`) | `2h`                          |
| `at`    | One-shot ISO datetime                       | `2026-09-11T08:00`            |

Set `timezone` (IANA, e.g. `Asia/Seoul`) when the clock time matters. Default is the server timezone.

Optional: `conversationId` (bot thread to post results into; defaults to the current thread), `fireImmediately`, `enabled`.

## When to add an automation

If the user asks to be told later, reminded, checked on a cadence, or notified when something changes, call `todo_add` in this turn. Do not only promise it.

Do NOT use `todo_add` when the user wants the item tracked as _their_ task in the todo list — that goes through `todo_suggest` and needs their approval.

## Handoff

If a user todo is something you can do with your tools (browse, check a site, run a job), call `todo_offer` with a short `reason` and a `prompt` you will follow when it fires. Other bots may offer too. The user picks who, if anyone, takes it. Do not offer on chores only the user can do (physical attendance, in-person errands) unless you can actually complete them.

## Silence (mandatory)

Write speak/silence rules **in the automation `prompt`**. There is no separate flag.

- Default: stay quiet unless there is something the user asked to be told.
- "Tell me when a new manga is up" → prompt says speak only when a new one appeared. On fire, if nothing is new, reply with ONLY `__SILENT__`. Do not say you looked or that the list is empty.
- "Every morning send me the list even if it's empty" → put that in the prompt so the run reports anyway.
- Persist last-seen facts in memory or a small file so later runs can tell "new" from "already told".
