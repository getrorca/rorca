# Source-Verified Hermes–Rorca–OMP SSDLC Delivery Program — Delivery Plan

## Story order
1. **US-001 — Control Catalog Schema and Validation**
2. **US-002 — Genesis Source Authority Projection**
3. **US-003 — Layered Applicability Resolver L0-L5**
4. **US-004 — Phase Control Groups and Stage Readiness Compiler**
5. **US-005 — Canonical Lifecycle Evidence and Exception Evaluation**
6. **US-006 — Skill Binding and Structured Findings**
7. **US-007 — Canonical Learn-Loop Candidate Generation**
8. **US-008 — Universal Kernel Catalog Artifact**
9. **HMG-001 — Versioned source and intent contracts with strict validation**
10. **HMG-002 — Source adapter framework with registry and honest failure states**
11. **HMG-003 — Genesis source adapter resolving canonical approved provenance**
12. **HMG-004 — Local file source adapter for workspace Markdown and text documents**
13. **HMG-005 — Context compiler with conflict detection and prompt-injection separation**
14. **HMG-006 — Intent intake router with visible disposition classification**
15. **HMG-007 — Mission draft bridging from compiled source bundle through assurance-ready persist**
16. **HMG-008 — Source-drift detection with revision and assurance invalidation**
17. **HMG-009 — Mission OS Intent lens with requirement-to-source traceability**
18. **HMG-010 — Gateway event family and canonical Hermes skill contract**
19. **AAV-001 — Assurance profile schema attached to exact spec revisions**
20. **AAV-002 — Universal verification kernel: execute, judge, bind**
21. **AAV-003 — Canonical control catalog consumer and contract validation**
22. **AAV-004 — Repository mechanism discovery from context**
23. **AAV-005 — Context-aware assurance mechanism binder**
24. **AAV-006 — Hermes assurance execution and canonical evidence emission**
25. **AAV-007 — Versioned OMP orchestration event ingestion**
26. **AAV-008 — Structured Run View orchestration tree**
27. **AAV-009 — Raw OMP terminal tab for debugging**
28. **AAV-010 — Assurance and OMP component parity qualification**
29. **AAV-011 — Hermes subscription to canonical run events**
30. **AAV-012 — Hermes intake review agent**
31. **AAV-013 — Hermes requirements verification**
32. **AAV-014 — Hermes architecture review and threat model**
33. **AAV-015 — Hermes security controls execution**
34. **AAV-016 — Hermes QA release-candidate review**
35. **AAV-017 — Hermes merge verification**
36. **AAV-018 — Hermes production confirmation**
37. **AAV-019 — Evidence adapters for real artifacts**
38. **AAV-020 — Hermes watchdog v2: diagnosis and governed healing**
39. **AAV-021 — Executor-neutral provider fallback policy and evidence**
40. **AAV-022 — Learn-loop adapter: heal events to canonical Genesis candidates**
41. **AAV-023 — Hermes authority model: service-to-operator split**
42. **MIG-001 — OMP executor sandbox wiring**
43. **MIG-002 — Default executor flip to OMP with per-spec override**
44. **MIG-003 — Pi fallback lane insurance**
45. **MIG-004 — Wave-parallel execution verification under OMP**
46. **MIG-005 — OMP executor parity and rollback qualification**
47. **MIG-006 — Engine fallback posture and dispatch enforcement**
48. **INT-001 — Contract registry and consumer-driven verification**
49. **INT-002 — Full source-to-learning interoperability qualification**
50. **INT-003 — Executor and recovery compatibility matrix**

## Dependencies
- US-001 → US-002
- US-001 → US-003
- US-001 → US-004
- US-003 → US-004
- US-001 → US-005
- US-002 → US-005
- US-004 → US-005
- US-001 → US-006
- US-004 → US-006
- US-005 → US-006
- US-005 → US-007
- US-006 → US-007
- US-001 → US-008
- US-002 → US-008
- US-003 → US-008
- US-004 → US-008
- HMG-001 → HMG-002
- HMG-002 → HMG-003
- US-002 → HMG-003
- HMG-002 → HMG-004
- HMG-001 → HMG-005
- HMG-003 → HMG-005
- HMG-004 → HMG-005
- HMG-001 → HMG-006
- HMG-005 → HMG-006
- AAV-023 → HMG-006
- HMG-005 → HMG-007
- HMG-006 → HMG-007
- US-003 → HMG-007
- US-004 → HMG-007
- AAV-001 → HMG-007
- AAV-005 → HMG-007
- HMG-007 → HMG-008
- AAV-001 → HMG-008
- AAV-005 → HMG-008
- HMG-008 → HMG-009
- HMG-006 → HMG-010
- HMG-007 → HMG-010
- AAV-011 → HMG-010
- AAV-023 → HMG-010
- HMG-001 → AAV-001
- US-001 → AAV-001
- AAV-001 → AAV-002
- US-001 → AAV-002
- US-001 → AAV-003
- US-008 → AAV-003
- AAV-001 → AAV-005
- AAV-003 → AAV-005
- AAV-004 → AAV-005
- US-003 → AAV-005
- US-004 → AAV-005
- HMG-001 → AAV-005
- AAV-002 → AAV-006
- AAV-005 → AAV-006
- US-005 → AAV-006
- US-006 → AAV-006
- AAV-023 → AAV-006
- MIG-001 → AAV-007
- AAV-007 → AAV-008
- AAV-007 → AAV-009
- AAV-005 → AAV-010
- AAV-006 → AAV-010
- AAV-007 → AAV-010
- AAV-008 → AAV-010
- MIG-005 → AAV-010
- AAV-007 → AAV-011
- AAV-006 → AAV-012
- AAV-006 → AAV-013
- AAV-006 → AAV-014
- AAV-006 → AAV-015
- AAV-019 → AAV-015
- AAV-006 → AAV-016
- AAV-006 → AAV-017
- AAV-006 → AAV-018
- AAV-002 → AAV-019
- AAV-006 → AAV-019
- AAV-006 → AAV-020
- AAV-019 → AAV-020
- HMG-010 → AAV-020
- AAV-020 → AAV-021
- MIG-002 → AAV-021
- AAV-006 → AAV-022
- AAV-019 → AAV-022
- AAV-020 → AAV-022
- US-007 → AAV-022
- MIG-001 → MIG-002
- MIG-001 → MIG-004
- MIG-002 → MIG-005
- MIG-003 → MIG-005
- MIG-004 → MIG-005
- MIG-005 → MIG-006
- US-008 → INT-001
- HMG-010 → INT-001
- AAV-006 → INT-001
- AAV-007 → INT-001
- AAV-011 → INT-001
- AAV-022 → INT-001
- MIG-005 → INT-001
- INT-001 → INT-002
- HMG-008 → INT-002
- HMG-010 → INT-002
- US-007 → INT-002
- US-008 → INT-002
- AAV-010 → INT-002
- AAV-011 → INT-002
- AAV-012 → INT-002
- AAV-013 → INT-002
- AAV-014 → INT-002
- AAV-015 → INT-002
- AAV-016 → INT-002
- AAV-017 → INT-002
- AAV-018 → INT-002
- AAV-022 → INT-002
- AAV-023 → INT-002
- MIG-005 → INT-002
- INT-001 → INT-003
- AAV-010 → INT-003
- AAV-021 → INT-003
- MIG-006 → INT-003

## Verification
- US-001: Given a complete valid control fixture, parseControl returns the record and validateControl returns [] with zero errors.
- US-001: ControlRecord requires schemaVersion 'rorca.ssdlc-control-record.v1'; an unknown schemaVersion is rejected.
- US-001: Given a control object with controlId omitted, validateControl returns at least one error whose path includes controlId.
- US-001: Given a control object with sourceStrength 'unverified', validateControl returns an error whose path includes sourceStrength.
- US-001: Given a control object whose sourceReferences contains an item lacking genesisEvidenceId, validateControl returns an error whose path includes sourceReferences and the offending index.
- US-001: Given a control object with version '1.0', validateControl returns an error whose path includes version, because '1.0' is not strict semver.
- US-001: Every requiredEvidence entry validates classification, allowed source types, required subject or release bindings, minimum trust, evidence depth, and freshness; an untyped string requirement is rejected.
- US-001: Given the JSON Schema artifact at control-schema.json, a record rejected by validateControl is also rejected by ajv JSON Schema validation.
- US-001: PHASES exports exactly ['intake','requirements','architecture','implementation','validation','security','staging','qa','merge','production','learn'] in that order and MISSION_STAGE_BY_PHASE maps them to intent, plan, build, verify, release, or learn.
- US-001: A consumer fixture from the assurance compiler validates through this schema without a second control-catalog type.
- US-002: Given a Genesis bridge projection for valid evidence GEN-001, getEvidence('GEN-001') returns that exact projection and its bridge provenance.
- US-002: No local function can promote pending or unreviewed evidence to approved or trusted; review state comes only from the Genesis bridge.
- US-002: Given a control whose sourceReferences cites genesisEvidenceId 'GEN-999' that is not registered by Genesis, validateControlAgainstGenesis returns an error identifying 'GEN-999'.
- US-002: Given a control whose sourceReferences includes a citation without a resolvable genesisEvidenceId, validateControlAgainstGenesis rejects the record.
- US-002: Given two projected evidence records sharing contradictionGroup 'authz-conflict', detectContradictions returns exactly one conflict object containing both genesisEvidenceIds and the group name.
- US-002: Given GEN-002 projected as superseding GEN-001, resolveAuthority('GEN-001') returns GEN-002 and marks GEN-001 superseded.
- US-002: The source-authority suite covers projection, reject, supersession, contradiction, and attempted local-promotion denial paths.
- US-003: Given a profile { productProfile: 'api-service', riskProfile: [], domainRegulatory: [] }, the resolver includes every control with applicability.universal true and every control whose productProfiles includes 'api-service', and excludes controls whose productProfiles is ['cli'].
- US-003: Given a profile with riskProfile containing 'safety-critical', every active control with applicability.riskProfiles including 'safety-critical' receives evidenceDepth 'independent-verification'.
- US-003: Given a profile with domainRegulatory ['finance'], controls with applicability.domainRegulatory including 'finance' are active and controls tagged only ['healthcare'] are excluded.
- US-003: Given an L5 specTaskOverride { controlId: 'CTRL-X', action: 'exclude', requirementId: 'REQ-42' }, the resolver excludes CTRL-X and the resolutionLog records REQ-42 as the override source.
- US-003: Given an empty profile { productProfile: null, riskProfile: [], domainRegulatory: [], workspaceConventions: [], specTaskOverrides: [] }, the resolver returns all L0 universal controls.
- US-003: Calling resolveActiveControls twice with identical profiles returns deep-equal activeControlIds and evidenceDepthByControlId.
- US-003: The jest suite resolver.test.ts covers L0-L5 selection, depth derivation, and override paths and passes.
- US-004: Given fixture controls covering all 11 phases with at least one control per mandatory family, compileGates returns exactly 11 ordered phase control groups from intake through learn.
- US-004: Each phase group contains phase, controlIds, families, and structured evidence requirements; every controlId appears in at least one family array.
- US-004: The readiness projection contains exactly six stages in order: intent, plan, build, verify, release, learn.
- US-004: The phase mapping is intake->intent; requirements and architecture->plan; implementation->build; validation and security->verify; staging, qa, merge, and production->release; learn->learn.
- US-004: Learn is explicitly non-blocking, while unresolved applicable controls block only their projected non-learn stage.
- US-004: Gate families match the brief, including intake need-validity/scope-boundaries/risk-classification, requirements completeness/verifiability/traceability/quality-attributes, security threat-control-verification/authz-boundaries/secrets/supply-chain/vulnerability-response, and learn incident-analysis/prediction-vs-outcome/delivery-metrics/control-effectiveness/improvement-candidates.
- US-004: Given a fixture set with no control mapping to qa family independent-evidence-review, compileGates reports the missing family for qa.
- US-004: Each evidence requirement derives from US-001 and contains the evidence depth computed by US-003.
- US-004: The gate-compiler suite covers phase order, six-stage projection, family coverage, learn non-blocking behavior, and missing-family reporting.
- US-005: Given a stage whose active controls each have matching current canonical lifecycle evidence, evaluateGate returns pass and every control result includes authority support, demonstrated evidence, and evaluated skill.
- US-005: Given an active control with no matching canonical lifecycle evidence, evaluateGate returns blocked with a reason naming the missing evidence requirement.
- US-005: Evidence with stale, mismatched, or absent spec hash, commit SHA, required release identity, trust level, depth, or freshness is rejected for the control.
- US-005: Given a control with allowedNotApplicable true and evidence-backed not-applicable evidence, evaluateGate records not-applicable and does not block the stage.
- US-005: Given a control with allowedNotApplicable false and no submitted evidence, evaluateGate remains blocked.
- US-005: Given a control with an expired or disallowed exception, evaluateGate remains blocked and names the exception authority or expiry.
- US-005: Given a resolver-assigned independent-verification requirement and evidence without independent verification, evaluateGate returns blocked.
- US-005: Learn outcomes are evaluated for traceability but do not block a completed release.
- US-005: The gate-evaluator suite covers canonical-envelope matching, identity mismatch, pass, missing evidence, not-applicable, exception, depth, freshness, and learn non-blocking paths.
- US-006: Given bindSkill called with a SkillRecord whose controlIds includes an existing catalog controlId, the registry stores the skill and resolveSkillRefs returns its current version.
- US-006: Given a control whose skillRefs includes an unresolved skill, resolveSkillRefs returns an error naming it.
- US-006: Given an AAV phase-review StructuredFinding with blocker status for an active control, the matching stage becomes blocked and the stored finding retains identity, control, skill, story, status, and evidence references.
- US-006: Given findings with pass status only, the gate verdict remains pass.
- US-006: Given a skill upgrade from v1 to v2, the control record's skillRefs remains stable and resolution returns v2 with an upgrade note.
- US-006: A finding missing controlId or skillId is rejected, and an alternate phase-review finding shape is rejected.
- US-006: The skill-binding suite covers binding, unresolved refs, AAV finding ingestion, blocker gating, upgrade stability, and validation.
- US-007: Given a production outcome where a defect reached production despite passing validation tests, consumeProductionOutcome returns a pending-review test-class-failed-to-predict-defect candidate.
- US-007: Given a production outcome recording rework caused by a granted exception, it returns an exception-caused-rework candidate.
- US-007: Given a control that produced no signal across all evaluated gates for a release, it returns a control-produced-no-signal candidate at the configured threshold.
- US-007: Given a model performance record with task-class underperformance, it returns a model-underperformed-on-task-class candidate.
- US-007: Given two identical outcomes, the second increments signalCount on the existing candidate and creates no new candidateId.
- US-007: AAV heal and run outcomes enter only through consumeProductionOutcome and return this canonical candidate shape.
- US-007: Given a pending-review candidate, applyCandidate without approved review errors and leaves controls.json byte-for-byte unchanged.
- US-007: The learn-loop suite covers all four types, deduplication, AAV adapter input, pending-review-only behavior, and the no-silent-rewrite invariant.
- US-008: controls.json contains between 20 and 40 ControlRecord records and every record passes US-001 validation.
- US-008: Every phase in PHASES has at least one control and US-004 reports no missing mandatory family.
- US-008: Every source reference resolves to a Genesis evidence id in genesis-evidence.json; no source reference is raw prose without an evidence id.
- US-008: Every control's source strength, failure severity, exception policy, skill refs, schema version, and structured evidence requirements match US-001.
- US-008: Every evidence requirement has a declared real adapter or an explicit governed human or approval route; no required evidence is an unimplementable string.
- US-008: The catalog contains at least one cited control for ISO/IEC/IEEE 29148, ISO/IEC/IEEE 42010, ISO/IEC 25010, ISO/IEC/IEEE 29119, NIST SP 800-218, and DORA with exact clause or section citations.
- US-008: The catalog suite validates every criterion and includes an AAV consumer fixture resolving controls by controlId.
- HMG-001: All seven schemas exist in shared/contracts/source.ts and the backend mirror with exact version strings and closed enum parity
- HMG-001: Every SourceRef carries a sha256 contentHash and a valid reviewStatus/sensitivity/authority from closed enums
- HMG-001: IntentDispositionV1 accepts only the six dispositions; unknown disposition is rejected at parse
- HMG-001: Bundle hash is derived deterministically from userIntent + included sources + selected sections + citations
- HMG-001: Automated tests include fixtures that accept a valid source bundle and reject each invalid case: unknown enum, external or traversing locator, missing content hash, and mismatched bundle hash.
- HMG-001: Frontend and backend typechecks pass; no changes to existing mission.ts contracts
- HMG-002: SourceAdapter interface and registry compile with strict types and are exported from the backend lib index
- HMG-002: Registry returns an honest unavailable result for unknown locator schemes instead of throwing or guessing
- HMG-002: Fetching a source yields a VersionedSource with content hash, revision, and selected section bounds
- HMG-002: No command execution or URL opening occurs anywhere in resolve/fetch/normalize
- HMG-002: Focused unit tests cover known adapter, unknown scheme, missing authority, and oversized content truncation
- HMG-002: Backend typecheck passes
- HMG-003: Resolving an approved Genesis package returns SourceRefV1 with bridge-derived reviewStatus approved and complete sha256 hashes.
- HMG-003: Pending or unreviewed candidates resolve with bridge-derived pending/unreviewed state, never approved.
- HMG-003: Restricted evidence is redacted in the compiled bundle with a visible marker and never included as raw text.
- HMG-003: The adapter emits GenesisProvenanceSchema-compatible metadata and the same provenance fields consumed by US-002.
- HMG-003: No adapter path can grant approval, trust, or a sensitivity exception locally.
- HMG-003: Focused tests cover approved, pending, missing-package, restricted-sensitivity, and attempted-local-promotion paths; backend typecheck passes.
- HMG-004: A workspace-relative Markdown path resolves to a hashed SourceRefV1 with heading section citations
- HMG-004: Path traversal, absolute paths outside the workspace, and missing files fail closed with ValidationError
- HMG-004: Sections are bounded by size; oversized content truncates with an explicit truncation record, never silently
- HMG-004: Using a file for a Mission does not write memory candidates or Genesis entries on its own
- HMG-004: Focused tests cover heading extraction, traversal rejection, truncation, and binary/non-text rejection
- HMG-004: Backend typecheck passes
- HMG-005: Compiling two non-conflicting sources produces one SourceBundleV1 with both SourceRefs and citations
- HMG-005: A material conflict (e.g. privacy policy vs feature PRD) produces a visible SourceConflictV1 and a clarification disposition
- HMG-005: Source text containing instruction-like content is never executed and is visibly quoted as source data
- HMG-005: Secrets (API keys, tokens) are redacted from the compiled bundle
- HMG-005: Compilation is bounded: an explicit budget caps total included tokens with truncation records
- HMG-005: Focused tests cover merge, conflict, prompt-injection, redaction, and budget paths; backend typecheck passes
- HMG-006: POST /api/hermes/intent returns strict IntentDispositionV1 with rationale for all six dispositions.
- HMG-006: A request referencing an existing mission id routes to existing_mission_action with the exact EntityRef.
- HMG-006: A request with explicit source refs and no mission routes to mission_draft and includes the compiled bundle hash.
- HMG-006: Replaying the same idempotencyKey returns the same disposition without duplicate side effects.
- HMG-006: Requests referencing another workspace's mission are denied.
- HMG-006: Every disposition records declared audit identity and authority mode; accidental admin fallback is rejected.
- HMG-006: Focused route tests cover all dispositions, idempotency, workspace isolation, and authority; Swagger annotations and backend typecheck pass.
- HMG-007: A compiled SourceBundleV1 becomes a persist payload with stories, contextUsed, Genesis provenance, and bundle hash.
- HMG-007: Persisting through the explicit-draft route succeeds and readback contains the frozen bundle hash, source refs, exact EntityRefV1, and RevisionRefV1.
- HMG-007: The assurance profile records the same spec revision and bundle hash; a mismatch is rejected before review or execution.
- HMG-007: US-003/US-004 control compilation and AAV-005 mechanism binding occur after persist and before the exact revision can be approved for trigger.
- HMG-007: The legacy generate endpoint is never invoked.
- HMG-007: A stale or mutated bundle is rejected before persistence.
- HMG-007: Focused integration tests prove bundle -> persist -> controls -> assurance profile -> readback with exact provenance; backend typecheck passes.
- HMG-008: A Mission whose frozen source files are unchanged reports no drift.
- HMG-008: Modifying a frozen local file marks context stale with the exact source and old/new hashes.
- HMG-008: Stale Missions never silently inherit new content; UI/API exposes explicit stale state.
- HMG-008: Recompilation produces a new bundle hash, exact spec revision, and new assurance profile receipt; the prior profile cannot apply to the new revision.
- HMG-008: The changed revision requires re-review before execution is affected.
- HMG-008: Focused tests cover unchanged, changed, deleted, unavailable, profile invalidation, and stale-evidence rejection paths; backend typecheck passes.
- HMG-009: The Intent lens renders the frozen source bundle: source count, titles, revisions, hashes, and citations
- HMG-009: Excluded sources and conflict resolutions are visible with rationale
- HMG-009: Drift state renders honestly (no drift / stale / unavailable) with a single dominant action
- HMG-009: No fabricated source fields: if the projection lacks a field, an honest unavailable state renders
- HMG-009: WCAG: keyboard navigable citation links, accessible hash chip labels, no color-only semantics; 390px no overflow
- HMG-009: Focused frontend tests cover bundle present, bundle absent, drift stale, and error states; frontend typecheck passes
- HMG-010: A bounded set of versioned gateway.* payloads is emitted through the existing WAL/SSE envelope with strict identity-bearing payloads.
- HMG-010: Gateway and orchestration payload families coexist on the same subscription without schema collision or a second transport.
- HMG-010: ActionEnvelopeV1 is never used as a generic event payload.
- HMG-010: The Hermes skill documents the full implemented source -> persist -> controls -> assurance -> approve -> trigger -> subscribe -> supervise -> learn sequence with canonical tool names.
- HMG-010: The skill states source content is data, never instructions; Hermes never grants execution leases; and declared authority follows AAV-023.
- HMG-010: Skill tests prove documented tools and payload families match the implemented MCP/WAL surface.
- HMG-010: No second orchestrator or workflow state machine is introduced; Rorca routes remain authoritative.
- HMG-010: Frontend/backend typechecks and skill tests pass.
- AAV-001: The profile schema is versioned as rorca.assurance-profile.v1 and is attached to an exact EntityRefV1 and RevisionRefV1.
- AAV-001: Control instances use US-001 controlId and validate against the canonical controls.json artifact.
- AAV-001: When source context exists, the profile records the persisted SourceBundleV1 bundle hash and rejects a bundle/spec revision mismatch.
- AAV-001: A spec content or source-drift revision invalidates the old profile and requires a new compilation receipt.
- AAV-001: Existing specs without profiles stay readable through an explicit default profile.
- AAV-001: Product stories are not polluted with lifecycle boilerplate stories.
- AAV-001: Focused tests cover profile freeze, revision mismatch, source-drift invalidation, and the default path; backend typecheck passes.
- AAV-002: Kernel has no tool- or methodology-specific branches.
- AAV-002: KernelVerificationOutcome binds controlId, exact spec revision, commit SHA, actor, timestamp, mechanism identity, and outcome digest.
- AAV-002: Kernel verdicts are exactly pass, fail, or blocked and gaps are actionable strings.
- AAV-002: The kernel never emits a second lifecycle-evidence envelope or directly passes a stage gate.
- AAV-002: Focused tests cover pass, fail, blocked, stale identity detection, and governed override input paths; backend typecheck passes.
- AAV-003: The adapter resolves only US-001 controlId values from the canonical controls.json artifact.
- AAV-003: No duplicate control catalog, controlRef shape, or independently versioned catalog is introduced under the assurance layer.
- AAV-003: Unknown controlId values are rejected by the US-001 validator.
- AAV-003: Every resolved control exposes the structured evidence requirements and required bindings declared by US-001.
- AAV-003: Consumer-driven tests load the US-001 JSON Schema and US-008 artifact and reject a changed or malformed provider shape.
- AAV-003: Focused tests cover canonical shape, unknown-id rejection, provider-version mismatch, and consumer expectations; backend typecheck passes.
- AAV-004: Discovery returns executable + args vector, cwd, discoveredFrom, and confidence
- AAV-004: No shell string execution or untrusted command construction
- AAV-004: A TypeScript+Jest repository resolves jest with the correct command and backend cwd
- AAV-004: Unknown/absent frameworks return an honest unavailable result
- AAV-004: Focused tests cover jest, pytest-like config, missing framework, and traversal-safe paths; backend typecheck passes
- AAV-005: Model proposal plus deterministic validation binds mechanisms and criteria to the active US-003/US-004 controls.
- AAV-005: Mandatory-control selection comes only from US-003 and US-004; AAV-005 never implements a second selector.
- AAV-005: Missing mechanism or evidence binding blocks compilation with an actionable gap.
- AAV-005: Invalid mechanisms, unknown controlIds, or weakened non-overridable controls fail validation.
- AAV-005: Compilation is idempotent and bound to the exact spec revision and, when present, HMG SourceBundleV1 bundle hash.
- AAV-005: Focused tests cover complete binding, missing mechanism, invalid control, weakened preference, and revision/bundle mismatch; backend typecheck passes.
- AAV-006: Hermes executes each compiled mechanism binding and emits matching canonical lifecycle evidence.
- AAV-006: Evidence binds exact mechanism identity, controlId, exact spec revision, spec hash, commit SHA, and required release identity.
- AAV-006: Kernel outcomes are normalized only here; no parallel lifecycle evidence envelope is emitted.
- AAV-006: Blocked controls produce actionable gaps and US-005 stage reevaluates on new evidence.
- AAV-006: AAV-012 through AAV-018 findings are validated and ingested exclusively as US-006 StructuredFinding records.
- AAV-006: Authority follows the explicit service-audit/operator-dispatch split, never an accidental fallback.
- AAV-006: Focused tests cover execution, canonical evidence, blocked reevaluation, finding ingestion, and authority paths; backend typecheck passes.
- AAV-007: Actual OMP JSONL RPC projects into the versioned orchestration payload schema with parentage retained.
- AAV-007: Events carry monotonic sequence numbers, survive restart, and are idempotent on replay.
- AAV-007: Events bind to EntityRefV1-compatible run, story, attempt, process, and exact spec revision identity.
- AAV-007: Unknown OMP events are recorded without breaking ingestion.
- AAV-007: The vocabulary is validated against a live instrumented OMP run, not the TUI.
- AAV-007: The implementation emits through the existing WAL/SSE envelope and does not define gateway payloads or reuse ActionEnvelopeV1 as transport.
- AAV-007: Focused tests cover mapping, idempotency, restart replay, unknown events, identity binding, and transport envelope compatibility; backend typecheck passes.
- AAV-008: Run View renders the orchestration tree from the durable event stream
- AAV-008: Roman numerals are presentation labels; stable agent IDs drive identity
- AAV-008: Browser refresh reconstructs the exact tree from stored events
- AAV-008: Failure reasons and retry/continuation lineage are visible per lane
- AAV-008: WCAG: keyboard navigation, accessible labels, no color-only semantics; 390px no overflow
- AAV-008: Focused frontend tests cover tree render, refresh reconstruction, failure, and empty states; frontend typecheck passes
- AAV-009: Raw PTY tab renders the omp session for an operator
- AAV-009: Structured view remains authoritative; PTY is explicitly a debug surface
- AAV-009: Terminal bytes are bounded and replayable; reconnect is explicit
- AAV-009: PTY failure does not invalidate structured evidence
- AAV-009: Secrets are redacted before persistence
- AAV-009: Focused tests cover PTY attach, failure fallback, and redaction; frontend and backend typechecks pass
- AAV-010: An exact spec revision with an assurance profile runs end to end under OMP.
- AAV-010: Subagent lanes render live and reconstruct exactly after refresh from AAV-007 durable events.
- AAV-010: A subagent failure produces canonical evidence and a US-005 blocked control with an actionable gap.
- AAV-010: Validation evidence binds the exact commit and spec revision; the applicable stage passes only on acceptable evidence.
- AAV-010: Raw terminal remains available for diagnosis.
- AAV-010: Qualification is recorded as a runnable component integration test or documented scenario with receipts and points to the cross-spec qualification boundary.
- AAV-011: rorca_subscribe_run_events, or its exact equivalent, delivers live run, story, gate, evidence, orchestration.*, and gateway.* events to an OMP session.
- AAV-011: Subscription reuses the canonical WAL/SSE envelope with idempotent replay and versioned payload dispatch.
- AAV-011: A session receives events only for its selected workspace.
- AAV-011: The subscription exposes implemented canonical tool names for HMG-010 skill-contract validation.
- AAV-011: No second orchestrator, workflow state machine, or Hermes skill file is introduced.
- AAV-011: Focused tests cover subscription, replay idempotency, isolation, both payload families, and canonical tool-name exposure; backend typechecks pass.
- AAV-012: A persisted spec triggers a Hermes intake review producing structured findings bound to the brief
- AAV-012: Findings surface as intake evidence through the standard lifecycle evidence contract
- AAV-012: Unreviewed or contested findings visibly block intake approval
- AAV-012: Focused tests cover finding emission, evidence binding, and waiver paths; backend typecheck passes
- AAV-013: Each story receives a structured verifiability/traceability finding
- AAV-013: Findings emit as requirements evidence bound to story IDs and the spec revision
- AAV-013: Stories with blocking gaps are visibly flagged
- AAV-013: Focused tests cover finding shape, evidence binding, and gap flagging; backend typecheck passes
- AAV-014: Architecture review findings emit as architecture evidence with decision rationale
- AAV-014: A threat-model pass runs for specs touching auth, secrets, egress, or execution boundaries
- AAV-014: Threat findings are surfaced as structured gaps, never silently dropped
- AAV-014: Focused tests cover review emission and threat-pass applicability; backend typecheck passes
- AAV-015: Secrets scan and dependency check run and emit security evidence
- AAV-015: Evidence binds the exact commit and mechanism identity
- AAV-015: Blocked security controls produce actionable gaps
- AAV-015: Focused tests cover scan execution, evidence emission, and blocked paths; backend typecheck passes
- AAV-016: An independent QA review runs against the release candidate and emits QA evidence
- AAV-016: QA findings are structured and bound to the candidate identity
- AAV-016: Focused tests cover review execution and evidence emission; backend typecheck passes
- AAV-017: Merge verification confirms exact head SHA and complete change set
- AAV-017: Drift or mismatch produces a blocked merge control with the exact discrepancy
- AAV-017: Merge evidence binds the verified head SHA
- AAV-017: Focused tests cover clean, mismatched, and drifted paths; backend typecheck passes
- AAV-018: Deployment confirmation emits production evidence with deployment_id and health result
- AAV-018: Unknown/unavailable deployment state is distinct and visible
- AAV-018: Focused tests cover confirmed, unknown, and failed-health paths; backend typecheck passes
- AAV-019: At minimum a test-result adapter parses a real test run into an AAV-002 outcome.
- AAV-019: Artifact digest and deployment receipt adapters produce bounded outcomes that AAV-006 maps to canonical lifecycle evidence.
- AAV-019: Adapters are executable+args mechanisms, never shell strings.
- AAV-019: Bounded capture includes explicit truncation records.
- AAV-019: Every adapter mapping declares its canonical lifecycle evidence classification, source type, and required subject/release bindings.
- AAV-019: Focused tests cover real-output parsing, canonical mapping, failure, and truncation paths; backend typecheck passes.
- AAV-020: Watchdog v2 classifies known failure classes deterministically and novel classes with bounded LLM assistance.
- AAV-020: Healing uses the canonical Rorca action and receipt path; it does not mutate canonical state directly or introduce a second scheduler.
- AAV-020: Applied restart, alternate-model, worktree-refresh, or authority-reprovision actions preserve exact model, identity, and run lineage.
- AAV-020: Every healing action emits a durable Hermes-bound event with diagnosis, action, receipt, and outcome.
- AAV-020: The watchdog holds at queued/running states and never restarts in flight.
- AAV-020: Focused tests cover known, novel, exhausted-attempt, queued-state, authority, and no-second-orchestrator paths; backend typecheck passes.
- AAV-021: A provider failure in an OMP story session applies the named allowed alternate chain instead of immediately failing the story.
- AAV-021: Fallback application is recorded in canonical story and lifecycle evidence with original reason, selected model, and attempt identity.
- AAV-021: Exhausted alternates fail with the original reason preserved.
- AAV-021: The Pi fallback consumes the same policy only when selected explicitly and does not define a divergent chain.
- AAV-021: Focused tests cover OMP fallback, chain exhaustion, canonical evidence, and Pi-policy compatibility; backend typecheck passes.
- AAV-022: Healing events and run outcomes reach US-007 consumeProductionOutcome with provenance and exact evidence references.
- AAV-022: The returned candidate uses the US-007 canonical shape and deduplication behavior.
- AAV-022: Accumulated evidence proposes control or mechanism adjustments only as pending-review candidates.
- AAV-022: Candidates never auto-approve or mutate controls directly.
- AAV-022: Focused tests cover candidate generation, provenance, US-007 deduplication, and governed review surfaces; backend typecheck passes.
- AAV-023: Every Hermes action declares authority mode and audit identity.
- AAV-023: Service-identity calls to admin-tier routes fail closed with a clear code.
- AAV-023: Dispatch actions carry operator-equivalent authority explicitly.
- AAV-023: HMG intent, persist, subscription, and watchdog paths use the same declared authority contract.
- AAV-023: Focused tests cover allowed, denied, fallback-denied, and cross-surface authority paths; backend typecheck passes.
- MIG-001: OMP story execution runs on Darwin via the ordinary-local profile without manual env assembly
- MIG-001: The OMP child uses the egress broker and auth copy identically to the pi child
- MIG-001: Linux bwrap path verified for the OMP child
- MIG-001: Launch failure is fail-closed with a durable diagnostic, never a raw spawn
- MIG-001: Focused tests cover Darwin launch, Linux launch, auth copy, and fail-closed paths
- MIG-002: MIG-001 sandbox qualification is required before a new run may default to OMP.
- MIG-002: New eligible runs default to OMP end to end.
- MIG-002: Per-spec and per-run overrides select pi, claude, opencode, or codex and are respected by dispatch and manifests.
- MIG-002: Trigger UI shows the executor selector defaulting to omp; the spec page shows the explicit override.
- MIG-002: Watchdog/retry preserves the original executor on restart.
- MIG-002: Existing pi-driven runs remain green via explicit override.
- MIG-003: prompt_delivery_failed no longer occurs on a healthy pi story attempt
- MIG-003: Retry attempts do not hit transient api_key_invalid
- MIG-003: A full pi-fallback run completes end to end with evidence bound correctly
- MIG-003: Focused tests cover the delivery protocol and auth-copy retry paths
- MIG-004: A wave-parallel OMP run with parallelism greater than one executes all wave stories concurrently in separate worktrees.
- MIG-004: Per-story branches merge back cleanly and wave policy gates apply.
- MIG-004: Heterogeneous waves containing omp and claude/pi stories run correctly.
- MIG-004: Each session emits stable run, story, attempt, process, and exact spec revision identity for AAV-007 consumption.
- MIG-004: Focused integration tests cover parallel waves, merge-back, policy gating, heterogeneous agents, and emitted identity.
- MIG-005: Sequential and wave-parallel OMP runs pass the executor qualification scenario.
- MIG-005: Run manifest, story-result, WAL/release-intent identity, retry lineage, and cancellation contracts are byte-compatible with the Pi fallback where executor-agnostic.
- MIG-005: A subagent failure emits durable executor failure identity for AAV/Universal Controls to evaluate; MIG-005 does not own the resulting gate semantics.
- MIG-005: Rollback to an explicit Pi override executes once with no contract drift after MIG-003 fallback qualification.
- MIG-005: Qualification is recorded with exact receipts and a consumer-facing contract fixture for AAV-007 and AAV-010.
- MIG-006: Documentation marks the Pi path as fallback-only with the residual-role rationale.
- MIG-006: A behavioral dispatch test proves eligible new runs default to OMP and Pi runs require explicit override.
- MIG-006: A behavior test proves the explicit Pi fallback remains available and preserves its declared executor across retry.
- MIG-006: The migration plan document and spec reference each other.
- MIG-006: No documentation-text lint is used as a substitute for dispatch behavior.
- INT-001: Registry declares exactly one provider per shared contract and names every consumer.
- INT-001: The suite loads actual provider schemas/artifacts and executes consumer fixtures; a malformed provider shape, unknown version, duplicate owner, or missing consumer assertion fails.
- INT-001: AAV control lookup validates against US-001/US-008 rather than a duplicate catalog.
- INT-001: AAV kernel/evidence adapter and US-005 evaluator validate against canonical lifecycle evidence schemas.
- INT-001: AAV-007 orchestration and HMG-010 gateway payloads coexist on the canonical WAL/SSE envelope without ActionEnvelopeV1 misuse.
- INT-001: The suite is runnable in CI and emits a machine-readable registry receipt.
- INT-002: SourceBundleV1 bundleHash is preserved through persisted EntityRefV1/RevisionRefV1, assurance profile, run manifest, canonical evidence, and gate receipt.
- INT-002: All 11 phase groups compile with no missing mandatory family and project to six Mission stages; learn remains non-blocking.
- INT-002: Every active evidence requirement resolves to a real adapter or explicit governed human/approval path.
- INT-002: A forced OMP subagent failure produces a durable event, actionable blocked control, Hermes-observed recovery, new canonical evidence, and applicable-stage re-evaluation.
- INT-002: Browser refresh reconstructs the durable orchestration tree and Hermes subscription replays the same event sequence idempotently.
- INT-002: Changing a frozen source creates a new bundle/revision/profile, requires re-review, and prevents old evidence from satisfying the new revision.
- INT-002: A production/healing outcome creates exactly one deduplicated US-007 pending-review candidate with provenance.
- INT-002: The scenario produces exact receipts and runs in CI or a documented isolated harness.
- INT-003: OMP sequential and wave-parallel executions satisfy the same executor-agnostic manifest/result/WAL identity fixtures.
- INT-003: A heterogeneous wave preserves per-story declared executors and isolated worktrees while merging under the normal wave policy.
- INT-003: Explicit Pi fallback completes after MIG-003 reliability qualification and preserves the original executor across retry.
- INT-003: OMP provider fallback records the named alternate and original reason in canonical evidence without changing control/gate semantics.
- INT-003: Restart and replay are idempotent across OMP and Pi paths; cancellation closes each process/worktree without duplicate terminal events.
- INT-003: Matrix results are attached to the INT-001 registry receipt with exact run and revision identities.

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
