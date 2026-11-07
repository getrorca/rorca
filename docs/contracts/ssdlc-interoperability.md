<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
-->

# SSDLC interoperability contract

This is the canonical ownership and compatibility boundary for the Source-Verified
SSDLC Universal Controls System, Hermes Mission Gateway, Context-Aware Assurance,
and the Rorca Execution Engine to OMP Migration. It applies Consumer-Driven
Contracts: a provider owns one contract; every consumer validates its expectations
against that provider's artifact. This document does not grant lifecycle, approval,
execution, or release authority.

The sole executable artifact is `source-verified-hermes-rorca-omp-ssdlc-delivery-program`.
`US`, `HMG`, `AAV`, `MIG`, and `INT` remain story-prefix module boundaries inside
its one dependency graph; they are not independently triggered specs.

## Ownership

| Contract | Canonical owner | Consumers |
|---|---|---|
| Source and intent contracts | HMG-001 | HMG adapters/compiler, spec persistence, assurance compiler |
| Spec/run identity | `EntityRefV1` and `RevisionRefV1` | all participants |
| Control schema and catalog | US-001 and US-008 | resolver, gate compiler, AAV compiler/kernel |
| Applicability resolution | US-003 | US-004, AAV-005 |
| Gate and evidence requirements | US-004 | US-005, AAV execution, lifecycle projections |
| Lifecycle evidence | `rorca.lifecycle-evidence.v1` and `hermes.evidence.v1` | AAV producers, US-005 evaluator |
| Exceptions and gate decision | US-005 | AAV and lifecycle projections |
| Structured findings | US-006 | AAV phase-review agents |
| Learn candidates | US-007 | AAV-022 adapter |
| Assurance profile and mechanism binding | AAV-001/004/005 | AAV-002/006 and lifecycle execution |
| OMP orchestration payload | AAV-007 | AAV Run View and subscription |
| Gateway payloads and Hermes skill | HMG-010 | Hermes supervisor |
| Executor launch, waves, and executor parity | MIG-001…005 | AAV qualification and pipeline dispatch |

## Immutable identity chain

Every integration path preserves the same workspace, spec revision, and execution
identity:

```text
SourceBundleV1.bundleHash
  -> persisted exact spec revision (EntityRefV1 + RevisionRefV1)
  -> rorca.assurance-profile.v1 compilationReceiptHash
  -> run manifest / story result
  -> rorca.lifecycle-evidence.v1 subject and releaseIdentity
  -> gate decision and supervision event
```

A consumer MUST reject a stale or mismatched identity. The current context itself
MUST contain a `kind: spec` `EntityRefV1` whose embedded revision exactly matches its
`RevisionRefV1`; callers cannot use an inconsistent pair to make a profile appear
current. A new source bundle creates a new spec revision; it invalidates the attached
assurance profile and cannot silently reuse evidence bound to the old revision or
compilation receipt. Both the persisted bundle ID and canonical bundle hash are
checked at read time. Absence is handled only by the explicit empty
`profileKind: default` compatibility profile; that profile is readable but uncompiled
and has no controls, source binding, or receipt authority.

### Assurance profile v1

`backend/src/ssdlc/assurance-profile.ts` owns the executable
`rorca.assurance-profile.v1` contract. A compiled profile is recursively frozen and
contains:

- a `specRef` of kind `spec` whose embedded `RevisionRefV1` exactly equals the
  required `specRevision`;
- `repositoryContextHash`, risk profile, and deterministic
  `compilationReceiptHash`;
- `controlInstances` addressed only by the US-001 `controlId`, with repository
  mechanism bindings, deterministic criteria, and structured evidence matchers;
- when HMG source context was persisted, its `SourceBundleV1` `bundleId`,
  `bundleHash`, and the exact spec revision against which it was persisted.

Compilation and read-time validation consume
`backend/src/ssdlc/catalog/controls.json` directly. Unknown control IDs and evidence
requirements that diverge from that catalog are rejected. A changed spec revision,
repository context hash, or source bundle hash rejects the old profile and requires
new compilation; evidence consumers must bind evidence to the resulting exact
revision and receipt rather than carry evidence forward implicitly.

Assurance profiles are attached lifecycle artifacts. Compilers MUST NOT add synthetic
approval, review, evidence, or other lifecycle boilerplate stories to the product
spec. Existing product stories remain the executable product scope.

## Compilation and evaluation pipeline

```text
HMG source compilation and explicit persist
  -> US-003 applicability resolution
  -> US-004 phase control groups and seven-stage readiness projection
  -> AAV-004 mechanism discovery
  -> AAV-005 mechanism/criteria binding into rorca.assurance-profile.v1
  -> AAV-002 execute -> judge -> bind
  -> AAV-006 canonical lifecycle evidence emission
  -> US-005 gate evaluation
  -> HMG/AAV supervisor projection
  -> US-007 pending-review learning candidate
```

AAV-005 MUST NOT select mandatory controls independently. US-003 and US-004 own
selection. AAV binds repository mechanisms and deterministic criteria to the already
active control requirements.

### Canonical control contract

`backend/src/ssdlc/schema/control-schema.ts` owns the `ControlRecord` TypeScript
contract and runtime parser. `backend/src/ssdlc/schema/control-schema.json` is its
published JSON Schema draft 2020-12 artifact. Catalog entries in
`backend/src/ssdlc/catalog/controls.json` are records of that contract and are
addressed only by `controlId`.

Assurance compilers and AAV adapters consume those artifacts directly. They MUST NOT
publish a second catalog, copy the `ControlRecord` shape, or introduce a separate
`controlRef`; a compiled assurance reference is the canonical `controlId`. Provider
and consumer fixtures are validated by the same runtime and JSON Schema boundaries.

### Verified Genesis binding

Every catalog `ControlRecord` names the authority for each control through
`sourceReferences`: an exact `genesisEvidenceId` (`GEN-…`) plus the exact citation
text. `backend/src/ssdlc/genesis/source-authority.ts` owns the canonical projection
of those records and their immutable bridge provenance (`reviewStatus` and
`access`). Registration cannot change review or access state, access-denied records
are not resolvable, and `validateControlAgainstGenesis` rejects a control whose
source references do not resolve through the bridge. `resolveAuthority` follows
Genesis-declared supersession links to the currently authoritative record, and
`detectContradictions` groups explicit Genesis contradiction markers.

Production Genesis packages register only through the authority bridge in
`backend/src/ssdlc/genesis/genesis-authority-bridge.ts` (`registerGenesisPackage`) —
the sole production registration seam. Restricted chunk content never leaves the
bridge: an uncleared principal receives the redaction marker, never vault bytes.
The published approved projection `backend/src/ssdlc/catalog/genesis-evidence.json`
and the catalog suite (`catalog.node.test.ts`) prove the binding: every exact
source citation in the catalog resolves through the approved Genesis projection,
matches the Genesis evidence strength, and has no duplicate or dangling reference.
Genesis evidence may enter agent/skill context only after a host verifies a
published approved export package; until then, the resulting gap remains visible.

## Evidence and findings

AAV kernel output is internal. AAV-006 translates it to the existing canonical
`rorca.lifecycle-evidence.v1` record (or authenticated `hermes.evidence.v1` ingress)
before US-005 evaluates it. An evidence requirement is a structured matcher, not an
untyped string: it specifies classification, allowed source types, required
subject/release bindings, minimum trust, evidence depth, and freshness.

AAV phase-review agents emit the US-006 `StructuredFinding` shape. US-007 is the
only candidate generator; AAV-022 adapts heal and run outcomes to
`consumeProductionOutcome` and never maintains a second candidate store.

## Stages, phases, and transport

The 11 SSDLC phase categories remain canonical for control coverage and drill-down.
They project to seven Mission stages; only the first six can block a normal delivery:

| Mission stage | Phase categories | Normal behavior |
|---|---|---|
| planning | intake | blocking when intake evidence is absent |
| requirements | requirements | blocking when active requirements controls are unresolved |
| design | architecture | blocking when active architecture controls are unresolved |
| development | implementation | blocking only on active implementation controls |
| testing | validation, security, qa | blocking |
| deployment | staging, merge, production | blocking when applicable |
| maintenance | learn | asynchronous and non-blocking |

`backend/src/ssdlc/profiles/general-sdlc-7.ts` is the single source of this projection:
the profile fixes the stage ids (`general-sdlc-7`, version 1), each stage's phase
categories, the blocking set (everything except `maintenance`), and a deterministic
`contentHash` over the mapping. Every compiled lifecycle plan embeds the profile
(`profileId`, `profileVersion`, `profileHash`, `stages`, `blockingStages`), and the
compiled-plan store records that hash (`ssdlc_compiled_plans.profile_hash`), so a
stage-mapping edit changes the content hash and supersedes plans compiled under the
previous mapping even when the spec material hash is unchanged.
`backend/src/ssdlc/schema/control-schema.ts` derives `MISSION_STAGE_BY_PHASE` from the
profile, keeping it the single source of the stage mapping.

US-004 compiles phase control groups and this stage projection; the full-chain
qualification fails unless the readiness projection lists exactly the seven canonical
Mission stages with `maintenance` non-blocking. The projection does not create 11
independent blocking workflow transitions. Risk, regulatory policy, or a governed
exception may surface a phase-specific approval within its stage.

The existing WAL/SSE envelope is the sole transport. AAV-007 owns only versioned
`orchestration.*` payloads. HMG-010 owns versioned `gateway.*` payloads. AAV-011
subscribes to the shared envelope and exposes both payload families to Hermes.
`ActionEnvelopeV1` remains a server-authored permitted-action descriptor, not a
generic event envelope.

## Component parity qualification

AAV-010 is deliberately narrower than release interoperability. Its runnable scenario is
`backend/src/ssdlc/__tests__/aav-omp-parity-qualification.node.test.ts`, using the
fail-closed coordinator in `backend/src/ssdlc/aav-omp-parity-qualification.ts`. The
scenario produces a `rorca.aav-omp-parity-qualification.v1` receipt only when:

- AAV-007 durable OMP events bind the compiled profile's exact persisted spec revision
  and spec hash, contain a complete agent lifecycle, and retain retry/continuation data;
- AAV-006 canonical evidence binds that profile receipt, exact revision, spec hash, and
  Git commit before the US-005 stage outcome is accepted;
- a failed subagent has canonical non-passing evidence with an actionable gap and the
  same blocked control appears in the US-005 trace; and
- the Run View Agents tab reconstructs from the durable WAL sequence while its separate
  raw Terminal tab remains available for diagnosis.

The receipt points back to this section as its qualification boundary. It is a component
integration receipt, not proof of source ingestion, supervision, release, or learning.
The whole-program INT-002 release proof is the database-free scenario in
`backend/src/ssdlc/__tests__/full-interoperability-qualification.node.test.ts`, coordinated by
`full-interoperability-qualification.ts`. It consumes provider-owned artifacts (rather than
implementing a second execution path) and fails closed unless the source hash, exact revision,
profile, run manifest, evidence, blocked/recovered gate receipts, Hermes replay, source-drift
invalidation, and one deduplicated pending-review learning candidate agree. CI runs it in the
SSDLC contract job:

```sh
cd backend && npm run verify:ssdlc-interoperability
```

Run the narrower component scenario without a database:

```sh
cd backend && node --import tsx --test src/ssdlc/__tests__/aav-omp-parity-qualification.node.test.ts
```

## Executor and recovery compatibility matrix

INT-003 is the database-free, fail-closed matrix in
`backend/src/ssdlc/executor-recovery-compatibility.ts`, exercised with the versioned
fixture `executor-recovery-matrix.v1.json`. It verifies that sequential and
wave-parallel OMP rows have identical manifest, story-result, and WAL/release-intent
identity; heterogeneous stories retain their declared executor and unique worktree
under `normal-wave` merge policy; and an explicit Pi fallback is qualified by
MIG-003 and remains Pi on retry. It consumes Rorca's production provider-fallback
policy to prove that OMP records the named alternate and original failure reason
without changing control or gate semantics.

The same matrix verifies replay-stable OMP and Pi event sequences and exactly one
terminal event after each process and worktree is closed. A passing receipt embeds
the exact run `EntityRefV1`, spec `EntityRefV1`, matching `RevisionRefV1`, and the
INT-001 registry digest. The registry writer attaches it at
`qualifications.executorRecoveryMatrix`; therefore the CI-uploaded INT-001 artifact
is also the canonical INT-003 matrix result. The qualifier grants no execution,
merge, gate, or release authority.

## Executable consumer-driven registry

`backend/src/ssdlc/interop/contract-registry.ts` is the release-gate source of truth for
shared contract ownership. Each `(contract, version)` has one provider artifact and an
explicit executable fixture/assertion for every named consumer. The registry reads the
published US-001 JSON Schema and US-008 catalog from disk and uses the production runtime
schemas/functions for identity, source/intent, stage projection, assurance profile,
lifecycle/Hermes evidence, orchestration, gateway, findings, and learning candidates.
It does not maintain substitute control or evidence catalogs.

Run the database-free CDC gate locally or in CI:

```sh
cd backend && npm run verify:ssdlc-contracts
```

The command fails on malformed provider data, an unregistered version, duplicate ownership,
or a consumer without an executable assertion. On success it writes the machine-readable
`backend/artifacts/ssdlc-contract-registry-receipt.json`; CI uploads that receipt. The
orchestration and gateway assertions additionally pass both payload families through the
canonical WAL/SSE subscription envelope and reject either payload as `ActionEnvelopeV1`.

## Change discipline and executable proof

- New optional fields or contract kinds are minor/additive.
- Shape, identity, or semantic changes require a new major version with every
  consumer named and tested.
- An internal implementation change is patch-only when the published contract is
  unchanged.
- A contract-registry suite MUST load provider schemas and artifacts and execute
  consumer expectations; prose compatibility is insufficient.
- The interoperability qualification spec is the release proof for the complete
  source -> assurance -> OMP -> evidence -> gate -> supervision -> learning chain.
