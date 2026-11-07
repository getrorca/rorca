# OMP Session Visibility: Resumable Rorca-Run Sessions in the OMP App — Delivery Plan

## Story order
1. **US-001 — Host-side tee of omp RPC sessions into the durable operator store**
2. **US-002 — Integration verification and docs for resumable Rorca sessions**

## Dependencies
- US-001 → US-002

## Verification
- US-001: After an omp-executed story, a session file exists under ~/.omp/profiles/rorca/agent/sessions/ containing the JSONL events of that story's omp session (same event types/ordering as the run stream)
- US-001: The file survives run cleanup (located outside the ephemeral runtime root)
- US-001: File naming matches omp's convention so `omp --profile rorca --resume` can open it; if omp's picker only scans its per-cwd namespace dirs, write into the exact namespace dir omp uses for the run worktree cwd
- US-001: Backend `npx tsc --noEmit` passes
- US-001: New unit tests for omp-session-store cover: naming, 0600 permissions, idempotent open/close (duplicate session_started), append ordering, and refusal to follow symlinks
- US-002: Integration test passes via `npx tsx scripts/run-isolated-jest.ts` (or the repo's standard isolated runner)
- US-002: Docs section added describing resume/replay of Rorca-run sessions
- US-002: `omp --profile rorca --resume` (or `omp --resume` listing) demonstrably lists an archived rorca-run session in manual verification
- US-002: No failing checks remain

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
