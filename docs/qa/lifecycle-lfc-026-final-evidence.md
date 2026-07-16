<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# LFC-026 final release evidence

## Status

**BLOCKED ONLY ON AUTHORIZED HUMAN SIGN-OFF — AUTOMATED RELEASE GATES COMPLETE.** The integrated candidate at `a359bbf86230f59ccd857bf3998c4ebbd938aec7` passed isolated migrations, focused backend/frontend regressions, real pg-boss cancellation, production build, governance checks, the Lifecycle Playwright golden journey, and the matrix performance budget. No merge, deploy, production mutation, external send, or credential transfer is authorized until an authorized human reviews the retained staging/visual evidence and binds approval to the final published candidate revision.

> Reconciliation update (2026-07-15): this section supersedes the historical command-ledger blockers below. See [`ssdlc-story-reconciliation.md`](./ssdlc-story-reconciliation.md) and the retained [`evidence/ssdlc-lifecycle-golden-journey`](./evidence/ssdlc-lifecycle-golden-journey/) bundle. The historical ledger remains for auditability.

## References

- Spec: `Rorca Evidence-Driven SSDLC Lifecycle and Autonomous Delivery Steward`
- Run: `20260316000493`
- Story: `LFC-026`
- Starting/base commit: `6fc208273a43ebd707680318d58910c2ee78d0b6`
- Final commit: `PENDING — the autonomous worktree is not itself an immutable commit`
- Coverage: [`lifecycle-requirements-coverage.md`](./lifecycle-requirements-coverage.md)
- Human gate: [`lifecycle-human-signoff.md`](./lifecycle-human-signoff.md) (`PENDING`)
- Golden journey: [`lifecycle-lfc-024-golden-journey.md`](./lifecycle-lfc-024-golden-journey.md)
- Visual source review: [`lifecycle-lfc-028-visual-review.md`](./lifecycle-lfc-028-visual-review.md)

## Implementation summary / changelog

- Added admin-tier `GET /api/lifecycle/operations`, a bounded, read-only operational projection over canonical spec files, compiled-plan/readiness state, evaluated blocked phases, and redacted 24-hour WAL counters.
- Reports current/stale/missing/failed plan coverage, compile failure codes, backfill progress, adapter availability/errors, evidence conflicts, stale-preview denials, evaluator failures, phase transitions, and exact safe recompile actions.
- Unexpected evaluator errors and denied stale/mismatched retry previews now emit countable metadata without request/evidence payloads; normal Specs/Runs state is untouched.
- Added focused operational projection/route regressions and complete operator/developer, rollout/recovery, traceability, human-QA, and release-evidence documentation.
- Public contract impact: no stable public API or shared public type changed. The new route is `admin`, has Swagger tier/rationale, is read-only, and is intentionally not MCP/public-contract exposed.

## Changed files

1. `backend/src/lib/lifecycle-operations.ts`
2. `backend/src/lib/__tests__/lifecycle-operations.test.ts`
3. `backend/src/routes/lifecycle.ts`
4. `backend/src/routes/pipeline.ts`
5. `backend/src/routes/__tests__/lifecycle.test.ts`
6. `docs/lifecycle-operations-runbook.md`
7. `docs/lifecycle-read-api.md`
8. `docs/architecture/ssdlc-lifecycle.md`
9. `docs/qa/lifecycle-requirements-coverage.md`
10. `docs/qa/lifecycle-human-signoff.md`
11. `docs/qa/lifecycle-lfc-026-final-evidence.md`
12. `scripts/check-rorca-tier-annotations.ts`
13. `backend/src/routes/__tests__/retry.test.ts`
14. `backend/src/routes/__tests__/story-timeout.test.ts`

The `.rorca/progress/.../LFC-026.md` run log is operational state, not release product code.

## Validation command ledger

| Command | Result | Notes |
|---|---|---|
| `cd backend && npx tsc --noEmit` | PASS | Rerun after fixing KPI type and WAL event-union errors. |
| `cd backend && JEST_SKIP_RUNTIME_MIGRATIONS=true npx jest src/lib/__tests__/lifecycle-operations.test.ts src/routes/__tests__/lifecycle.test.ts --runInBand` | PASS, 2 suites / 14 tests | Isolated `rorca_test` was recreated; no live database targeted. Jest reported force-exit/open-handle advisory after completion. |
| targeted ESLint over changed operations/route/test files | PASS | Backend config emitted only module-type advisory. |
| `npm run typecheck` | BLOCKED by repository baseline | Root and backend stages pass; Pi extension fails because optional `@mariozechner/pi-tui` is unresolved in `tmux-subagents.ts`. |
| `npx tsc --noEmit && cd backend && npx tsc --noEmit` | PASS | Final independent frontend/backend checks. |
| `npm run lint` | PASS | 0 errors, 67 unrelated warnings. |
| `npm run lint:swagger` | PASS with baseline warnings | New operation is annotated; checker reports 15 unrelated pre-existing omissions. |
| `npm run lint:tier` | BLOCKED by stale global allowlist baseline | New operations/closeout admin routes were added to expected governance and no longer appear as unexpected; 100+ unrelated route/count mismatches remain. |
| `cd backend && npm run lint` | BLOCKED by repository baseline | 83 unrelated errors/57 warnings; targeted changed-file lint passes. |
| focused/isolated broad Lifecycle backend suites | PASS after fixes, with one integration exception | Broad run: 28 suites/318 tests passed and 4 stale-fixture assertions failed; retry rerun 13/13 and timeout rerun 6/6 passed after fixture fixes. Operations 14/14 and wave/mode/closeout 53/53 passed. |
| frontend Lifecycle Vitest suites | PASS | 12 files / 89 tests. |
| `npm run build` | PASS | Vite, backend TypeScript, and bin TypeScript; chunk-size advisory only. |
| `npm run check:contract` | BLOCKED by stale baseline snapshot | Reports many unrelated additive/breaking routes; admin Lifecycle operations is absent from the stable public surface. |
| `npm run check:licenses` | BLOCKED by repository baseline | Reports many pre-existing missing headers; all new source/docs and the changed tier script have Apache-2.0/SPDX headers. |
| license boundary/open-core checks | MIXED | Single-license boundary check passes/skips; open-core check blocks on an unrelated existing threat-model boundary rule. |
| PTY cleanup regression | PASS | Golden PTY cleanup 2/2. |
| pg-boss cancel integration | **BLOCKED** | Custom isolated run reached the suite but its stale harness expects missing `pgboss.job` and overflows run IDs during cleanup; 0/2 passed. No live DB used. |
| Lifecycle Playwright journey | **BLOCKED** | The required Playwright MCP tool namespace was not exposed to this agent; CLI fallback was prohibited. No journey or screenshots were fabricated. |
| human staging and visual QA | **BLOCKED** | No authorized human decision or immutable final revision exists yet. |

### Root-cause fixes from validation

The first focused pass found (1) an invalid KPI shape cast and (2) a too-narrow retry WAL event union. The report now derives blocked phases from bounded portfolio items with explicit truncation metadata, and the canonical retry WAL helper accepts the redacted denial event. Typecheck and both focused suites passed on rerun.

The broad backend run then exposed stale tests rather than product regressions: retry dispatch correctly persists `queued` until worker validation, while its fixture expected `running`; timeout fixtures used the removed `scripts/ralph/specs` path, retained a deleted workspace path across tests, and expected the obsolete 120-minute maximum instead of the documented 240. Fixtures were corrected and complete retry (13/13) and timeout (6/6) suites passed on rerun. The real pg-boss cancel integration remains blocked by its separate stale schema/run-ID harness and is not represented as passed.

## Required execution non-regression matrix

| Surface | Evidence | Final status |
|---|---|---|
| Implementation / QA / Journey modes remain execution modes | multi-engine/mode tests and authority docs | PASS |
| Claude / OpenCode / Codex / Pi agent paths | multi-engine lifecycle regression | PASS |
| ANSI parallel waves | wave compiler + execution closeout regressions | PASS |
| PTY sequential execution | golden PTY cleanup regression | PASS |
| Timeout/cancel cleanup | timeout route 6/6 and PTY cleanup 2/2 pass; real pg-boss cancel integration harness fails before proof | **BLOCKED** |
| Retry option replay/scope | retry governance/dispatch plus route 13/13 | PASS |
| Closeout persisted before pass | story-closeout/execution ordering regressions | PASS |

## Known risks and limitations

| Risk/limitation | Owner | Impact/workaround | Release effect |
|---|---|---|---|
| Human staging and visual QA is pending | Release owner / authorized human QA | Execute the golden journey, review every required capture, and sign the immutable revision record | **Blocking** |
| Final commit/artifact/deployment identities do not yet exist | Release owner | Commit/build only after review; bind sign-off to those exact identities | **Blocking** |
| Operational adapter availability is error-derived, not active provider probing | Integration operator | `available` means no recent adapter error; use provider-native health for reachability. No automatic probe was invented. | Documented KISS boundary; non-blocking if human QA confirms behavior |
| Blocked-phase operations sample is capped at 100 and declares truncation | Operator | Narrow Lifecycle filters or inspect subsequent portfolio pages | Non-blocking; lifecycle truth remains canonical |
| Existing Jest harness reports an open-handle/force-exit advisory | Test infrastructure owner | Use explicit isolated suite and verify no worker remains | Must be checked during cleanup |

No residual item is currently classified as “non-critical polish approved for release”; the release remains blocked rather than claiming a completion percentage.

## Rollback and recovery

1. Stop further bounded backfill pages; preserve the last operation report and response cursor.
2. Remove/disable only the `/api/lifecycle/operations` route and unexpected-error/preview-denial audit calls if this change regresses operator reads. Specs/Runs and canonical lifecycle tables require no rollback.
3. Repair canonical spec/preflight input and invoke the existing one-spec recompile with a fresh idempotency key; do not hand-edit plans/readiness rows.
4. Adapter failures are side-write-only: repair/reconnect the adapter and replay its canonical normalization/ingress. Never fabricate a pass.
5. Refresh on snapshot conflict; old evidence/decisions remain immutable history.
6. Restore a database backup only through the existing approved recovery procedure. No migration was added by LFC-026.

## Cleanup and side-effect declaration

- Story-owned Playwright MCP processes `26267/28006`: terminated and verified absent.
- Story-owned Jest/test/PTY/cancel-mock workers: exited; temporary integration config removed.
- Ports 3030/5210 and worker processes predate this story run and were not started or stopped by LFC-026.
- The current execution-engine/Pi parent remains only to persist this response and is supervisor-owned for post-response teardown.
- Test process: Jest exited after its configured force-exit/open-handle advisories.
- Production merge/deploy/external send: **not performed**.
- Credential copy/production mutation: **not performed**.

## Release decision

Remain **BLOCKED** until every pending command passes, the actual Playwright journey evidence is retained, the final revision is immutable, an authorized human completes `lifecycle-human-signoff.md`, and no P0/P1 defect or unproven primary/negative/recovery journey remains.
