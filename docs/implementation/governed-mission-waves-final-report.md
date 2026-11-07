<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Governed mission waves integration report

Verdict: **WAVE 2 IMPLEMENTED; DOWNSTREAM OPERATIONAL REQUIREMENTS DRAFTED; ALL CANONICAL PASSES REMAIN FALSE; FRESH PREFLIGHT, EXACT-SHA INDEPENDENT REVIEW, AND HUMAN CLOSEOUT REQUIRED**

This is an implementation/evidence and downstream documentation report, not approval, pass, closeout, execution authority, merge authority, deployment proof, provider consent, or production state.

## 2026-07-29 governed Hermes operations documentation revision

The isolated documentation branch `docs/hermes4friends-ops-takeaways-20260729` started from exact SHA `ea88f5484549d54a89fb9e2241012b6f77640a45`. It adds architecture and pending downstream requirements only. It does not alter Wave 1 or Wave 2 story/criterion text, production code, migrations, databases, services, providers, runs, approval, merge, deployment, Linear, Genesis, or proof state.

Canonical architecture is [`../architecture/governed-hermes-operations.md`](../architecture/governed-hermes-operations.md). It defines the governed Doctor check/fix loop and authority classes; typed dependency admission; workspace/runtime CPU, memory, concurrency, event, context, storage, retry, and provider-cost quotas; observability isolation and seven status planes; idle-loop suspension; supervisor/worker failure isolation; inventory-backed provider/runtime/Forgejo provisioning/offboarding; identity-preserving updates; noisy-neighbor fault isolation; clean-room reconstruction; and explicit unsafe patterns not to copy. PostgreSQL/Git/host evidence authority and advisory memory remain unchanged.

| Pending downstream spec | Previous stories / criteria / SHA-256 | Current stories / criteria / SHA-256 |
| --- | --- | --- |
| Wave 3A | 9 / 52 / `aae3a068a9235aa911eda81f528842c2aadefef4640ff96e4bff981407762f77` | 9 / 67 / `249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d` |
| Wave 3B | 9 / 49 / `a3d465ae88ee85c2e48998ee135458dd302f614de71f06880577f028dc730ded` | 9 / 60 / `992cdad5119b7f4e359d3839665d10a9dd19aeec4fbdec6e2bf895c6f5e9ddd4` |
| Wave 4 | 10 / 62 / `9ad385c5c243bc48d2f0ea8bcd6c401c59675331719a40ef313214d7d65f437d` | 14 / 92 / `6c67ac5993d7de4a95ed82b7ab0d2a7c68fb98ae5bc17bc7d3f3ef65938e20cd` |
| Downstream total | 28 / 163 | 32 / 219 |
| All Waves 1–4 | 50 / 285 | 54 / 341 |

The current-path coverage ledger SHA-256 is `e9259f2baf4833cf69d541b55e2730d09d152da697c79e7e11d9f2094073854e`. It exactly mirrors all current story/criterion IDs and text. Wave 3A/3B/4 code, test, and evidence arrays remain empty and `gated`; every downstream `passes` is false, `authoring.state=stale_authoring_preflight`, `approvalReady=false`, and `executionAuthority=none`. The stale-current canonical and authoring material hashes were recomputed from current bytes while prior expected preflight hashes remain preserved as stale provenance. Fresh canonical preflight and independent review are required.

The DAG remains acyclic and preserves every prior edge. Only Wave 3A and Wave 3B may overlap, in separate worktrees/ownership zones with serialized shared generated files; Wave 4 remains sequential. The new Wave 4 operational stories gate the existing final bounded-pilot story and grant no additional provider, merge, or deployment authority.

## Source and gate identity

- Branch: `feat/wave2-governed-contracts-20260729`
- Required clean starting SHA: `dab2a136a1d1754ccdaeb15224a60a6e9dedd594`
- Wave 2 implementation source SHA before validation-evidence commit: `ffb7644315b3fb5908d659be0c998ef7478ea2a5`
- Wave 1 approved source prerequisite: `38d26ee944f0fd80904e79021100d5023b70f170`
- Reviewed context/spec source: `51df69a6016596df33dc486353620919c2a56c11`
- Wave 2 spec: 12 stories / 71 criteria, complete-file SHA-256 `8b6a36021eb7a2b42a141a4d7081eda77cb3f91dc157cf7c146c3b9b355b4730`
- Coverage ledger: `docs/implementation/governed-mission-waves-coverage.json`; all 71 entries have candidate code/test/evidence and remain `implementation_evidence_present_unreviewed`.

ROR-24 acceptance is bound by `docs/implementation/evidence/ror24-adr-0001-v1/acceptance-envelope.json`: exact pre-transition ADR SHA-256 `b6ca538e513716b5e331964af110c5f8b20d432c22308cac18099a3ef7f973a5`, exact Linear workspace/team/issue/state/comment/actor and snapshot SHA-256 `9946a04ece8f1d92b3f0682c1a6a7f131c6c095194b05ab2e09ce87c726fd7c6`. The governed source changed only ADR acceptance metadata. ROR-24 is schema-rejected as dispatch work.

Fresh deterministic Wave 1 and Wave 2 preflight ran twice and is recorded under `docs/implementation/evidence/wave2-authoring-preflight-20260729/`. Confirmation, persistence, and approval are intentionally null because no post-hash human confirmation was available. No identity was fabricated or reused as authority.

## Implemented Wave 2 boundary

- Deterministic LP1 hashing, version negotiation, strict MissionContract/WorkPackage/ExecutionLease/context/event/evidence/closeout/cancellation/proposal schemas and reproducible public JSON Schema/TypeScript exports.
- Stable missions, immutable mission/work-package/policy/context/event/evidence/closeout/cancellation/proposal revisions and mutable CAS heads where effective state must change.
- Fenced lease acquisition/renewal/release/cancellation/takeover using PostgreSQL time, one active slot, monotonic fences, runtime/repository/worktree/revision checks, and policy-activation head checks.
- Immutable policy definitions and activations with a revisioned activation CAS head; revocation makes old leases and unused continuation authority ineligible.
- Checkpoint, ordered receipt sources, required/advisory bundle separation, safe delta/full fallback, shared retry budget/quarantine, and double-verified one-use dispatch.
- Runtime-neutral events with explicit continuation identities, typed compaction/retry/completion-candidate material, generation/runtime/fence binding, three order domains, durable replay conflicts, and no closeout authority.
- Evidence with explicit spec/story/lease/activation/repository/worktree lineage, server-computed envelope identity, non-escalating trust, redacted read models, and runtime-asserted evidence excluded from eligible closeout.
- Server-evaluated immutable closeout eligibility with `establishesStoryCompletion=false`; existing accepted `StoryCloseoutDecision` remains the only story-completion authority.
- Append-only cancellation acknowledgements and non-mutating, no-scope-expansion plan-change proposals.
- Strict `/api/mission-control/v1` auth/admin/internal-runtime routes, bounded pagination/read models, durable audit/conflict records, standardized errors, Swagger tiers/rationales, and MCP exclusion for every mutation.
- Disabled-by-default non-authoritative current-executor compatibility projection; no parallelism, auto-merge, deployment, or provider behavior was enabled.
- Exact read-only ContextEpoch projection, bounded telemetry, explicit non-GET rejection, and an executable next-major/two-minor/90-day/zero-use/client/fixture/break-marker/independent-review retirement gate. No ContextEpoch writer, lease, head, or authority table exists.

Architecture, threat model, route boundary and local recipe: `docs/implementation/wave2-governed-mission-control-plane.md`.

## PostgreSQL and conformance evidence

Final fresh evidence directory: `docs/implementation/evidence/wave2-final-validation-20260729/`.

- Dedicated fresh `_test` database and owner: PG 16.13, vector 0.8.0, AGE 1.5.0, pgcrypto 1.3.
- Owner flags: login true; superuser/createdb/createrole/replication/bypass-RLS all false.
- Canonical migrations: 252, head `20260729134000`.
- Contract readiness: `1.0.0`, digest `sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2`, state `ready`.
- Required Wave 2 catalog relations: 14/14; RLS tables: 41; Wave 2 triggers: 58; pg-boss schemas: 0.
- DB integration: 1 suite / 10 tests passed.
- DB-independent contract/service/route/compatibility lane: 6 suites / 74 tests passed.
- Cleanup: service stopped, listener 0, DB state/socket/credential material absent, no prune.

The DB lane exercises immutable/CAS mission/work packages, idempotency conflicts, lease race/renewal/revocation/cancellation/takeover/release, context lineage, delta fallback, one-use dispatch, retry contention/quarantine, proposal scope denial, trust-bounded evidence, closeout, cancellation acknowledgements, and ordered/stale-generation events.

## Other validation

- Multi-project root/backend/CLI/Pi/public-contract/capture typecheck: passed.
- Frontend production build, backend build, CLI and capture builds: passed.
- Frontend Vitest rerun: 91 files / 1,046 tests passed.
- Pi extension: 19 files / 151 tests passed; generated runtime parity passed.
- Governed artifact stability, public contract stability, Swagger exact parity, tier/MCP lint: passed.
- License headers: 1,448 files passed. Frontend/backend lint had 0 errors and retained pre-existing warnings.
- Gitleaks exact implementation range `dab2a136a..ffb764431`: 0 findings.
- `git diff --check`: passed.

A repository-wide monolithic backend run was also attempted and is truthfully disclosed rather than relabeled: 431 suites / 5,081 tests passed; 39 suites / 190 tests failed under the ad-hoc shared certification topology. Failures include grant-incomplete `anon`/`authenticated` authority roles, direct-pool search-path assumptions, cross-suite retained rows, and unrelated existing release/execution-environment fixture state. The exact log hash and classification are in the final validation receipt. This is not a Wave 2 pass claim; the fresh isolated Wave 2 lanes above are the governed affected validation.

## Advisory memory

Mandatory memory policy was reread. Workspace `rorca` was searched before posting; foundation memories 4155-4161 were not duplicated. Newly validated remediation memories are:

- 4162 — server-computed replay identity;
- 4163 — host-trust closeout boundary;
- 4164 — append-only cancellation acknowledgement state;
- 4165 — activation revocation CAS head.

All were independently retrieved. Search found no stable rule requiring `SUPERSEDES` or `CONFLICTS_WITH`. Memory is advisory and cannot grant any authority.

## Remaining governed closeout

1. Independent architecture/authority/security, DB/race/recovery, and API/compatibility/conformance review of one exact final SHA.
2. Remediation of any substantiated P0/P1 finding followed by review of the new exact SHA.
3. Human review of the exact coverage and review packet. Story `passes`, approval readiness, and execution authority remain unchanged unless separately changed through canonical governed authority.
4. Only after separate human closeout may the isolated Wave 3A ROR-28 and Wave 3B ROR-25 workstreams overlap. Every other wave remains sequential.

No provider operation, protected-run access, ROR-24 dispatch, merge, deployment, readiness override, or story-pass mutation occurred.
