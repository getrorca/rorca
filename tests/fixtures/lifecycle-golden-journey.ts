/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  LIFECYCLE_PHASES,
  type LifecycleEvidenceDetail,
  type LifecycleEvidenceSummary,
  type LifecycleEvaluatedStatus,
  type LifecycleGate,
  type LifecyclePhaseId,
  type LifecyclePhaseResponse,
  type LifecyclePortfolioResponse,
  type LifecycleSpecResponse,
} from '../../src/types/lifecycle';

export const GOLDEN = {
  fixtureId: 'lfc-024-billing-anomaly-alerts-v1',
  workspaceId: 'lfc-024-staging-workspace',
  workspaceName: 'Lifecycle staging fixture',
  specId: 'billing-anomaly-alerts',
  specTitle: 'Billing anomaly alerts',
  originalRunId: 913,
  retryRunId: 914,
  qaRunId: 915,
  intent: 'Alert each organization when its billing changes unexpectedly without exposing another tenant’s data.',
  governedScopeDecision: {
    decisionId: 'scope-decision-lfc-024',
    specCount: 1,
    boundaries: ['alert evaluation', 'tenant-scoped delivery', 'operability', 'validation'],
    rationale: 'One cohesive deployable capability owns all requirements; splitting delivery would leave tenant isolation unowned.',
  },
  revision: {
    specVersion: '7',
    inputHash: `sha256:${'1'.repeat(64)}`,
    planVersion: 3,
    sourceCommit: '8f32a1d7ef78d49e6f74bf482531e18553f00f6c',
    stagedArtifactDigest: `sha256:${'2'.repeat(64)}`,
    testDeploymentId: 'staging-billing-alerts-20260715-01',
  },
  replacement: {
    stagedArtifactDigest: `sha256:${'3'.repeat(64)}`,
  },
  screenshots: [
    'explorer-default-1440x900-light.png', 'explorer-default-1440x900-dark.png',
    'explorer-default-390x844-light.png', 'explorer-row-390x844-light.png',
    'blocked-1440x900-light.png', 'blocked-1024x768-light.png', 'blocked-390x844-light.png',
    'recovery-1440x900-light.png', 'recovery-1024x768-light.png', 'recovery-390x844-light.png',
    'approval-1440x900-light.png', 'stale-1024x768-light.png',
    'empty-390x844-light.png', 'loading-390x844-light.png', 'error-390x844-light.png',
  ],
} as const;

export const GOLDEN_STORIES = [
  { id: 'BAA-001', capability: 'intent-and-scope', requirements: ['REQ-001'], dependsOn: [] },
  { id: 'BAA-002', capability: 'anomaly-evaluator', requirements: ['REQ-002'], dependsOn: ['BAA-001'] },
  { id: 'BAA-003', capability: 'alert-api', requirements: ['REQ-003'], dependsOn: ['BAA-002'] },
  { id: 'BAA-004', capability: 'observable-worker', requirements: ['REQ-004'], dependsOn: ['BAA-002'] },
  { id: 'BAA-005', capability: 'tenant-isolation-validation', requirements: ['REQ-005'], dependsOn: ['BAA-004'] },
  { id: 'BAA-006', capability: 'staging-qa-and-learning', requirements: ['REQ-006'], dependsOn: ['BAA-005'] },
] as const;

export const GOLDEN_STORY_EXECUTION = GOLDEN_STORIES.map((story, index) => ({
  storyId: story.id,
  attemptPacketId: `attempt:${GOLDEN.originalRunId}:${story.id}`,
  completionPacketId: `completion:${index === 4 ? GOLDEN.retryRunId : GOLDEN.originalRunId}:${story.id}`,
  commitSha: index === GOLDEN_STORIES.length - 1
    ? GOLDEN.revision.sourceCommit
    : `${String(index + 1).repeat(40)}`,
  attemptState: 'completed',
  closeoutState: index === 4 ? 'accepted_after_retry' : 'accepted',
  lifecycleStateSource: 'canonical_phase_evaluator',
}));

/**
 * This is a browser transport fixture, not a lifecycle evaluator. Its states are
 * snapshots previously emitted by the canonical backend contracts. External
 * GitHub/Hermes/GitReins/staging boundaries are explicitly marked test_adapter.
 */
export type GoldenJourneyState = 'preflight_gap' | 'blocked' | 'recovered' | 'qa_evidence_only' | 'approved' | 'stale';

const SNAPSHOT = {
  snapshotId: 'snapshot:lfc-024:revision-7',
  evidenceHighWaterMark: 'evidence:lfc-024:12',
  decisionHighWaterMark: 'decision:lfc-024:4',
};

const VALIDATION_GATE_DEFINITIONS = [
  ['validation-unit', 'Unit tests · 84 passed'],
  ['validation-typecheck', 'Typecheck'],
  ['validation-tenant-isolation', 'Tenant-isolation integration test'],
  ['validation-broad', 'Broad regression and GitReins judgment'],
] as const;

function phaseStatus(state: GoldenJourneyState, phaseId: LifecyclePhaseId): LifecycleEvaluatedStatus {
  const afterFix = state === 'recovered' || state === 'qa_evidence_only' || state === 'approved' || state === 'stale';
  if (phaseId === 'testing') return afterFix ? 'passed' : 'blocked';
  if (phaseId === 'deployment') {
    if (state === 'stale') return 'stale';
    if (state === 'approved') return 'passed';
    if (state === 'qa_evidence_only') return 'awaiting_approval';
    return 'not_started';
  }
  if (phaseId === 'maintenance') return state === 'approved' || state === 'stale' ? 'in_progress' : 'not_started';
  if (phaseId === 'development') return afterFix ? 'passed' : 'in_progress';
  return 'passed';
}

function validationEvidence(state: GoldenJourneyState): LifecycleEvidenceSummary[] {
  const current = state !== 'stale';
  const afterFix = state === 'recovered' || state === 'qa_evidence_only' || state === 'approved' || state === 'stale';
  return VALIDATION_GATE_DEFINITIONS.map(([gateId], index) => ({
    id: String(701 + index),
    evidenceType: 'automated_validation',
    sourceSystem: index < 2 ? 'rorca:host-runner' : index === 2 ? 'Hermes test adapter' : 'GitReins test adapter',
    sourceEventId: `lfc-024-${gateId}-${afterFix ? 'fixed' : 'blocked'}`,
    status: index < 2 || afterFix ? 'passed' : index === 2 ? 'story_caused_failure' : 'unknown',
    trustLevel: index < 2 ? 'host_observed' : 'provider_verified',
    confidence: index < 2 ? 1 : 0.99,
    observedAt: `2026-07-15T12:0${index}:00.000Z`,
    subject: { type: 'commit_sha', value: GOLDEN.revision.sourceCommit },
    gateId,
    storyId: index >= 2 ? 'BAA-005' : index === 0 ? 'BAA-002' : 'BAA-004',
    runId: afterFix ? GOLDEN.retryRunId : GOLDEN.originalRunId,
    currentRevision: current,
    stale: !current,
    invalidReasons: current ? [] : ['artifact_lineage_replaced'],
  }));
}

function gate(state: GoldenJourneyState, phaseId: LifecyclePhaseId, gateId: string, title: string, status: LifecycleEvaluatedStatus): LifecycleGate {
  return {
    gateId,
    phaseId,
    title,
    evidenceKind: phaseId === 'deployment' ? 'deployment_verification' : 'automated_validation',
    subjectRevisionRequirement: phaseId === 'deployment' ? 'current_artifact' : 'current_commit',
    approvalRequirement: phaseId === 'deployment' ? 'human' : 'none',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: phaseId === 'deployment' ? 'release_blocking' : 'blocking',
    evidenceRequirementIds: [`evidence:${gateId}`],
    acceptedSubjectTypes: phaseId === 'deployment' ? ['artifact_digest'] : ['commit_sha'],
    downstreamSubjectCoherence: { testing: 'same_subject', deployment: 'derived_from_subject' },
    authorizedApprovers: phaseId === 'deployment' ? ['local_admin'] : undefined,
    evaluation: {
      status,
      rationale: 'Canonical lifecycle evaluator result for the immutable fixture revision.',
      blockerReason: status === 'blocked' ? 'Worker payload query is missing organizationId scope.' : status === 'awaiting_approval' ? 'QA-mode evidence exists, but an authorized revision-bound approval is still required.' : status === 'stale' ? 'The staged artifact digest changed after this proof was recorded.' : null,
      nextSafeAction: status === 'blocked' ? 'Retry only BAA-005 after adding organizationId scope.' : status === 'awaiting_approval' ? 'Request an explicit staging QA approval.' : null,
      evidenceCount: status === 'not_started' ? 0 : 1,
      decisionCount: phaseId === 'deployment' && state === 'approved' ? 1 : 0,
    },
  };
}

function phaseGates(state: GoldenJourneyState, phaseId: LifecyclePhaseId): LifecycleGate[] {
  if (phaseId === 'testing') {
    const evidence = validationEvidence(state);
    return VALIDATION_GATE_DEFINITIONS.map(([id, title], index) => gate(
      state,
      phaseId,
      id,
      title,
      evidence[index].status === 'passed' ? 'passed' : index === 2 ? 'blocked' : 'not_started',
    ));
  }
  return [gate(state, phaseId, `${phaseId}-gate`, `${LIFECYCLE_PHASES.find((phase) => phase.id === phaseId)?.displayName} contract`, phaseStatus(state, phaseId))];
}

function phaseCell(state: GoldenJourneyState, phaseId: LifecyclePhaseId) {
  const status = phaseStatus(state, phaseId);
  const required = phaseId === 'testing' ? 4 : 1;
  const passed = phaseId === 'testing'
    ? (state === 'blocked' || state === 'preflight_gap' ? 2 : 4)
    : status === 'passed' ? 1 : 0;
  return {
    phaseId,
    displayName: LIFECYCLE_PHASES.find((phase) => phase.id === phaseId)?.displayName ?? phaseId,
    status,
    disposition: 'required' as const,
    gateProgress: { passed, required },
    rationale: 'Required by the compiled SSDLC plan.',
    blocker: status === 'blocked' ? 'Tenant-isolation integration test fails because organizationId is missing.' : status === 'stale' ? 'Dependent release proof is stale after artifact replacement.' : null,
    nextSafeAction: status === 'blocked' ? 'Retry only BAA-005.' : null,
  };
}

export function goldenPortfolio(state: GoldenJourneyState): LifecyclePortfolioResponse {
  const phases = LIFECYCLE_PHASES.map((phase) => phaseCell(state, phase.id));
  const blocked = state === 'blocked' || state === 'preflight_gap';
  const delivery = {
    status: state === 'approved' ? 'completed' as const : state === 'stale' ? 'superseded' as const : blocked ? 'failed' as const : 'in_progress' as const,
    rationale: state === 'approved' ? 'The revision has completed its governed delivery path.' : state === 'stale' ? 'A replacement artifact superseded the reconciled delivery.' : blocked ? 'Delivery is blocked by failed testing.' : 'The governed delivery path is still active.',
    reconciledAt: state === 'approved' ? '2026-07-15T12:15:00.000Z' : null,
  };
  const assurance = {
    status: state === 'approved' ? 'complete' as const : state === 'stale' ? 'stale' as const : blocked ? 'blocked' as const : 'partial' as const,
    passedControls: blocked ? 4 : 7,
    totalControls: 7,
    coverage: blocked ? 4 / 7 : 1,
    rationale: blocked ? 'Four of seven canonical phase controls are satisfied.' : state === 'stale' ? 'Deployment assurance is stale after artifact replacement.' : state === 'approved' ? 'All seven canonical phase controls are satisfied.' : 'Testing passed; deployment approval remains pending.',
  };
  const reconciliation = null;
  const readiness = {
    execution: { status: blocked ? 'failed' as const : 'completed' as const, runId: blocked ? GOLDEN.originalRunId : GOLDEN.retryRunId, rationale: blocked ? 'The original run failed testing.' : 'The targeted retry completed.' },
    assurance: { ...assurance, pendingPolicyApprovals: 0, pendingHumanApprovals: state === 'qa_evidence_only' ? 1 : 0 },
    delivery: { ...delivery, reconciliation },
  };
  return {
    items: [{
      specId: GOLDEN.specId,
      title: GOLDEN.specTitle,
      specStatus: 'approved',
      state: 'current',
      overallStatus: blocked ? 'blocked' : state === 'stale' ? 'stale' : state === 'qa_evidence_only' ? 'awaiting_approval' : 'in_progress',
      risk: 'medium',
      owner: { id: 'qa-approver', label: 'Test Approver' },
      storySummary: { total: 6, passed: blocked ? 4 : 6, failed: blocked ? 1 : 0 },
      currentPhaseId: blocked ? 'testing' : state === 'approved' || state === 'stale' ? 'maintenance' : 'deployment',
      blocked,
      blockers: blocked ? [{ phaseId: 'testing', reason: 'Missing organizationId scope in the worker payload query.' }] : [],
      liveness: null,
      currentRevision: { specVersion: GOLDEN.revision.specVersion, inputHash: GOLDEN.revision.inputHash, planVersion: GOLDEN.revision.planVersion },
      phases,
      readiness,
      delivery,
      assurance,
      reconciliation,
      ...SNAPSHOT,
      updatedAt: '2026-07-15T12:10:00.000Z',
    }],
    total: 1,
    hasMore: false,
    workspace: { id: GOLDEN.workspaceId, label: GOLDEN.workspaceName },
    phaseOrder: [...LIFECYCLE_PHASES],
    stageProfile: null,
    kpis: {
      specs: 1, activeSpecs: 1, evaluatedSpecs: 1, needsCompilation: 0,
      blockedSpecs: blocked ? 1 : 0, deliveredSpecs: state === 'approved' ? 1 : 0,
      inProgressSpecs: state === 'approved' || state === 'stale' ? 0 : 1,
      needsReconciliation: state === 'stale' ? 1 : 0, assuranceComplete: state === 'approved' ? 1 : 0,
      missingGates: blocked ? 2 : 0, specsWithBlockers: blocked ? 1 : 0,
      readyForQa: state === 'recovered' || state === 'qa_evidence_only' ? 1 : 0,
      waitingApprovals: state === 'qa_evidence_only' ? 1 : 0,
      recentPhaseTransitions: blocked ? 4 : 7, stories: 6,
      phases: { total: phases.length, excluded: 0, denominator: phases.length, passed: phases.filter((phase) => phase.status === 'passed').length, completionRate: phases.filter((phase) => phase.status === 'passed').length / phases.length, byStatus: {} as Record<LifecycleEvaluatedStatus, number> },
    },
    ...SNAPSHOT,
  };
}

export function goldenSpec(state: GoldenJourneyState): LifecycleSpecResponse {
  const portfolio = goldenPortfolio(state).items[0];
  const evidence = validationEvidence(state);
  return {
    workspaceId: GOLDEN.workspaceId,
    specId: GOLDEN.specId,
    title: GOLDEN.specTitle,
    state: 'current',
    plan: {
      id: 'plan:billing-anomaly-alerts:v3', databaseId: '24024', version: 3,
      specVersion: GOLDEN.revision.specVersion, schemaVersion: 1,
      compilerVersion: 'ssdlc-plan-compiler-2', policyVersion: 'lifecycle-policy-1',
      inputHash: GOLDEN.revision.inputHash, compiledAt: '2026-07-15T11:45:00.000Z',
    },
    provenance: {
      fixtureId: GOLDEN.fixtureId,
      intent: GOLDEN.intent,
      governedScopeDecision: GOLDEN.governedScopeDecision,
      persistedThrough: 'rorca_persist_spec',
      preflightRepair: { storyId: 'BAA-005', gap: 'Missing tenant-isolation owner', repaired: true },
    },
    overallReadiness: { ready: false, status: portfolio.overallStatus, completionRate: 0.82, counts: null },
    readiness: portfolio.readiness,
    delivery: portfolio.delivery,
    assurance: portfolio.assurance,
    reconciliation: portfolio.reconciliation,
    phaseTimeline: portfolio.phases,
    traceability: {
      requirements: {
        items: GOLDEN_STORIES.map((story) => ({
          requirementReference: story.requirements[0],
          stories: [story.id],
          decisions: [GOLDEN.governedScopeDecision.decisionId],
          gateIds: story.id === 'BAA-005' ? VALIDATION_GATE_DEFINITIONS.map(([id]) => id) : [`${story.capability}-gate`],
          evidenceRequirementIds: [`evidence:${story.id}`],
          gates: story.id === 'BAA-005' ? phaseGates(state, 'testing').map((item) => ({
            gateId: item.gateId, phaseId: item.phaseId, title: item.title, status: item.evaluation?.status ?? 'not_started',
            subjectRevisionRequirement: item.subjectRevisionRequirement,
            evidenceRequirementIds: item.evidenceRequirementIds,
            currentEvidence: evidence.filter((entry) => entry.gateId === item.gateId && !entry.stale),
            historicalEvidence: evidence.filter((entry) => entry.gateId === item.gateId && entry.stale),
          })) : [],
          blockers: story.id === 'BAA-005' && (state === 'blocked' || state === 'preflight_gap') ? [{
            kind: 'gate_to_evidence' as const,
            requirementReference: 'REQ-005', storyReference: 'BAA-005', gateId: 'validation-tenant-isolation',
            message: 'organizationId scope is missing from the worker payload query.',
            remediation: 'Retry BAA-005 only; keep BAA-006 unscheduled until accepted closeout.',
          }] : [],
        })),
        total: 6, truncated: false,
      },
      stories: { items: GOLDEN_STORIES.map((story) => story.id), total: 6, truncated: false },
      architectureDecisions: { items: ['ADR-BAA-001 Tenant boundary'], total: 1, truncated: false },
      gates: { items: [], total: 11, truncated: true },
      blockers: { items: [], total: 0, truncated: false },
      boundRevision: { specVersion: GOLDEN.revision.specVersion, inputHash: GOLDEN.revision.inputHash, planId: 'plan:billing-anomaly-alerts:v3', planVersion: 3 },
      subjectLineage: [
        { type: 'commit_sha', status: 'available', value: GOLDEN.revision.sourceCommit },
        { type: 'artifact_digest', status: 'available', value: state === 'stale' ? GOLDEN.replacement.stagedArtifactDigest : GOLDEN.revision.stagedArtifactDigest },
        { type: 'deployment_id', status: 'available', value: GOLDEN.revision.testDeploymentId },
      ],
      downstreamCoherence: {
        status: state === 'stale' ? 'mismatch' : 'consistent',
        bindings: ['testing', 'deployment'].map((phaseId) => ({
          phaseId, commitSha: GOLDEN.revision.sourceCommit,
          artifactDigest: phaseId === 'deployment' && state === 'stale' ? GOLDEN.replacement.stagedArtifactDigest : GOLDEN.revision.stagedArtifactDigest,
          deploymentId: phaseId === 'deployment' ? GOLDEN.revision.testDeploymentId : null,
        })),
      },
      graphContext: { mode: 'relational', relatedEvidenceLabels: ['Journey validation mapping', 'QA-mode evidence mapping'] },
      evidence: { total: evidence.length, validForCurrentRevision: evidence.filter((item) => !item.stale).length, stale: evidence.filter((item) => item.stale).length, boundedAt: 200 },
      storyReconciliation: {
        specRevision: GOLDEN.revision.sourceCommit,
        blocking: state === 'blocked' || state === 'preflight_gap',
        repairedStoryIds: state === 'blocked' || state === 'preflight_gap' ? [] : ['BAA-005'],
        stories: {
          items: [
            { storyId: 'BAA-005', agentAttempt: 'completed', acceptedCloseout: state === 'blocked' || state === 'preflight_gap' ? 'blocked' : 'accepted', lifecycleEvaluation: phaseStatus(state, 'testing') },
            { storyId: 'BAA-006', scheduling: state === 'blocked' || state === 'preflight_gap' ? 'unscheduled_dependency_blocked' : 'eligible_after_governed_retry' },
          ], total: 6, truncated: true,
        },
      },
    },
    currentRun: {
      id: state === 'blocked' || state === 'preflight_gap' ? GOLDEN.originalRunId : GOLDEN.retryRunId,
      status: state === 'blocked' || state === 'preflight_gap' ? 'failed' : 'completed',
      startedAt: '2026-07-15T11:50:00.000Z', finishedAt: '2026-07-15T12:10:00.000Z', queuePosition: null,
      triggerType: state === 'blocked' || state === 'preflight_gap' ? 'manual' : 'retry', agentType: 'pi',
      stories: { total: 6, passed: state === 'blocked' || state === 'preflight_gap' ? 4 : 6, failed: state === 'blocked' || state === 'preflight_gap' ? 1 : 0 },
      liveness: {
        state: 'completed', evaluatedAt: '2026-07-15T12:10:00.000Z', lastMeaningfulActivity: '2026-07-15T12:09:50.000Z', confidence: 1,
        evidence: [{ source: 'completion_packet', reference: `run:${GOLDEN.retryRunId}:completion`, observedAt: '2026-07-15T12:09:50.000Z', available: true, meaningful: true, detail: 'Agent attempt packet persisted; closeout evaluated separately.' }],
        blocker: null, nextSafeAction: { action: 'none', explanation: 'The attempt is terminal; lifecycle evaluation remains independent.' },
        policy: { inactivityThresholdMs: 300_000, lookbackMs: 3_600_000, evidenceLimit: 16 },
      },
    },
    evaluationSnapshot: {
      ...SNAPSHOT, planId: 'plan:billing-anomaly-alerts:v3', planVersion: 3, inputHash: GOLDEN.revision.inputHash,
      activeReleaseSubject: { type: 'commit_sha', value: GOLDEN.revision.sourceCommit }, policyVersion: 'lifecycle-policy-1',
      compilerVersion: 'ssdlc-plan-compiler-2', evaluatedAt: '2026-07-15T12:11:00.000Z',
    },
    ...SNAPSHOT,
  };
}

export function goldenPhase(state: GoldenJourneyState, phaseId: LifecyclePhaseId): LifecyclePhaseResponse {
  const gates = phaseGates(state, phaseId);
  const evidence = phaseId === 'testing' ? validationEvidence(state) : [];
  const status = phaseStatus(state, phaseId);
  const blocked = status === 'blocked';
  return {
    workspaceId: GOLDEN.workspaceId, specId: GOLDEN.specId, phaseId, state: 'current', status, disposition: 'required',
    whyRequired: phaseId === 'testing' ? 'Tenant-visible background processing requires focused isolation and broad regression evidence.' : 'Required by the accepted seven-phase plan.',
    mappedRequirements: { items: phaseId === 'testing' ? ['REQ-002', 'REQ-004', 'REQ-005', 'REQ-006'] : [`REQ-${phaseId.toUpperCase()}`], total: phaseId === 'testing' ? 4 : 1, truncated: false },
    mappedDecisions: { items: [GOLDEN.governedScopeDecision.decisionId, 'ADR-BAA-001'], total: 2, truncated: false },
    mappedStories: { items: phaseId === 'testing' ? ['BAA-002', 'BAA-004', 'BAA-005', 'BAA-006'] : ['BAA-006'], total: phaseId === 'testing' ? 4 : 1, truncated: false },
    governedDecisions: {
      items: phaseId === 'deployment' && state === 'approved' ? [{
        id: 'decision-qa-lfc-024', gateId: 'deployment-gate', storyId: 'BAA-006', decisionType: 'deployment_approval',
        rationale: 'Authorized test approver reviewed staging evidence for the exact release lineage.',
        evidenceGap: null, actor: { id: 'test-approver', label: 'Test Approver', type: 'local_admin' },
        createdAt: '2026-07-15T12:15:00.000Z', expiresAt: null, revokedAt: null,
      }] : [], total: phaseId === 'deployment' && state === 'approved' ? 1 : 0, truncated: false,
    },
    requiredGates: { items: gates, total: gates.length, truncated: false },
    evidence: { items: evidence, total: evidence.length, hasMore: false },
    blocker: blocked
      ? { gateId: 'validation-tenant-isolation', reason: 'Worker payload query is missing organizationId scope; BAA-006 remains unscheduled.' }
      : status === 'awaiting_approval'
        ? { gateId: `${phaseId}-gate`, reason: 'QA-mode evidence exists, but an authorized revision-bound approval is still required.' }
        : status === 'stale'
          ? { gateId: `${phaseId}-gate`, reason: 'The staged artifact digest changed after this proof was recorded.' }
          : null,
    nextSafeActionGuidance: {
      action: blocked ? 'Retry BAA-005 only.' : status === 'awaiting_approval' ? 'Request explicit deployment approval for this revision.' : status === 'stale' ? 'Re-run only dependent deployment proof.' : 'No unsafe automation is permitted.',
      rationale: blocked ? 'The backend closeout classifier isolated one story-caused failure.' : 'The lifecycle evaluator derived this state from revision-bound evidence and decisions.',
      confidence: 0.99, classifier: 'phase_evaluator',
    },
    nextSafeAction: blocked ? 'Retry BAA-005 only.' : null,
    permittedActions: phaseId === 'testing'
      ? ['inspect_evidence', 'retry_smallest_scope', 'run_phase', 'reopen_disposition', 'recompile_plan']
      : phaseId === 'deployment' ? ['inspect_evidence', 'request_approval', 'run_phase'] : ['inspect_evidence'],
    learn: phaseId === 'maintenance' && (state === 'approved' || state === 'stale') ? {
      requiredCandidateCount: 1, candidateCount: 1, sourceEvidenceCount: 2, reviewStates: { review_required: 1 },
      generation: { state: 'generated', attemptedAt: '2026-07-15T12:20:00.000Z', blocker: null },
      candidates: { items: [{
        id: 24024, status: 'review_required', category: 'Gotcha', confidence: 'high', securitySensitive: true,
        defaultRetrievalEligible: false, createdAt: '2026-07-15T12:20:00.000Z', provenance: {
          workspaceId: GOLDEN.workspaceId, specId: GOLDEN.specId, runId: GOLDEN.retryRunId, storyId: 'BAA-005', commitSha: GOLDEN.revision.sourceCommit,
          releaseSubject: { type: 'commit_sha', value: GOLDEN.revision.sourceCommit }, sourceEvidenceIds: ['703', '704'],
          sourceDecisionIds: ['decision-qa-lfc-024'], deduplicationKey: 'lfc-024-tenant-scope-gotcha',
        },
      }], total: 1, truncated: false },
      nextAction: 'Human-review the redacted candidate; do not auto-promote sensitive content.',
    } : undefined,
    evaluationSnapshot: goldenSpec(state).evaluationSnapshot,
    ...SNAPSHOT,
  };
}

export function goldenEvidence(state: GoldenJourneyState, evidenceId = '703'): LifecycleEvidenceDetail {
  const summary = validationEvidence(state).find((item) => item.id === evidenceId) ?? validationEvidence(state)[0];
  return {
    id: summary.id, workspaceId: GOLDEN.workspaceId, specId: GOLDEN.specId,
    scope: { workspaceId: GOLDEN.workspaceId, specSlug: GOLDEN.specId, runId: summary.runId, storyId: summary.storyId, phaseId: 'testing', gateId: summary.gateId },
    source: { type: 'test_adapter', system: summary.sourceSystem, eventId: summary.sourceEventId },
    observedAt: summary.observedAt!, createdAt: summary.observedAt,
    subject: summary.subject, phaseSubject: summary.subject,
    releaseIdentity: { commitSha: GOLDEN.revision.sourceCommit, artifactDigest: GOLDEN.revision.stagedArtifactDigest, deploymentId: GOLDEN.revision.testDeploymentId },
    classification: summary.gateId === 'validation-tenant-isolation' ? 'story_caused_failure' : 'automated_validation',
    status: summary.status, trustLevel: summary.trustLevel, confidence: summary.confidence,
    excerpt: summary.status === 'story_caused_failure' ? 'Expected organization_id predicate in worker payload query; none observed.' : 'Focused and broad validation passed.',
    actor: 'authenticated-lfc-024-test-adapter', rationale: 'Unavailable provider boundary represented as deterministic test evidence.',
    expiresAt: null, environment: 'local-staging', redactionState: 'normalized_redacted',
    details: { command: 'npm run test:tenant-isolation', result: summary.status, fixtureId: GOLDEN.fixtureId },
    provenanceChain: [{ system: 'rorca:host-runner', eventId: `run-${summary.runId}`, observedAt: summary.observedAt!, verification: 'host_observed' }, { system: summary.sourceSystem, eventId: summary.sourceEventId, observedAt: summary.observedAt!, verification: 'test_adapter' }],
    revisionMismatch: summary.stale, eligibleForActiveGate: !summary.stale && summary.status === 'passed', invalidReasons: summary.invalidReasons,
    lineageVerified: !summary.stale, payloadHash: `sha256:${'4'.repeat(64)}`, sourcePayloadHash: `sha256:${'5'.repeat(64)}`,
    rawReference: { available: true, accessTier: 'auth', allowed: true, kind: 'run', label: 'Open run', reference: `run:${summary.runId}:evidence:${summary.id}`, href: `/runs/${summary.runId}`, external: false, rawPayloadIncluded: false },
    ...SNAPSHOT,
  };
}

export const GOLDEN_RETRY_PREVIEW = {
  ok: true as const,
  preview: {
    schemaVersion: 'retry-preview.v1' as const,
    originalRunId: GOLDEN.originalRunId,
    scope: {
      requested: [{ storyId: 'BAA-005', reasonCode: 'STORY_CAUSED_FAILURE' }],
      requiredDependency: [],
      copiedPassed: GOLDEN_STORIES.slice(0, 4).map((story) => ({ storyId: story.id, reasonCode: 'ACCEPTED_CLOSEOUT_COPIED' })),
      skipped: [{ storyId: 'BAA-006', reasonCode: 'DEPENDENCY_UNSCHEDULED' }],
      executable: [{ storyId: 'BAA-005', reasonCode: 'SMALLEST_SAFE_RETRY' }],
      remaining: [{ storyId: 'BAA-006', reasonCode: 'WAIT_FOR_ACCEPTED_UPSTREAM_CLOSEOUT' }],
      excluded: [],
    },
    options: {
      agent: 'pi' as const, model: 'openai/gpt-5.4', effort: 'high', terminalMode: 'headless', includeGraph: true,
      worktree: { enabled: true, path: '/tmp/rorca-lfc-024', branch: 'retry/baa-005-tenant-scope' },
      merge: { strategy: 'branch-only' as const, autoMerge: false },
      safety: { deploy: false, externalSend: false, policyLocked: true, allowBackendJest: false as const },
    },
    forceSequential: true, requiresApproval: false,
    destructiveOperations: ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'] as const,
    previewHash: `sha256:${'6'.repeat(64)}`,
  },
  previewIdentity: {
    schemaVersion: 'retry-preview-identity.v1' as const, previewHash: `sha256:${'6'.repeat(64)}`,
    originalRunId: GOLDEN.originalRunId, expiresAt: '2999-07-15T12:30:00.000Z', signature: `sha256:${'6'.repeat(64)}`,
  },
  worktreePreflight: { classification: 'fresh', ok: true, detail: `Current revision ${GOLDEN.revision.sourceCommit}`, remediation: 'None' },
  passReconciliation: { BAA005: 'retry', BAA006: 'unscheduled_until_accepted_closeout' },
};

export const GOLDEN_EVIDENCE_BUNDLE_CONTRACT = {
  schemaVersion: 'rorca.lifecycle-golden-journey-evidence.v1',
  fixtureId: GOLDEN.fixtureId,
  deterministicSeed: 'LFC-024',
  intent: GOLDEN.intent,
  governedScopeDecision: GOLDEN.governedScopeDecision,
  referenceDiagrams: {
    uiJourney: 'docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.png',
    runtimeEvidence: 'docs/diagrams/hermes-rorca-ssdlc-skill-sequence-clean.png',
    authorityRule: 'Validated canonical contracts override stale visual details.',
  },
  ids: { workspaceId: GOLDEN.workspaceId, specId: GOLDEN.specId, runIds: [GOLDEN.originalRunId, GOLDEN.retryRunId, GOLDEN.qaRunId], storyIds: GOLDEN_STORIES.map((story) => story.id) },
  storyExecution: GOLDEN_STORY_EXECUTION,
  lineage: GOLDEN.revision,
  explicitMappings: {
    journeyModeEvidence: ['validation-broad', 'deployment-gate'],
    qaModeEvidence: ['validation-broad', 'deployment-gate'],
    evaluatorOnlyPhaseAuthority: true,
    qaApprovalIndependent: true,
  },
  externalBoundaryAdapters: ['GitHub test adapter', 'Hermes test adapter', 'GitReins test adapter', 'approval-gated staging test adapter'],
  commands: [
    { command: 'npm run test:tenant-isolation', expectedResult: 'fails before BAA-005 fix; passes after targeted retry', evidenceTrust: 'host_observed' },
    { command: 'npm run typecheck', expectedResult: 'passes after recovery', evidenceTrust: 'host_observed' },
    { command: 'npx playwright test tests/lifecycle-golden-journey.spec.ts', expectedResult: 'passes', evidenceTrust: 'host_observed' },
  ],
  mutations: ['recompile', 'evidence_ingest', 'decision', 'revocation', 'retry_preview', 'retry_dispatch', 'qa_approval'],
  approvals: [{ id: 'decision-qa-lfc-024', type: 'qa_approval', subject: GOLDEN.revision.sourceCommit, actor: 'authorized test approver' }],
  screenshots: GOLDEN.screenshots,
  remainingRisks: ['Production deployment evidence intentionally absent.', 'Slack, merge, deploy, and production mutation are policy-locked.'],
  cleanup: { browser: 'required', server: 'required_if_started_by_harness', runner: 'required', fixtureWorkspace: 'idempotently removed or reset' },
} as const;
