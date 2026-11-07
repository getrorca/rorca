---
name: contract-interop-assessment
description: Assess interoperability between multiple specs, systems, or services and decide what to modify, remove, or add and to what degree, using Consumer-Driven Contracts (CDC) with contract semantic versioning. Use when asked to make several independently-planned systems/specs work together, determine cross-system impact, or audit a migration/integration for contract drift.
compatibility: Model-agnostic reasoning skill; works with any high-reasoning model. No runtime dependencies.
---

# Contract Interop Assessment (Consumer-Driven Contracts)

## The principle you may not know: Consumer-Driven Contracts (CDC)

Most teams design contracts from the **producer's** side: "here is my API/schema, consumers adapt." CDC inverts it: **every consumer writes down the exact expectations it holds of a provider, and those expectations are executable** (tests, schemas, assertions). A system is interoperable not when both sides "look compatible," but when every consumer's expectation set is *provable* against the provider's artifact.

The two companion ideas:

1. **Design by Contract (DbC)** — every contract has obligations and benefits on each side: preconditions (what the consumer must supply), postconditions (what the provider guarantees), invariants (what never changes). Interop analysis = checking each seam's three.
2. **Contract semantic versioning** — a contract change is classed like semver: **additive** (new fields/kinds — consumers unaffected), **breaking** (shape, identity, or semantics changed — every consumer must migrate), **internal** (implementation only — invisible). The "degree" of a change is exactly this class.

The decision rule that falls out: **add rather than modify, modify rather than remove, and never break a versioned contract without a migration plan.** Degree is forced by the change class, not by preference.

## Vocabulary

- **Contract** — any shared, versioned shape: schema, API, event kind, catalog entry, evidence envelope, manifest, protocol. Has `schemaVersion`.
- **Consumer** — a system/spec that *reads* or *depends on* the contract.
- **Provider** — the system/spec that *defines and serves* the contract.
- **Seam** — a point where two systems exchange a contract (the unit of analysis).
- **Owner** — exactly one provider per contract. Duplicate owners = guaranteed drift.
- **Change class** — `additive` (safe), `breaking` (migratory), `internal` (invisible).
- **Degree** — `patch` (internal), `minor` (additive), `major` (breaking) — semver on the contract's `schemaVersion`.

## Assessment procedure

For each seam between the systems under review:

1. **Inventory contracts.** List every shared shape and its `schemaVersion`. Include implicit ones (file paths, branch names, WAL event kinds, process identities).
2. **Map consumer → provider.** For each contract: who defines it (owner) and who consumes it. Flag any contract with two or more owners — that is the first interop defect.
3. **Classify the seam.**
   - Is the shape shared verbatim, or re-declared per system? (re-declaration = drift risk)
   - Do the versions agree? (mismatch = breaking state)
   - Do preconditions/postconditions/invariants line up per DbC?
   - Is there an executable check tying the consumer's expectation to the provider's artifact? (no = unverified interop)
4. **Determine change class per contract.** For each contract that needs change:
   - Can the provider *add* without affecting consumers? → `additive`/`minor`.
   - Must the shape, identity, or semantics change? → `breaking`/`major` — requires a migration plan naming every consumer.
   - Is only the implementation changing? → `internal`/`patch`.
5. **Decide modify / remove / add with degree.**
   - **Add** a new contract when the capability is genuinely new (no existing shape covers it). Degree: `minor` (new additive contract) — never `major` unless it replaces an old one.
   - **Modify** the *consumer* when the provider's contract is canonical (additive expectations, version-pinned). Degree: `minor`.
   - **Modify** the *provider* only when the contract is wrong or duplicated — and then prefer adding a new version over mutating the old. Degree: `major` only if old consumers cannot pin the old version.
   - **Remove** only when no consumer remains, and even then prefer deprecation-with-expiry. Degree: `major` (removal is always breaking while any consumer remains).
6. **Produce the interop statement.** One line per seam: `owner → consumer : contract@version — status (verified | additive-ok | breaking-needs-migration | duplicate-owner)`, plus the full change list with degrees and rationales.

## Decision signals

| Situation | Action | Degree |
|---|---|---|
| Two systems re-declare the same concept | Pick one owner; other becomes consumer | major (one-time) |
| Consumer needs a new field/kind | Provider adds optional shape; consumer pins | minor |
| Consumer needs different *semantics* of an existing field | New version of the contract, old pinned | major with migration |
| Capability has no existing shape | New contract | minor |
| No consumers remain | Deprecate; remove after expiry | major |
| Implementation changes, shape stable | No contract change | patch |
| Consumer expectation has no executable check | Add the check (contract-registry test) | minor |

## Invariants

- One owner per contract. Duplicate owners are always the first thing to fix.
- Never mutate a published contract in place — version it.
- A consumer may only *add* expectations; changing an expectation is a version bump.
- Interop is unproven until a consumer expectation executes against the provider artifact.
- A change's degree is dictated by its class, never by effort or preference.
- Removals are breaking while any consumer exists; prefer deprecation.
- Every contract change names all affected consumers in the same artifact.

## Worked example — Rorca four-spec interoperability

Seams found and verdicts (illustrative of the method, from the 2026-08 program):

| Seam | Owner → consumers | Status | Action | Degree |
|---|---|---|---|---|
| Control catalog / ControlRecord | universal-controls US-001 → AAV-003 | duplicate re-declaration risk | AAV-003 consumes US-001's schema; add cross-validation test | major (one-time) + minor (test) |
| Phase gates + evidence families | US-004 FAMILY_MAP → AAV-005 | no executable check | contract-registry test: AAV-005 gates resolve US-004 families | minor |
| Evidence envelope | AAV-002 kernel → US-005 evaluator | shapes must be identical | shared envelope type; cross-schema test | minor |
| Spec revision identity | HMG-007 persist → AAV-001 profile | implicit | versioned `spec revision` contract with one owner (specs persist path) | minor |
| Learn loop | US-007 → AAV-022 | **two implementations** | AAV-022 consumes US-007 machinery; delete duplicate | major (one-time) |
| Run/story identity | MIG manifests → AAV-007 events | implicit | explicit manifest-identity contract + test | minor |
| Hermes observation | AAV-011 event schema → HMG-010 skill contract | unverified | skill test asserts tool names match implemented surface | minor |
| Chain qualification | none — missing | add cross-spec E2E story | new additive contract/story | minor |

Change list summary: 1 major (learn-loop de-dup), 1 major (catalog owner), 6 minor (contract-registry tests + explicit identity contract), 0 removals.

## Output format for the reasoning model

```text
## Interop assessment: <systems>
### Seams
| contract | owner | consumers | version | status |
### Changes
| contract | action (add/modify/remove) | class | degree | affected consumers | rationale |
### Risks
- <unverified seams, duplicate owners, version mismatches>
### Interop statement
<one line per seam: owner → consumer : contract@version — status>
```
