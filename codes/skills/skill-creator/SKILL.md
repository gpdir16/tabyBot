---
name: skill-creator
description: "Create new skills, modify and improve existing skills. Use when users want to create a skill from scratch, edit, or optimize an existing skill. Also trigger when the user says 'create a skill', 'make a skill', 'improve this skill', 'update skill', 'turn this into a skill', or when a task is important and likely to repeat."
---

# Skill Creator

A skill for creating new skills and iteratively improving them.

## tabyAgent context

- Skills live at `{{SKILLS_DIR}}/<name>/SKILL.md` (user skills) or `{{SYSTEM_SKILLS_DIR}}/<name>/SKILL.md` (system skills).
- Use `file_read` to read existing skills, `file_patch` to write or edit SKILL.md files.
- Use `terminal_run` to run scripts, install packages, or test skills.
- After creating/updating a skill, it appears in the system prompt skill list on the next turn.
- Use `skills_read <name>` to verify the skill content.

## High-level process

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Improve the skill based on user feedback
- Repeat until satisfied

## Communicating with the user

The skill creator may be used by people across a wide range of familiarity with coding jargon. Pay attention to context cues to understand how to phrase your communication.

It's OK to briefly explain terms if you're in doubt.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first.

1. What should this skill enable the agent to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Skill identifier (matches directory name)
- **description**: When to trigger, what it does. This is the primary triggering mechanism — include both what the skill does AND specific contexts for when to use it. Make the description "pushy" — combat undertriggering by listing many trigger phrases.
- **the rest of the skill body**

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed (read with file_read)
    └── assets/     - Files used in output (templates, icons, fonts)
```

#### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (read with `file_read` when needed)

**Key patterns:**

- Keep SKILL.md under 500 lines; if approaching this limit, add hierarchy with clear pointers to reference files.
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

#### Writing Style

Prefer using the imperative form in instructions. Explain the **why** behind things rather than using heavy-handed MUSTs. Use theory of mind and make the skill general, not narrow to specific examples.

---

## Improving the skill

After writing the draft, improve the skill based on user feedback.

### How to think about improvements

1. **Generalize from the feedback.** We're trying to create skills that can be used many times across many different prompts. Rather than put in fiddly overfitting changes, if there's a stubborn issue, try branching out and using different metaphors or recommending different patterns.

2. **Keep the prompt lean.** Remove things that aren't pulling their weight. If the skill is making the model waste time doing unproductive things, get rid of those parts.

3. **Explain the why.** Try hard to explain the **why** behind everything. If you find yourself writing ALWAYS or NEVER in all caps, reframe and explain the reasoning so the model understands why.

4. **Look for repeated work.** If multiple tasks resulted in writing similar helper scripts, bundle that script into the skill's `scripts/` directory.

### The iteration loop

After improving the skill:

1. Apply your improvements to the skill (using `file_patch`)
2. Present the changes to the user
3. Wait for feedback
4. Read the new feedback, improve again, repeat

Keep going until:

- The user says they're happy
- You're not making meaningful progress

---

## Core loop

1. Figure out what the skill is about
2. Draft or edit the skill (use `file_patch` to write `SKILL.md`)
3. Present to the user and get feedback
4. Improve the skill based on feedback
5. Repeat until you and the user are satisfied
