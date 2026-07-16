<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# SSDLC + Recovery Wave 4 combined integration review

Date: 2026-07-16

## Decision

**READY FOR HUMAN REVIEW; NOT AUTHORIZED FOR MERGE OR DEPLOYMENT.**

The combined candidate preserves the focused Recovery Wave 4 and SSDLC release gates. No live `rorca` database, production process, existing source worktree, remote branch, PR, deployment, external integration, or human approval record was mutated. The repository-wide backend suite remains an infrastructure/baseline blocker and did not complete within the 45-minute review budget; focused feature gates are green and newly exposed candidate fixtures were corrected and rerun.

Do not merge or update PR 16 from this review without explicit authorization. The next safe publication action is to open or update a human-review candidate from `integration/ssdlc-wave4-combined-review`, preserving this branch history and identifying PR 16 as superseded by the combined candidate.

## Exact inputs and provenance

| Input | Ref | Commit |
|---|---|---|
| Current base | `origin/main` | `6f87e79b0035985463739b05245cdd6e34969717` |
| Canonical Recovery Wave 4 | `integration/recovery-final` | `c45ad33f9b9ea34c2a9a06b1ee91874c30807d09` |
| SSDLC lifecycle candidate | `release/ssdlc-lifecycle-candidate` | `9f899df5cb044ea3eb6f90ce84a3a10e25942862` |
| Wave 4 merge | local merge commit | `e67c8588aa2c94ab7774afe693a0fff9569a2a4d` |
| SSDLC merge / semantic union | local merge commit | `1b53062ee` |
| Authority remediation | local commit | `f20d7dfb1090c6958829ca0b221c097dc968f0b2` |
| License correction | local commit | `5cbfb5a66` |
| Generated DB safety parity | local commit | `b312ad1cd` |
| Git-provenance test fixtures | local commit | `beca2fea99344ddf11fe810c283853cc1afd439b` |
| Bound QA report and retained browser evidence | local evidence commit | `abba72d28deaf29e7131066f3eae9f43c66f358c` |

Combined branch: `integration/ssdlc-wave4-combined-review`

Combined worktree: `/private/tmp/rorca-ssdlc-wave4-combined-review`

Archive refs created before integration:

- `refs/archive/20260716/recovery-wave4-c45ad33f9`
- `refs/archive/20260716/ssdlc-candidate-9f899df5`

Both source worktrees were clean at the recorded heads and were not changed. `origin/main` had not advanced beyond the shared recorded base. Wave 4 contains remediated equivalents of the earlier pass-integrity work and supersedes `/private/tmp/rorca-wave-pass-integrity`; that branch was not merged independently.

## Integration strategy

1. Fetched and verified `origin/main`.
2. Created archive refs for both exact inputs.
3. Created a new worktree and branch from current `origin/main`.
4. Merged canonical Wave 4 first without source conflicts.
5. Merged SSDLC second.
6. Manually resolved all four source conflicts as semantic unions.
7. Regenerated the OpenAPI snapshot instead of selecting either generated conflict side.
8. Reviewed all six auto-merged overlap paths and TypeScript/JavaScript runtime parity.
9. Applied and repeated the complete migration set in an isolated restricted `_test` database.
10. Ran Recovery, SSDLC, pg-boss, frontend, Playwright, contract, licensing, build, and broader regression checks.

## Conflict resolutions

### `backend/src/lib/execution-engine.ts`

The result preserves both authority models:

- Uses SSDLC's process-tree termination helper and detached-process-group metadata while preserving Wave 4 process containment.
- Exports `PiCliSelection` as required by SSDLC tests and callers.
- Keeps host-resolved immutable execution-manifest model/effort authority and records that effective posture for configured-agent merge resolution.
- Keeps the exported, lock-protected `MarkStoryPassedResult` contract used by recovery reconciliation.
- Uses `isPassed()` for duplicate detection and returns `{ changed, storyFound }` without duplicate mutation.
- Calls `recordIntegratedCheckpointAttestation(...)` after run-branch integration and before `markStoryPassed(...)`.
- Suppresses duplicate WAL/result/memory finalization when pass state did not transition.
- Preserves completion packets, commit SHA/message/branch, token/cost/graph/skills payloads, story-result persistence, WAL evidence, and memory synthesis.
- Keeps the closeout handoff mandatory for merged parallel stories; a merged story without an accepted closeout packet fails closed.
- Preserves manifest-authoritative model/effort selection and configured-agent resolver posture rather than introducing Claude fallback.

Final semantic order:

1. story implementation and host closeout accepted;
2. story worktree merged into the run branch;
3. integrated tree checked for unmerged files, conflict markers, and `git diff --check` failures;
4. exact run-branch checkpoint attestation attempted after integration;
5. canonical pass mutation performed once;
6. WAL, story result, completion packet, tokens, provenance, and memory follow-up persisted.

Crash behavior remains safe:

- Crash after attestation but before pass: exact attestation permits bounded reconciliation.
- Attestation failure: current completion may continue, but recovery has no shortcut and fails closed.
- Duplicate finalization: no duplicate pass/WAL/result side effects.
- Integration conflict or missing closeout handoff: no canonical pass.
- Dry run: attestation persistence is skipped.

### `backend/src/lib/pg-boss-schemas.ts`

Created the strict union of both payload contracts:

- Wave 4 opaque `secretReferences` and non-secret `envOverrides`.
- SSDLC `safetyOptions` and immutable `executionManifestPath`.
- Governed retry preview/scope/plan hashes and exact approved preview.
- Numeric PostgreSQL run IDs remain payload data and are normalized at producer boundaries.
- pg-boss job UUIDs remain pg-boss generated; no numeric ID is placed in the pg-boss `id` option.

### `backend/src/routes/pipeline.ts`

Preserved public recovery telemetry and SSDLC governed execution/retry behavior. Important remediation found during review:

- **Fixed implicit merge authority:** SSDLC's `autoMerge !== false` behavior could default a worktree run or queued run to merge-enabled. Combined behavior requires explicit `autoMerge === true`.
- **Fixed queued promotion authority drift:** promotion now loads and validates the queued row's immutable effective options, refuses missing/mismatched queue identity, and cannot broaden frozen merge strategy, auto-merge, graph, terminal, deploy, or external-send authority through a later request.
- **Fixed BIGINT promotion identity:** promoted `queuedRunId` is normalized before immutable manifest creation and API response.
- Preserved SSDLC effective run options, manifests, retry preview identity, exact scope checks, pre-run approval hooks, and lifecycle invalidation.
- Preserved Wave 4 opaque secret references; decrypted values are resolved only for the hook/worker process and do not enter pg-boss payloads.
- Preserved task-manifest compatibility and recovery telemetry.
- Removed the conflicting dormant Claude-specific pipeline resolver block; configured-agent merge resolution remains canonical.

### `backend/src/worker.ts`

Combined payload destructuring rather than choosing one side:

- Fresh runs receive both `executionManifestPath` and opaque `secretReferences`.
- Retries receive immutable preview/scope/plan identities, manifests, and secret references.
- Worker validates strict schemas before execution.
- Queue registration remains singular and relies on `initBoss()`/`ensureQueues()` to create pg-boss v10 queues before `work()`.
- Cancellation, PTY signaling, closeout drain, stale-job recovery, process cleanup, and graceful shutdown remain present.

### `docs/openapi-public-snapshot.json`

No hand merge was retained. The canonical contract generator produced contract `8.0.0` with 116 public routes. Contract stability accepts the three explicit major-version override markers and reports the intended additive recovery telemetry and SSDLC authoring routes.

## Auto-merged overlap review

| File | Review result |
|---|---|
| `backend/src/db/pg-index.js` | Duplicate-prefix guard and search-path behavior preserved; fresh migration run proved runtime behavior. |
| `backend/src/lib/db-strategy.js` | Dedicated test URL is preserved whole; production credentials are not reused with a renamed database. |
| `backend/src/lib/run-queue.ts` | Carries stored merge/graph/terminal/agent/model/effort data; promotion route now re-verifies immutable effective safety options server-side. |
| `backend/src/routes/__tests__/pipeline.test.ts` | Both contract families remain represented; broader historical fixture drift remains separately reported. |
| `backend/src/server.ts` | Recovery router registered once under `/api/admin/recovery`; four lifecycle routers registered once under `/api/lifecycle`. |
| `docs/OPEN_API_CONTRACT.md` | Regenerated with the public snapshot; documents contract 8.0.0. |

The build exposed stale tracked runtime JS: `backend/src/db/index.js` did not include the TypeScript application-pool identity/owner check and its required `test-db-safety.js` did not exist. Commit `b312ad1cd` restores runtime parity.

## Migration review

- No duplicate numeric migration prefixes.
- No combined migration creates, alters, or drops `pgboss.*`.
- Wave 4 migrations precede later SSDLC decisions/retry/lifecycle migrations:
  - `20260715140000_checkpoint_reconciliation_attestations.sql`
  - `20260715141000_checkpoint_attestation_immutability.sql`
  - `20260715143000_ssdlc_decisions.sql` and later SSDLC migrations
- Exact checkpoint identity has a unique database constraint.
- Evidence updates and deletes are blocked; only one-way revocation is allowed.
- SSDLC lifecycle, plan, evidence, decision, retry, mutation, index, and Learn closeout migrations remain intact.

Disposable database used for focused validation:

`rorca_ssdlc_wave4_review_20260716_test`

Server-verified identity:

- database: `rorca_ssdlc_wave4_review_20260716_test`
- login: `rorca_test_runner`
- owner: `rorca_test_runner`

The restricted role cannot provision extensions. External setup on only the newly created disposable database installed `vector` and `age` and granted the minimum AGE catalog read needed by the legacy migration guard. Jest did not create a database or extension.

Final migration result:

- 177 ledger rows
- latest version `20260715200000`
- first complete pass: 176 applied, one intentionally skipped legacy graph collision
- second pass: zero applied, 177 skipped

A real PostgreSQL attestation probe confirmed:

- duplicate exact recording remains one row;
- evidence mutation blocked;
- deletion blocked;
- one-way revocation allowed;
- reverse revocation blocked.

## Validation results

### Focused backend

| Matrix | Result |
|---|---|
| Recovery Wave 4 final matrix | 15 suites, **137/137 passed** |
| SSDLC canonical baseline | 32 suites, **341/341 passed** at implementation commit `f20d7dfb1`; final non-behavioral commits produced 339/341 before global cleanup timeouts, with the complete retry suite **13/13 passed** immediately on isolated rerun |
| Additional SSDLC/Learn tests | 33 suites, **307/307 passed** |
| Frozen queued-promotion authority | **3/3 passed** |
| Real pg-boss v10 cancellation | **2/2 passed** (queued cancellation and running SIGTERM) |
| Pipeline readiness with real Git fixture | passed |
| Graph trigger with real Git fixture | **2/2 passed** |

The later 32-suite timeout failures occurred in `jest.pool-cleanup.ts` before test bodies after heavy repeated use of the same disposable database. Each affected test/suite passed in isolation, and the exact 341-test matrix had already passed before documentation/license/runtime-parity-only commits.

### Frontend and packages

| Check | Result |
|---|---|
| Focused Lifecycle frontend | 16 files, **104/104 passed** (prior baseline 102) |
| Full frontend Vitest | 82 files, **967/967 passed** |
| Pi extension Vitest | 11 files, **87/87 passed** |
| Capture package Vitest | 8 files, **75/75 passed** |
| Root frontend TypeScript | passed |
| Backend TypeScript | passed |
| Public-contract, capture, and bin TypeScript | passed |
| Full `npm run typecheck` | blocked only in Pi extension by pre-existing optional standalone types: `@mariozechner/pi-tui` and `typebox`; affected runtime tests pass |

### Playwright

Executed against an isolated Vite-only server at `127.0.0.1:55210`; the live Rorca stack was not used.

- Lifecycle golden journey: passed.
- 50-row lifecycle matrix performance: passed.
- Interaction feedback observed approximately 15–21 ms.
- Eleven required light-theme screenshots retained.
- No Slack, merge, deployment, production mutation, or external runner side effect.

Evidence:

- [`evidence/ssdlc-wave4-combined-review/evidence-bundle.json`](./evidence/ssdlc-wave4-combined-review/evidence-bundle.json)
- [`evidence/ssdlc-wave4-combined-review/validation-metadata.json`](./evidence/ssdlc-wave4-combined-review/validation-metadata.json)
- [`evidence/ssdlc-wave4-combined-review/screenshots/`](./evidence/ssdlc-wave4-combined-review/screenshots/)

### Static and build gates

- Production build: passed (frontend, backend, bin, capture).
- Frontend ESLint: zero errors, 65 baseline warnings.
- Targeted merged-source ESLint: zero errors, one existing worker console warning.
- Tier lint: passed; 117 public, 46 auth, 17 paid, 38 admin; 116 stable public routes and 163 MCP tools.
- Recovery admin routes remain `admin` and MCP-excluded.
- Swagger coverage command completed with 18 existing missing-annotation warnings.
- Public contract regeneration and stability check: passed with acknowledged 8.0.0 override markers.
- Apache-2.0 license check: 1,151 source files passed after restoring missing Wave 4 headers.
- License boundary and OpenCore export checks: passed/skipped as designed.
- `git diff --check`: passed.

### Broad regression

The full backend suite was run against a separate fresh restricted database, `rorca_ssdlc_wave4_broad_20260716_test`, but exceeded the 45-minute command budget before Jest emitted final totals.

Observed before timeout:

- 198 suite pass lines;
- 91 suite fail lines;
- no lingering Jest process after timeout;
- database identity remained the restricted `_test` database and owner.

The canonical Wave 4 baseline had 87 failing suites. Comparison found eleven suites newly observed as failures and seven prior failing suites now passing. Of the eleven newly observed:

- six passed immediately in a bounded rerun;
- the two manifest/Git-provenance fixture failures were fixed and passed targeted reruns;
- the remaining failures are existing order/fixture/post-save-generation drift (`QRW-006`, batch specs, and spec-job retrieval feedback), not a merged recovery/lifecycle authority failure.

This does not make the repository-wide suite green. It remains explicit release debt and must not be represented as passed.

## Security and authority review

### Confirmed

- No story passes solely because an agent exits successfully.
- Parallel stories pass only after their contribution reaches the run branch and the integrated tree validates.
- Trusted checkpoint attestation is created by Rorca, not Hermes, and is recorded before canonical pass mutation.
- Recovery lookup and mutation are admin-only, exact-identity, and MCP-excluded.
- Recovery cannot accept caller-authored validation prose or commands as evidence.
- Attestations bind workspace, run, story, branch, full checkpoint SHA, gate, and evidence digest.
- Duplicate/replayed finalization is idempotent.
- Secret values do not enter pg-boss payloads; workers receive opaque references.
- Configured-agent merge resolution has no ambient Claude fallback.
- Worktree isolation does not imply auto-merge authority.
- Queued promotion cannot broaden frozen merge/graph/safety options.
- PostgreSQL BIGINT run IDs are normalized before strict worker/manifest contracts.
- Test setup and application pools verify `_test` suffix, expected database, connected login, and database owner.
- No migration manages `pgboss.*`; pg-boss v10 queues are explicitly created.
- Lifecycle UI remains a client of server authority and cannot set canonical status directly.

### Residual risks

1. Repository-wide backend Jest remains slow, order-sensitive, and not green; global per-test truncation can exceed its 30-second hook timeout after prolonged runs.
2. Standalone Pi extension typecheck lacks optional peer type packages even though Pi extension runtime tests pass.
3. Attestation persistence is best effort for current completion. Failure safely removes later recovery authority but should remain operationally observable.
4. A successful process-level recovery reconciliation still requires a genuine recoverable failed/cancelled run with exact branch head; no production-like history was fabricated for this review.
5. Existing worker/server test imports accumulate process listeners and emit open-handle/force-exit advisories.

No unresolved P0/P1 security or lifecycle-truth defect was found in the combined feature surfaces after remediation.

## Production and cleanup declaration

- The live `rorca` database was not connected to by test credentials and was not migrated, truncated, reset, restored, renamed, or otherwise mutated.
- No production service was restarted or stopped.
- No source worktree or source branch was rewritten.
- No push, force-push, PR update, merge, auto-merge, deployment, canary, external send, or human sign-off occurred.
- Test execution used only newly created databases ending in `_test` and the restricted `rorca_test_runner` login/owner.
- Both review-created databases (`rorca_ssdlc_wave4_review_20260716_test` and `rorca_ssdlc_wave4_broad_20260716_test`) were identity-checked and removed after validation. Their temporary credential files were removed.
- A final read-only catalog check found the pre-existing `rorca_test` database owned by `rorca`, not `rorca_test_runner`; this review did not alter it. The candidate's owner check will therefore fail closed until that external test-fixture drift is corrected through the approved provisioning path.
- The isolated Vite process, Playwright browser, Jest processes, and other task-owned validation processes exited.

## Final recommendation and PR 16 action

**Recommendation: ready for human review, but not ready for automatic merge/deploy.**

Recovery Wave 4 guarantees remain intact. SSDLC lifecycle, closeout, retry, evidence, cancellation, UI, and retained journey guarantees remain intact. The combined candidate also closes two important integration-only authority defects: implicit auto-merge and queued-promotion option broadening.

Exact next action for PR 16:

1. Do not merge the current SSDLC-only PR 16.
2. After explicit authorization, publish `integration/ssdlc-wave4-combined-review` as the replacement review head or open a replacement PR that clearly supersedes PR 16.
3. Bind human review to the final published SHA and retained combined evidence.
4. Keep deployment and autonomous recovery arming disabled until separately approved.
