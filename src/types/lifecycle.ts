/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { FeatureAssuranceMapInput } from './feature-assurance-map';

/** Frontend mirror of the authenticated /api/lifecycle wire contract. */

export const LIFECYCLE_PHASE_IDS = [
  'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
] as const;

export type LifecyclePhaseId = typeof LIFECYCLE_PHASE_IDS[number];

const LIFECYCLE_PHASE_LABELS: Record<LifecyclePhaseId, string> = {
  planning: 'Planning',
  requirements: 'Requirements',
  design: 'Design',
  development: 'Development',
  testing: 'Testing',
  deployment: 'Deployment',
  maintenance: 'Maintenance',
};

/** Canonical matrix columns. UI code must not reorder these from API metadata. */
export const LIFECYCLE_PHASES: readonly Readonly<LifecyclePhaseDescriptor>[] = LIFECYCLE_PHASE_IDS.map((id) => ({
  id,
  displayName: LIFECYCLE_PHASE_LABELS[id],
}));

/**
 * Seven conventional SSDLC stages — the canonical phases ARE the stages
 * (identity projection). Only the first six stages can block a normal
 * delivery; `maintenance` is asynchronous and non-blocking.
 */
export type LifecycleMissionStage =
  | 'planning'
  | 'requirements'
  | 'design'
  | 'development'
  | 'testing'
  | 'deployment'
  | 'maintenance';

export interface LifecycleStageDescriptor {
  id: LifecycleMissionStage;
  displayName: string;
  phaseIds: readonly LifecyclePhaseId[];
}

export const LIFECYCLE_STAGES: readonly Readonly<LifecycleStageDescriptor>[] = [
  { id: 'planning', displayName: 'Planning', phaseIds: ['planning'] },
  { id: 'requirements', displayName: 'Requirements', phaseIds: ['requirements'] },
  { id: 'design', displayName: 'Design', phaseIds: ['design'] },
  { id: 'development', displayName: 'Development', phaseIds: ['development'] },
  { id: 'testing', displayName: 'Testing', phaseIds: ['testing'] },
  { id: 'deployment', displayName: 'Deployment', phaseIds: ['deployment'] },
  { id: 'maintenance', displayName: 'Maintenance', phaseIds: ['maintenance'] },
];

export function lifecycleStageOf(phaseId: LifecyclePhaseId): LifecycleMissionStage {
  return LIFECYCLE_STAGES.find((stage) => stage.phaseIds.includes(phaseId))?.id ?? 'maintenance';
}

/**
 * Wire mirror of the compiled plan's stage profile
 * (backend LifecycleProfileSchema). `stages` drive the matrix stage header row;
 * when the profile is absent the UI falls back to the bundled LIFECYCLE_STAGES.
 */
export interface LifecycleStageProfile {
  profileId: string;
  profileVersion: number;
  profileHash: string;
  stages: readonly LifecycleStageDescriptor[];
  blockingStages: readonly string[];
}
export type LifecycleEvaluatedStatus =
  | 'not_started'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_approval'
  | 'passed'
  | 'deferred'
  | 'not_applicable'
  | 'stale';
export type LifecycleStatusFilter = LifecycleEvaluatedStatus | 'needs_compilation';
export type LifecycleSpecStatus = 'pending' | 'approved' | 'completed' | 'rejected';
export type LifecycleRisk = 'low' | 'medium' | 'high' | 'critical';
export type LifecycleDisposition = 'required' | 'deferred' | 'not_applicable';
export type LifecycleSort = 'current_view' | 'updated_desc' | 'title_asc' | 'risk_desc' | 'readiness_desc' | 'owner_asc';
export type LifecycleViewMode = 'explorer' | 'matrix';
export type LifecyclePlanState = 'current' | 'stale' | 'needs_compilation' | 'compilation_failed';
export type LifecyclePermittedAction =
  | 'inspect_evidence'
  | 'recompile_plan'
  | 'retry_smallest_scope'
  | 'request_approval'
  | 'run_phase'
  | 'reopen_disposition';

export interface LifecyclePortfolioFilters {
  search?: string;
  status?: LifecycleStatusFilter;
  specStatus?: LifecycleSpecStatus;
  phase?: LifecyclePhaseId;
  /** Seven-stage delivery projection filter; filters specs whose current phase projects to the stage. */
  stage?: LifecycleMissionStage;
  risk?: LifecycleRisk;
  owner?: string;
  blocked?: boolean;
  disposition?: LifecycleDisposition;
  sort: LifecycleSort;
}

export interface LifecycleUrlState extends LifecyclePortfolioFilters {
  page: number;
  limit: number;
  compact: boolean;
  mode: LifecycleViewMode;
  selectedSpecId: string | null;
  selectedPhaseId: LifecyclePhaseId | null;
}

export interface LifecyclePaginationRequest {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface LifecyclePaginated<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

export interface LifecycleBounded<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface LifecycleSnapshotRef {
  snapshotId: string;
  evidenceHighWaterMark: string;
  decisionHighWaterMark: string;
}

export interface LifecycleEvaluationSnapshot extends LifecycleSnapshotRef {
  planId: string;
  planVersion: number;
  inputHash: string;
  activeReleaseSubject: LifecycleReleaseSubject;
  policyVersion: string;
  compilerVersion: string;
  evaluatedAt: string;
}

export type LifecycleReleaseSubjectType = 'spec_hash' | 'commit_sha' | 'artifact_digest' | 'deployment_id';
export interface LifecycleReleaseSubject {
  type: LifecycleReleaseSubjectType;
  value: string;
}

export type LifecycleDependencyStatus = 'ready' | 'waiting' | 'blocked';
export type LifecycleExecutionStatus = 'not_started' | 'blocked' | 'ready' | 'queued' | 'running' | 'completed' | 'failed';
export type LifecycleAssuranceStatus = 'not_evaluated' | 'partial' | 'complete' | 'stale' | 'blocked';
export type LifecycleDeliveryStatus = 'unknown' | 'in_progress' | 'failed' | 'completed' | 'operator_attested' | 'superseded';

export interface LifecycleExecutionProjection {
  status: LifecycleExecutionStatus;
  runId: number | null;
  rationale: string;
}

export interface LifecycleAssuranceProjection {
  status: LifecycleAssuranceStatus;
  passedControls: number | null;
  totalControls: number | null;
  coverage?: number | null;
  pendingPolicyApprovals: number;
  pendingHumanApprovals: number;
  rationale: string;
}

export interface LifecycleDeliveryProjection {
  status: LifecycleDeliveryStatus;
  rationale: string;
  reconciledAt: string | null;
}

export interface LifecycleReconciliationProjection {
  resultHash: string;
  assuranceStatus: LifecycleAssuranceStatus;
  unresolvedGaps: Array<{ code?: string; message?: string; stageId?: string }>;
  operatorAttested: boolean;
  createdAt: string;
}

export interface LifecycleReadinessProjection {
  execution: LifecycleExecutionProjection;
  assurance: LifecycleAssuranceProjection;
  delivery: LifecycleDeliveryProjection & { reconciliation: LifecycleReconciliationProjection | null };
}

export interface LifecyclePhaseDescriptor {
  id: LifecyclePhaseId;
  displayName: string;
}

export interface LifecycleLearnCandidate {
  id: number;
  status: string;
  category: string | null;
  confidence: string | null;
  securitySensitive: boolean;
  defaultRetrievalEligible: boolean;
  createdAt: string | null;
  provenance: {
    workspaceId: string | null;
    specId: string | null;
    runId: number | null;
    storyId: string | null;
    commitSha: string | null;
    releaseSubject: { type: string; value: string } | null;
    sourceEvidenceIds: string[];
    sourceDecisionIds: string[];
    deduplicationKey: string | null;
  };
}

export interface LifecycleLearnSummary {
  requiredCandidateCount: number;
  candidateCount: number;
  sourceEvidenceCount: number;
  reviewStates: Record<string, number>;
  generation: {
    state: 'not_started' | 'generated' | 'blocked';
    attemptedAt: string | null;
    blocker: { code: string; message: string; retryable: boolean } | null;
  };
  candidates: LifecycleBounded<LifecycleLearnCandidate>;
  nextAction: string;
}

export interface LifecyclePhaseCell {
  phaseId: LifecyclePhaseId;
  displayName: string;
  status: LifecycleEvaluatedStatus | 'unassessed';
  /** Observable work activity, independent of gate evaluation. */
  activityStatus?: LifecycleEvaluatedStatus | 'unassessed';
  /** Gate aggregate for this phase, independent of predecessor readiness. */
  ownStatus?: LifecycleEvaluatedStatus | 'unassessed';
  /** Predecessor readiness only. Omitted by snapshots predating lifecycle readiness projection. */
  dependencyStatus?: LifecycleDependencyStatus;
  disposition: LifecycleDisposition | null;
  /** Gate progress excludes disposition from success semantics; deferred/N/A cells show rationale instead. */
  gateProgress?: { passed: number | null; required: number | null };
  rationale?: string | null;
  blocker: string | null;
  nextSafeAction: string | null;
  learn?: LifecycleLearnSummary;
}

export type LifecycleEvidenceSource = 'database' | 'wal' | 'log' | 'pty' | 'process' | 'worker' | 'git' | 'completion_packet' | 'retry';
export type LifecycleLivenessState = 'active' | 'quiet_active' | 'stalled' | 'blocked' | 'completed' | 'unknown';
export type LifecycleLivenessAction = 'wait' | 'inspect evidence' | 'retry smallest scope' | 'refresh worktree' | 'request approval' | 'preserve/commit' | 'cancel' | 'none';
export type LifecycleLivenessBlockerType = 'credential' | 'environment' | 'policy_approval' | 'worktree' | 'testing' | 'retry_scope';

export interface LifecycleLivenessEvidence {
  source: LifecycleEvidenceSource;
  reference: string;
  observedAt: string | null;
  available: boolean;
  meaningful: boolean;
  detail: string;
}

export interface LifecycleLivenessBlocker {
  type: LifecycleLivenessBlockerType;
  code: string;
  summary: string;
  remediation: string;
  evidenceReference: string;
  observedAt: string | null;
}

export interface LifecycleLiveness {
  state: LifecycleLivenessState;
  evaluatedAt: string;
  lastMeaningfulActivity: string | null;
  confidence: number;
  evidence: LifecycleLivenessEvidence[];
  blocker: LifecycleLivenessBlocker | null;
  nextSafeAction: { action: LifecycleLivenessAction; explanation: string };
  policy: { inactivityThresholdMs: number; lookbackMs: number; evidenceLimit: number };
}

export interface LifecyclePortfolioItem {
  specId: string;
  title: string;
  specStatus: LifecycleSpecStatus | 'unknown';
  state: LifecyclePlanState;
  overallStatus: LifecycleStatusFilter;
  risk: LifecycleRisk | null;
  owner: { id: string; label: string } | null;
  storySummary: { total: number; passed: number | null; failed: number | null };
  currentPhaseId: LifecyclePhaseId | null;
  blocked: boolean;
  blockers: Array<{ phaseId: LifecyclePhaseId; reason: string }>;
  liveness: LifecycleLiveness | null;
  currentRevision: { specVersion: string | null; inputHash: string; planVersion: number } | null;
  phases: LifecyclePhaseCell[];
  snapshotId?: string;
  evidenceHighWaterMark?: string;
  decisionHighWaterMark?: string;
  updatedAt: string | null;
  recompileHint?: { safe: true; method: 'POST'; href: string };
  /** Rolling compatibility: absent only on snapshots created before readiness projection. */
  readiness?: LifecycleReadinessProjection;
  delivery: LifecycleDeliveryProjection;
  assurance: Omit<LifecycleAssuranceProjection, 'pendingPolicyApprovals' | 'pendingHumanApprovals'> & {
    pendingPolicyApprovals?: number;
    pendingHumanApprovals?: number;
  };
  reconciliation: LifecycleReconciliationProjection | null;
}

export interface LifecyclePhaseCounts {
  total: number;
  excluded: number;
  denominator: number;
  passed: number;
  completionRate: number;
  byStatus: Record<LifecycleEvaluatedStatus, number>;
}

export interface LifecyclePortfolioResponse extends LifecyclePaginated<LifecyclePortfolioItem>, LifecycleSnapshotRef {
  workspace: { id: string; label: string };
  phaseOrder: LifecyclePhaseDescriptor[];
  /** Compiled stage profile driving matrix headers; null when no plan is visible. */
  stageProfile: LifecycleStageProfile | null;
  kpis: {
    specs: number;
    activeSpecs: number;
    evaluatedSpecs: number;
    needsCompilation: number;
    blockedSpecs: number;
    deliveredSpecs: number;
    inProgressSpecs: number;
    needsReconciliation: number;
    assuranceComplete: number;
    missingGates: number;
    specsWithBlockers: number;
    readyForQa: number;
    waitingApprovals: number;
    recentPhaseTransitions: number;
    stories: number;
    phases: LifecyclePhaseCounts;
  };
}

export interface LifecyclePlanSummary {
  id: string;
  databaseId: string | null;
  version: number;
  specVersion: string | null;
  schemaVersion: number;
  compilerVersion: string;
  policyVersion: string;
  inputHash: string;
  compiledAt: string;
}

export type LifecycleTraceabilityBlockerKind = 'requirement_to_story' | 'story_to_gate' | 'gate_to_evidence' | 'revision' | 'subject_coherence';

export interface LifecycleTraceabilityBlocker {
  kind: LifecycleTraceabilityBlockerKind;
  requirementReference: string | null;
  storyReference: string | null;
  gateId: string | null;
  message: string;
  remediation: string;
}

export interface LifecycleTraceabilityGate {
  gateId: string;
  phaseId: LifecyclePhaseId;
  title: string;
  status: LifecycleEvaluatedStatus;
  subjectRevisionRequirement?: LifecycleSubjectRevisionRequirement;
  evidenceRequirementIds?: string[];
  currentEvidence?: LifecycleEvidenceSummary[];
  historicalEvidence?: LifecycleEvidenceSummary[];
}

export interface LifecycleTraceabilityRequirement {
  requirementReference: string;
  stories: string[];
  decisions: string[];
  gateIds: string[];
  evidenceRequirementIds: string[];
  gates?: LifecycleTraceabilityGate[];
  blockers?: LifecycleTraceabilityBlocker[];
}

export interface LifecycleTraceabilityChain {
  requirementReference: string;
  storyReference: string;
  gateId: string;
  phaseId: LifecyclePhaseId;
  status: LifecycleEvaluatedStatus;
  exactSubject: LifecycleReleaseSubject | null;
  evidenceIds: string[];
  decisionIds: string[];
}

export interface LifecycleTraceability {
  requirements: LifecycleBounded<LifecycleTraceabilityRequirement>;
  stories: LifecycleBounded<string>;
  architectureDecisions: LifecycleBounded<string>;
  gates: LifecycleBounded<LifecycleTraceabilityGate>;
  blockers?: LifecycleBounded<LifecycleTraceabilityBlocker>;
  /** Canonical requirement → story → gate → exact subject → evidence/decision chains. */
  endToEnd?: LifecycleBounded<LifecycleTraceabilityChain>;
  boundRevision?: { specVersion: string | null; inputHash: string; planId: string; planVersion: number };
  subjectLineage?: Array<{ type: LifecycleReleaseSubjectType; status: 'available' | 'absent' | 'not_applicable'; value: string | null }>;
  downstreamCoherence?: {
    status: 'consistent' | 'mismatch' | 'insufficient_evidence';
    bindings: Array<{ phaseId: 'testing' | 'deployment'; commitSha: string | null; artifactDigest: string | null; deploymentId: string | null }>;
  };
  graphContext?: { mode: 'full' | 'lite' | 'unavailable' | 'relational'; relatedEvidenceLabels: string[] };
  evidence: { total: number; validForCurrentRevision: number; stale: number; boundedAt: number };
  storyReconciliation?: LifecycleStoryReconciliation | null;
}

export interface LifecycleStoryReconciliation {
  specRevision: string;
  blocking: boolean;
  repairedStoryIds: string[];
  stories: LifecycleBounded<Record<string, unknown>>;
}

export interface LifecycleCurrentRun {
  id: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  queuePosition: number | null;
  triggerType: string;
  agentType: string;
  stories: { total: number; passed: number; failed: number };
  liveness: LifecycleLiveness;
  storyReconciliation?: LifecycleStoryReconciliation | null;
}

export interface LifecycleSpecResponse extends LifecycleSnapshotRef {
  workspaceId: string;
  specId: string;
  title: string;
  state: LifecyclePlanState;
  stale?: boolean;
  plan: LifecyclePlanSummary | null;
  provenance: Record<string, unknown> | null;
  overallReadiness: {
    ready: boolean | null;
    status?: LifecycleStatusFilter;
    completionRate: number | null;
    counts: LifecyclePhaseCounts | null;
  };
  /** Rolling compatibility: absent only on snapshots created before readiness projection. */
  readiness?: LifecycleReadinessProjection;
  delivery: LifecycleDeliveryProjection;
  assurance: LifecyclePortfolioItem['assurance'];
  reconciliation: LifecycleReconciliationProjection | null;
  phaseTimeline: LifecyclePhaseCell[];
  traceability: LifecycleTraceability;
  /** Read-only source rows for the feature assurance map projector. */
  assuranceMapInput?: FeatureAssuranceMapInput;
  currentRun: LifecycleCurrentRun | null;
  evaluationSnapshot: LifecycleEvaluationSnapshot | LifecycleSnapshotRef;
  recompileHint?: { safe: true; method: 'POST'; href: string };
}

export type LifecycleGateEvidenceKind = 'spec_review' | 'architecture_review' | 'change_review' | 'automated_validation' | 'security_assessment' | 'deployment_verification' | 'qa_assessment' | 'merge_authorization' | 'production_verification' | 'learning_review';
export type LifecycleSubjectRevisionRequirement = 'current_spec_revision' | 'current_commit' | 'current_artifact' | 'current_deployment';

export interface LifecycleEvidenceRequirement {
  evidenceRequirementId: string;
  gateId: string;
  description: string;
  classification: string;
  minimumTrustLevel: string;
}

export interface LifecyclePlan {
  schemaVersion: 1;
  planId: string;
  planVersion: number;
  inputHash: string;
  workspaceId: string;
  specId: string;
  compilerVersion: string;
  policyVersion: string;
  compiledAt: string;
  phaseOrder: LifecyclePhaseId[];
  phases: Array<{ phaseId: LifecyclePhaseId; disposition: { disposition: LifecycleDisposition; rationale: string; approvalReference?: string; expiryPolicy?: string }; gateIds: string[] }>;
  requirementReferences: string[];
  storyReferences: string[];
  architectureDecisionReferences: string[];
  requirementMappings: Array<{
    requirementReference: string;
    targetReferences: Array<{ type: 'story' | 'architecture_decision'; reference: string }>;
    gateIds: string[];
    evidenceRequirementIds: string[];
  }>;
  gates: Array<Omit<LifecycleGate, 'evaluation'>>;
  evidenceRequirements: LifecycleEvidenceRequirement[];
  completeness: {
    placeholderUiForbidden: true;
    todoBackedPrimaryFlowsForbidden: true;
    fakeSuccessStatesForbidden: true;
    unspecifiedLaterReleaseDeferralForbidden: true;
    requiredJourneyClasses: ['normal', 'negative', 'recovery', 'responsive', 'accessibility', 'light_theme'];
  };
}

export interface LifecycleGate {
  gateId: string;
  /** Server policy classification; clients must not infer bypassability from presentation text. */
  hardDeny?: boolean;
  /** Server-recognized approver classes. Identity is still verified during mutation. */
  authorizedApprovers?: Array<'local_admin' | 'authenticated_admin' | 'hermes_delegated'>;
  phaseId: LifecyclePhaseId;
  title: string;
  evidenceKind: LifecycleGateEvidenceKind;
  subjectRevisionRequirement: LifecycleSubjectRevisionRequirement;
  approvalRequirement: 'none' | 'policy' | 'human';
  expirationPolicy: 'when_spec_changes' | 'when_subject_changes' | 'after_30_days' | 'never';
  blockingSeverity: 'advisory' | 'blocking' | 'release_blocking';
  evidenceRequirementIds: string[];
  acceptedSubjectTypes: LifecycleReleaseSubjectType[];
  downstreamSubjectCoherence: { testing: 'same_subject' | 'derived_from_subject' | 'not_applicable'; deployment: 'same_subject' | 'derived_from_subject' | 'not_applicable' };
  evaluation: {
    status: LifecycleEvaluatedStatus;
    rationale: string;
    blockerReason: string | null;
    nextSafeAction: string | null;
    evidenceCount: number;
    decisionCount: number;
  } | null;
}

export type LifecycleEvidenceStatus = 'passed' | 'failed' | 'story_caused_failure' | 'unrelated_baseline' | 'environment_credential_blocker' | 'skipped_with_rationale' | 'unknown';
export type LifecycleEvidenceTrust = 'host_observed' | 'provider_verified' | 'authenticated_manual' | 'agent_proposed';

export interface LifecycleEvidenceSummary {
  id: string;
  evidenceType: string;
  sourceSystem: string;
  sourceEventId: string;
  status: LifecycleEvidenceStatus;
  trustLevel: LifecycleEvidenceTrust;
  confidence: number;
  observedAt: string | null;
  subject: LifecycleReleaseSubject;
  gateId: string | null;
  storyId: string | null;
  runId: number | null;
  currentRevision: boolean;
  stale: boolean;
  invalidReasons: string[];
}

export type LifecycleDecisionType = 'defer' | 'not_applicable_confirmation' | 'gate_override' | 'testing_approval' | 'deployment_approval' | 'release_approval';

export interface LifecycleGovernedDecisionSummary {
  id: string;
  gateId: string | null;
  storyId: string | null;
  decisionType: LifecycleDecisionType;
  rationale: string;
  evidenceGap: string | null;
  actor: { id: string; label: string; type: string };
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  activity?: 'active' | 'expired' | 'revoked' | 'stale_revision';
}

export type LifecycleSourceLens = 'planning' | 'requirements' | 'design';
export type LifecycleSourceArtifactAction = 'open' | 'reveal';

export interface LifecycleSourceArtifact {
  name: string;
  label: string;
  role: 'requirements' | 'design' | 'planning' | 'context' | 'citations' | 'manifest' | 'rendered' | 'other';
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: string;
}

export interface LifecycleSourceSynthesisSection {
  id: string;
  title: string;
  content: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  sourceContentHash: string | null;
  freshness: 'current' | 'stale';
}

export type LifecycleSourceMaterial = {
  state: 'available';
  schemaVersion: 'rorca.lifecycle-source-material.v1';
  lens: LifecycleSourceLens;
  package: {
    packageId: string;
    title: string;
    workspaceId: string | null;
    status: string;
    publicationStatus: string;
    authoritative: boolean;
    scope: string | null;
    contentHash: string;
    previewHash: string | null;
    snapshotHash: string | null;
  };
  authority: {
    status: 'verified' | 'context_only';
    reasonCode: string;
    rationale: string;
    receiptId: string | null;
    receiptHash: string | null;
    manifestHash: string | null;
    releaseSubject: { type: 'spec_hash'; value: string } | null;
  };
  match: {
    method: 'explicit_binding' | 'referenced_source_overlap' | 'title_overlap';
    confidence: number;
    referencesMatched: string[];
    rationale: string;
  };
  inventory: {
    evidenceCount: number;
    excludedCount: number;
    warningCount: number;
    contradictionCount: number;
    uncertaintyCount: number;
    warnings: string[];
    contradictions: string[];
    uncertainties: string[];
  };
  artifacts: LifecycleSourceArtifact[];
  synthesis: {
    title: string;
    description: string;
    sections: LifecycleSourceSynthesisSection[];
    sourcePackageHash: string;
  };
} | {
  state: 'not_found' | 'ambiguous' | 'invalid';
  schemaVersion: 'rorca.lifecycle-source-material.v1';
  lens: LifecycleSourceLens;
  rationale: string;
};

export interface LifecycleSourceArtifactOpenResult {
  opened: true;
  action: LifecycleSourceArtifactAction;
  relativePath: string;
  editor: string;
  line: number | null;
  column: number | null;
}

export interface LifecycleSourceArtifactPreview {
  relativePath: string;
  name: string;
  role: LifecycleSourceArtifact['role'];
  content: string;
  contentType: 'markdown' | 'json' | 'html' | 'text';
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  projectedContentHash: string;
  actualContentHash: string;
  stale: boolean;
  modifiedAt: string;
}


export interface LifecycleDevelopmentExecution {
  run: {
    id: string;
    status: string;
    agentType: string;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  activityStatus: 'not_started' | 'in_progress' | 'blocked' | 'completed';
  currentStoryId: string | null;
  stories: {
    total: number;
    passed: number;
    failed: number;
    items: Array<{
      storyId: string;
      status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'retrying';
      attempts: number;
      elapsedSeconds: number | null;
      modelUsed: string | null;
      commitSha: string | null;
      integrationState: string | null;
      resultingHead: string | null;
      failureReason: string | null;
    }>;
  };
  source: {
    worktreePath: string | null;
    branch: string | null;
    baseCommit: string | null;
    resultingHead: string | null;
    dirty: boolean | null;
  };
  changes: {
    commits: number;
    additions: number | null;
    deletions: number | null;
    files: Array<{ path: string; change: 'added' | 'modified' | 'deleted' | 'renamed' }>;
  };
  verification: Record<'hostReview' | 'unit' | 'typecheck' | 'build' | 'security' | 'secrets' | 'dependencies', {
    status: 'passed' | 'failed' | 'pending' | 'missing';
    evidence: string | null;
  }>;
  integration: {
    finalized: number;
    failed: number;
    expected: number;
    conflicted: number;
    resultingHead: string | null;
  };
}

export interface LifecyclePhaseResponse extends LifecycleSnapshotRef {
  workspaceId: string;
  specId: string;
  phaseId: LifecyclePhaseId;
  state: LifecyclePlanState;
  status: LifecycleEvaluatedStatus;
  /** Observable work activity, independent of gate evaluation. */
  activityStatus?: LifecycleEvaluatedStatus;
  /** Gate aggregate for this phase, independent of predecessor readiness. */
  ownStatus?: LifecycleEvaluatedStatus;
  /** Predecessor readiness only. Omitted by snapshots predating lifecycle readiness projection. */
  dependencyStatus?: LifecycleDependencyStatus;
  disposition?: LifecycleDisposition;
  whyRequired: string | null;
  mappedRequirements: LifecycleBounded<string>;
  mappedDecisions: LifecycleBounded<string>;
  mappedStories: LifecycleBounded<string>;
  governedDecisions: LifecycleBounded<LifecycleGovernedDecisionSummary>;
  requiredGates: LifecycleBounded<LifecycleGate>;
  evidence: LifecyclePaginated<LifecycleEvidenceSummary>;
  blocker: { gateId: string | null; reason: string } | null;
  /** Backend-classified guidance. Clients must not derive this from status presentation. */
  nextSafeActionGuidance: {
    action: string;
    rationale: string;
    confidence: number;
    classifier: 'phase_evaluator' | 'plan_state';
  };
  /** Backward-compatible evaluator action text. Prefer nextSafeActionGuidance in new UI. */
  nextSafeAction: string | null;
  permittedActions: LifecyclePermittedAction[];
  learn?: LifecycleLearnSummary;
  sourceMaterial?: LifecycleSourceMaterial;
  developmentExecution?: LifecycleDevelopmentExecution;
  evaluationSnapshot: LifecycleEvaluationSnapshot | LifecycleSnapshotRef;
  recompileHint?: { safe: true; method: 'POST'; href: string };
}

export interface LifecycleEvidenceScope {
  workspaceId: string;
  specSlug: string;
  runId: number | null;
  storyId: string | null;
  phaseId: string | null;
  gateId: string | null;
}

/**
 * US-011: one advisory "what's missing" suggestion. Every suggestion carries at
 * least one citation (requirementId | controlId | sourceId) validated by the
 * server against the phase input context.
 */
export interface LifecycleAdviceSuggestion {
  text: string;
  cites: string[];
}

/**
 * US-011: advisory "what's missing" response. `advisory` is always true and
 * suggestions are never persisted as lifecycle evidence — this payload cannot
 * satisfy any gate or evaluation.
 */
export interface LifecycleAdviceResponse {
  advisory: true;
  workspaceId: string;
  specId: string;
  phaseId: LifecyclePhaseId;
  generatedAt: string;
  suggestions: LifecycleAdviceSuggestion[];
}

export interface LifecycleEvidenceListItem {
  id: string;
  schemaVersion: 'rorca.lifecycle-evidence.v1';
  source: { type: string; system: string; eventId: string };
  observedAt: string;
  scope: LifecycleEvidenceScope;
  subject: LifecycleReleaseSubject;
  phaseSubject: LifecycleReleaseSubject | null;
  releaseIdentity: { commitSha: string | null; artifactDigest: string | null; deploymentId: string | null };
  classification: string;
  status: LifecycleEvidenceStatus;
  trustLevel: LifecycleEvidenceTrust;
  confidence: number;
  excerpt: string | null;
  rawReference: string | null;
  provenanceChain: Array<{ system: string; eventId: string; observedAt: string; principal?: string; verification?: string }>;
  actor: string | null;
  rationale: string | null;
  details: Record<string, unknown>;
  revisionMismatch: boolean;
  lineageVerified: boolean;
  sourcePayloadHash: string | null;
  payloadHash: string;
  createdAt: string;
}

export interface LifecycleRawReferenceDescriptor {
  available: boolean;
  accessTier: 'auth';
  allowed: boolean;
  kind: 'run' | 'log' | 'pty' | 'github' | 'gitreins' | 'unknown';
  label: string;
  reference: string | null;
  href: string | null;
  external: boolean;
  rawPayloadIncluded: false;
}

export interface LifecycleEvidenceDetail extends LifecycleSnapshotRef {
  id: string;
  workspaceId: string;
  specId: string;
  scope: LifecycleEvidenceScope;
  source: { type: string; system: string; eventId: string };
  observedAt: string;
  createdAt: string | null;
  subject: LifecycleReleaseSubject;
  phaseSubject: LifecycleReleaseSubject | null;
  releaseIdentity: { commitSha: string | null; artifactDigest: string | null; deploymentId: string | null };
  classification: string;
  status: LifecycleEvidenceStatus;
  trustLevel: LifecycleEvidenceTrust;
  confidence: number;
  excerpt: string | null;
  actor: string | null;
  rationale: string | null;
  expiresAt: string | null;
  environment: string | null;
  redactionState: 'normalized_redacted';
  details: Record<string, unknown>;
  provenanceChain: Array<{ system: string; eventId: string; observedAt: string; principal?: string; verification?: string }>;
  revisionMismatch: boolean;
  eligibleForActiveGate: boolean;
  invalidReasons: string[];
  lineageVerified: boolean;
  payloadHash: string;
  sourcePayloadHash: string | null;
  rawReference: LifecycleRawReferenceDescriptor;
}

export interface LifecycleDecisionRecord {
  id: string;
  workspaceId: string;
  specSlug: string;
  specVersion: string | null;
  runId: number | null;
  storyId: string | null;
  phaseId: string;
  gateId: string | null;
  decisionType: LifecycleDecisionType;
  rationale: string;
  evidenceGap: string | null;
  subject: { type: 'commit_sha' | 'artifact_digest'; value: string } | null;
  policy: { version: string; reference: string; authorized: boolean };
  actor: { principalType: string; principalId: string; displayLabel: string; sourceChannel: string; delegatedOnBehalfOf: { principalId: string; displayLabel: string } | null };
  sourceRequestId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocation: { principalType: string; principalId: string; displayLabel: string; rationale: string; sourceRequestId: string } | null;
}

export interface LifecycleDecisionMutationResult {
  decision: LifecycleDecisionRecord;
  replayed: boolean;
}

export interface LifecycleEvaluatedDecision extends LifecycleDecisionRecord {
  activity: 'active' | 'expired' | 'revoked' | 'stale_revision';
  inactiveReason: string | null;
}

export interface LifecycleDecisionState {
  state: 'pending' | 'deferred' | 'not_applicable' | 'approved';
  effectiveDecisions: LifecycleEvaluatedDecision[];
  history: LifecycleEvaluatedDecision[];
}

export interface RecordLifecycleDecisionInput {
  workspaceId: string;
  specSlug: string;
  phaseId: LifecyclePhaseId;
  decisionType: LifecycleDecisionType;
  rationale: string;
  specVersion?: string | number | null;
  runId?: number | null;
  storyId?: string | null;
  gateId?: string | null;
  expiresAt?: string | null;
  evidenceGap?: string | null;
  subject?: { type: 'commit_sha' | 'artifact_digest'; value: string } | null;
  delegatedOnBehalfOf?: { principalId: string; displayLabel: string };
}

export interface LifecycleRetryScopeStory {
  storyId: string;
  reasonCode: string;
}

export interface LifecycleRetryPreviewPacket {
  schemaVersion: 'retry-preview.v1';
  originalRunId: number;
  scope: Record<'requested' | 'requiredDependency' | 'copiedPassed' | 'skipped' | 'executable' | 'remaining' | 'excluded', LifecycleRetryScopeStory[]>;
  options: {
    agent: 'claude' | 'opencode' | 'codex' | 'pi';
    model: string | null;
    effort: string | null;
    terminalMode: string;
    includeGraph: boolean;
    worktree: { enabled: boolean; path: string | null; branch: string | null };
    merge: { strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only'; autoMerge: boolean };
    safety: { deploy: boolean; externalSend: boolean; policyLocked: boolean; allowBackendJest: false };
  };
  forceSequential: boolean;
  requiresApproval: boolean;
  destructiveOperations: readonly ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'];
  previewHash: string;
}

export interface LifecycleRetryPreviewIdentity {
  schemaVersion: 'retry-preview-identity.v1';
  previewHash: string;
  originalRunId: number;
  expiresAt: string;
  signature: string;
}

export interface LifecycleRetryPreviewResponse {
  ok: true;
  preview: LifecycleRetryPreviewPacket;
  previewIdentity: LifecycleRetryPreviewIdentity;
  worktreePreflight: { classification: string; ok: boolean; detail?: string; remediation?: string } | null;
  passReconciliation?: Record<string, unknown> | null;
}

export interface LifecycleRetryDispatchResult {
  ok: true;
  queued: true;
  duplicate?: boolean;
  runId: number;
  originalRunId: number;
  previewHash: string;
  retriedStories?: Array<{ storyId: string; attempt: number }>;
  copiedStories?: string[];
}

export type LifecycleMutationResult = ({
  status: 'compiled' | 'skipped';
  specSlug: string;
  specVersion: string;
  specHash: string;
  inputHash: string;
  planId: string;
  planVersion: number;
  compilerVersion: string;
  profiles: string[];
  riskLevel: LifecycleRisk;
  generatedAt: string;
  saveGeneration: number | null;
} | {
  status: 'failed';
  specSlug: string;
  code: string;
  message: string;
  retryable: true;
}) & { replayed: boolean };

export interface LifecycleQueryState<T> {
  data: T | null;
  snapshotId: string | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  partial: boolean;
  error: Error | null;
}

export interface LifecycleSavedView {
  id: string;
  name: string;
  filters: LifecyclePortfolioFilters;
  display: { compact: boolean; limit: number };
  updatedAt: string;
}

export interface LifecycleSavedViewsEnvelope {
  version: 2;
  views: LifecycleSavedView[];
}


export type SoftwareQualificationCategory =
  | 'lint' | 'typecheck' | 'unit' | 'integration' | 'e2e'
  | 'performance' | 'security' | 'build' | 'package' | 'smoke';

export interface QualificationCheckPlan {
  id: string;
  category: SoftwareQualificationCategory;
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  discoveredFrom: string[];
  timeoutMs: number;
}

export interface PreStagingQualificationPreview {
  schemaVersion: 'rorca.pre-staging-qualification-preview.v1';
  workspaceId: string;
  specId: string;
  title: string;
  specRevisionHash: string;
  compiledPlanId: string | null;
  planId: string | null;
  policyVersion: string | null;
  compilerVersion: string | null;
  headSha: string;
  cleanHead: boolean;
  runId: number | null;
  checks: QualificationCheckPlan[];
  availableCategories: SoftwareQualificationCategory[];
  unavailableCategories: SoftwareQualificationCategory[];
  requiredCategories: SoftwareQualificationCategory[];
  missingRequiredCategories: SoftwareQualificationCategory[];
  preconditions: { canExecute: boolean; blockers: string[] };
  authority: { stagingAuthorityGranted: false; rationale: string };
  previewHash: string;
  observedAt: string;
}

export interface QualificationCheckResult extends QualificationCheckPlan {
  status: 'passed' | 'failed';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutHash: string;
  stderrHash: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface PreStagingQualificationReceipt {
  schemaVersion: 'rorca.pre-staging-qualification-receipt.v1';
  id: string;
  workspaceId: string;
  specId: string;
  specRevisionHash: string;
  compiledPlanId: string | null;
  runId: number | null;
  headSha: string;
  /** Exact immutable preview persisted with the receipt; null only for legacy rows. */
  previewHash: string | null;
  status: 'passed' | 'failed' | 'blocked';
  mechanisms: QualificationCheckPlan[];
  checkResults: QualificationCheckResult[];
  evidenceIds: string[];
  readiness: {
    allDiscoveredChecksPassed?: boolean;
    missingRequiredCategories?: SoftwareQualificationCategory[];
    evidenceEmittedGateIds?: string[];
    pendingGovernedGateIds?: string[];
    stagingAuthorityGranted?: false;
    rationale?: string;
  };
  receiptHash: string;
  createdBy: string;
  createdAt: string;
  replayed: boolean;
}