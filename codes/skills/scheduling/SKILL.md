---
name: scheduling
description: Create and manage scheduling jobs (reminders, recurring checks, tell-me-when). Use when the user wants to be notified later, on a clock, on an interval, or when something changes.
---

# Scheduling

Use when the user wants reminders, daily briefings, recurring checks, or "tell me when X happens".

## Storage

Jobs live in `{{SCHEDULING_PATH}}` (managed via `schedule_*` tools).

## When to create a job

If the user asks to be told later, reminded, checked on a cadence, or notified when something changes, call `schedule_create` in this turn. Do not only promise it.

## Schedule (exactly one)

| Field   | Meaning                                     | Example                       |
| ------- | ------------------------------------------- | ----------------------------- |
| `cron`  | 5-field cron in the job timezone            | `30 8 * * 1-5` weekdays 08:30 |
| `every` | Interval, min 60s (`5m`, `2h`, `1d`, `60s`) | `2h`                          |
| `at`    | One-shot ISO datetime                       | `2026-09-11T08:00`            |

Set `timezone` (IANA, e.g. `Asia/Seoul`) when the clock time matters. Default is the server timezone.

## Tools

- `schedule_list` — jobs, next run, last run, recent history
- `schedule_create` — name, prompt, cron/every/at, timezone, conversationId, fireImmediately
- `schedule_update` — change any field in place (pause with `enabled: false`)
- `schedule_delete` — by id
- `schedule_run` — test run now (does not consume a one-shot)

Default `conversationId` is the current conversation. Results post there.

## Silence (mandatory)

Write speak/silence rules **in the job `prompt`**. There is no separate flag.

- Default: stay quiet unless there is something the user asked to be told.
- "Tell me when a new manga is up" → prompt says speak only when a new one appeared. On fire, if nothing is new, reply with ONLY `__SILENT__`. Do not say you looked or that the list is empty.
- "Every morning send me the list even if it's empty" → put that in the prompt so the run reports anyway.
- Persist last-seen facts in memory or a small file so later runs can tell "new" from "already told".
