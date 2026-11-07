# Universal Assurance: 7-Stage SSDLC, Genesis Binding, and Phase Advisor — Delivery Plan

## Story order
1. **US-001 — Seven conventional stage projection (backend contracts)**
2. **US-002 — Seven-stage projection in the lifecycle matrix UI**
3. **US-003 — LifecycleProfileV1 and plan compiler profile emission**
4. **US-004 — API-driven stage rendering in the matrix**
5. **US-005 — Skill metadata scope/appliesToStages/enforcement and baseline pack**
6. **US-006 — Deterministic universal skill selection with Pi/OMP parity**
7. **US-007 — Production Genesis authority bridge and spec_sources table**
8. **US-008 — Verified Genesis binding at spec persist and binding API**
9. **US-009 — Run findings feed-forward (Rorca operational authority)**
10. **US-010 — Per-phase compiled coverage in the lifecycle UI**
11. **US-011 — Phase advisor endpoint and UI panel**
12. **US-012 — Docs, hardening, and CI green**

## Dependencies
- US-001 → US-002
- US-001 → US-003
- US-003 → US-004
- US-001 → US-005
- US-005 → US-006
- US-007 → US-008
- US-008 → US-010
- US-010 → US-011
- US-002 → US-012
- US-004 → US-012
- US-006 → US-012
- US-008 → US-012
- US-009 → US-012
- US-010 → US-012
- US-011 → US-012

## Verification
- US-001: MISSION_STAGES exports exactly ['planning','requirements','design','development','testing','deployment','maintenance'] in order
- US-001: MISSION_STAGE_BY_PHASE maps every one of the 11 phases to a stage with no omissions
- US-001: maintenance readiness reports status non-blocking (learn semantics preserved)
- US-001: full-interoperability-qualification asserts the 7-stage projection and passes
- US-001: control-schema, gate-compiler, assurance-profile, full-interop, and mission contract suites all green
- US-002: LIFECYCLE_STAGES contains 7 entries in conventional order with correct phaseIds
- US-002: Matrix renders the 7 stage headers spanning their phase columns
- US-002: Matrix tests updated and green; frontend suite green; tsc clean
- US-003: general-sdlc-7 profile exports the 7-stage mapping with a stable content hash
- US-003: Compiled plan response includes profile with stages and profileHash
- US-003: Changing the profile mapping changes the profileHash and invalidates stale plans
- US-003: Existing lifecycle plan tests updated and green
- US-004: Matrix uses plan profile stages when present in the plan response
- US-004: Fallback to bundled constant when plan is absent or profile missing
- US-004: Matrix tests cover both paths and pass
- US-005: Frontmatter with scope/appliesToStages/enforcement parses and persists
- US-005: Unknown stage id in appliesToStages rejects the entrypoint with a validation warning
- US-005: Catalog prompt lists the new fields
- US-005: Baseline pack ships 4 universal skills with general-sdlc-7
- US-005: Skill registry tests updated and green
- US-006: A universal skill matching the run stage is always selected for claude/opencode/codex runs
- US-006: Pi/OMP runs receive universal skill text via the direction stack context
- US-006: Specialist skills never auto-inject into Pi/OMP without an explicit match
- US-006: Skill matcher tests updated and green
- US-007: Bridge resolves a genesis_package projection through resolveGenesisSource with a principal identity
- US-007: Restricted chunk content never leaves the adapter (redaction marker only)
- US-007: spec_sources migration applies cleanly; rows are immutable after insert
- US-007: Genesis source adapter tests green
- US-008: Persist with a valid package id stores a verified spec_sources row and returns boundSources
- US-008: Forged or unapproved provenance is rejected with a typed error and no row
- US-008: Binding endpoint binds idempotently and surfaces in GET spec
- US-008: Readiness engineeringCanonCoverage.evidenceProvenance.genesisPackageIds populates from real bindings
- US-009: Completed runs emit a findings record persisted with the run
- US-009: Findings surface in memory synthesis (L2/L3/MEMORY.md) on the next run
- US-009: No automatic Genesis promotion: findings are capture candidates requiring explicit action
- US-009: Run closeout tests green
- US-010: Readiness response includes coverageByPhase for all 11 phases
- US-010: Phase view renders covered/uncovered cells and missing skills with citations
- US-010: Degraded coverage path renders 'coverage unavailable' without errors
- US-010: Readiness and frontend tests green
- US-011: Advice endpoint returns cited suggestions for a phase with advisory:true
- US-011: Suggestions are never persisted as lifecycle evidence
- US-011: Phase view renders the advisory panel with citations and Advisory label
- US-011: Endpoint and frontend tests green
- US-012: Docs reflect the 7-stage projection, profile model, and verified Genesis binding
- US-012: Backend and frontend suites fully green; tsc clean; gitleaks 0 findings
- US-012: Final commit pushed to both remotes with Forgejo CI success

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
