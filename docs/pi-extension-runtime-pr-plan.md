# Pi Extension + Native Pi Runtime PR Plan

Status: Draft PR plan

## PR Title
Pi native execution runtime, packaged Pi extension, and autonomous runner hardening

## Summary
This PR lands the Pi-backed execution/runtime integration and the packaged Pi extension on top of it.

It keeps Rorca as the control plane and system of record while using Pi as the execution/reasoning layer where appropriate.

## Scope

### 1. Backend/runtime integration
- Route Pi runs through the canonical queued worker/execution-engine flow
- Keep old external `pi_native` behavior only behind explicit opt-in
- Preserve Rorca run state, WAL, memory, graph/retrieval context, and PR/merge ownership
- Improve single-story targeting semantics with `specificStory`
- Improve Pi model fallback behavior
- Fix memory persistence and post-run PR metadata issues

### 2. Packaged Pi extension
- Add `packages/rorca-pi-extension`
- Add installable Pi package manifest and runtime wiring
- Provide slash commands for forge / forge-run / approve / run / status / watch / attach / retry / help
- Load the packaged extension from `rorca chat`
- Bridge to backend REST/MCP directly rather than shelling out to CLI commands

### 3. Autonomous runner improvements
- Add reusable Pi autonomous runner skill text
- Add persistent per-story progress logs
- Seed the runner with done definition, likely files/tests, validation plan, and retry context
- Write machine-side retry/failure/pass context back into the progress log

### 4. Docs / planning / package assets
- Operator docs
- publishing/maintainer docs
- store/listing/announcement draft assets
- skill-first architecture planning docs and implementation checklist

## Review order

### Review chunk A — runtime/backend correctness
Files:
- `backend/src/lib/execution-engine.ts`
- `backend/src/lib/pi-autonomous-runner.ts`
- `backend/src/lib/pi-execution-mode.ts`
- `backend/src/routes/pipeline.ts`
- `backend/src/worker.ts`
- `backend/src/routes/specs.ts`
- `backend/src/routes/memory.ts`
- `backend/src/mcp/server.ts`
- `backend/src/lib/auto-memory.ts`
- `backend/src/lib/pg-boss-schemas.ts`
- `backend/src/db/pg-migrations/20260513180000_memories_source_run_id_bigint.sql`

Focus:
- Pi uses canonical engine path
- retry / worktree / single-story / model fallback semantics
- memory persistence correctness
- PR metadata correctness
- autonomous runner progress-log behavior

### Review chunk B — tests and validation
Files:
- `backend/src/lib/__tests__/pi-autonomous-runner.test.ts`
- `backend/src/routes/__tests__/pipeline.test.ts`
- existing Pi retry-context tests

Focus:
- regression coverage for Pi path
- autonomous-runner contract coverage
- single-story forwarding coverage

### Review chunk C — extension package
Files:
- `packages/rorca-pi-extension/package.json`
- `packages/rorca-pi-extension/extensions/rorca/*`
- `packages/rorca-pi-extension/extensions/rorca/__tests__/*`
- `packages/rorca-pi-extension/skills/*`
- `packages/rorca-pi-extension/README.md`
- `packages/rorca-pi-extension/PUBLISHING.md`
- package docs assets

Focus:
- slash-command UX
- MCP bridge behavior
- persisted state/watch behavior
- package installability and docs quality

### Review chunk D — repo wiring / CLI / docs
Files:
- `bin/rorca.ts`
- `bin/rorca.js`
- `package.json`
- `README.md`
- `docs/*.md`

Focus:
- packaged extension loading
- root script wiring
- docs accuracy and discoverability

## Validation evidence to call out in PR
- `cd backend && npx tsc --noEmit`
- `cd backend && npm test -- --runInBand src/lib/__tests__/pi-autonomous-runner.test.ts`
- `cd backend && npm test -- --runInBand src/__tests__/CLI-019-pi-rpc-retry-context.test.ts`
- targeted Pi pipeline tests
- `npm run test:pi-extension`
- `npm run typecheck`
- `npm run build`
- real Pi-backed run / memory / PR / merge verification already captured during implementation

## Known limitations to disclose in PR
- Full `pipeline.test.ts` still has unrelated pre-existing failures when run wholesale in this branch
- Some repo/workspace state files are intentionally excluded from the commit for PR cleanliness
- Skill-first forge architecture planning exists, but full cross-product implementation is a follow-up, not fully delivered in this PR

## Suggested PR description structure
1. Problem
2. Architecture decision: Rorca control plane, Pi execution plane
3. What changed in backend/runtime
4. What changed in the Pi extension package
5. Autonomous runner hardening
6. Validation performed
7. Known limitations / follow-ups

## Suggested follow-ups after merge
- Deeper worker-level integration coverage for external orchestration seam
- UI/TUI surfacing of Pi progress-log links and diagnostics
- Optional `rorca pi-extension install|status|remove` CLI wrapper
- Skill-first forge implementation across all Rorca surfaces
