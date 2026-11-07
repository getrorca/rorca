# Universal Assurance: 7-Stage SSDLC, Genesis Binding, and Phase Advisor — Product Requirements

## Problem
Deliver the behavior defined by the canonical Universal Assurance: 7-Stage SSDLC, Genesis Binding, and Phase Advisor specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- US-001 — Seven conventional stage projection (backend contracts)
- US-002 — Seven-stage projection in the lifecycle matrix UI
- US-003 — LifecycleProfileV1 and plan compiler profile emission
- US-004 — API-driven stage rendering in the matrix
- US-005 — Skill metadata scope/appliesToStages/enforcement and baseline pack
- US-006 — Deterministic universal skill selection with Pi/OMP parity
- US-007 — Production Genesis authority bridge and spec_sources table
- US-008 — Verified Genesis binding at spec persist and binding API
- US-009 — Run findings feed-forward (Rorca operational authority)
- US-010 — Per-phase compiled coverage in the lifecycle UI
- US-011 — Phase advisor endpoint and UI panel
- US-012 — Docs, hardening, and CI green

## In scope
- Replace the six Mission stage ids (intent/plan/build/verify/release/learn) with the seven conventional SDLC stages across the SSDLC contracts. The 11 canonical phases stay. MISSION_STAGE_BY_PHASE remaps: planning->intake, requirements->requirements, design->architecture, development->implementation, testing->validation+security+qa, deployment->staging+merge+production, maintenance->learn. maintenance stays non-blocking. Touch: backend/src/ssdlc/schema/control-schema.ts, backend/src/ssdlc/gates/gate-compiler.ts, backend/src/ssdlc/assurance-profile.ts, backend/src/ssdlc/full-interoperability-qualification.ts, lib/mission-contracts.ts + shared/contracts (bump read projection revision).
- Update src/types/lifecycle.ts LIFECYCLE_STAGES to the seven conventional stages with display labels (Planning, Requirements analysis, Design, Development, Testing, Deployment, Maintenance) and lifecycleStageOf fallback to maintenance. LifecycleMatrix already renders the stage header row data-driven; verify and update tests in src/panels/__tests__/LifecycleMatrix.test.tsx (header order, 19 columnheaders, 52 rows).
- Add backend/src/ssdlc/profiles/general-sdlc-7.ts as the single source of the stage projection: profileId, version, stages (id/label/phaseIds), blockingStages, contentHash. Make the plan compiler emit profile {profileId, profileVersion, profileHash, stages} alongside the phases in the compiled plan, and surface it in the lifecycle plan API (GET /api/lifecycle/specs/:specId).
- LifecycleMatrix renders stage headers from the compiled plan profile when the plan response carries profile.stages, falling back to the bundled LIFECYCLE_STAGES constant when absent. No stage semantics hardcoded beyond the fallback.
- Extend skill frontmatter parsing in backend/src/lib/skill-registry.ts with scope (universal|specialist), appliesToStages (array of the 7 stage ids), enforcement (advisory|required). Reject entrypoints with unknown stage ids instead of broadening. Include the new fields in the catalog prompt. Ship the baseline universal pack with general-sdlc-7: evidence-discipline, reversible-changes, no-placeholder-delivery, traceability. Update docs/agent-skill-packages.md.
- backend/src/lib/skill-matcher.ts: universal-scope skills are always selected within the token budget (filtered by appliesToStages); specialist skills stay LLM-reranked over the deterministic eligible set. Universal skills must reach Pi and OMP runs through the direction-stack context path (pi-autonomous-runner directionText) since the matched-skills section is skipped for pi/omp. enforcement: required reserves budget only after selection; it never creates a gate.
- Implement the production GenesisAuthorityBridge (backend/src/lib/source-adapters/genesis.ts interface) wired to the Genesis bridge endpoint, and add a pg-migration for spec_sources (spec_id, source_kind, source_id, package_hash, content_hash, citation_summary, evidence_chunk_ids, citations jsonb, review_status, sensitivity, bound_at, bound_by) with immutable rows. Restricted chunks must stay redacted through resolveGenesisSource.
- Extend PersistSpecDraftSchema with optional genesisSource {kind, id, principalId, selectedChunkIds}. On persist, resolve through the bridge, store only verified provenance in spec_sources, and reject forged/redacted/unapproved provenance (no row). GET spec returns boundSources. Add POST /api/specs/:specId/genesis-sources for binding after persist (idempotent). Canon sufficiency request includes bound package ids (genesisPackageIds).
- On run completion derive a structured findings record (decisions made, deviations from spec, discovered risks, new conventions) alongside the existing story-result evidence derivation. Findings update workspace L2/L3 context and MEMORY.md through the existing memory synthesis path, and become explicit Genesis capture candidates via the explicit-action adapter only (no silent promotion).
- Spec readiness gains coverageByPhase (phaseId -> covered/uncovered requirement cells, missing skills, nextActions) derived from engineering canon coverage cells. The lifecycle phase drill-down renders the coverage section: what the phase requires, what is covered, what is missing, bound Genesis packages. Absent canon degrades gracefully.
- Add POST /api/lifecycle/specs/:specId/advice accepting {phaseId, storyId?}. Input: spec typed facts + bound Genesis sources + compiled coverage for the phase; output via chatComplete: {suggestions: [{text, cites: [requirementId|controlId|sourceId]}]}. Advisory only: never persisted as evidence, never evaluated by gates, every suggestion cited. UI: advisory 'What's missing' panel in the phase view.
- Update docs/contracts/ssdlc-interoperability.md (seven-stage table, profile, Genesis binding sections), docs/agent-skill-packages.md (scope/stages metadata), AGENTS.md lifecycle references. Full backend + frontend suites, tsc both sides, gitleaks. Push to GitHub and Forgejo; Forgejo CI must be green.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### US-001
Replace the six Mission stage ids (intent/plan/build/verify/release/learn) with the seven conventional SDLC stages across the SSDLC contracts. The 11 canonical phases stay. MISSION_STAGE_BY_PHASE remaps: planning->intake, requirements->requirements, design->architecture, development->implementation, testing->validation+security+qa, deployment->staging+merge+production, maintenance->learn. maintenance stays non-blocking. Touch: backend/src/ssdlc/schema/control-schema.ts, backend/src/ssdlc/gates/gate-compiler.ts, backend/src/ssdlc/assurance-profile.ts, backend/src/ssdlc/full-interoperability-qualification.ts, lib/mission-contracts.ts + shared/contracts (bump read projection revision).

**Acceptance criteria**
- MISSION_STAGES exports exactly ['planning','requirements','design','development','testing','deployment','maintenance'] in order
- MISSION_STAGE_BY_PHASE maps every one of the 11 phases to a stage with no omissions
- maintenance readiness reports status non-blocking (learn semantics preserved)
- full-interoperability-qualification asserts the 7-stage projection and passes
- control-schema, gate-compiler, assurance-profile, full-interop, and mission contract suites all green

### US-002
Update src/types/lifecycle.ts LIFECYCLE_STAGES to the seven conventional stages with display labels (Planning, Requirements analysis, Design, Development, Testing, Deployment, Maintenance) and lifecycleStageOf fallback to maintenance. LifecycleMatrix already renders the stage header row data-driven; verify and update tests in src/panels/__tests__/LifecycleMatrix.test.tsx (header order, 19 columnheaders, 52 rows).

**Acceptance criteria**
- LIFECYCLE_STAGES contains 7 entries in conventional order with correct phaseIds
- Matrix renders the 7 stage headers spanning their phase columns
- Matrix tests updated and green; frontend suite green; tsc clean

### US-003
Add backend/src/ssdlc/profiles/general-sdlc-7.ts as the single source of the stage projection: profileId, version, stages (id/label/phaseIds), blockingStages, contentHash. Make the plan compiler emit profile {profileId, profileVersion, profileHash, stages} alongside the phases in the compiled plan, and surface it in the lifecycle plan API (GET /api/lifecycle/specs/:specId).

**Acceptance criteria**
- general-sdlc-7 profile exports the 7-stage mapping with a stable content hash
- Compiled plan response includes profile with stages and profileHash
- Changing the profile mapping changes the profileHash and invalidates stale plans
- Existing lifecycle plan tests updated and green

### US-004
LifecycleMatrix renders stage headers from the compiled plan profile when the plan response carries profile.stages, falling back to the bundled LIFECYCLE_STAGES constant when absent. No stage semantics hardcoded beyond the fallback.

**Acceptance criteria**
- Matrix uses plan profile stages when present in the plan response
- Fallback to bundled constant when plan is absent or profile missing
- Matrix tests cover both paths and pass

### US-005
Extend skill frontmatter parsing in backend/src/lib/skill-registry.ts with scope (universal|specialist), appliesToStages (array of the 7 stage ids), enforcement (advisory|required). Reject entrypoints with unknown stage ids instead of broadening. Include the new fields in the catalog prompt. Ship the baseline universal pack with general-sdlc-7: evidence-discipline, reversible-changes, no-placeholder-delivery, traceability. Update docs/agent-skill-packages.md.

**Acceptance criteria**
- Frontmatter with scope/appliesToStages/enforcement parses and persists
- Unknown stage id in appliesToStages rejects the entrypoint with a validation warning
- Catalog prompt lists the new fields
- Baseline pack ships 4 universal skills with general-sdlc-7
- Skill registry tests updated and green

### US-006
backend/src/lib/skill-matcher.ts: universal-scope skills are always selected within the token budget (filtered by appliesToStages); specialist skills stay LLM-reranked over the deterministic eligible set. Universal skills must reach Pi and OMP runs through the direction-stack context path (pi-autonomous-runner directionText) since the matched-skills section is skipped for pi/omp. enforcement: required reserves budget only after selection; it never creates a gate.

**Acceptance criteria**
- A universal skill matching the run stage is always selected for claude/opencode/codex runs
- Pi/OMP runs receive universal skill text via the direction stack context
- Specialist skills never auto-inject into Pi/OMP without an explicit match
- Skill matcher tests updated and green

### US-007
Implement the production GenesisAuthorityBridge (backend/src/lib/source-adapters/genesis.ts interface) wired to the Genesis bridge endpoint, and add a pg-migration for spec_sources (spec_id, source_kind, source_id, package_hash, content_hash, citation_summary, evidence_chunk_ids, citations jsonb, review_status, sensitivity, bound_at, bound_by) with immutable rows. Restricted chunks must stay redacted through resolveGenesisSource.

**Acceptance criteria**
- Bridge resolves a genesis_package projection through resolveGenesisSource with a principal identity
- Restricted chunk content never leaves the adapter (redaction marker only)
- spec_sources migration applies cleanly; rows are immutable after insert
- Genesis source adapter tests green

### US-008
Extend PersistSpecDraftSchema with optional genesisSource {kind, id, principalId, selectedChunkIds}. On persist, resolve through the bridge, store only verified provenance in spec_sources, and reject forged/redacted/unapproved provenance (no row). GET spec returns boundSources. Add POST /api/specs/:specId/genesis-sources for binding after persist (idempotent). Canon sufficiency request includes bound package ids (genesisPackageIds).

**Acceptance criteria**
- Persist with a valid package id stores a verified spec_sources row and returns boundSources
- Forged or unapproved provenance is rejected with a typed error and no row
- Binding endpoint binds idempotently and surfaces in GET spec
- Readiness engineeringCanonCoverage.evidenceProvenance.genesisPackageIds populates from real bindings

### US-009
On run completion derive a structured findings record (decisions made, deviations from spec, discovered risks, new conventions) alongside the existing story-result evidence derivation. Findings update workspace L2/L3 context and MEMORY.md through the existing memory synthesis path, and become explicit Genesis capture candidates via the explicit-action adapter only (no silent promotion).

**Acceptance criteria**
- Completed runs emit a findings record persisted with the run
- Findings surface in memory synthesis (L2/L3/MEMORY.md) on the next run
- No automatic Genesis promotion: findings are capture candidates requiring explicit action
- Run closeout tests green

### US-010
Spec readiness gains coverageByPhase (phaseId -> covered/uncovered requirement cells, missing skills, nextActions) derived from engineering canon coverage cells. The lifecycle phase drill-down renders the coverage section: what the phase requires, what is covered, what is missing, bound Genesis packages. Absent canon degrades gracefully.

**Acceptance criteria**
- Readiness response includes coverageByPhase for all 11 phases
- Phase view renders covered/uncovered cells and missing skills with citations
- Degraded coverage path renders 'coverage unavailable' without errors
- Readiness and frontend tests green

### US-011
Add POST /api/lifecycle/specs/:specId/advice accepting {phaseId, storyId?}. Input: spec typed facts + bound Genesis sources + compiled coverage for the phase; output via chatComplete: {suggestions: [{text, cites: [requirementId|controlId|sourceId]}]}. Advisory only: never persisted as evidence, never evaluated by gates, every suggestion cited. UI: advisory 'What's missing' panel in the phase view.

**Acceptance criteria**
- Advice endpoint returns cited suggestions for a phase with advisory:true
- Suggestions are never persisted as lifecycle evidence
- Phase view renders the advisory panel with citations and Advisory label
- Endpoint and frontend tests green

### US-012
Update docs/contracts/ssdlc-interoperability.md (seven-stage table, profile, Genesis binding sections), docs/agent-skill-packages.md (scope/stages metadata), AGENTS.md lifecycle references. Full backend + frontend suites, tsc both sides, gitleaks. Push to GitHub and Forgejo; Forgejo CI must be green.

**Acceptance criteria**
- Docs reflect the 7-stage projection, profile model, and verified Genesis binding
- Backend and frontend suites fully green; tsc clean; gitleaks 0 findings
- Final commit pushed to both remotes with Forgejo CI success

## Success metrics
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

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

