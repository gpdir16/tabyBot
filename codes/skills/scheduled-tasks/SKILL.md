# Scheduled Tasks (Cron)

Use when the user wants reminders, daily briefings, or recurring agent work.

## Storage

Jobs live in `{{CRON_PATH}}` (managed via `cron_*` tools).

## Schedule syntax

Standard **5-field cron** (minute hour day month weekday), server timezone:

| Example        | Meaning            |
| -------------- | ------------------ |
| `0 9 * * *`    | Every day at 09:00 |
| `0 */6 * * *`  | Every 6 hours      |
| `30 8 * * 1-5` | Weekdays 08:30     |

## Tools

- `cron_list` — list jobs
- `cron_add` — name, schedule, prompt, chatId (use the user's Telegram chat id)
- `cron_remove` — by id
- `cron_set_enabled` — pause/resume

## Behavior

- Jobs run **only when the agent is idle**. If the user is mid-turn, the job waits in queue until that finishes.
- On fire, the agent receives the job `prompt` and may reply in the configured chat.
- If nothing needs the user (a check that passed, a skip), reply with only `__SILENT__`. Telegram stays quiet.
- After adding/removing jobs, the scheduler reloads automatically.

## Tips

- Keep prompts self-contained (include what to check, where files live).
- For one-shot reminders, prefer telling the user to use a single alarm elsewhere; cron is for **recurring** work.
