---
name: rorcha
description: Implement and validate changes with subagent-assisted context management.
---

## 1. Context Gathering

**Check progress.txt first** (if it exists):
- `## Current Phase` → Resume from where you left off
- `## Specs Loaded` → Skip re-reading loaded docs

**For codebase research (use subagent):**
```
Task(subagent_type="Explore", prompt="
  Directories: [list dirs you'll modify]
  Task: [description]
  Return: AGENTS.md gotchas + existing patterns (max 20 lines)
")
```

**For project docs:** Load CLAUDE.md for architecture. Load PRDs/SDDs on-demand.

## 2. Before Writing Code
- Redundancy check: Is this already implemented?
- Missing details: Ask user, don't guess
- Non-trivial task: Use `EnterPlanMode`

## 3. Implementation
- Write code in main context
- Apply DB migrations immediately after creating them
- Keep changes focused — only what the story requires

## 4. Validation (REQUIRED)
Run in parallel where possible. Adapt commands to this project's stack:
```bash
npx tsc --noEmit          # Type check (if TypeScript)
npm run lint              # Lint (zero warnings)
npm run build             # Build succeeds
npm test                  # Tests pass
```
If any fail, fix before marking story done.

## 4b. Browser Testing (if UI changed)
Skip if backend-only change or running in automated loop.
Use Playwright MCP — never ask user to manually test.
Test: happy path + one edge case. Keep it fast (< 30 seconds).

## 5. QA
- Happy path works?
- Edge case handled?
- Error case graceful?

## 6. Progress Tracking (`progress.txt`)

**Update after every story completion** (critical for surviving context compaction):

```
## Story [ID]: [Title] — DONE
Files touched: [list]
What was built: [2-3 bullet summary]
Key decisions: [any non-obvious choices]

## Story [ID]: [Title] — IN PROGRESS
Remaining: [specific items]

## Story [ID]: [Title] — NOT STARTED
Expects: [prerequisites]
```

**Rules:**
- Re-read progress.txt FIRST after any compaction to know where you are
- Never overwrite previous entries — append below
- Log gotchas discovered to AGENTS.md in the relevant directory

## 7. Wrap-up
- [ ] Type check passes
- [ ] Build succeeds
- [ ] Tests pass
- [ ] New gotchas → AGENTS.md in relevant directory
- [ ] progress.txt updated

## Context Alert
At ~75% context: output `Context: ~X% | /compact?`
