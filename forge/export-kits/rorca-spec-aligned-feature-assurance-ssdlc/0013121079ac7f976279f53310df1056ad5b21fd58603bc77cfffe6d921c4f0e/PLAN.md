# Rorca Spec-Aligned Feature Assurance SSDLC — Delivery Plan

## Story order
1. **AFM-001 — Project a revision-bound Feature Assurance Map**
2. **AFM-002 — Bind assurance candidates to exact subject and scope**
3. **AFM-003 — Compile Development Assurance obligations from changed work**
4. **AFM-004 — Normalize real test execution and requirement coverage**
5. **AFM-005 — Compile proportionate assurance profiles with workspace extensions**
6. **AFM-006 — Evaluate isolated review axes and adversarial assurance cases**
7. **AFM-007 — Dogfood a non-authorizing AssuredCandidate handoff**

## Dependencies
- AFM-001 → AFM-002
- AFM-002 → AFM-003
- AFM-002 → AFM-004
- AFM-003 → AFM-004
- AFM-002 → AFM-005
- AFM-003 → AFM-005
- AFM-001 → AFM-006
- AFM-003 → AFM-006
- AFM-004 → AFM-006
- AFM-005 → AFM-006
- AFM-001 → AFM-007
- AFM-002 → AFM-007
- AFM-003 → AFM-007
- AFM-004 → AFM-007
- AFM-005 → AFM-007
- AFM-006 → AFM-007

## Verification
- AFM-001: The map displays a navigable requirement-to-acceptance-criterion-to-story-to-control-to-evidence-to-decision chain for the selected feature.
- AFM-001: When a row revision or plan identity differs from its source, the map displays stale state and both identities.
- AFM-001: For a fixture containing generated narrative, host-observed evidence, and a missing link, the map displays their distinct sources, timestamps, bindings, trust levels, and gap states.
- AFM-001: Focused tests pass for complete, missing, stale, and mismatched projection fixtures and fail for false-green relationships.
- AFM-002: Submitting a candidate missing each required specification revision, plan, commit, tree, diff, or scope identity returns a missing-identity finding naming that field.
- AFM-002: The scope evaluator records each changed, required, allowed, forbidden, unexpected, and missing path for the bound work package.
- AFM-002: When an evidence or decision subject differs from the candidate, the validator returns a rejected-subject result and excludes it from satisfaction.
- AFM-002: Automated fixtures pass for exact matches and fail for missing identity, path drift, forbidden changes, and wrong-subject evidence.
- AFM-003: For a bound change, the compiler emits a stable obligation set with requirement, change kind, component or boundary, expected evidence, and rationale for every applicable check.
- AFM-003: Given contrasting requirement, risk, architecture, and change-scope fixtures, the compiler reports selected and excluded checks with a rationale for each.
- AFM-003: Given absent or conflicting inputs, the compiler emits explicit not-applicable, unresolved, or blocked dispositions and never emits passing state for a required check.
- AFM-003: Focused tests pass for deterministic repeated compilation and fail for changed-boundary, deleted-behavior, scope-drift, and missing-rationale fixtures.
- AFM-004: Every accepted execution record contains runner, command, start and finish time, exit status, counts, output digest, exact candidate identity, and environment identity.
- AFM-004: JUnit XML, Jest or Vitest, and Pytest fixtures return normalized passed, failed, skipped, blocked, quarantined, and malformed outcomes without inventing success.
- AFM-004: For an explicit stable test-case-to-obligation mapping, coverage returns satisfied only when a passing execution matches the exact bound candidate.
- AFM-004: Zero-test, skipped-only, stale, malformed, wrong-commit, missing-mapping, and failed-execution fixtures return blocked or insufficient coverage.
- AFM-005: For a bound candidate, the compiler returns the active profile, selected controls, applicability rationale, effective thresholds, and unselected controls.
- AFM-005: A test registering a declared workspace extension returns its namespace and additive controls, and rejects an extension that mutates shared core or another workspace.
- AFM-005: Absent, invalid, or conflicting profile fixtures return unresolved or blocked controls and a corrective action rather than a default passing state.
- AFM-005: Tests pass for deterministic selection, extension isolation, conflict reporting, baseline preservation, and exact repeatability.
- AFM-006: Standards and Design review fixtures return independently attributable findings that identify the bounded subject and reviewed source locations.
- AFM-006: Adversarial fixtures for story-pass-without-tests, stale replay, wrong-subject evidence, fake output, weakened assertions, missing negative coverage, and scope expansion return named detections or bounded unresolved findings.
- AFM-006: The review view displays independent, self-review, and stale-review trust states, and returns insufficient evidence when independent review is required but unavailable.
- AFM-006: Regression fixtures for reproducible assurance incidents return their expected detection outcome.
- AFM-007: The dogfood path emits an AssuredCandidate containing bound feature, plan, candidate, obligations, evidence links, evaluation outcomes, unresolved findings, and freshness data.
- AFM-007: When an obligation is missing, stale, rejected, or insufficient, the handoff records that condition and returns a non-all-satisfied outcome.
- AFM-007: Replay, restart, and partial-failure fixtures preserve immutable observations, record the recovery decision, and never promote a partial attempt.
- AFM-007: Dogfood output records assurance trends and routes incident observations as governed improvement inputs without changing upstream lifecycle facts.

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
