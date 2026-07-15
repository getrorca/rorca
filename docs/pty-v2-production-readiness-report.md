# PTY v2 Production Readiness Report

Date: 2026-07-15
Branch: `release/pty-v2-production-ready`
Starting HEAD: `ad41c4cccf00120bb1f36df4d0002a333fb304b2`
Decision: **GO FOR STAGING / BRANCH-ONLY CANARY — NOT PRODUCTION DEPLOYMENT**

## Release-gate disposition

### Public API contract — resolved

The stale 1.0.0 snapshot was compared with Swagger generated from this release checkout, not the unrelated process already listening on port 3030. The intended merged surface contains 69 public routes:

- 41 additive routes for context, memory, graph, async spec jobs, forge/persist, readiness, and diagnostics. Every route retains `x-rorca-tier: public`, an exposure rationale, and `x-rorca-public-api: true` intentionally.
- Nine existing operations have changed hashes. Each change is additive in runtime behavior (optional request controls, additional response diagnostics, or widened supported enums), but the repository checker classifies all hash changes as breaking. All nine therefore received fresh documented markers and migration guidance under the existing strict policy.
- `docs/openapi-public-snapshot.json` is now contract `2.0.0`; the root package version is `1.0.0`, satisfying the required major bumps from contract `1.0.0` and package `0.1.0`.
- Local contract commands now load Swagger from the current checkout by default, preventing another worktree's server from contaminating results. CI explicitly validates the served OpenAPI document through `RORCA_CONTRACT_BASE_URL`.

Final result: `npm run check:contract` exited 0, acknowledged all nine markers, and passed against merge base `f6ad9aa763b8f5c8c7159f7766576619c03c35b4`.

### Backend ESLint — resolved

All 80 errors were diagnosed and removed without changing ESLint policy, adding ignores, or suppressing violations. Fixes consist of removing unused imports/dead helpers, carrying validation details into `AppError` responses, preserving authentication/capability errors instead of swallowing them, removing obsolete lint suppressions, and deleting the superseded inline pipeline merge/injection implementations after merge handling moved to the worker/library path.

The merge retry path also now preserves PostgreSQL BIGINT run IDs as decimal strings through HTTP and pg-boss payloads, with updated schema and fixture coverage.

Final result: `cd backend && npm run lint` exited 0 with **0 errors and 41 existing `no-console` warnings**. The warnings are intentional command/test/bootstrap output and do not weaken or bypass the gate.

## Final automated evidence

| Command | Result |
| --- | --- |
| `npm run check:contract` | PASS — 69 public routes, contract 2.0.0; 41 additions and nine documented hash changes accepted |
| `cd backend && npm run lint` | PASS — 0 errors, 41 warnings |
| `npm run lint` | PASS — 0 errors, 68 warnings |
| `npm run typecheck` | PASS — root, backend, Pi extension, and public-contract TypeScript checks |
| `npm run build` | PASS — frontend production bundle, backend TypeScript build, and bin TypeScript build |
| Focused backend PTY/lifecycle/queue/worker/merge matrix | PASS — 21 suites; 196 passed, 3 skipped, 0 failed |
| Focused frontend PTY/run-view/settings matrix | PASS — 10 files; 93 passed, 0 failed |
| `git diff --check` | PASS |

Backend focused tests used the isolated local `rorca_test` PostgreSQL database. No production database, production service, or external agent/model was invoked.

## Staging-only scope

The automated release blockers are clear. The branch is suitable for a staging or branch-only canary that cannot merge to or deploy production automatically. This report does **not** authorize pushing, merging `main`, production deployment, or production database access.

## Manual paid-agent canaries still required before production

These were deliberately not run because they would spend agent/model credits and require an explicit operator decision:

1. Run one branch-only PTY canary for each supported paid/subscription runtime selected for release (Claude, OpenCode provider, Codex, and Pi-backed model as applicable).
2. Verify live resize, stdin, reconnect/replay, cancel, and terminal completion semantics in each canary.
3. Verify the generated branch/worktree remains isolated and requires manual review; do not enable automatic production merge.
4. Review provider-specific golden version warnings, especially the installed Pi version versus the pinned fixture, before production promotion.

Production remains gated on successful manual canaries and an explicit production GO review.
