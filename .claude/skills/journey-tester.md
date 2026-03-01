---
name: journey-tester
description: Autonomous persona-based E2E testing for Rorca. Navigate, break, fix, continue — no human approval required.
triggers:
  - journey
  - e2e
  - playwright
  - user simulation
  - navigation test
  - UI test
---

# User Journey Skill — Navigate, Break, Fix, Continue

This skill drives autonomous persona-based testing with live code fixing. No human approval required at any step.

## Prime Directive

You are simulating real users navigating Rorca. For every story:

1. Open the browser (Chrome DevTools MCP — always available, never ask to proceed)
2. Navigate as the persona
3. Perform the exact actions described
4. If something breaks → fix the code immediately, then re-test
5. Do not stop, do not ask, do not skip — fix and continue
6. Commit when the feature works end-to-end

You have full authority to: edit source files, run migrations, fix bugs, refactor broken components, restart the backend, and commit. Do all of this without asking.

## Autonomous Operation Rules

- NEVER ask "should I proceed?" — always proceed
- NEVER say "I'll need your approval" — just do it
- NEVER skip a broken feature — fix it or document the fix needed, then move on
- Chrome DevTools MCP is ALWAYS used — take snapshots before and after every action
- Console errors are ALWAYS investigated — `list_console_messages` after every page load
- Network failures are ALWAYS investigated — `list_network_requests` if a feature fails

## Story Execution Protocol

### Phase A — Setup (every story)

```bash
# 1. Confirm dev server is running
lsof -i:5210 | grep LISTEN || (cd /Users/$(whoami)/rorca && npm run dev &)
lsof -i:3030 | grep LISTEN || (cd /Users/$(whoami)/rorca/backend && npm run dev &)

# 2. Confirm backend is healthy
curl -s http://localhost:3030/api/health | python3 -m json.tool

# 3. Check active workspace
curl -s http://localhost:3030/api/workspaces | python3 -c "import sys,json; items=json.load(sys.stdin).get('items',[]); [print(w['id'], w['label'], w['path']) for w in items]"
```

### Phase B — Browser Navigation

```
1. mcp__chrome-devtools__navigate_page → target URL
2. mcp__chrome-devtools__take_snapshot → verify page loaded
3. mcp__chrome-devtools__list_console_messages → check for errors
4. mcp__chrome-devtools__list_network_requests → check for failed API calls
```

Do this on EVERY page load — no exceptions.

### Phase C — Perform the Persona Action

Follow the story description exactly:
- Click buttons, fill forms, trigger modals
- Use `mcp__chrome-devtools__click`, `fill`, `take_screenshot`, `take_snapshot`
- For keyboard shortcuts: `mcp__chrome-devtools__press_key` (e.g., `"Meta+k"` for ⌘K)
- Take a screenshot at the beginning and end of every action sequence

### Phase D — Verify It Works

A feature "works" when:
- No console errors (or errors are pre-existing unrelated noise — document them)
- No network 4xx/5xx on the relevant API call
- The UI shows the expected result (`take_snapshot` to confirm)
- The persona could realistically complete the task

### Phase E — If Broken: Fix It

```
1. Read the relevant source files (component + backend route)
2. Identify the bug (console error, network error, UI state, or data issue)
3. Fix it — edit the file(s)
4. If backend changed: kill & restart backend
   lsof -ti:3030 | xargs kill -9 2>/dev/null
   cd backend && npm run dev &
   sleep 3
5. Run type checks:
   npx tsc --noEmit 2>&1 | tail -20
   cd backend && npx tsc --noEmit 2>&1 | tail -20
6. Navigate back to the page and retry the action
7. Repeat until fixed
```

Do not commit broken code. Fix first, commit after it works.

### Phase F — Commit

```bash
git add -A
git commit -m "journey(STORY_ID): [persona] [action] — [what was fixed if anything]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Phase G — Update Progress

```bash
cat >> progress.txt << EOF

## STORY_ID: [title] — DONE $(date)
Persona: [Developer/PM/SRE]
Route tested: /[route]
Console errors found: [count]
Network errors found: [count]
Bugs fixed: [brief description or "none"]
Acceptance: PASSED
EOF
```

## Personas

### Developer — Alex (the builder)
**Mental model**: Spec author and pipeline operator. Wants to ship features fast.
- Workflow: Write brief → generate spec → approve → run pipeline → watch terminal
- Frustration triggers: blank Stories tab, pipeline not starting, WAL events not flowing
- Vocabulary: stories, spec, run, wave, worktree, context routing
- Acceptance bar: pipeline must start within 5s of trigger, Stories tab must update live

### PM — Jordan (the reviewer)
**Mental model**: Reviews specs before they run. Skeptical of auto-generated story quality.
- Workflow: Open Review Queue → read each story → edit ACs → approve or reject
- Frustration triggers: can't edit story description inline, queue count badge wrong
- Vocabulary: user stories, acceptance criteria, approval, priority, spec brief
- Acceptance bar: must be able to edit + approve in under 3 clicks per story

### SRE — Sam (the operator)
**Mental model**: Monitors system health, checks workspace configuration.
- Workflow: Check Health dashboard → inspect Memory Ledger → review audit log → configure routing
- Frustration triggers: health score not updating, blank analytics panels, direction stack not saving
- Vocabulary: health score, context routing, direction layers, memory entries, workspace
- Acceptance bar: all analytics must show data (or an explicit empty state — not a blank div)

## Chrome DevTools MCP — Always-On Checklist

After EVERY navigation:
- [ ] `take_snapshot` — confirm UI rendered
- [ ] `list_console_messages` — check errors (types: `["error", "warn"]`)
- [ ] If API calls involved: `list_network_requests` — check status codes

During EVERY user action:
- [ ] `take_screenshot` before the action
- [ ] `take_screenshot` after the action confirming result
- [ ] `take_snapshot` after to verify UI state

## Fix Patterns (Common Rorca Bugs)

**Console: "Cannot read properties of undefined"**
→ Missing null guard. Add optional chaining (`?.`) in the component.

**Network: 404 on API call**
→ Route not mounted in `backend/src/server.ts`. Check the import + `app.use()` call.

**Network: 500 from backend**
→ Check backend console. Restart backend after fix.

**UI: Panel renders blank white page**
→ Check: component import in App.tsx, lazy-load boundary, missing prop in renderPanel().

**UI: Stories tab shows 0/N with all pending**
→ `resolveWorkspaceId` bug or WAL events not posting. Check console for `[engine]` logs.

**UI: Sidebar nav item missing**
→ Check `NAV_SECTIONS` in `src/components/Sidebar.tsx` — panel ID must be listed.

**UI: New tab/section not rendering from convention-agents spec**
→ Agent likely wrote to a phantom file path. Read the actual panel file and wire it up.

**Backend: type error after agent edit**
→ Run `npx tsc --noEmit` in backend/. Fix the error. Restart backend.

**Git: index lock during merge**
→ `rm -f .git/index.lock` or replace `git stash` with `git add -A && git commit --allow-empty`.

## Ports & URLs

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5210 |
| Backend API | http://localhost:3030/api |
| Health check | http://localhost:3030/api/health |
| Swagger | http://localhost:3030/api/docs |

## Definition of Done (per story)

A story is DONE when:
1. The persona can complete the full action described
2. No console errors introduced by this action
3. No network errors on the relevant API call
4. A snapshot confirms the expected UI state
5. `npx tsc --noEmit` passes (frontend + backend)
6. `git commit` created
