---
name: skill-authoring
description: Create or update agent skills under the user skills directory. Use when a non-trivial, repeatable workflow just succeeded and should be captured for future sessions, or when the user asks to write or fix a skill.
---

# Skill authoring

Skills are playbooks future-you loads on demand. Write them so a run with zero memory of today can execute the workflow.

## When to create or update

- Create when a **non-trivial, repeatable** workflow succeeded: 5+ tool calls, error recovery, user-corrected knowledge, or a multi-step task likely to recur.
- One-off fixes and trivia do not deserve a skill.
- Update an existing skill in the same turn it proves wrong or incomplete — prefer patching a related skill over creating a near-duplicate. Check the Available skills list first.

## Location & file format

- Path: `{{SKILLS_DIR}}/<slug>/SKILL.md` — kebab-case slug. `mkdir -p` the directory first via `terminal_run`, then write the file.
- YAML frontmatter with exactly `name` and `description`, then concise markdown.
- After writing, the skill appears in the system prompt skill list on the next turn; it is usable immediately via `skills_read <name>`.

## The description is the trigger

The skill list injects only `name` + `description` each turn — the description alone decides whether future-you loads the skill. Write it as **what it does + when to use + trigger keywords**. Include the exact terms that will appear in future requests (site names, file types, domain nouns). "Helps with X" is a bad description; "Fetch X/Twitter posts … use whenever an x.com link appears" is a good one.

## Writing rules

- Write declarative playbook steps ("run X, then check Y"), not a narrative of what happened today.
- Keep the main file tight; put bulky references (API tables, long examples) in `<slug>/references/` and link them.
- Use `{{VAR}}` placeholders for environment paths instead of hardcoding — `{{SKILLS_DIR}}`, `{{MEMORY_PATH}}`, `{{USER_DIR}}`, `{{CODES_DIR}}`, `{{MCP_CONFIG_PATH}}`, `{{CAMOFOX_DATA_DIR}}` are rendered at load time.
- Never embed secrets, tokens, or per-user data.
- Write constraints that matter ("always check `code`", "never do X") — future-you follows them literally, so keep them accurate and few.
