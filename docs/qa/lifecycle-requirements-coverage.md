<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Lifecycle requirements coverage report

- Spec: **Rorca Evidence-Driven SSDLC Lifecycle and Autonomous Delivery Steward**
- Run: `20260316000493`
- Coverage convention: `LFC-NNN.AC-*` means every acceptance-criterion reference persisted in that story packet; the story progress log is the detailed criterion source.
- Authority rule: implementation/tests are evidence for a gate, never an approval. A phase is complete only when the canonical evaluator sees eligible evidence and governed decisions on the current immutable subject.

## Requirement → story → gate → implementation/test/evidence

| Stable requirement reference | Story | Gate | Implementation | Test/evidence | State |
|---|---|---|---|---|---|
| `LFC-010.AC-*` | Pass reconciliation | Closeout integrity | `ssdlc-pass-reconciler.ts`, closeout persistence/migration | reconciliation unit/repository tests; LFC-010 progress evidence | Covered |
| `LFC-011.AC-*` | Smallest safe retry | Retry governance | `retry-governance.ts`, pipeline retry preview/dispatch, worker refusal | retry-governance/worktree/dispatch tests; retry option replay | Covered |
| `LFC-012.AC-*` | Liveness and next action | Runtime truth | `ssdlc-liveness.ts`, liveness read API | active/quiet/stalled/blocked/completed/unknown and false-positive regressions | Covered |
| `LFC-013.AC-*` | Lifecycle read API | Snapshot/read integrity | `ssdlc-lifecycle-read.ts`, lifecycle routes/indexes | route/read/provenance/performance tests; `docs/lifecycle-read-api.md` | Covered |
| `LFC-014.AC-*` | Governed mutation APIs | Mutation authority | lifecycle evidence/decision/mutation routes and idempotency migration | route/repository replay, workspace, conflict, SSE tests | Covered |
| `LFC-015.AC-*` | Typed clients/state/SSE | Client contract | `src/api/lifecycle.ts`, types, hook | API/hook URL/storage/SSE/stale-suppression tests | Covered |
| `LFC-016.AC-*` | First-class panel | Navigation | Lifecycle panel/sidebar/command palette routing | desktop/mobile/deep-link/navigation regressions | Covered |
| `LFC-017.AC-*` | Header/KPIs/filters/views | Portfolio operability | metrics/toolbar/panel and saved-view state | filter/debounce/persistence/refresh/keyboard tests | Covered |
| `LFC-018.AC-*` | Evidence matrix | Matrix truth | matrix/cell/KPI contract and performance fixture | matrix semantics/keyboard/pagination and 50×11 profile | Covered |
| `LFC-019.AC-*` | Phase drawer | Next-safe-action | phase drawer and server-authored guidance | drawer focus/order/permission/action tests | Covered |
| `LFC-020.AC-*` | Traceability/inspector | Evidence safety | traceability, inspector, raw-reference allowlist | API/hook/component/provenance/stale-inspector tests | Covered |
| `LFC-021.AC-*` | Retry/override/approval UX | Governed action | governed dialog, review tab, retry/decision clients | confirmation, duplicate, stale denial, recovery tests | Covered |
| `LFC-022.AC-*` | Backend exhaustive regression | Contract security | compiler/evaluator/manifest/architecture boundaries | prior 21 suites/240 tests plus LFC-026 broad 28-suite pass set; retry/timeout failures fixed and rerun | Covered; pg-boss cancel integration blocked separately |
| `LFC-023.AC-*` | Frontend/a11y/responsive/theme | UX quality | responsive drawers, focus, contrast/reduced-motion tokens | Vitest/axe/theme/API-client/performance evidence | Covered |
| `LFC-024.AC-*` | Golden staging journey | Journey evidence | deterministic fixture, Playwright journey, evidence bundle contract | fixture and discovery checks exist; actual final Playwright execution and human staging review are pending | **Blocked** |
| `LFC-025.AC-*` | Red-team and recovery | Security/authority | repeatable-read snapshots, exact adapter authority, liveness bounds, fail-closed retry | adversarial lifecycle/liveness/retry regressions and threat model | Covered and rerun |
| `LFC-026.AC-*` | Rollout/operations/release evidence | Release readiness | operations projection, redacted counters, runbook, architecture/release docs | focused operations/route tests plus final command ledger | **Blocked on human QA and final journey** |
| `LFC-027.AC-*` | Learn closeout | Learn governance | deterministic candidate producer and existing memory review lifecycle | redaction/dedupe/model/migration/route/UI tests; `docs/learn-closeout.md` | Covered |
| `LFC-028.AC-*` | Light-first polish | Visual quality | lifecycle tokens/components/states/visual fixture contract | focused visual/theme/responsive tests and source comparison; human capture approval pending | **Blocked** |

## LFC-026 acceptance coverage

| Reference | Gate/evidence | Status |
|---|---|---|
| `LFC-026.AC-01` bounded rollout/backfill | `POST /api/lifecycle/recompile`; `GET /api/lifecycle/operations`; operator runbook | Covered |
| `LFC-026.AC-02` health/observability | compiler readiness, adapter/conflict/denial/evaluator/transition/backfill WAL counters; no payloads | Covered |
| `LFC-026.AC-03` operator semantics/interactions/recovery | `docs/lifecycle-operations-runbook.md` | Covered |
| `LFC-026.AC-04` developer schema/profiles/contracts/SSE/KISS | developer guide in architecture ADR | Covered |
| `LFC-026.AC-05` public/shared contract governance | operations route is admin/non-public; Swagger/tier/contract/license/open-core checks must pass in final ledger | Validation pending |
| `LFC-026.AC-06` final traceability/no agent-only completion | this report plus evaluator authority rule | Covered structurally; release gate blocked |
| `LFC-026.AC-07` required final commands/journey | final evidence command ledger | Automated checks recorded; Playwright and baseline gates blocked |
| `LFC-026.AC-08` immutable human staging QA | human sign-off record | **Blocked: no human approval recorded** |
| `LFC-026.AC-09` complete final evidence | `docs/qa/lifecycle-lfc-026-final-evidence.md` | Pending final command/cleanup update |
| `LFC-026.AC-10` cleanup/no external side effect | final process inspection and evidence declaration | Pending closeout |
| `LFC-026.AC-11` release quality threshold | canonical coverage plus human QA and no P0/P1 | **Blocked until AC-07/08/13 pass** |
| `LFC-026.AC-12` residual-polish accounting | final evidence risk table; no hidden 95% claim | Covered structurally; final review pending |
| `LFC-026.AC-13` human visual matrix | immutable QA sign-off checklist | **Blocked: captures not human-approved** |
| `LFC-026.AC-14` non-generic dashboard quality | LFC-028 implementation/tests/source review | Implemented; human confirmation pending |
| `LFC-026.AC-15` all-story coverage incl. Learn/polish | this report includes LFC-010–028, LFC-027, and LFC-028 | Covered |
| `LFC-026.AC-16` full skill-first lifecycle docs | operator runbook + architecture ADR | Covered |
| `LFC-026.AC-17` five planes and three contracts | architecture ADR names `StoryExecutionManifest`, `StoryAttemptResult`, `StoryCloseoutDecision` | Covered |
| `LFC-026.AC-18` execution mode vs lifecycle status | operator runbook examples | Covered |
| `LFC-026.AC-19` execution non-regression matrix | final modes/agents/waves/PTY/retry/closeout evidence ledger | All pass except real pg-boss cancel integration; therefore blocked |

## Blocking conclusion

Coverage is not release approval. `LFC-024`, `LFC-026`, and `LFC-028` remain blocked until the actual Lifecycle Playwright journey and an authorized human staging/visual review are recorded against the final immutable revision. No percentage-complete substitute is valid.
