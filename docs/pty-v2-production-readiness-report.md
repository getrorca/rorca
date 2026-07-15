# PTY v2 Production Readiness Report

Date: 2026-07-15  
Branch: `release/pty-v2-production-ready`  
Base: `610ef0769` + PTY v2 merge `cc3b3eded`  
Decision: **NO-GO — do not push or promote**

## Changes validated

- Integrated PTY v2 through `d959800ad` without force-rewriting history.
- Fixed `node-pty` `spawn-helper` executable permissions in install/postinstall handling (`0dce800d0`).
- Accepted PostgreSQL BIGINT string IDs for internal queue promotion and made null queue timestamps deterministic (`backend/src/routes/pipeline.ts`, `backend/src/lib/run-queue.ts`).
- Hardened PTY/run-view completion animation when a pass event arrives with the result payload (`src/components/RunStoryList.tsx`).
- Repaired test fixtures for WAL `queryOne` writes, readiness gates, real Git worktrees, shared queue state, JSONB payloads, and worker settings.

## Passing gates

- Root/backend/Pi/public-contract TypeScript checks.
- Root production build and backend TypeScript build.
- PTY/lifecycle/backend focused validation: **22 suites, 207 tests passed**.
- Frontend PTY/run-view focused validation: **10 files, 93 tests passed**.
- Root ESLint: 0 errors (existing warnings only).
- `git diff --check`.
- Native `node-pty` require/spawn smoke and focused PTY fake-agent coverage.

Tests used the isolated `rorca_test` database on the local native PostgreSQL test service. No production database or service was intentionally touched.

## Blocking gates

1. `npm run check:contract` fails because the committed public API snapshot is stale and reports additive/breaking drift. Regenerating it requires the repository's contract-version/marker process; the generated result was not included because the drift is broader than this PTY release.
2. `cd backend && npm run lint` fails on pre-existing repository-wide lint configuration/errors (80 errors, 57 warnings), including unrelated files. This is not a PTY-specific type or test failure, but it prevents a clean release gate.

Because these gates are not green, this branch is intentionally **not pushed**, and no GO decision is made.

## Required before GO

- Reconcile the public contract snapshot against the intended release base and add required breaking-change markers/versioning, or explicitly waive the gate through the repository release process.
- Resolve or formally baseline the backend ESLint errors.
- Re-run the complete release gate set from a clean worktree, then obtain an explicit GO review before pushing/promoting.
