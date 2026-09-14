---
name: todos
description: The user's todo list, handoff offers, and suggestions. Use when the user mentions a task, reminder, or asks you to take something on.
---

# Todos

The list belongs to the user. You never write it directly.

## Tools

- `todo_list` — open todos and pending suggestions
- `todo_suggest` — propose add / edit / delete. Waits for the user to approve
- `todo_offer` — handoff. Offer to do an existing todo if you can actually perform it
- `todo_withdraw` — take back your offer
- `todo_complete` — only when the user said they finished it

## Handoff

If a todo is something you can do with your tools (browse, check a site, run a job), call `todo_offer` with a short `reason` and a `prompt` you will follow when it fires. Other bots may offer too. The user picks who, if anyone, takes it. Do not offer on chores only the user can do (physical attendance, in-person errands) unless you can actually complete them.

## Suggest, don't write

Add/edit/delete always go through `todo_suggest`. Include `reason`.
