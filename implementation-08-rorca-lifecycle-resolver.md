# Implementation 08 — Lifecycle and resolver integrity

Base: `136eba5d0`
Branch: `fix/wave-pass-state-integrity`

## Implemented

- Worktree runs now pass the engine the spec located in the run worktree, never the approved/base-spec path.
- A parallel story worktree records a contribution only; it cannot set `passes:true` on the run branch until its own worktree merge succeeds. This removes the crash-before-wave-merge skip window.
- Contribution posture is captured at execution and emitted as append-only `story_contribution_started` WAL evidence. Wave conflict resolution fails closed when integrated contributions have mixed postures.
- Reconciliation now requires recorded direct base integration (`auto_merge`, `direct`, `merged`) and verifies the checkpoint commit is reachable from both the run branch and `HEAD` before moving canonical spec state.
- Worker closeout reads the run-branch spec and emits `run_closeout` with explicit `completion_scope` and `base_integrated`. Branch-only/PR runs therefore report run-branch completion rather than base integration.
- The worker delegates final direct merges to `merge-handler.performMerge`; the duplicate worker merge implementation was removed.
- Resolver containment now requires the staged set to equal the allowed conflict set and rejects remaining unmerged, unstaged, or untracked files. Wave commit code no longer broadens a resolver result with `git add -A`.
- Resolver uses shared OpenCode model normalization and Pi's `agent_end` completion protocol, supports the run's OpenCode attachment, and starts resolver/Pi children in process groups so termination includes descendants.
- Merge WAL diagnostics redact patch content and absolute paths.

## Validation

- `npm test -- --runInBand src/lib/__tests__/execution-engine-pi-rpc.test.ts src/lib/__tests__/merge-conflict-resolver.test.ts src/lib/__tests__/checkpoint-reconciliation.test.ts src/lib/__tests__/merge-handler-redaction.test.ts`
- `npm test -- --runInBand src/routes/__tests__/auto-merge-pipeline.test.ts`
- `npx tsc --noEmit --pretty false`
- Targeted ESLint completed without errors (pre-existing warnings remain in `execution-engine.ts` and `worker.ts`).

No runs, deployments, pushes, or production data operations were performed.
