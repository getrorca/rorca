/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const FEATURE_ASSURANCE_STATUSES = [
  'verified', 'pending', 'stale', 'blocked', 'unavailable',
] as const;

export type FeatureAssuranceStatus = typeof FEATURE_ASSURANCE_STATUSES[number];

export interface FeatureAssuranceIdentity {
  revision: string | null;
  planId: string | null;
  planVersion: number | null;
}

export interface FeatureAssuranceIdentityState {
  row: FeatureAssuranceIdentity | null;
  source: FeatureAssuranceIdentity | null;
  status: 'current' | 'stale' | 'unavailable';
}

export interface FeatureAssuranceFeature {
  id: string;
  title: string;
  identity: FeatureAssuranceIdentity;
}

export interface FeatureAssuranceRequirement {
  id: string;
  text: string;
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
  acceptanceCriterionIds: string[];
  controlIds: string[];
}

export interface FeatureAssuranceAcceptanceCriterion {
  id: string;
  text: string;
  requirementId: string;
  storyIds: string[];
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
}

export interface FeatureAssuranceStory {
  id: string;
  title: string;
  acceptanceCriterionIds: string[];
  controlIds: string[];
  workPackageId?: string | null;
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
}

export interface FeatureAssuranceControl {
  id: string;
  title: string;
  evidenceRequirementIds: string[];
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
}

export interface FeatureAssuranceEvidenceBinding {
  requirementId?: string | null;
  acceptanceCriterionId?: string | null;
  storyId?: string | null;
  controlId?: string | null;
  workPackageId?: string | null;
  evidenceRequirementIds?: string[];
  subject?: { type: string; value: string } | null;
}

export interface FeatureAssuranceEvidence {
  id: string;
  source: string;
  sourceSystem: string;
  observedAt: string | null;
  binding: FeatureAssuranceEvidenceBinding;
  trustLevel: string;
  lineageVerified?: boolean;
  outcome: 'passed' | 'failed' | 'pending' | 'unknown';
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
  detail?: string | null;
}

export interface FeatureAssuranceDecision {
  id: string;
  source: string;
  decisionType: string;
  createdAt: string | null;
  binding: FeatureAssuranceEvidenceBinding;
  outcome: 'approved' | 'revoked' | 'pending' | 'unknown';
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
  rationale?: string | null;
}

export interface FeatureAssuranceWorkPackage {
  id: string;
  storyId: string;
  facts: Array<{ label: string; value: string }>;
  identity: FeatureAssuranceIdentity;
  sourceIdentity?: FeatureAssuranceIdentity | null;
}
export type DevelopmentAssuranceDisposition = 'required' | 'not_applicable' | 'unresolved' | 'blocked';
export type DevelopmentAssuranceState = 'pending' | 'not_applicable' | 'unresolved' | 'blocked';

export interface DevelopmentAssuranceExpectedEvidence {
  evidenceRequirementId: string;
  gateId: string;
  kind: string;
  description: string;
  minimumTrustLevel: string;
}

export interface DevelopmentAssuranceCheck {
  checkId: string;
  checkKind: 'scope-conformance' | 'requirement-implementation' | 'risk-mitigation' | 'architecture-conformance' | 'boundary-contract' | 'deletion-regression';
  selection: 'selected' | 'excluded';
  disposition: DevelopmentAssuranceDisposition;
  state: DevelopmentAssuranceState;
  requirement: { requirementId: string; text: string } | null;
  change: { changeId: string; path: string; kind: 'added' | 'modified' | 'deleted' | 'boundary' } | null;
  componentOrBoundary: string | null;
  expectedEvidence: DevelopmentAssuranceExpectedEvidence[];
  riskId: string | null;
  architectureDecisionId: string | null;
  rationale: string;
  reasonCodes: string[];
}

export interface DevelopmentAssuranceCompilation {
  compilerVersion: 'development-assurance.v1';
  obligationSetId: string;
  obligationSetHash: string;
  binding: {
    featureId: string;
    revision: string;
    candidateId: string | null;
    planId: string | null;
    planVersion: number | null;
    workPackageId: string | null;
    workPackageRevision: number | null;
    workPackageHash: string | null;
    scopeIdentity: string | null;
  };
  obligations: DevelopmentAssuranceCheck[];
  excludedChecks: DevelopmentAssuranceCheck[];
  checks: DevelopmentAssuranceCheck[];
  summary: {
    required: number;
    notApplicable: number;
    unresolved: number;
    blocked: number;
    readyForEvidence: boolean;
  };
}
export type FeatureAssuranceReviewAxis = 'standards' | 'design' | 'adversarial';
export type FeatureAssuranceReviewTrustState = 'independent' | 'self-review' | 'stale-review' | 'unattributed-review';
export type FeatureAssuranceReviewFreshness = 'current' | 'stale' | 'unverifiable';

export interface FeatureAssuranceSourceLocation {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface FeatureAssuranceReviewerProvenance {
  reviewerId: string;
  reviewerKind: 'human' | 'agent';
  executionId: string;
  model?: string;
}

export interface FeatureAssuranceReviewFinding {
  findingId: string;
  axis: FeatureAssuranceReviewAxis;
  subjectId: string;
  detection: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  disposition: 'open' | 'resolved' | 'accepted-risk' | 'unresolved';
  freshness: FeatureAssuranceReviewFreshness;
  reviewer: FeatureAssuranceReviewerProvenance;
  sourceLocations: FeatureAssuranceSourceLocation[];
}

export interface FeatureAssuranceReviewEvidence {
  reviewId: string;
  axis: FeatureAssuranceReviewAxis;
  subjectId: string;
  submittedSubjectId: string;
  subjectMatches: boolean;
  reviewedSourceLocations: FeatureAssuranceSourceLocation[];
  startedAt: string;
  completedAt: string;
  freshness: FeatureAssuranceReviewFreshness;
  trustState: FeatureAssuranceReviewTrustState;
  reviewer: FeatureAssuranceReviewerProvenance;
  findings: FeatureAssuranceReviewFinding[];
  evidenceUsable: boolean;
  issues: string[];
  evidencePurpose: 'inspection';
  authorization: 'none';
}

export interface FeatureAssuranceReviewAxisView {
  axis: FeatureAssuranceReviewAxis;
  required: boolean;
  evidenceState: 'available' | 'insufficient_evidence';
  independentReviewCount: number;
  reviews: FeatureAssuranceReviewEvidence[];
}

export interface FeatureAssuranceReviewView {
  subjectId: string;
  independentReviewRequired: boolean;
  requiredAxes: FeatureAssuranceReviewAxis[];
  evidenceState: 'available' | 'insufficient_evidence';
  reason: string;
  axes: FeatureAssuranceReviewAxisView[];
  trustStateCounts: Record<FeatureAssuranceReviewTrustState, number>;
  readOnly: true;
  approvalIssued: false;
  authorization: 'none';
}


export interface FeatureAssuranceMapInput {
  feature: FeatureAssuranceFeature;
  requirements: FeatureAssuranceRequirement[];
  acceptanceCriteria: FeatureAssuranceAcceptanceCriterion[];
  stories: FeatureAssuranceStory[];
  controls: FeatureAssuranceControl[];
  evidence: FeatureAssuranceEvidence[];
  decisions: FeatureAssuranceDecision[];
  workPackages: FeatureAssuranceWorkPackage[];
  developmentAssurance?: DevelopmentAssuranceCompilation | null;
  reviewView?: FeatureAssuranceReviewView | null;
}

export interface FeatureAssuranceGap {
  kind: 'missing_link' | 'mismatched_binding' | 'stale_identity' | 'untrusted_evidence' | 'failed_evidence' | 'unavailable_source' | 'pending_decision';
  status: Exclude<FeatureAssuranceStatus, 'verified'>;
  message: string;
  relatedId?: string;
}

export interface FeatureAssuranceChainNode<T> {
  value: T | null;
  expectedId: string | null;
  identity: FeatureAssuranceIdentityState;
}

export interface FeatureAssuranceChain {
  key: string;
  requirement: FeatureAssuranceChainNode<FeatureAssuranceRequirement>;
  acceptanceCriterion: FeatureAssuranceChainNode<FeatureAssuranceAcceptanceCriterion>;
  story: FeatureAssuranceChainNode<FeatureAssuranceStory>;
  control: FeatureAssuranceChainNode<FeatureAssuranceControl>;
  evidence: FeatureAssuranceEvidence[];
  decisions: FeatureAssuranceDecision[];
  workPackage: FeatureAssuranceChainNode<FeatureAssuranceWorkPackage>;
  status: FeatureAssuranceStatus;
  gaps: FeatureAssuranceGap[];
}

export interface FeatureAssuranceMapProjection {
  feature: FeatureAssuranceFeature;
  chains: FeatureAssuranceChain[];
  unlinkedEvidence: FeatureAssuranceEvidence[];
  unlinkedDecisions: FeatureAssuranceDecision[];
  summary: Record<FeatureAssuranceStatus, number>;
  developmentAssurance: DevelopmentAssuranceCompilation | null;
  reviewView: FeatureAssuranceReviewView | null;
  readOnly: true;
}
