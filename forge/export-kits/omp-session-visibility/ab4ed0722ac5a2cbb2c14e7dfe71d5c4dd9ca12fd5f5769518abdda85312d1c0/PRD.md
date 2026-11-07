# OMP Session Visibility: Resumable Rorca-Run Sessions in the OMP App — Product Requirements

## Problem
Deliver the behavior defined by the canonical OMP Session Visibility: Resumable Rorca-Run Sessions in the OMP App specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- US-001 — Host-side tee of omp RPC sessions into the durable operator store
- US-002 — Integration verification and docs for resumable Rorca sessions

## In scope
- The sandboxed omp lane writes its session file into the ephemeral per-run runtime dir (deleted at run end), so Rorca-executed sessions never appear in the operator's OMP app. Implement a host-side tee: the engine already reads every JSONL line from the omp RPC child (attachJsonlLineReader on omp stdout); append each line to a durable, omp-compatible session file under ~/.omp/profiles/rorca/agent/sessions/ (operator store), created when the session id is first observed (session_started event), 0600 perms, fsync+close on session end. New module backend/src/lib/omp-session-store.ts (path builder using omp's naming convention '<ISO timestamp with Z and dashes>_<sessionId>.jsonl', open/append/close, idempotent per session); wire into backend/src/lib/execution-engine.ts at the omp RPC JSONL consumption point (~line 4718, where [omp-ui] events are handled). Do not rely on the sandboxed child's runtime session file. The tee must never alter the events forwarded to the run (read-only tee).
- Add a node integration test (isolated-jest compatible, like backend/src/lib/__tests__/omp-session-store.node.test.ts) that runs a bounded omp RPC session against the real omp binary with the rorca profile (RORCA_OMP_SANDBOX_QUALIFIED not required for the test; use a temp operator store via env override) and asserts the tee file is written with session events and survives. Document the feature: docs/execution-engine-omp-migration-plan.md gets a short section 'Watching Rorca runs in the OMP app' explaining `omp --profile rorca --resume` to replay/continue any story session, and that sessions are mirrored host-side into the operator store.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### US-001
The sandboxed omp lane writes its session file into the ephemeral per-run runtime dir (deleted at run end), so Rorca-executed sessions never appear in the operator's OMP app. Implement a host-side tee: the engine already reads every JSONL line from the omp RPC child (attachJsonlLineReader on omp stdout); append each line to a durable, omp-compatible session file under ~/.omp/profiles/rorca/agent/sessions/ (operator store), created when the session id is first observed (session_started event), 0600 perms, fsync+close on session end. New module backend/src/lib/omp-session-store.ts (path builder using omp's naming convention '<ISO timestamp with Z and dashes>_<sessionId>.jsonl', open/append/close, idempotent per session); wire into backend/src/lib/execution-engine.ts at the omp RPC JSONL consumption point (~line 4718, where [omp-ui] events are handled). Do not rely on the sandboxed child's runtime session file. The tee must never alter the events forwarded to the run (read-only tee).

**Acceptance criteria**
- After an omp-executed story, a session file exists under ~/.omp/profiles/rorca/agent/sessions/ containing the JSONL events of that story's omp session (same event types/ordering as the run stream)
- The file survives run cleanup (located outside the ephemeral runtime root)
- File naming matches omp's convention so `omp --profile rorca --resume` can open it; if omp's picker only scans its per-cwd namespace dirs, write into the exact namespace dir omp uses for the run worktree cwd
- Backend `npx tsc --noEmit` passes
- New unit tests for omp-session-store cover: naming, 0600 permissions, idempotent open/close (duplicate session_started), append ordering, and refusal to follow symlinks

### US-002
Add a node integration test (isolated-jest compatible, like backend/src/lib/__tests__/omp-session-store.node.test.ts) that runs a bounded omp RPC session against the real omp binary with the rorca profile (RORCA_OMP_SANDBOX_QUALIFIED not required for the test; use a temp operator store via env override) and asserts the tee file is written with session events and survives. Document the feature: docs/execution-engine-omp-migration-plan.md gets a short section 'Watching Rorca runs in the OMP app' explaining `omp --profile rorca --resume` to replay/continue any story session, and that sessions are mirrored host-side into the operator store.

**Acceptance criteria**
- Integration test passes via `npx tsx scripts/run-isolated-jest.ts` (or the repo's standard isolated runner)
- Docs section added describing resume/replay of Rorca-run sessions
- `omp --profile rorca --resume` (or `omp --resume` listing) demonstrably lists an archived rorca-run session in manual verification
- No failing checks remain

## Success metrics
- US-001: After an omp-executed story, a session file exists under ~/.omp/profiles/rorca/agent/sessions/ containing the JSONL events of that story's omp session (same event types/ordering as the run stream)
- US-001: The file survives run cleanup (located outside the ephemeral runtime root)
- US-001: File naming matches omp's convention so `omp --profile rorca --resume` can open it; if omp's picker only scans its per-cwd namespace dirs, write into the exact namespace dir omp uses for the run worktree cwd
- US-001: Backend `npx tsc --noEmit` passes
- US-001: New unit tests for omp-session-store cover: naming, 0600 permissions, idempotent open/close (duplicate session_started), append ordering, and refusal to follow symlinks
- US-002: Integration test passes via `npx tsx scripts/run-isolated-jest.ts` (or the repo's standard isolated runner)
- US-002: Docs section added describing resume/replay of Rorca-run sessions
- US-002: `omp --profile rorca --resume` (or `omp --resume` listing) demonstrably lists an archived rorca-run session in manual verification
- US-002: No failing checks remain

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

