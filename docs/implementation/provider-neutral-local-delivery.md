<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Provider-neutral local delivery implementation packet

Status: **cleanup-only W1-010.4 remediation validated; independent review remains required**

This packet records source provenance and intended validation only. It is not spec approval, lifecycle evidence, independent review, provider consent, merge/deployment authority, or permission to mutate a live/proof run.

## Frozen scope

- Branch: `feat/provider-neutral-local-delivery-20260728`
- Original delivery base: `a8efec9023787edb525609fb8e9f8da77fd76ce0`
- Final remediation exact start: `407752564e654e1bc8d83af4d9f5154f6807f307`
- Functional remediation commit: `ca7e8a8b8bb8cedd0b3a2e874f3971516b678541`
- Wave 1 spec: `forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json`
- Spec before SHA-256: `0934cdff26bc35d72af84e958114b322186e1b21adacae510fb7fd9ee404425d`
- Spec after SHA-256: `caeb0720cd09f4e6a5cd22b078b2d50932b34613262c15631cdf71af9c056920`
- Material change: mandatory GitHub App W1-010 proof replaced by canonical provider-neutral local-review-bundle proof; GitHub retained as optional.
- Authoring state after change: `stale_authoring_preflight`, `approvalReady=false`, `executionAuthority=none`.
- Story pass flags: all remain `false`.
- Protected Genesis run: `20260316000549`; rejected before delivery reads/authority loading.
- Proof run `20260316000550`: not read, reconciled, or mutated.

The stale authoring object retains prior plan/preflight hashes and receipt IDs only inside an explicit `stale` provenance record. The old accepted plan, preflight, confirmation, lifecycle compile, and persistence receipt do not approve revised material. A future approval requires deterministic authoring preflight and governed approval against the revised bytes.

## Implementation map

| Boundary | Source |
| --- | --- |
| Versioned `local-review-bundle@1.1.0` adapter/manifest contract and local-default catalog | `backend/src/lib/delivery-adapter.ts` |
| No-network Git observation, bounded/secret-safe bundle assembly, atomic projection, PostgreSQL idempotency/read model | `backend/src/lib/local-review-bundle-adapter.ts` |
| Human-only creation middleware | `backend/src/lib/local-delivery-authority.ts` |
| Public safe reads and admin creation route | `backend/src/routes/delivery.ts`, `backend/src/server.ts` |
| Canonical append-only metadata, byte-derived hashes, authority locks/disqualification, changed-replay and non-destructive restart-maintenance audit | `backend/src/db/pg-migrations/20260727128000_provider_neutral_local_review_bundles.sql`, `backend/src/db/pg-migrations/20260727129000_local_review_bundle_final_remediation.sql`, `backend/src/db/pg-migrations/20260729130000_local_review_projection_non_destructive_maintenance.sql` |
| Public TypeScript contract | `packages/rorca-public-contract/src/index.ts` |
| Pi Workbench read-only surface plus separate exact-attempt admin client boundary | `src/api/delivery.ts`, `src/components/LocalReviewBundlesTab.tsx`, `src/panels/RunViewPanel.tsx` |
| Packaged Pi read-only surface | `packages/rorca-pi-extension/extensions/rorca/{api.ts,api.js,commands.ts,types.ts}` |
| Architecture | `docs/architecture/provider-neutral-delivery.md` |

The filesystem projection defaults outside the repository under the local Rorca data directory and is configurable with `RORCA_DELIVERY_ARTIFACT_ROOT`. PostgreSQL remains authoritative. Because portable Node has no descriptor-relative recursive removal primitive, restart maintenance retains orphan and crash-left staging trees unchanged and appends bounded operator-maintenance outcomes; it does not perform automatic destructive GC. Historical planned actions are reconciled without claiming deletion, and creation never invokes maintenance. No PostgreSQL, pg-boss, graph, lifecycle, GitHub, release, or deployment subsystem is replaced.

## W1-010 criterion traceability

| Criterion | Source/test evidence | Disposition |
| --- | --- | --- |
| W1-010:criterion:1 — versioned local default; GitHub optional | Adapter descriptors/catalog; route catalog test; existing GitHub contract/repository-authority regression suites | Author validation complete; independent review pending |
| W1-010:criterion:2 — exact immutable bundle identity/artifacts/receipts | Contract schema, local adapter, migration, unit and isolated-DB integration tests | Author validation complete; independent review pending |
| W1-010:criterion:3 — host-only pass; no merge/deploy | Host-envelope/closeout/attestation query, strict manifest literals, DB checks, route input rejection | Author validation complete; independent review pending |
| W1-010:criterion:4 — replay/restart/corruption/path/size/redaction/no-network | Focused adapter tests, migration test, DB integration test, source adversarial review | Author validation complete; independent review pending |
| W1-010:criterion:5 — safe Rorca/Hermes/Pi read model; authorized creation | Swagger/public contract, route tests, frontend API/component tests, Pi API/command tests | Author validation complete; independent review pending |
| W1-010:criterion:6 — independent exact-SHA review | Not author-satisfiable | **Blocked pending independent review** |

Criteria IDs are unchanged in the spec annotations and coverage ledger. Their text is synchronized with `userStories[W1-010]`; no criterion is marked passed in the canonical spec.

## Side-effect truth

This implementation did not call a provider, query GitHub, create a remote branch/PR/Check Run, push, merge, deploy, dispatch a workflow/release, mutate Genesis, reconcile a proof run, override readiness, or capture fake provider evidence. Test repositories and artifact roots are disposable local fixtures only. GitHub historical reports remain historical and are not rewritten as provider-neutral proof.

## Context-continuation integration

The separate branch `spec/context-continuation-retrieval-contract-20260728` at observed local SHA `51df69a6016596df33dc486353620919c2a56c11` is deliberately excluded. The exact conflict matrix is maintained in `docs/architecture/provider-neutral-delivery.md` and covers spec/authoring identity, migrations, public-contract/OpenAPI/MCP/Pi assets, context-vs-delivery authority, UI, and validation evidence. No current approval or report can be reused as integration authority.

## Cleanup-only W1-010.4 author-validation record

The final cleanup removes automatic destructive recursive maintenance because portable Node has no descriptor-relative removal primitive. Focused adversarial coverage exercises root/namespace/prefix/staging parent replacement, symlink/hard-link/oversize/count/depth failures, restart staging observation, historical planned-action recovery, canonical-reference preservation, audit failure before/after filesystem observation, commit failure, immutable snapshots, and create/maintenance separation.

- Focused adapter/migration lane: **2 suites / 31 tests passed**.
- Wave 1 unit lane: **20 suites / 179 tests passed**.
- Fresh isolated PostgreSQL 16.13/vector 0.8.0/AGE 1.5.0/pgcrypto 1.3 lane: all **248 migrations** and **5 suites / 35 tests passed** under a dedicated login owner with `rolsuper=false`, `rolcreatedb=false`, and `rolcreaterole=false`; exact cluster/listener cleanup completed without prune.
- Multi-package typecheck, root/backend lint (pre-existing warnings only), production build, package build, public contract build/stability, exact Swagger parity, tier lint, packed Pi parity, package dry-run, license checks, OpenCore candidate classification, Gitleaks diff scan, and `git diff --check` passed.
- Frontend and Pi sources were not changed; their full test lanes were therefore not rerun. Pi TypeScript/runtime and packed Forge parity were still exercised by package/parity gates.
- No provider, network delivery, push, merge, deploy, protected/live/proof run, Genesis, approval, preflight, readiness override, or shared database operation occurred. All story flags remain false and approval/execution authority remain absent.

These are author-side validation facts, not independent review, story pass evidence, spec approval, merge/deployment authority, or execution authority.

## Prior final-remediation author-validation record (historical at the required cleanup start)

The record below describes the pre-cleanup exact start `5a24f86c538a4c8c62eff9f924cefd44816f8608`; it does not validate the cleanup diff.

- Final implementation source before its documentation-only ledger update: `d54b5059c6ec0975f47e3bb0795cf7db5dd9c9b5`.
- Wave 1 unit lane: **20 suites / 164 tests passed**.
- Full frontend lane: **91 files / 1,046 tests passed**; packaged Pi lane: **19 files / 150 tests passed**.
- Fresh isolated PostgreSQL 16.14/vector/AGE lane: all **247 migrations** and **5 suites / 29 tests passed**, including the real disposable synthetic adapter proof (**1 suite / 3 tests**). The dedicated owner was non-superuser without create-role/create-database authority.
- Multi-package typecheck, production build, package build, frontend/backend lint (pre-existing warnings only), OpenAPI/contract/Swagger/tier checks, MCP and packed Pi parity, license headers, OpenCore classification, `git diff --check`, and redacted range Gitleaks passed.
- `npm audit --omit=dev` retains two package findings for one React Router RSC advisory (`GHSA-qwww-vcr4-c8h2`). This SPA does not enable React Router RSC mode, and the registry currently offers no non-breaking remediated release above the repository's existing security floor.
- No provider, GitHub, push, merge, deploy, protected/live run, Genesis, readiness override, or self-approval operation was performed.

These are author-side validation facts, not independent review, story pass evidence, spec approval, merge/deployment authority, or execution authority.

## Superseded pre-remediation validation record

The following results describe `5682da47126cd24d98320e1674bcef603c96ff29` only. They were reset after substantiated adversarial findings and are not evidence for the final remediation source:

- Wave 1 unit lane: **20 suites / 159 tests passed**.
- Full frontend Vitest lane: **91 files / 1,045 tests passed**.
- Full packaged Pi extension lane: **19 files / 149 tests passed**; packed Forge parity and `npm pack --dry-run` passed (41 files).
- Fresh PostgreSQL 16.14/non-superuser/BYOP: all **246 migrations** applied with zero skipped; the delivery migration was latest. The delivery integration suite passed **1 suite / 2 tests**, and the host/closeout authority regression set passed **4 suites / 22 tests** in a separate fresh invocation. Every scoped container, network, bind directory, listener, and test database was removed exactly.
- Multi-package typecheck, frontend/backend lint (baseline warnings only), production build, package build, contract generation/stability, Swagger parity, tier lint, license headers/boundaries, and `git diff --check` passed.
- Public contract is `21.0.0`; the existing acknowledged spec-approval break marker remains the only non-additive contract item.
- Gitleaks passed after ignored build products were removed; no provider/network operation was used by delivery tests.
- OpenCore classification has no unknown files; the private Wave spec remains intentionally blocked from export, while implementation reports require human review.

Retained baseline observations are not hidden: `npm audit --omit=dev` reports two high findings for React Router advisory `GHSA-qwww-vcr4-c8h2`, whose automated fix is breaking. One five-suite DB diagnostic also reproduced a pre-existing governed-retry lease-loss timeout after that suite had passed in the preceding fresh invocation; all delivery and host/closeout DB suites passed in fresh isolated lanes. Initial DB diagnostics additionally exposed fixture/provisioning issues (missing hosted roles, then an ambiguous test parameter), both corrected before the passing delivery lane. A post-test attestation probe queried `public` instead of the canonical `rorca` schema and exited nonzero after Jest had passed; the migration runner and integration assertions remain the authoritative table/trigger checks.

No author-side review satisfies W1-009.4 or W1-010.6. A genuinely independent reviewer must inspect the exact commits and residual observations before any approval, merge, deployment, live run, or provider action.
