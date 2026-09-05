# Scripting

`camofox run <script-file>` executes CLI commands sequentially from a script file (or stdin).

Related:

- `../SKILL.md`
- `./cli-commands.md`
- `./session-management.md`
- `./search-macros.md`

Source of truth for development: `AGENTS.md`

## Table of Contents

1. Command behavior
2. Script format
3. Quoting and escaping
4. Error handling (`--continue-on-error`)
5. Practical script examples
6. Limitations

---

## 1) Command behavior

Implemented in `src/cli/commands/pipe.ts`:

```bash
camofox run <script-file>
```

Execution model:

- reads script text from file path (or `-` for stdin)
- parses one command per non-empty, non-comment line
- executes each command in order as `camofox <command> ...`
- carries global output format (`--format`) into each command

Nested runner protection:

- `run` inside a script is rejected (`Nested "run" command is not supported in scripts.`)

---

## 2) Script format

Rules:

- one command per line
- blank lines are ignored
- lines starting with `#` are ignored as comments
- no inline comment stripping after command text

Example `commands.txt`:

```text
# open page and inspect
open "https://example.com" --user demo
snapshot --user demo
get-links --user demo

# search on active tab
search "typescript fetch timeout" --engine github --user demo
```

Run it:

```bash
camofox run commands.txt
```

Stdin mode:

```bash
cat commands.txt | camofox run -
```

---

## 3) Quoting and escaping

Line parser supports:

- single quotes `'...'`
- double quotes `"..."`
- backslash escaping `\`

Examples:

```text
navigate "https://news.ycombinator.com" --user demo
search 'web scraping ethics' --engine duckduckgo --user demo
eval "document.title" --user demo
```

If a quote is left open, parsing fails with `Unterminated quote in script line.`

---

## 4) Error handling (`--continue-on-error`)

Default behavior:

- stop on first failed command
- error message includes script line number

Continue mode:

```bash
camofox run commands.txt --continue-on-error
```

With `--continue-on-error`, failures are tolerated and the runner proceeds to remaining lines.

---

## 5) Practical script examples

### Example A: navigation + capture

```text
open "https://example.com" --user batch1
wait networkidle --user batch1
snapshot --user batch1
get-links --user batch1
```

### Example B: search workflow

```text
open "https://google.com" --user research
search "playwright aria snapshot" --engine google --user research
wait networkidle --user research
snapshot --user research
```

### Example C: restore cookies then verify

```text
open "https://example.com/login" --user acctA
session load acctA --user acctA
navigate "https://example.com/account" --user acctA
snapshot --user acctA
```

---

## 6) Limitations

`camofox run` is intentionally simple and does not support:

- command piping between lines
- conditionals/branching
- loops
- parallel execution
- variables/interpolation

For complex orchestration, use shell scripts around `camofox` commands or call API endpoints directly.
