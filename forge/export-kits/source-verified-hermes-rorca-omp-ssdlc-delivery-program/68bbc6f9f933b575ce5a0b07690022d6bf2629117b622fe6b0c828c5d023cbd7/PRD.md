# Source-Verified Hermes–Rorca–OMP SSDLC Delivery Program — Product Requirements

## Problem
Deliver the behavior defined by the canonical Source-Verified Hermes–Rorca–OMP SSDLC Delivery Program specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- US-001 — Control Catalog Schema and Validation
- US-002 — Genesis Source Authority Projection
- US-003 — Layered Applicability Resolver L0-L5
- US-004 — Phase Control Groups and Stage Readiness Compiler
- US-005 — Canonical Lifecycle Evidence and Exception Evaluation
- US-006 — Skill Binding and Structured Findings
- US-007 — Canonical Learn-Loop Candidate Generation
- US-008 — Universal Kernel Catalog Artifact
- HMG-001 — Versioned source and intent contracts with strict validation
- HMG-002 — Source adapter framework with registry and honest failure states
- HMG-003 — Genesis source adapter resolving canonical approved provenance
- HMG-004 — Local file source adapter for workspace Markdown and text documents
- HMG-005 — Context compiler with conflict detection and prompt-injection separation
- HMG-006 — Intent intake router with visible disposition classification
- HMG-007 — Mission draft bridging from compiled source bundle through assurance-ready persist
- HMG-008 — Source-drift detection with revision and assurance invalidation
- HMG-009 — Mission OS Intent lens with requirement-to-source traceability
- HMG-010 — Gateway event family and canonical Hermes skill contract
- AAV-001 — Assurance profile schema attached to exact spec revisions
- AAV-002 — Universal verification kernel: execute, judge, bind
- AAV-003 — Canonical control catalog consumer and contract validation
- AAV-004 — Repository mechanism discovery from context
- AAV-005 — Context-aware assurance mechanism binder
- AAV-006 — Hermes assurance execution and canonical evidence emission
- AAV-007 — Versioned OMP orchestration event ingestion
- AAV-008 — Structured Run View orchestration tree
- AAV-009 — Raw OMP terminal tab for debugging
- AAV-010 — Assurance and OMP component parity qualification
- AAV-011 — Hermes subscription to canonical run events
- AAV-012 — Hermes intake review agent
- AAV-013 — Hermes requirements verification
- AAV-014 — Hermes architecture review and threat model
- AAV-015 — Hermes security controls execution
- AAV-016 — Hermes QA release-candidate review
- AAV-017 — Hermes merge verification
- AAV-018 — Hermes production confirmation
- AAV-019 — Evidence adapters for real artifacts
- AAV-020 — Hermes watchdog v2: diagnosis and governed healing
- AAV-021 — Executor-neutral provider fallback policy and evidence
- AAV-022 — Learn-loop adapter: heal events to canonical Genesis candidates
- AAV-023 — Hermes authority model: service-to-operator split
- MIG-001 — OMP executor sandbox wiring
- MIG-002 — Default executor flip to OMP with per-spec override
- MIG-003 — Pi fallback lane insurance
- MIG-004 — Wave-parallel execution verification under OMP
- MIG-005 — OMP executor parity and rollback qualification
- MIG-006 — Engine fallback posture and dispatch enforcement
- INT-001 — Contract registry and consumer-driven verification
- INT-002 — Full source-to-learning interoperability qualification
- INT-003 — Executor and recovery compatibility matrix

## In scope
- Implement the canonical ControlRecord contract as the sole source of truth for SSDLC controls. Create backend/src/ssdlc/schema/control-schema.ts exporting PHASES, MISSION_STAGE_BY_PHASE, SOURCE_STRENGTHS, FAILURE_SEVERITIES, EVIDENCE_DEPTHS, ControlRecord, EvidenceRequirement, parseControl(unknown), and validateControl(unknown): ValidationError[]. Emit backend/src/ssdlc/schema/control-schema.json as a JSON Schema draft 2020-12 artifact. ControlRecord has schemaVersion 'rorca.ssdlc-control-record.v1', strict semver version, controlId, phase, objective, applicability, source references, structured requiredEvidence, failure severity, exception policy, and skillRefs. Each EvidenceRequirement specifies classification, allowedSourceTypes, required subject/release bindings, minimum trust level, evidence depth, and freshness. This schema and controls.json are canonical: AAV consumes controlId and this artifact; it must not define a second catalog or controlRef shape. Follow docs/contracts/ssdlc-interoperability.md.
- Implement the Genesis source authority projection at backend/src/ssdlc/genesis/source-authority.ts. Genesis is the sole authority for evidence review status and access. Define a validated local EvidenceRecord projection { genesisEvidenceId, sourceTitle, exactCitation, evidenceStrength, supersedes?: string[], supersededBy?: string, contradictionGroup?: string } sourced from the existing Genesis bridge; it must never independently approve, trust, or promote evidence. Export getEvidence, resolveAuthority, detectContradictions, validateControlAgainstGenesis, and test-fixture registration only. Integrate with US-001 so every source reference resolves to a Genesis evidence id; raw-prose-only references are rejected. Contradictions and supersession remain explicit and carry Genesis provenance. HMG-003 consumes this same bridge-compatible projection.
- Implement the layered applicability resolver at backend/src/ssdlc/applicability/resolver.ts. Profile shape: { productProfile: 'cli'|'library'|'web-frontend'|'api-service'|'mobile'|'data-pipeline'|'ai-ml'|'infrastructure'|null, riskProfile: string[], domainRegulatory: string[], workspaceConventions?: string[], specTaskOverrides?: Array<{ controlId, action: 'include'|'exclude', evidenceDepthOverride?, requirementId }> }. L0 controls with applicability.universal true are always active. L1 product profile selects by applicability.productProfiles. L2 risk profile selects by applicability.riskProfiles. L3 domain-regulatory overlay selects by applicability.domainRegulatory. L4 workspace conventions and L5 spec-task requirements apply as overrides on top of L0-L3. Export resolveActiveControls(profile) returning { activeControlIds, evidenceDepthByControlId, resolutionLog }. Evidence depth derivation: controls tied to safety-critical, aviation, or privacy-regulated receive independent-verification; controls tied to data-modifying, financial-side-effects, external-integration, or privileged-admin receive artifact; remaining active controls receive self-attestation; L4/L5 overrides are applied last and recorded in resolutionLog. Add jest tests in backend/src/ssdlc/applicability/resolver.test.ts.
- Implement the phase compiler at backend/src/ssdlc/gates/gate-compiler.ts. FAMILY_MAP defines mandatory control families for each of the 11 canonical phases. Compile active controls from US-003 into 11 phase control groups with evidence requirements, then project them into the six Mission stages: intent=intake; plan=requirements+architecture; build=implementation; verify=validation+security; release=staging+qa+merge+production; learn=learn. The first five stages may block delivery when applicable controls are unresolved; learn is asynchronous and non-blocking. Risk, regulation, or governed exception may expose an approval inside its stage. This compiler owns mandatory-control selection; AAV-005 only binds mechanisms and criteria to its output.
- Implement the mandatory gate evaluation engine at backend/src/ssdlc/evaluation/gate-evaluator.ts. evaluateGate consumes only canonical rorca.lifecycle-evidence.v1 records (or validated hermes.evidence.v1 ingress normalized into that record) against US-001 structured EvidenceRequirements and returns a GateEvaluationTrace. It aggregates phase results into the US-004 stage projection. A control with no matching current evidence, no evidence-backed not-applicable determination, and no valid exception is blocked. Evidence must bind the exact spec hash and release identity required by the control and be newer than the subject mutation. AAV kernel outcomes are internal and must be normalized by AAV-006 before reaching this evaluator.
- Implement skill binding at backend/src/ssdlc/skills/skill-registry.ts and findings ingestion at backend/src/ssdlc/skills/findings.ts. SkillRecord { skillId, name, version, controlIds[], implementationRef } binds only existing US-001 controlIds. StructuredFinding is the sole finding shape for AAV-012 through AAV-018: { findingId, controlId, skillId, requirementId?, storyId?, status: 'pass'|'fail'|'blocker', evidenceRefs, message }. ingestFindings validates each finding and blocks the matching US-004 stage when a blocker maps to an active control. No phase-review agent may introduce an alternate finding store or shape.
- Implement the only learn-loop candidate store at backend/src/ssdlc/learn/learn-loop.ts. consumeProductionOutcome(outcome) classifies a production or healing outcome into reviewable Genesis candidates of four types: test-class-failed-to-predict-defect, exception-caused-rework, control-produced-no-signal, and model-underperformed-on-task-class. Candidate shape is { candidateId, type, controlId, phase, evidenceRef, signalCount, status: 'pending-review'|'approved'|'rejected' }. Deduplicate by (type, controlId, evidenceRefHash). AAV-022 adapts its outcomes into this function; it must not implement a second candidate shape or store. applyCandidate requires approved status and explicit authorized actor; no candidate auto-approves or silently rewrites the catalog.
- Curate and ship the initial canonical catalog at backend/src/ssdlc/catalog/controls.json and the Genesis evidence projection fixture at backend/src/ssdlc/catalog/genesis-evidence.json. Include 20 to 40 US-001-valid controls across all 11 phase categories so US-004 reports no missing mandatory family. Source controls from ISO/IEC/IEEE 29148:2018, ISO/IEC/IEEE 42010:2022, ISO/IEC 25010:2023, ISO/IEC/IEEE 29119, NIST SP 800-218 SSDF, and DORA delivery research with exact citations. Every control provides structured evidence requirements and every requirement resolves either to a real AAV-019 adapter or an explicit governed human or approval route. This is the only catalog consumed by AAV.
- Add SourceRefV1, SourceBundleV1, SourceCitationV1, SourceConflictV1, ContextCompilationReceiptV1, IntentEnvelopeV1, and IntentDispositionV1 to shared/contracts/source.ts (and the rootDir-safe backend mirror backend/src/lib/source-contracts.ts) following the existing mission.ts versioning pattern (schemaVersion per contract, strict Zod, closed enums with explicit unknown). SourceRefV1 carries kind (genesis_package | genesis_evidence | local_file | url | github_issue | github_pr | linear_document | rorca_mission | inline), locator, title, contentHash sha256, sourceVersion, reviewStatus (approved | trusted | pending | unreviewed | external), sensitivity, authority (user_mandated | approved_context | supporting_evidence), and selectedSections. SourceBundleV1 records bundleId, bundleHash, userIntent, workspaceRef (EntityRefV1), includedSources, excludedSources with reasons, conflicts, assumptions, truncations, citations, compiledAt. IntentDispositionV1 is a closed union: answer | clarification_required | mission_draft | existing_mission_action | memory_candidate | denied, each with targetRef, draftHash, rationale, requiredDecision, permittedAction. Reject external/nested locators, unhashed content, overloaded statuses, and client-authored arbitrary actions.
- Define the SourceAdapter interface (canResolve, resolve, fetch, normalize) and a registry in backend/src/lib/source-adapters.ts. Each adapter returns typed SourceCandidate[] from resolve and a frozen VersionedSource from fetch (content + exact revision + sha256 hash + byte/section bounds). Adapters must fail closed on unresolvable locators, unsupported schemes, missing authority, or redaction-required content. The registry exposes listAdapters(), resolveFor(locator), and a bounded normalize pipeline that never executes commands and treats source content strictly as data.
- Implement the Genesis adapter (kind genesis_package | genesis_evidence) in backend/src/lib/source-adapters/genesis.ts. It resolves approved Genesis packages/evidence by id through the existing Genesis bridge/provenance surface, maps to the existing GenesisProvenanceSchema shape, and preserves bridge-derived reviewStatus approved/trusted/pending/unreviewed. Pending candidates are never presented as approved. Restricted material obeys the requesting principal's sensitivity authority and remains redacted. Selected sections reference exact evidence chunk ids and citations. Consume the US-002 Genesis authority projection; do not create a local approval registry or mutate Genesis review state.
- Implement the local-file adapter (kind local_file) resolving paths relative to the active workspace root. It resolves the exact path (rejecting traversal), reads and normalizes Markdown/text, computes sha256, extracts heading-level sections with line ranges, and produces SourceRefV1 with selectedSections and citations to exact headings. A document used for one Mission is classified user-supplied source evidence; it is not automatically promoted to organizational knowledge. Offer capture-to-Genesis as an explicit separate action, never implicit.
- Implement compileSourceBundle in backend/src/lib/source-compiler.ts. It merges user-mandated sources (user_mandated), approved organizational context (Direction Stack, approved Genesis knowledge, conventions), and supporting evidence (code, git, prior Missions) into a SourceBundleV1. It detects material conflicts across sources and against higher-authority direction, emitting SourceConflictV1 entries and requiring user resolution only when scope, safety, or acceptance is affected. It separates source content from instructions: external content is data, never executable instructions; secrets are redacted; and a bounded extraction contract prevents token blowup. It reuses buildForgeContextBundle for the Rorca-native context side.
- Add POST /api/hermes/intent accepting IntentEnvelopeV1 and returning IntentDispositionV1. Classification is deterministic-first: explicit source refs and existing-mission refs drive mission_draft / existing_mission_action; read-only question phrasing yields answer; memory-candidate phrasing yields memory_candidate; ambiguous scope yields clarification_required; policy violation yields denied. Model synthesis may assist only after deterministic signals. The endpoint is idempotent by workspace-scoped idempotencyKey and uses the AAV-023 declared service-audit/operator-dispatch authority model. A mission_draft continues only through HMG-007's source bundle -> persist -> controls -> assurance compilation -> review/approval -> trigger sequence.
- Bridge a mission_draft disposition to canonical explicit-draft persistence: build PersistSpecDraft from the frozen SourceBundleV1, then POST to existing /api/specs/persist. Freeze the bundle hash, exact source refs, Genesis provenance, and the returned EntityRefV1/RevisionRefV1 in the persisted spec revision. Reject stale or mutated bundles before persistence. After persistence, invoke the canonical US-003/US-004 control compilation and AAV-001/AAV-005 assurance-profile compilation for that exact revision before review/approval can permit trigger. No legacy /api/specs/generate path is used.
- Re-hash each frozen source of an approved Mission and compare it to the recorded contentHash. When a source changes, mark the Mission context stale without silently swapping content; expose the exact old/new hash and source state. Bounded recompilation produces a new SourceBundleV1, a new spec revision, and a new assurance profile compilation receipt. The old profile and evidence remain bound to their historical revision but cannot satisfy gates for the new revision. Unknown and unavailable are distinct honest states.
- Extend the Mission Workspace Intent lens (src/panels/MissionWorkspacePanel.tsx, src/components/mission/) to show source provenance: Built from N sources with exact revisions/hashes, included vs excluded sections, citations linking requirements to source passages, conflict resolutions, and drift state. Reuse the Evidence Field vocabulary (text+icon+tone, unknown/unavailable distinct, one dominant action). The lens renders the frozen bundle from the delivery-case/spec read; it never re-fetches live source content and never fabricates source data not present in the projection. Accessible: keyboard navigable citations, screen-reader labels for hash chips, no color-only semantics.
- Define the durable gateway contract for Hermes. Own versioned gateway.* payloads (mission_draft_ready, decision_required, gate_blocked, source_drift, run_completed, release_ready) carried through the existing WAL/SSE envelope beside AAV-007 orchestration.* payloads. ActionEnvelopeV1 remains a server-authored permitted action descriptor, not generic transport. Update the sole Hermes workflow skill contract at packages/rorca-pi-extension/skills/hermes-autonomous-supervisor to teach the exact implemented sequence: intent -> compile sources -> draft -> persist exact revision -> compile controls -> bind assurance -> approve -> trigger -> subscribe -> supervise -> learn. The skill uses canonical tool names exposed by AAV-011; Hermes observes, classifies, proposes, relays, notifies, and escalates while Rorca owns every canonical mutation.
- Define rorca.assurance-profile.v1 as an immutable artifact attached to an exact existing EntityRefV1 and RevisionRefV1 spec revision. It contains US-001 controlId-based controlInstances, mechanism bindings, criteria, structured evidence requirements, repositoryContextHash, risk profile, SourceBundleV1 bundle hash when HMG persisted source context, and compilationReceiptHash. A source-bundle or spec revision change invalidates the profile and requires recompilation; old evidence cannot silently satisfy the new revision. Product stories remain separate from lifecycle controls. Existing specs without profiles stay readable through an explicit empty/default profile path. Follow docs/contracts/ssdlc-interoperability.md.
- Implement the tool-agnostic verification kernel in backend/src/lib/assurance-kernel.ts. verify(contract, actor) runs execute(mechanism) -> judge(outcome, criteria) -> bind(contract, outcome, actor, now) and returns an internal KernelVerificationOutcome with pass|fail|blocked and an actionable gap. The kernel has zero tool- or methodology-specific branches. It binds US-001 controlId, exact spec/revision/commit identity, actor, timestamp, mechanism identity, and outcome digest, but it does not invent a lifecycle evidence schema or decide a gate. AAV-006 is the only adapter that normalizes this outcome to canonical lifecycle evidence; US-005 owns gate decisions.
- Implement backend/src/lib/assurance-control-catalog.ts as a read-only consumer/query adapter over US-001 and US-008's canonical ControlRecord schema and backend/src/ssdlc/catalog/controls.json. It resolves controls by controlId, validates AAV compilation input against the published JSON Schema, and exposes no second catalog, controlRef type, catalog file, or ownership semantics. Add consumer-driven contract tests loading the actual US-001 schema and US-008 artifact.
- Implement backend/src/lib/mechanism-discovery.ts: detect repository-specific verification mechanisms from evidence (package.json scripts/deps, pyproject.toml, Cargo.toml, go.mod, existing CI workflows, AGENTS.md/governance files) and produce candidate mechanisms as executable + args vector (never untrusted shell strings), cwd, discoveredFrom file paths, and confidence. The user never has to name the tool; the repository does. Discovery is deterministic, read-only, and bounded.
- Implement the assurance binding path: HMG-persisted exact spec revision and source bundle, repository context, risk profile, US-003 applicability result, US-004 active phase groups/stage projection, and the canonical US-008 catalog feed a model proposal. The deterministic binder validates that selected mechanisms are allowed, criteria and structured evidence requirements are complete, and no selected control is weakened. It binds repository mechanisms and criteria to controls already selected by US-003/US-004; it must not independently select mandatory controls. Output is an idempotent rorca.assurance-profile.v1 bound to the exact revision and bundle hash.
- Implement the Hermes assurance adapter that executes compiled mechanism bindings, records exact mechanism identity, captures bounded results, evaluates criteria deterministically, converts AAV-002 outcomes into canonical rorca.lifecycle-evidence.v1 records, and requests US-005 stage reevaluation. It emits the sole lifecycle evidence shape, preserving the exact spec/revision/commit/release identity required by US-001. Blocked controls carry actionable gaps. Every Hermes phase-review agent (AAV-012 through AAV-018) emits US-006 StructuredFinding through this boundary. Authority follows the explicit AAV-023 service-audit/operator-dispatch split, never accidental admin fallback.
- Implement provider-neutral orchestration event ingestion: project actual OMP JSONL RPC output from OmpManagedExecutor into durable rorca.orchestration-event.v1 payloads carried by the existing WAL/SSE transport. This story owns only orchestration.* payloads: agent_started, task_started, agent_progress, agent_completed, and agent_failed. Payloads retain parentage, monotonic sequence numbers, idempotent replay, and EntityRefV1-bound run/story/attempt/process identity. Unknown OMP events remain inspectable. Gateway-domain events remain HMG-010's gateway.* payload family; ActionEnvelopeV1 is never used as a generic event envelope.
- Render the durable orchestration stream in the run surface (src/panels/RunViewPanel.tsx / RunTerminal): a parent agent tree with subagent lanes (I, II, III, IV) showing live status, role/name, parent-child relationship, elapsed time, tool/event summary, failure reason, produced evidence, and retry/continuation lineage. Roman numerals are presentation labels only - stable IDs underneath, since concurrency and retries reorder agents. The view reconstructs exactly after browser refresh (rebuilt from stored events, not a live terminal) and is accessible: keyboard navigable, no color-only semantics.
- Add an optional raw OMP terminal tab to the run surface using PTY passthrough of the omp session (terminal_mode pty path). The structured orchestration view remains the authoritative surface; the raw terminal is for operator fidelity and debugging. Reconnect behavior is explicit, terminal bytes are bounded and replayable where possible, PTY failure never invalidates structured evidence, and secrets are redacted before persistence.
- Qualify the assurance/OMP component boundary: an exact persisted spec revision with an attached assurance profile executes under OMP; orchestration lanes render/reconstruct; a subagent failure becomes a canonical blocked control with an actionable gap; retry/continuation is visible; and acceptable evidence binds exact commit and spec identity before US-005 permits the applicable stage. This is component parity only. The complete HMG -> controls -> assurance -> OMP -> gates -> supervision -> learning proof belongs to the interoperability qualification spec.
- Expose the existing durable WAL/SSE run event envelope back into OMP so a supervising Hermes session observes live run, story, gate, evidence, orchestration.*, and gateway.* events without polling. Add rorca_subscribe_run_events to the MCP surface or an equivalent subscription with idempotent replay and workspace isolation. AAV-011 consumes AAV-007 orchestration payloads and HMG-010 gateway payloads; it does not create a second orchestrator or own the Hermes skill contract. HMG-010 is the sole skill owner and documents this implemented subscription surface.
- Hermes reviews the user brief before forging: outcome framing, scope boundaries, and risk class, returning structured findings that become intake-phase lifecycle evidence through the AAV-006 execution surface. Findings are visible and reviewable; the forge proceeds only when intake findings are satisfied or explicitly waived.
- Hermes verifies each story for verifiability and traceability (29148-style: testable, traceable, atomic) and emits per-story findings as requirements-phase evidence. Unverifiable stories are flagged with concrete gaps before implementation begins.
- Hermes reviews architecture-relevant decisions in the spec (42010-style stakeholder concerns, decision rationale, threat model for the change surface) and emits architecture-phase evidence. The threat-model pass is mandatory for specs touching auth, secrets, network egress, or execution boundaries.
- Hermes executes security controls against the implementation: secrets scan, dependency check, and threat verification, emitting security-phase evidence from real artifact output. Security evidence follows the same execute -> judge -> bind -> decide kernel as every other control.
- Hermes performs an independent review of the completed release candidate (workflow checks, regression assessment, release-candidate acceptance) and emits QA-phase evidence. QA is distinct from validation: it judges the candidate, not the build correctness.
- Hermes verifies exact-SHA change-set integrity before merge: the merged branch head matches the authorized head, the change set is complete, and no uncommitted drift exists; emits merge-phase evidence.
- Hermes confirms deployment: deployment_id binding, target identity, and post-deploy health check, emitting production-phase evidence. Unavailable or unknown deployment state is an honest distinct state, never a silent pass.
- Implement concrete adapters that turn real artifact output into AAV-002 mechanism outcomes: test_result parses Jest/Vitest/Pytest command, exit code, test summary, and requirement coverage; artifact digest captures build outputs; deployment receipt captures deployment evidence. AAV-006 maps those outcomes to the existing canonical lifecycle evidence source types/classifications and required subject/release identities. Adapters use executable+args vectors, bounded capture, and deterministic criteria; they never create a second evidence-kind taxonomy.
- Implement the session-built watchdog v2 at the Hermes supervision boundary, not as a second Rorca execution-engine loop. It consumes canonical run/gate/evidence events, classifies known failures deterministically, uses LLM synthesis only for novel patterns, and proposes or invokes governed Rorca actions for restart, alternate model, worktree refresh, or authority re-provision. Rorca retains canonical mutations, leases, worktree authority, and durable receipts. Every diagnosis, action, and outcome is Hermes-bound, auditable, and follows AAV-023 authority; no controller restarts queued or running work in flight.
- Implement a named provider fallback policy that the primary OMP executor applies within a story session on provider failures such as usage limit, connection error, or terminalized authority. Rorca supplies the allowed alternate chain and records the selected fallback in canonical story/lifecycle evidence; OMP performs session-level fallback. The explicit Pi fallback may consume the same policy but does not become its owner. Exhaustion preserves the original reason. This is not a return to engine-primary execution.
- Adapt Hermes heal events and run outcomes to US-007 consumeProductionOutcome. Preserve controlId, phase, exact evidence reference, and provenance, then return the canonical US-007 candidate. This story owns no candidate shape, deduplication key, candidate store, approval decision, or catalog mutation. Accumulated evidence may propose control or mechanism adjustments only through US-007's pending-review path.
- Make the Hermes authority split explicit and enforced across AAV, HMG, and the watchdog: Hermes identity is used for audit and evidence; operator-equivalent authority is explicit for permitted dispatch and mutation; no accidental admin fallback exists. Every Hermes action carries a declared authority mode and audit identity. HMG intent, persist, supervision, and retry flows consume this contract.
- Wire the OmpManagedExecutor child through the ordinary-local Pi sandbox profile on Darwin (egress broker, auth copy, runtime state) so governed OMP story execution works on macOS; verify the existing linux-bwrap path on Linux. The OMP child must launch with the same fail-closed posture as the pi child: allowlisted env, model-credential egress, worktree confinement, death receipts.
- After MIG-001 has qualified OMP sandbox launch, make OMP the default story executor: pipeline dispatch selects agent omp unless explicitly overridden at spec or run level. Pi remains a fully supported fallback through explicit override. Add the executor selector to trigger UI and per-spec override field. Dispatch, manifests, watchdog restart, and retry preserve the original executor. Governance, lifecycle evidence, gate semantics, and Run View rendering remain owned by Universal Controls and AAV.
- Fix the pi fallback path root causes observed this session so it is dependable when used: the prompt_delivery_failed progress-log verification (pi_progress_log_unverified) and the transient api_key_invalid on retry attempts (sandbox auth copy). The fallback lane must be reliable enough for watchdog-restarted runs and per-spec overrides.
- Verify executor-level wave-parallel execution with OMP: a wave of N parallel stories launches N concurrent OMP RPC sessions, each in its own per-story worktree, and merges per-story branches back to the run branch through commitGuardedMerge under wave-production-policy gates. Confirm generic per-agent wave machinery routes OMP stories alongside other agent types. This story owns process/worktree/merge parity and emits durable identity-bearing run results/events; AAV-007/008 own event projection and Run View rendering.
- Qualify the executor migration only: sequential and wave-parallel OMP runs produce byte-compatible execution contracts with the explicit Pi fallback for run manifests, story results, WAL/release intent identity, retry lineage, cancellation, and rollback. It does not define lifecycle evidence semantics, gate decisions, or Run View behavior; AAV and Universal Controls consume the stable executor contracts. Prove the single-config rollback to explicitly selected Pi once after MIG-003 restores fallback reliability.
- Document and enforce the engine fallback-only posture after MIG-005 qualification: OMP is the default executor; Pi remains selectable as explicit fallback; Claude agent compatibility remains a deliberate per-story override. The migration plan is docs/mig-006-engine-fallback-posture.md; this spec and that plan are a bidirectional control pair. Enforce behavior through dispatch tests rather than documentation-text linting. Any future change that makes Pi default or expands its primary-executor role reopens this spec.
- Implement backend/src/ssdlc/interop/contract-registry.ts and an executable registry suite that loads provider artifacts and validates consumer expectations, not prose. Register: HMG SourceBundleV1/intent contracts; existing EntityRefV1 and RevisionRefV1; US-001 ControlRecord JSON Schema and US-008 controls.json; US-004 stage projection; rorca.assurance-profile.v1; canonical rorca.lifecycle-evidence.v1/hermes.evidence.v1; AAV-007 orchestration payloads; HMG-010 gateway payloads; US-006 StructuredFinding; US-007 candidate. Each entry names one provider, every consumer, version, and an executable validation fixture. This is the CDC release gate defined by docs/contracts/ssdlc-interoperability.md.
- Execute the complete governed chain in an isolated qualification workspace after HMG, Universal Controls, AAV, and MIG implementation receipts exist: HMG source bundle -> explicit persist exact revision -> US-003 applicability -> US-004 phase groups/six-stage projection -> AAV mechanism binding/profile -> MIG OMP run -> canonical evidence -> US-005 stage evaluation -> Hermes subscription/healing -> US-007 candidate. Exercise a success path, forced subagent failure/recovery, and source-drift/revision invalidation. This is the only whole-program qualification; component specs retain their own focused tests.
- Run the executor compatibility matrix after MIG and AAV component qualification: OMP sequential, OMP wave-parallel, heterogeneous wave with an explicit Claude or Pi story, explicit Pi fallback, restart/replay, provider fallback, and cancellation. Assert that only executor-specific behavior varies; EntityRef/RevisionRef identity, manifests, story results, WAL/release intent, canonical evidence binding, and event replay stay compatible with the contract registry.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### US-001
Implement the canonical ControlRecord contract as the sole source of truth for SSDLC controls. Create backend/src/ssdlc/schema/control-schema.ts exporting PHASES, MISSION_STAGE_BY_PHASE, SOURCE_STRENGTHS, FAILURE_SEVERITIES, EVIDENCE_DEPTHS, ControlRecord, EvidenceRequirement, parseControl(unknown), and validateControl(unknown): ValidationError[]. Emit backend/src/ssdlc/schema/control-schema.json as a JSON Schema draft 2020-12 artifact. ControlRecord has schemaVersion 'rorca.ssdlc-control-record.v1', strict semver version, controlId, phase, objective, applicability, source references, structured requiredEvidence, failure severity, exception policy, and skillRefs. Each EvidenceRequirement specifies classification, allowedSourceTypes, required subject/release bindings, minimum trust level, evidence depth, and freshness. This schema and controls.json are canonical: AAV consumes controlId and this artifact; it must not define a second catalog or controlRef shape. Follow docs/contracts/ssdlc-interoperability.md.

**Acceptance criteria**
- Given a complete valid control fixture, parseControl returns the record and validateControl returns [] with zero errors.
- ControlRecord requires schemaVersion 'rorca.ssdlc-control-record.v1'; an unknown schemaVersion is rejected.
- Given a control object with controlId omitted, validateControl returns at least one error whose path includes controlId.
- Given a control object with sourceStrength 'unverified', validateControl returns an error whose path includes sourceStrength.
- Given a control object whose sourceReferences contains an item lacking genesisEvidenceId, validateControl returns an error whose path includes sourceReferences and the offending index.
- Given a control object with version '1.0', validateControl returns an error whose path includes version, because '1.0' is not strict semver.
- Every requiredEvidence entry validates classification, allowed source types, required subject or release bindings, minimum trust, evidence depth, and freshness; an untyped string requirement is rejected.
- Given the JSON Schema artifact at control-schema.json, a record rejected by validateControl is also rejected by ajv JSON Schema validation.
- PHASES exports exactly ['intake','requirements','architecture','implementation','validation','security','staging','qa','merge','production','learn'] in that order and MISSION_STAGE_BY_PHASE maps them to intent, plan, build, verify, release, or learn.
- A consumer fixture from the assurance compiler validates through this schema without a second control-catalog type.

### US-002
Implement the Genesis source authority projection at backend/src/ssdlc/genesis/source-authority.ts. Genesis is the sole authority for evidence review status and access. Define a validated local EvidenceRecord projection { genesisEvidenceId, sourceTitle, exactCitation, evidenceStrength, supersedes?: string[], supersededBy?: string, contradictionGroup?: string } sourced from the existing Genesis bridge; it must never independently approve, trust, or promote evidence. Export getEvidence, resolveAuthority, detectContradictions, validateControlAgainstGenesis, and test-fixture registration only. Integrate with US-001 so every source reference resolves to a Genesis evidence id; raw-prose-only references are rejected. Contradictions and supersession remain explicit and carry Genesis provenance. HMG-003 consumes this same bridge-compatible projection.

**Acceptance criteria**
- Given a Genesis bridge projection for valid evidence GEN-001, getEvidence('GEN-001') returns that exact projection and its bridge provenance.
- No local function can promote pending or unreviewed evidence to approved or trusted; review state comes only from the Genesis bridge.
- Given a control whose sourceReferences cites genesisEvidenceId 'GEN-999' that is not registered by Genesis, validateControlAgainstGenesis returns an error identifying 'GEN-999'.
- Given a control whose sourceReferences includes a citation without a resolvable genesisEvidenceId, validateControlAgainstGenesis rejects the record.
- Given two projected evidence records sharing contradictionGroup 'authz-conflict', detectContradictions returns exactly one conflict object containing both genesisEvidenceIds and the group name.
- Given GEN-002 projected as superseding GEN-001, resolveAuthority('GEN-001') returns GEN-002 and marks GEN-001 superseded.
- The source-authority suite covers projection, reject, supersession, contradiction, and attempted local-promotion denial paths.

### US-003
Implement the layered applicability resolver at backend/src/ssdlc/applicability/resolver.ts. Profile shape: { productProfile: 'cli'|'library'|'web-frontend'|'api-service'|'mobile'|'data-pipeline'|'ai-ml'|'infrastructure'|null, riskProfile: string[], domainRegulatory: string[], workspaceConventions?: string[], specTaskOverrides?: Array<{ controlId, action: 'include'|'exclude', evidenceDepthOverride?, requirementId }> }. L0 controls with applicability.universal true are always active. L1 product profile selects by applicability.productProfiles. L2 risk profile selects by applicability.riskProfiles. L3 domain-regulatory overlay selects by applicability.domainRegulatory. L4 workspace conventions and L5 spec-task requirements apply as overrides on top of L0-L3. Export resolveActiveControls(profile) returning { activeControlIds, evidenceDepthByControlId, resolutionLog }. Evidence depth derivation: controls tied to safety-critical, aviation, or privacy-regulated receive independent-verification; controls tied to data-modifying, financial-side-effects, external-integration, or privileged-admin receive artifact; remaining active controls receive self-attestation; L4/L5 overrides are applied last and recorded in resolutionLog. Add jest tests in backend/src/ssdlc/applicability/resolver.test.ts.

**Acceptance criteria**
- Given a profile { productProfile: 'api-service', riskProfile: [], domainRegulatory: [] }, the resolver includes every control with applicability.universal true and every control whose productProfiles includes 'api-service', and excludes controls whose productProfiles is ['cli'].
- Given a profile with riskProfile containing 'safety-critical', every active control with applicability.riskProfiles including 'safety-critical' receives evidenceDepth 'independent-verification'.
- Given a profile with domainRegulatory ['finance'], controls with applicability.domainRegulatory including 'finance' are active and controls tagged only ['healthcare'] are excluded.
- Given an L5 specTaskOverride { controlId: 'CTRL-X', action: 'exclude', requirementId: 'REQ-42' }, the resolver excludes CTRL-X and the resolutionLog records REQ-42 as the override source.
- Given an empty profile { productProfile: null, riskProfile: [], domainRegulatory: [], workspaceConventions: [], specTaskOverrides: [] }, the resolver returns all L0 universal controls.
- Calling resolveActiveControls twice with identical profiles returns deep-equal activeControlIds and evidenceDepthByControlId.
- The jest suite resolver.test.ts covers L0-L5 selection, depth derivation, and override paths and passes.

### US-004
Implement the phase compiler at backend/src/ssdlc/gates/gate-compiler.ts. FAMILY_MAP defines mandatory control families for each of the 11 canonical phases. Compile active controls from US-003 into 11 phase control groups with evidence requirements, then project them into the six Mission stages: intent=intake; plan=requirements+architecture; build=implementation; verify=validation+security; release=staging+qa+merge+production; learn=learn. The first five stages may block delivery when applicable controls are unresolved; learn is asynchronous and non-blocking. Risk, regulation, or governed exception may expose an approval inside its stage. This compiler owns mandatory-control selection; AAV-005 only binds mechanisms and criteria to its output.

**Acceptance criteria**
- Given fixture controls covering all 11 phases with at least one control per mandatory family, compileGates returns exactly 11 ordered phase control groups from intake through learn.
- Each phase group contains phase, controlIds, families, and structured evidence requirements; every controlId appears in at least one family array.
- The readiness projection contains exactly six stages in order: intent, plan, build, verify, release, learn.
- The phase mapping is intake->intent; requirements and architecture->plan; implementation->build; validation and security->verify; staging, qa, merge, and production->release; learn->learn.
- Learn is explicitly non-blocking, while unresolved applicable controls block only their projected non-learn stage.
- Gate families match the brief, including intake need-validity/scope-boundaries/risk-classification, requirements completeness/verifiability/traceability/quality-attributes, security threat-control-verification/authz-boundaries/secrets/supply-chain/vulnerability-response, and learn incident-analysis/prediction-vs-outcome/delivery-metrics/control-effectiveness/improvement-candidates.
- Given a fixture set with no control mapping to qa family independent-evidence-review, compileGates reports the missing family for qa.
- Each evidence requirement derives from US-001 and contains the evidence depth computed by US-003.
- The gate-compiler suite covers phase order, six-stage projection, family coverage, learn non-blocking behavior, and missing-family reporting.

### US-005
Implement the mandatory gate evaluation engine at backend/src/ssdlc/evaluation/gate-evaluator.ts. evaluateGate consumes only canonical rorca.lifecycle-evidence.v1 records (or validated hermes.evidence.v1 ingress normalized into that record) against US-001 structured EvidenceRequirements and returns a GateEvaluationTrace. It aggregates phase results into the US-004 stage projection. A control with no matching current evidence, no evidence-backed not-applicable determination, and no valid exception is blocked. Evidence must bind the exact spec hash and release identity required by the control and be newer than the subject mutation. AAV kernel outcomes are internal and must be normalized by AAV-006 before reaching this evaluator.

**Acceptance criteria**
- Given a stage whose active controls each have matching current canonical lifecycle evidence, evaluateGate returns pass and every control result includes authority support, demonstrated evidence, and evaluated skill.
- Given an active control with no matching canonical lifecycle evidence, evaluateGate returns blocked with a reason naming the missing evidence requirement.
- Evidence with stale, mismatched, or absent spec hash, commit SHA, required release identity, trust level, depth, or freshness is rejected for the control.
- Given a control with allowedNotApplicable true and evidence-backed not-applicable evidence, evaluateGate records not-applicable and does not block the stage.
- Given a control with allowedNotApplicable false and no submitted evidence, evaluateGate remains blocked.
- Given a control with an expired or disallowed exception, evaluateGate remains blocked and names the exception authority or expiry.
- Given a resolver-assigned independent-verification requirement and evidence without independent verification, evaluateGate returns blocked.
- Learn outcomes are evaluated for traceability but do not block a completed release.
- The gate-evaluator suite covers canonical-envelope matching, identity mismatch, pass, missing evidence, not-applicable, exception, depth, freshness, and learn non-blocking paths.

### US-006
Implement skill binding at backend/src/ssdlc/skills/skill-registry.ts and findings ingestion at backend/src/ssdlc/skills/findings.ts. SkillRecord { skillId, name, version, controlIds[], implementationRef } binds only existing US-001 controlIds. StructuredFinding is the sole finding shape for AAV-012 through AAV-018: { findingId, controlId, skillId, requirementId?, storyId?, status: 'pass'|'fail'|'blocker', evidenceRefs, message }. ingestFindings validates each finding and blocks the matching US-004 stage when a blocker maps to an active control. No phase-review agent may introduce an alternate finding store or shape.

**Acceptance criteria**
- Given bindSkill called with a SkillRecord whose controlIds includes an existing catalog controlId, the registry stores the skill and resolveSkillRefs returns its current version.
- Given a control whose skillRefs includes an unresolved skill, resolveSkillRefs returns an error naming it.
- Given an AAV phase-review StructuredFinding with blocker status for an active control, the matching stage becomes blocked and the stored finding retains identity, control, skill, story, status, and evidence references.
- Given findings with pass status only, the gate verdict remains pass.
- Given a skill upgrade from v1 to v2, the control record's skillRefs remains stable and resolution returns v2 with an upgrade note.
- A finding missing controlId or skillId is rejected, and an alternate phase-review finding shape is rejected.
- The skill-binding suite covers binding, unresolved refs, AAV finding ingestion, blocker gating, upgrade stability, and validation.

### US-007
Implement the only learn-loop candidate store at backend/src/ssdlc/learn/learn-loop.ts. consumeProductionOutcome(outcome) classifies a production or healing outcome into reviewable Genesis candidates of four types: test-class-failed-to-predict-defect, exception-caused-rework, control-produced-no-signal, and model-underperformed-on-task-class. Candidate shape is { candidateId, type, controlId, phase, evidenceRef, signalCount, status: 'pending-review'|'approved'|'rejected' }. Deduplicate by (type, controlId, evidenceRefHash). AAV-022 adapts its outcomes into this function; it must not implement a second candidate shape or store. applyCandidate requires approved status and explicit authorized actor; no candidate auto-approves or silently rewrites the catalog.

**Acceptance criteria**
- Given a production outcome where a defect reached production despite passing validation tests, consumeProductionOutcome returns a pending-review test-class-failed-to-predict-defect candidate.
- Given a production outcome recording rework caused by a granted exception, it returns an exception-caused-rework candidate.
- Given a control that produced no signal across all evaluated gates for a release, it returns a control-produced-no-signal candidate at the configured threshold.
- Given a model performance record with task-class underperformance, it returns a model-underperformed-on-task-class candidate.
- Given two identical outcomes, the second increments signalCount on the existing candidate and creates no new candidateId.
- AAV heal and run outcomes enter only through consumeProductionOutcome and return this canonical candidate shape.
- Given a pending-review candidate, applyCandidate without approved review errors and leaves controls.json byte-for-byte unchanged.
- The learn-loop suite covers all four types, deduplication, AAV adapter input, pending-review-only behavior, and the no-silent-rewrite invariant.

### US-008
Curate and ship the initial canonical catalog at backend/src/ssdlc/catalog/controls.json and the Genesis evidence projection fixture at backend/src/ssdlc/catalog/genesis-evidence.json. Include 20 to 40 US-001-valid controls across all 11 phase categories so US-004 reports no missing mandatory family. Source controls from ISO/IEC/IEEE 29148:2018, ISO/IEC/IEEE 42010:2022, ISO/IEC 25010:2023, ISO/IEC/IEEE 29119, NIST SP 800-218 SSDF, and DORA delivery research with exact citations. Every control provides structured evidence requirements and every requirement resolves either to a real AAV-019 adapter or an explicit governed human or approval route. This is the only catalog consumed by AAV.

**Acceptance criteria**
- controls.json contains between 20 and 40 ControlRecord records and every record passes US-001 validation.
- Every phase in PHASES has at least one control and US-004 reports no missing mandatory family.
- Every source reference resolves to a Genesis evidence id in genesis-evidence.json; no source reference is raw prose without an evidence id.
- Every control's source strength, failure severity, exception policy, skill refs, schema version, and structured evidence requirements match US-001.
- Every evidence requirement has a declared real adapter or an explicit governed human or approval route; no required evidence is an unimplementable string.
- The catalog contains at least one cited control for ISO/IEC/IEEE 29148, ISO/IEC/IEEE 42010, ISO/IEC 25010, ISO/IEC/IEEE 29119, NIST SP 800-218, and DORA with exact clause or section citations.
- The catalog suite validates every criterion and includes an AAV consumer fixture resolving controls by controlId.

### HMG-001
Add SourceRefV1, SourceBundleV1, SourceCitationV1, SourceConflictV1, ContextCompilationReceiptV1, IntentEnvelopeV1, and IntentDispositionV1 to shared/contracts/source.ts (and the rootDir-safe backend mirror backend/src/lib/source-contracts.ts) following the existing mission.ts versioning pattern (schemaVersion per contract, strict Zod, closed enums with explicit unknown). SourceRefV1 carries kind (genesis_package | genesis_evidence | local_file | url | github_issue | github_pr | linear_document | rorca_mission | inline), locator, title, contentHash sha256, sourceVersion, reviewStatus (approved | trusted | pending | unreviewed | external), sensitivity, authority (user_mandated | approved_context | supporting_evidence), and selectedSections. SourceBundleV1 records bundleId, bundleHash, userIntent, workspaceRef (EntityRefV1), includedSources, excludedSources with reasons, conflicts, assumptions, truncations, citations, compiledAt. IntentDispositionV1 is a closed union: answer | clarification_required | mission_draft | existing_mission_action | memory_candidate | denied, each with targetRef, draftHash, rationale, requiredDecision, permittedAction. Reject external/nested locators, unhashed content, overloaded statuses, and client-authored arbitrary actions.

**Acceptance criteria**
- All seven schemas exist in shared/contracts/source.ts and the backend mirror with exact version strings and closed enum parity
- Every SourceRef carries a sha256 contentHash and a valid reviewStatus/sensitivity/authority from closed enums
- IntentDispositionV1 accepts only the six dispositions; unknown disposition is rejected at parse
- Bundle hash is derived deterministically from userIntent + included sources + selected sections + citations
- Automated tests include fixtures that accept a valid source bundle and reject each invalid case: unknown enum, external or traversing locator, missing content hash, and mismatched bundle hash.
- Frontend and backend typechecks pass; no changes to existing mission.ts contracts

### HMG-002
Define the SourceAdapter interface (canResolve, resolve, fetch, normalize) and a registry in backend/src/lib/source-adapters.ts. Each adapter returns typed SourceCandidate[] from resolve and a frozen VersionedSource from fetch (content + exact revision + sha256 hash + byte/section bounds). Adapters must fail closed on unresolvable locators, unsupported schemes, missing authority, or redaction-required content. The registry exposes listAdapters(), resolveFor(locator), and a bounded normalize pipeline that never executes commands and treats source content strictly as data.

**Acceptance criteria**
- SourceAdapter interface and registry compile with strict types and are exported from the backend lib index
- Registry returns an honest unavailable result for unknown locator schemes instead of throwing or guessing
- Fetching a source yields a VersionedSource with content hash, revision, and selected section bounds
- No command execution or URL opening occurs anywhere in resolve/fetch/normalize
- Focused unit tests cover known adapter, unknown scheme, missing authority, and oversized content truncation
- Backend typecheck passes

### HMG-003
Implement the Genesis adapter (kind genesis_package | genesis_evidence) in backend/src/lib/source-adapters/genesis.ts. It resolves approved Genesis packages/evidence by id through the existing Genesis bridge/provenance surface, maps to the existing GenesisProvenanceSchema shape, and preserves bridge-derived reviewStatus approved/trusted/pending/unreviewed. Pending candidates are never presented as approved. Restricted material obeys the requesting principal's sensitivity authority and remains redacted. Selected sections reference exact evidence chunk ids and citations. Consume the US-002 Genesis authority projection; do not create a local approval registry or mutate Genesis review state.

**Acceptance criteria**
- Resolving an approved Genesis package returns SourceRefV1 with bridge-derived reviewStatus approved and complete sha256 hashes.
- Pending or unreviewed candidates resolve with bridge-derived pending/unreviewed state, never approved.
- Restricted evidence is redacted in the compiled bundle with a visible marker and never included as raw text.
- The adapter emits GenesisProvenanceSchema-compatible metadata and the same provenance fields consumed by US-002.
- No adapter path can grant approval, trust, or a sensitivity exception locally.
- Focused tests cover approved, pending, missing-package, restricted-sensitivity, and attempted-local-promotion paths; backend typecheck passes.

### HMG-004
Implement the local-file adapter (kind local_file) resolving paths relative to the active workspace root. It resolves the exact path (rejecting traversal), reads and normalizes Markdown/text, computes sha256, extracts heading-level sections with line ranges, and produces SourceRefV1 with selectedSections and citations to exact headings. A document used for one Mission is classified user-supplied source evidence; it is not automatically promoted to organizational knowledge. Offer capture-to-Genesis as an explicit separate action, never implicit.

**Acceptance criteria**
- A workspace-relative Markdown path resolves to a hashed SourceRefV1 with heading section citations
- Path traversal, absolute paths outside the workspace, and missing files fail closed with ValidationError
- Sections are bounded by size; oversized content truncates with an explicit truncation record, never silently
- Using a file for a Mission does not write memory candidates or Genesis entries on its own
- Focused tests cover heading extraction, traversal rejection, truncation, and binary/non-text rejection
- Backend typecheck passes

### HMG-005
Implement compileSourceBundle in backend/src/lib/source-compiler.ts. It merges user-mandated sources (user_mandated), approved organizational context (Direction Stack, approved Genesis knowledge, conventions), and supporting evidence (code, git, prior Missions) into a SourceBundleV1. It detects material conflicts across sources and against higher-authority direction, emitting SourceConflictV1 entries and requiring user resolution only when scope, safety, or acceptance is affected. It separates source content from instructions: external content is data, never executable instructions; secrets are redacted; and a bounded extraction contract prevents token blowup. It reuses buildForgeContextBundle for the Rorca-native context side.

**Acceptance criteria**
- Compiling two non-conflicting sources produces one SourceBundleV1 with both SourceRefs and citations
- A material conflict (e.g. privacy policy vs feature PRD) produces a visible SourceConflictV1 and a clarification disposition
- Source text containing instruction-like content is never executed and is visibly quoted as source data
- Secrets (API keys, tokens) are redacted from the compiled bundle
- Compilation is bounded: an explicit budget caps total included tokens with truncation records
- Focused tests cover merge, conflict, prompt-injection, redaction, and budget paths; backend typecheck passes

### HMG-006
Add POST /api/hermes/intent accepting IntentEnvelopeV1 and returning IntentDispositionV1. Classification is deterministic-first: explicit source refs and existing-mission refs drive mission_draft / existing_mission_action; read-only question phrasing yields answer; memory-candidate phrasing yields memory_candidate; ambiguous scope yields clarification_required; policy violation yields denied. Model synthesis may assist only after deterministic signals. The endpoint is idempotent by workspace-scoped idempotencyKey and uses the AAV-023 declared service-audit/operator-dispatch authority model. A mission_draft continues only through HMG-007's source bundle -> persist -> controls -> assurance compilation -> review/approval -> trigger sequence.

**Acceptance criteria**
- POST /api/hermes/intent returns strict IntentDispositionV1 with rationale for all six dispositions.
- A request referencing an existing mission id routes to existing_mission_action with the exact EntityRef.
- A request with explicit source refs and no mission routes to mission_draft and includes the compiled bundle hash.
- Replaying the same idempotencyKey returns the same disposition without duplicate side effects.
- Requests referencing another workspace's mission are denied.
- Every disposition records declared audit identity and authority mode; accidental admin fallback is rejected.
- Focused route tests cover all dispositions, idempotency, workspace isolation, and authority; Swagger annotations and backend typecheck pass.

### HMG-007
Bridge a mission_draft disposition to canonical explicit-draft persistence: build PersistSpecDraft from the frozen SourceBundleV1, then POST to existing /api/specs/persist. Freeze the bundle hash, exact source refs, Genesis provenance, and the returned EntityRefV1/RevisionRefV1 in the persisted spec revision. Reject stale or mutated bundles before persistence. After persistence, invoke the canonical US-003/US-004 control compilation and AAV-001/AAV-005 assurance-profile compilation for that exact revision before review/approval can permit trigger. No legacy /api/specs/generate path is used.

**Acceptance criteria**
- A compiled SourceBundleV1 becomes a persist payload with stories, contextUsed, Genesis provenance, and bundle hash.
- Persisting through the explicit-draft route succeeds and readback contains the frozen bundle hash, source refs, exact EntityRefV1, and RevisionRefV1.
- The assurance profile records the same spec revision and bundle hash; a mismatch is rejected before review or execution.
- US-003/US-004 control compilation and AAV-005 mechanism binding occur after persist and before the exact revision can be approved for trigger.
- The legacy generate endpoint is never invoked.
- A stale or mutated bundle is rejected before persistence.
- Focused integration tests prove bundle -> persist -> controls -> assurance profile -> readback with exact provenance; backend typecheck passes.

### HMG-008
Re-hash each frozen source of an approved Mission and compare it to the recorded contentHash. When a source changes, mark the Mission context stale without silently swapping content; expose the exact old/new hash and source state. Bounded recompilation produces a new SourceBundleV1, a new spec revision, and a new assurance profile compilation receipt. The old profile and evidence remain bound to their historical revision but cannot satisfy gates for the new revision. Unknown and unavailable are distinct honest states.

**Acceptance criteria**
- A Mission whose frozen source files are unchanged reports no drift.
- Modifying a frozen local file marks context stale with the exact source and old/new hashes.
- Stale Missions never silently inherit new content; UI/API exposes explicit stale state.
- Recompilation produces a new bundle hash, exact spec revision, and new assurance profile receipt; the prior profile cannot apply to the new revision.
- The changed revision requires re-review before execution is affected.
- Focused tests cover unchanged, changed, deleted, unavailable, profile invalidation, and stale-evidence rejection paths; backend typecheck passes.

### HMG-009
Extend the Mission Workspace Intent lens (src/panels/MissionWorkspacePanel.tsx, src/components/mission/) to show source provenance: Built from N sources with exact revisions/hashes, included vs excluded sections, citations linking requirements to source passages, conflict resolutions, and drift state. Reuse the Evidence Field vocabulary (text+icon+tone, unknown/unavailable distinct, one dominant action). The lens renders the frozen bundle from the delivery-case/spec read; it never re-fetches live source content and never fabricates source data not present in the projection. Accessible: keyboard navigable citations, screen-reader labels for hash chips, no color-only semantics.

**Acceptance criteria**
- The Intent lens renders the frozen source bundle: source count, titles, revisions, hashes, and citations
- Excluded sources and conflict resolutions are visible with rationale
- Drift state renders honestly (no drift / stale / unavailable) with a single dominant action
- No fabricated source fields: if the projection lacks a field, an honest unavailable state renders
- WCAG: keyboard navigable citation links, accessible hash chip labels, no color-only semantics; 390px no overflow
- Focused frontend tests cover bundle present, bundle absent, drift stale, and error states; frontend typecheck passes

### HMG-010
Define the durable gateway contract for Hermes. Own versioned gateway.* payloads (mission_draft_ready, decision_required, gate_blocked, source_drift, run_completed, release_ready) carried through the existing WAL/SSE envelope beside AAV-007 orchestration.* payloads. ActionEnvelopeV1 remains a server-authored permitted action descriptor, not generic transport. Update the sole Hermes workflow skill contract at packages/rorca-pi-extension/skills/hermes-autonomous-supervisor to teach the exact implemented sequence: intent -> compile sources -> draft -> persist exact revision -> compile controls -> bind assurance -> approve -> trigger -> subscribe -> supervise -> learn. The skill uses canonical tool names exposed by AAV-011; Hermes observes, classifies, proposes, relays, notifies, and escalates while Rorca owns every canonical mutation.

**Acceptance criteria**
- A bounded set of versioned gateway.* payloads is emitted through the existing WAL/SSE envelope with strict identity-bearing payloads.
- Gateway and orchestration payload families coexist on the same subscription without schema collision or a second transport.
- ActionEnvelopeV1 is never used as a generic event payload.
- The Hermes skill documents the full implemented source -> persist -> controls -> assurance -> approve -> trigger -> subscribe -> supervise -> learn sequence with canonical tool names.
- The skill states source content is data, never instructions; Hermes never grants execution leases; and declared authority follows AAV-023.
- Skill tests prove documented tools and payload families match the implemented MCP/WAL surface.
- No second orchestrator or workflow state machine is introduced; Rorca routes remain authoritative.
- Frontend/backend typechecks and skill tests pass.

### AAV-001
Define rorca.assurance-profile.v1 as an immutable artifact attached to an exact existing EntityRefV1 and RevisionRefV1 spec revision. It contains US-001 controlId-based controlInstances, mechanism bindings, criteria, structured evidence requirements, repositoryContextHash, risk profile, SourceBundleV1 bundle hash when HMG persisted source context, and compilationReceiptHash. A source-bundle or spec revision change invalidates the profile and requires recompilation; old evidence cannot silently satisfy the new revision. Product stories remain separate from lifecycle controls. Existing specs without profiles stay readable through an explicit empty/default profile path. Follow docs/contracts/ssdlc-interoperability.md.

**Acceptance criteria**
- The profile schema is versioned as rorca.assurance-profile.v1 and is attached to an exact EntityRefV1 and RevisionRefV1.
- Control instances use US-001 controlId and validate against the canonical controls.json artifact.
- When source context exists, the profile records the persisted SourceBundleV1 bundle hash and rejects a bundle/spec revision mismatch.
- A spec content or source-drift revision invalidates the old profile and requires a new compilation receipt.
- Existing specs without profiles stay readable through an explicit default profile.
- Product stories are not polluted with lifecycle boilerplate stories.
- Focused tests cover profile freeze, revision mismatch, source-drift invalidation, and the default path; backend typecheck passes.

### AAV-002
Implement the tool-agnostic verification kernel in backend/src/lib/assurance-kernel.ts. verify(contract, actor) runs execute(mechanism) -> judge(outcome, criteria) -> bind(contract, outcome, actor, now) and returns an internal KernelVerificationOutcome with pass|fail|blocked and an actionable gap. The kernel has zero tool- or methodology-specific branches. It binds US-001 controlId, exact spec/revision/commit identity, actor, timestamp, mechanism identity, and outcome digest, but it does not invent a lifecycle evidence schema or decide a gate. AAV-006 is the only adapter that normalizes this outcome to canonical lifecycle evidence; US-005 owns gate decisions.

**Acceptance criteria**
- Kernel has no tool- or methodology-specific branches.
- KernelVerificationOutcome binds controlId, exact spec revision, commit SHA, actor, timestamp, mechanism identity, and outcome digest.
- Kernel verdicts are exactly pass, fail, or blocked and gaps are actionable strings.
- The kernel never emits a second lifecycle-evidence envelope or directly passes a stage gate.
- Focused tests cover pass, fail, blocked, stale identity detection, and governed override input paths; backend typecheck passes.

### AAV-003
Implement backend/src/lib/assurance-control-catalog.ts as a read-only consumer/query adapter over US-001 and US-008's canonical ControlRecord schema and backend/src/ssdlc/catalog/controls.json. It resolves controls by controlId, validates AAV compilation input against the published JSON Schema, and exposes no second catalog, controlRef type, catalog file, or ownership semantics. Add consumer-driven contract tests loading the actual US-001 schema and US-008 artifact.

**Acceptance criteria**
- The adapter resolves only US-001 controlId values from the canonical controls.json artifact.
- No duplicate control catalog, controlRef shape, or independently versioned catalog is introduced under the assurance layer.
- Unknown controlId values are rejected by the US-001 validator.
- Every resolved control exposes the structured evidence requirements and required bindings declared by US-001.
- Consumer-driven tests load the US-001 JSON Schema and US-008 artifact and reject a changed or malformed provider shape.
- Focused tests cover canonical shape, unknown-id rejection, provider-version mismatch, and consumer expectations; backend typecheck passes.

### AAV-004
Implement backend/src/lib/mechanism-discovery.ts: detect repository-specific verification mechanisms from evidence (package.json scripts/deps, pyproject.toml, Cargo.toml, go.mod, existing CI workflows, AGENTS.md/governance files) and produce candidate mechanisms as executable + args vector (never untrusted shell strings), cwd, discoveredFrom file paths, and confidence. The user never has to name the tool; the repository does. Discovery is deterministic, read-only, and bounded.

**Acceptance criteria**
- Discovery returns executable + args vector, cwd, discoveredFrom, and confidence
- No shell string execution or untrusted command construction
- A TypeScript+Jest repository resolves jest with the correct command and backend cwd
- Unknown/absent frameworks return an honest unavailable result
- Focused tests cover jest, pytest-like config, missing framework, and traversal-safe paths; backend typecheck passes

### AAV-005
Implement the assurance binding path: HMG-persisted exact spec revision and source bundle, repository context, risk profile, US-003 applicability result, US-004 active phase groups/stage projection, and the canonical US-008 catalog feed a model proposal. The deterministic binder validates that selected mechanisms are allowed, criteria and structured evidence requirements are complete, and no selected control is weakened. It binds repository mechanisms and criteria to controls already selected by US-003/US-004; it must not independently select mandatory controls. Output is an idempotent rorca.assurance-profile.v1 bound to the exact revision and bundle hash.

**Acceptance criteria**
- Model proposal plus deterministic validation binds mechanisms and criteria to the active US-003/US-004 controls.
- Mandatory-control selection comes only from US-003 and US-004; AAV-005 never implements a second selector.
- Missing mechanism or evidence binding blocks compilation with an actionable gap.
- Invalid mechanisms, unknown controlIds, or weakened non-overridable controls fail validation.
- Compilation is idempotent and bound to the exact spec revision and, when present, HMG SourceBundleV1 bundle hash.
- Focused tests cover complete binding, missing mechanism, invalid control, weakened preference, and revision/bundle mismatch; backend typecheck passes.

### AAV-006
Implement the Hermes assurance adapter that executes compiled mechanism bindings, records exact mechanism identity, captures bounded results, evaluates criteria deterministically, converts AAV-002 outcomes into canonical rorca.lifecycle-evidence.v1 records, and requests US-005 stage reevaluation. It emits the sole lifecycle evidence shape, preserving the exact spec/revision/commit/release identity required by US-001. Blocked controls carry actionable gaps. Every Hermes phase-review agent (AAV-012 through AAV-018) emits US-006 StructuredFinding through this boundary. Authority follows the explicit AAV-023 service-audit/operator-dispatch split, never accidental admin fallback.

**Acceptance criteria**
- Hermes executes each compiled mechanism binding and emits matching canonical lifecycle evidence.
- Evidence binds exact mechanism identity, controlId, exact spec revision, spec hash, commit SHA, and required release identity.
- Kernel outcomes are normalized only here; no parallel lifecycle evidence envelope is emitted.
- Blocked controls produce actionable gaps and US-005 stage reevaluates on new evidence.
- AAV-012 through AAV-018 findings are validated and ingested exclusively as US-006 StructuredFinding records.
- Authority follows the explicit service-audit/operator-dispatch split, never an accidental fallback.
- Focused tests cover execution, canonical evidence, blocked reevaluation, finding ingestion, and authority paths; backend typecheck passes.

### AAV-007
Implement provider-neutral orchestration event ingestion: project actual OMP JSONL RPC output from OmpManagedExecutor into durable rorca.orchestration-event.v1 payloads carried by the existing WAL/SSE transport. This story owns only orchestration.* payloads: agent_started, task_started, agent_progress, agent_completed, and agent_failed. Payloads retain parentage, monotonic sequence numbers, idempotent replay, and EntityRefV1-bound run/story/attempt/process identity. Unknown OMP events remain inspectable. Gateway-domain events remain HMG-010's gateway.* payload family; ActionEnvelopeV1 is never used as a generic event envelope.

**Acceptance criteria**
- Actual OMP JSONL RPC projects into the versioned orchestration payload schema with parentage retained.
- Events carry monotonic sequence numbers, survive restart, and are idempotent on replay.
- Events bind to EntityRefV1-compatible run, story, attempt, process, and exact spec revision identity.
- Unknown OMP events are recorded without breaking ingestion.
- The vocabulary is validated against a live instrumented OMP run, not the TUI.
- The implementation emits through the existing WAL/SSE envelope and does not define gateway payloads or reuse ActionEnvelopeV1 as transport.
- Focused tests cover mapping, idempotency, restart replay, unknown events, identity binding, and transport envelope compatibility; backend typecheck passes.

### AAV-008
Render the durable orchestration stream in the run surface (src/panels/RunViewPanel.tsx / RunTerminal): a parent agent tree with subagent lanes (I, II, III, IV) showing live status, role/name, parent-child relationship, elapsed time, tool/event summary, failure reason, produced evidence, and retry/continuation lineage. Roman numerals are presentation labels only - stable IDs underneath, since concurrency and retries reorder agents. The view reconstructs exactly after browser refresh (rebuilt from stored events, not a live terminal) and is accessible: keyboard navigable, no color-only semantics.

**Acceptance criteria**
- Run View renders the orchestration tree from the durable event stream
- Roman numerals are presentation labels; stable agent IDs drive identity
- Browser refresh reconstructs the exact tree from stored events
- Failure reasons and retry/continuation lineage are visible per lane
- WCAG: keyboard navigation, accessible labels, no color-only semantics; 390px no overflow
- Focused frontend tests cover tree render, refresh reconstruction, failure, and empty states; frontend typecheck passes

### AAV-009
Add an optional raw OMP terminal tab to the run surface using PTY passthrough of the omp session (terminal_mode pty path). The structured orchestration view remains the authoritative surface; the raw terminal is for operator fidelity and debugging. Reconnect behavior is explicit, terminal bytes are bounded and replayable where possible, PTY failure never invalidates structured evidence, and secrets are redacted before persistence.

**Acceptance criteria**
- Raw PTY tab renders the omp session for an operator
- Structured view remains authoritative; PTY is explicitly a debug surface
- Terminal bytes are bounded and replayable; reconnect is explicit
- PTY failure does not invalidate structured evidence
- Secrets are redacted before persistence
- Focused tests cover PTY attach, failure fallback, and redaction; frontend and backend typechecks pass

### AAV-010
Qualify the assurance/OMP component boundary: an exact persisted spec revision with an attached assurance profile executes under OMP; orchestration lanes render/reconstruct; a subagent failure becomes a canonical blocked control with an actionable gap; retry/continuation is visible; and acceptable evidence binds exact commit and spec identity before US-005 permits the applicable stage. This is component parity only. The complete HMG -> controls -> assurance -> OMP -> gates -> supervision -> learning proof belongs to the interoperability qualification spec.

**Acceptance criteria**
- An exact spec revision with an assurance profile runs end to end under OMP.
- Subagent lanes render live and reconstruct exactly after refresh from AAV-007 durable events.
- A subagent failure produces canonical evidence and a US-005 blocked control with an actionable gap.
- Validation evidence binds the exact commit and spec revision; the applicable stage passes only on acceptable evidence.
- Raw terminal remains available for diagnosis.
- Qualification is recorded as a runnable component integration test or documented scenario with receipts and points to the cross-spec qualification boundary.

### AAV-011
Expose the existing durable WAL/SSE run event envelope back into OMP so a supervising Hermes session observes live run, story, gate, evidence, orchestration.*, and gateway.* events without polling. Add rorca_subscribe_run_events to the MCP surface or an equivalent subscription with idempotent replay and workspace isolation. AAV-011 consumes AAV-007 orchestration payloads and HMG-010 gateway payloads; it does not create a second orchestrator or own the Hermes skill contract. HMG-010 is the sole skill owner and documents this implemented subscription surface.

**Acceptance criteria**
- rorca_subscribe_run_events, or its exact equivalent, delivers live run, story, gate, evidence, orchestration.*, and gateway.* events to an OMP session.
- Subscription reuses the canonical WAL/SSE envelope with idempotent replay and versioned payload dispatch.
- A session receives events only for its selected workspace.
- The subscription exposes implemented canonical tool names for HMG-010 skill-contract validation.
- No second orchestrator, workflow state machine, or Hermes skill file is introduced.
- Focused tests cover subscription, replay idempotency, isolation, both payload families, and canonical tool-name exposure; backend typechecks pass.

### AAV-012
Hermes reviews the user brief before forging: outcome framing, scope boundaries, and risk class, returning structured findings that become intake-phase lifecycle evidence through the AAV-006 execution surface. Findings are visible and reviewable; the forge proceeds only when intake findings are satisfied or explicitly waived.

**Acceptance criteria**
- A persisted spec triggers a Hermes intake review producing structured findings bound to the brief
- Findings surface as intake evidence through the standard lifecycle evidence contract
- Unreviewed or contested findings visibly block intake approval
- Focused tests cover finding emission, evidence binding, and waiver paths; backend typecheck passes

### AAV-013
Hermes verifies each story for verifiability and traceability (29148-style: testable, traceable, atomic) and emits per-story findings as requirements-phase evidence. Unverifiable stories are flagged with concrete gaps before implementation begins.

**Acceptance criteria**
- Each story receives a structured verifiability/traceability finding
- Findings emit as requirements evidence bound to story IDs and the spec revision
- Stories with blocking gaps are visibly flagged
- Focused tests cover finding shape, evidence binding, and gap flagging; backend typecheck passes

### AAV-014
Hermes reviews architecture-relevant decisions in the spec (42010-style stakeholder concerns, decision rationale, threat model for the change surface) and emits architecture-phase evidence. The threat-model pass is mandatory for specs touching auth, secrets, network egress, or execution boundaries.

**Acceptance criteria**
- Architecture review findings emit as architecture evidence with decision rationale
- A threat-model pass runs for specs touching auth, secrets, egress, or execution boundaries
- Threat findings are surfaced as structured gaps, never silently dropped
- Focused tests cover review emission and threat-pass applicability; backend typecheck passes

### AAV-015
Hermes executes security controls against the implementation: secrets scan, dependency check, and threat verification, emitting security-phase evidence from real artifact output. Security evidence follows the same execute -> judge -> bind -> decide kernel as every other control.

**Acceptance criteria**
- Secrets scan and dependency check run and emit security evidence
- Evidence binds the exact commit and mechanism identity
- Blocked security controls produce actionable gaps
- Focused tests cover scan execution, evidence emission, and blocked paths; backend typecheck passes

### AAV-016
Hermes performs an independent review of the completed release candidate (workflow checks, regression assessment, release-candidate acceptance) and emits QA-phase evidence. QA is distinct from validation: it judges the candidate, not the build correctness.

**Acceptance criteria**
- An independent QA review runs against the release candidate and emits QA evidence
- QA findings are structured and bound to the candidate identity
- Focused tests cover review execution and evidence emission; backend typecheck passes

### AAV-017
Hermes verifies exact-SHA change-set integrity before merge: the merged branch head matches the authorized head, the change set is complete, and no uncommitted drift exists; emits merge-phase evidence.

**Acceptance criteria**
- Merge verification confirms exact head SHA and complete change set
- Drift or mismatch produces a blocked merge control with the exact discrepancy
- Merge evidence binds the verified head SHA
- Focused tests cover clean, mismatched, and drifted paths; backend typecheck passes

### AAV-018
Hermes confirms deployment: deployment_id binding, target identity, and post-deploy health check, emitting production-phase evidence. Unavailable or unknown deployment state is an honest distinct state, never a silent pass.

**Acceptance criteria**
- Deployment confirmation emits production evidence with deployment_id and health result
- Unknown/unavailable deployment state is distinct and visible
- Focused tests cover confirmed, unknown, and failed-health paths; backend typecheck passes

### AAV-019
Implement concrete adapters that turn real artifact output into AAV-002 mechanism outcomes: test_result parses Jest/Vitest/Pytest command, exit code, test summary, and requirement coverage; artifact digest captures build outputs; deployment receipt captures deployment evidence. AAV-006 maps those outcomes to the existing canonical lifecycle evidence source types/classifications and required subject/release identities. Adapters use executable+args vectors, bounded capture, and deterministic criteria; they never create a second evidence-kind taxonomy.

**Acceptance criteria**
- At minimum a test-result adapter parses a real test run into an AAV-002 outcome.
- Artifact digest and deployment receipt adapters produce bounded outcomes that AAV-006 maps to canonical lifecycle evidence.
- Adapters are executable+args mechanisms, never shell strings.
- Bounded capture includes explicit truncation records.
- Every adapter mapping declares its canonical lifecycle evidence classification, source type, and required subject/release bindings.
- Focused tests cover real-output parsing, canonical mapping, failure, and truncation paths; backend typecheck passes.

### AAV-020
Implement the session-built watchdog v2 at the Hermes supervision boundary, not as a second Rorca execution-engine loop. It consumes canonical run/gate/evidence events, classifies known failures deterministically, uses LLM synthesis only for novel patterns, and proposes or invokes governed Rorca actions for restart, alternate model, worktree refresh, or authority re-provision. Rorca retains canonical mutations, leases, worktree authority, and durable receipts. Every diagnosis, action, and outcome is Hermes-bound, auditable, and follows AAV-023 authority; no controller restarts queued or running work in flight.

**Acceptance criteria**
- Watchdog v2 classifies known failure classes deterministically and novel classes with bounded LLM assistance.
- Healing uses the canonical Rorca action and receipt path; it does not mutate canonical state directly or introduce a second scheduler.
- Applied restart, alternate-model, worktree-refresh, or authority-reprovision actions preserve exact model, identity, and run lineage.
- Every healing action emits a durable Hermes-bound event with diagnosis, action, receipt, and outcome.
- The watchdog holds at queued/running states and never restarts in flight.
- Focused tests cover known, novel, exhausted-attempt, queued-state, authority, and no-second-orchestrator paths; backend typecheck passes.

### AAV-021
Implement a named provider fallback policy that the primary OMP executor applies within a story session on provider failures such as usage limit, connection error, or terminalized authority. Rorca supplies the allowed alternate chain and records the selected fallback in canonical story/lifecycle evidence; OMP performs session-level fallback. The explicit Pi fallback may consume the same policy but does not become its owner. Exhaustion preserves the original reason. This is not a return to engine-primary execution.

**Acceptance criteria**
- A provider failure in an OMP story session applies the named allowed alternate chain instead of immediately failing the story.
- Fallback application is recorded in canonical story and lifecycle evidence with original reason, selected model, and attempt identity.
- Exhausted alternates fail with the original reason preserved.
- The Pi fallback consumes the same policy only when selected explicitly and does not define a divergent chain.
- Focused tests cover OMP fallback, chain exhaustion, canonical evidence, and Pi-policy compatibility; backend typecheck passes.

### AAV-022
Adapt Hermes heal events and run outcomes to US-007 consumeProductionOutcome. Preserve controlId, phase, exact evidence reference, and provenance, then return the canonical US-007 candidate. This story owns no candidate shape, deduplication key, candidate store, approval decision, or catalog mutation. Accumulated evidence may propose control or mechanism adjustments only through US-007's pending-review path.

**Acceptance criteria**
- Healing events and run outcomes reach US-007 consumeProductionOutcome with provenance and exact evidence references.
- The returned candidate uses the US-007 canonical shape and deduplication behavior.
- Accumulated evidence proposes control or mechanism adjustments only as pending-review candidates.
- Candidates never auto-approve or mutate controls directly.
- Focused tests cover candidate generation, provenance, US-007 deduplication, and governed review surfaces; backend typecheck passes.

### AAV-023
Make the Hermes authority split explicit and enforced across AAV, HMG, and the watchdog: Hermes identity is used for audit and evidence; operator-equivalent authority is explicit for permitted dispatch and mutation; no accidental admin fallback exists. Every Hermes action carries a declared authority mode and audit identity. HMG intent, persist, supervision, and retry flows consume this contract.

**Acceptance criteria**
- Every Hermes action declares authority mode and audit identity.
- Service-identity calls to admin-tier routes fail closed with a clear code.
- Dispatch actions carry operator-equivalent authority explicitly.
- HMG intent, persist, subscription, and watchdog paths use the same declared authority contract.
- Focused tests cover allowed, denied, fallback-denied, and cross-surface authority paths; backend typecheck passes.

### MIG-001
Wire the OmpManagedExecutor child through the ordinary-local Pi sandbox profile on Darwin (egress broker, auth copy, runtime state) so governed OMP story execution works on macOS; verify the existing linux-bwrap path on Linux. The OMP child must launch with the same fail-closed posture as the pi child: allowlisted env, model-credential egress, worktree confinement, death receipts.

**Acceptance criteria**
- OMP story execution runs on Darwin via the ordinary-local profile without manual env assembly
- The OMP child uses the egress broker and auth copy identically to the pi child
- Linux bwrap path verified for the OMP child
- Launch failure is fail-closed with a durable diagnostic, never a raw spawn
- Focused tests cover Darwin launch, Linux launch, auth copy, and fail-closed paths

### MIG-002
After MIG-001 has qualified OMP sandbox launch, make OMP the default story executor: pipeline dispatch selects agent omp unless explicitly overridden at spec or run level. Pi remains a fully supported fallback through explicit override. Add the executor selector to trigger UI and per-spec override field. Dispatch, manifests, watchdog restart, and retry preserve the original executor. Governance, lifecycle evidence, gate semantics, and Run View rendering remain owned by Universal Controls and AAV.

**Acceptance criteria**
- MIG-001 sandbox qualification is required before a new run may default to OMP.
- New eligible runs default to OMP end to end.
- Per-spec and per-run overrides select pi, claude, opencode, or codex and are respected by dispatch and manifests.
- Trigger UI shows the executor selector defaulting to omp; the spec page shows the explicit override.
- Watchdog/retry preserves the original executor on restart.
- Existing pi-driven runs remain green via explicit override.

### MIG-003
Fix the pi fallback path root causes observed this session so it is dependable when used: the prompt_delivery_failed progress-log verification (pi_progress_log_unverified) and the transient api_key_invalid on retry attempts (sandbox auth copy). The fallback lane must be reliable enough for watchdog-restarted runs and per-spec overrides.

**Acceptance criteria**
- prompt_delivery_failed no longer occurs on a healthy pi story attempt
- Retry attempts do not hit transient api_key_invalid
- A full pi-fallback run completes end to end with evidence bound correctly
- Focused tests cover the delivery protocol and auth-copy retry paths

### MIG-004
Verify executor-level wave-parallel execution with OMP: a wave of N parallel stories launches N concurrent OMP RPC sessions, each in its own per-story worktree, and merges per-story branches back to the run branch through commitGuardedMerge under wave-production-policy gates. Confirm generic per-agent wave machinery routes OMP stories alongside other agent types. This story owns process/worktree/merge parity and emits durable identity-bearing run results/events; AAV-007/008 own event projection and Run View rendering.

**Acceptance criteria**
- A wave-parallel OMP run with parallelism greater than one executes all wave stories concurrently in separate worktrees.
- Per-story branches merge back cleanly and wave policy gates apply.
- Heterogeneous waves containing omp and claude/pi stories run correctly.
- Each session emits stable run, story, attempt, process, and exact spec revision identity for AAV-007 consumption.
- Focused integration tests cover parallel waves, merge-back, policy gating, heterogeneous agents, and emitted identity.

### MIG-005
Qualify the executor migration only: sequential and wave-parallel OMP runs produce byte-compatible execution contracts with the explicit Pi fallback for run manifests, story results, WAL/release intent identity, retry lineage, cancellation, and rollback. It does not define lifecycle evidence semantics, gate decisions, or Run View behavior; AAV and Universal Controls consume the stable executor contracts. Prove the single-config rollback to explicitly selected Pi once after MIG-003 restores fallback reliability.

**Acceptance criteria**
- Sequential and wave-parallel OMP runs pass the executor qualification scenario.
- Run manifest, story-result, WAL/release-intent identity, retry lineage, and cancellation contracts are byte-compatible with the Pi fallback where executor-agnostic.
- A subagent failure emits durable executor failure identity for AAV/Universal Controls to evaluate; MIG-005 does not own the resulting gate semantics.
- Rollback to an explicit Pi override executes once with no contract drift after MIG-003 fallback qualification.
- Qualification is recorded with exact receipts and a consumer-facing contract fixture for AAV-007 and AAV-010.

### MIG-006
Document and enforce the engine fallback-only posture after MIG-005 qualification: OMP is the default executor; Pi remains selectable as explicit fallback; Claude agent compatibility remains a deliberate per-story override. The migration plan is docs/mig-006-engine-fallback-posture.md; this spec and that plan are a bidirectional control pair. Enforce behavior through dispatch tests rather than documentation-text linting. Any future change that makes Pi default or expands its primary-executor role reopens this spec.

**Acceptance criteria**
- Documentation marks the Pi path as fallback-only with the residual-role rationale.
- A behavioral dispatch test proves eligible new runs default to OMP and Pi runs require explicit override.
- A behavior test proves the explicit Pi fallback remains available and preserves its declared executor across retry.
- The migration plan document and spec reference each other.
- No documentation-text lint is used as a substitute for dispatch behavior.

### INT-001
Implement backend/src/ssdlc/interop/contract-registry.ts and an executable registry suite that loads provider artifacts and validates consumer expectations, not prose. Register: HMG SourceBundleV1/intent contracts; existing EntityRefV1 and RevisionRefV1; US-001 ControlRecord JSON Schema and US-008 controls.json; US-004 stage projection; rorca.assurance-profile.v1; canonical rorca.lifecycle-evidence.v1/hermes.evidence.v1; AAV-007 orchestration payloads; HMG-010 gateway payloads; US-006 StructuredFinding; US-007 candidate. Each entry names one provider, every consumer, version, and an executable validation fixture. This is the CDC release gate defined by docs/contracts/ssdlc-interoperability.md.

**Acceptance criteria**
- Registry declares exactly one provider per shared contract and names every consumer.
- The suite loads actual provider schemas/artifacts and executes consumer fixtures; a malformed provider shape, unknown version, duplicate owner, or missing consumer assertion fails.
- AAV control lookup validates against US-001/US-008 rather than a duplicate catalog.
- AAV kernel/evidence adapter and US-005 evaluator validate against canonical lifecycle evidence schemas.
- AAV-007 orchestration and HMG-010 gateway payloads coexist on the canonical WAL/SSE envelope without ActionEnvelopeV1 misuse.
- The suite is runnable in CI and emits a machine-readable registry receipt.

### INT-002
Execute the complete governed chain in an isolated qualification workspace after HMG, Universal Controls, AAV, and MIG implementation receipts exist: HMG source bundle -> explicit persist exact revision -> US-003 applicability -> US-004 phase groups/six-stage projection -> AAV mechanism binding/profile -> MIG OMP run -> canonical evidence -> US-005 stage evaluation -> Hermes subscription/healing -> US-007 candidate. Exercise a success path, forced subagent failure/recovery, and source-drift/revision invalidation. This is the only whole-program qualification; component specs retain their own focused tests.

**Acceptance criteria**
- SourceBundleV1 bundleHash is preserved through persisted EntityRefV1/RevisionRefV1, assurance profile, run manifest, canonical evidence, and gate receipt.
- All 11 phase groups compile with no missing mandatory family and project to six Mission stages; learn remains non-blocking.
- Every active evidence requirement resolves to a real adapter or explicit governed human/approval path.
- A forced OMP subagent failure produces a durable event, actionable blocked control, Hermes-observed recovery, new canonical evidence, and applicable-stage re-evaluation.
- Browser refresh reconstructs the durable orchestration tree and Hermes subscription replays the same event sequence idempotently.
- Changing a frozen source creates a new bundle/revision/profile, requires re-review, and prevents old evidence from satisfying the new revision.
- A production/healing outcome creates exactly one deduplicated US-007 pending-review candidate with provenance.
- The scenario produces exact receipts and runs in CI or a documented isolated harness.

### INT-003
Run the executor compatibility matrix after MIG and AAV component qualification: OMP sequential, OMP wave-parallel, heterogeneous wave with an explicit Claude or Pi story, explicit Pi fallback, restart/replay, provider fallback, and cancellation. Assert that only executor-specific behavior varies; EntityRef/RevisionRef identity, manifests, story results, WAL/release intent, canonical evidence binding, and event replay stay compatible with the contract registry.

**Acceptance criteria**
- OMP sequential and wave-parallel executions satisfy the same executor-agnostic manifest/result/WAL identity fixtures.
- A heterogeneous wave preserves per-story declared executors and isolated worktrees while merging under the normal wave policy.
- Explicit Pi fallback completes after MIG-003 reliability qualification and preserves the original executor across retry.
- OMP provider fallback records the named alternate and original reason in canonical evidence without changing control/gate semantics.
- Restart and replay are idempotent across OMP and Pi paths; cancellation closes each process/worktree without duplicate terminal events.
- Matrix results are attached to the INT-001 registry receipt with exact run and revision identities.

## Success metrics
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

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

