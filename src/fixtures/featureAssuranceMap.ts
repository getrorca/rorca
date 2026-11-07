/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type {
  DevelopmentAssuranceCheck,
  FeatureAssuranceIdentity,
  FeatureAssuranceMapInput,
} from '../types/feature-assurance-map';

const CURRENT: FeatureAssuranceIdentity = { revision: 'spec-rev-7', planId: 'plan-feature-7', planVersion: 3 };
const STALE: FeatureAssuranceIdentity = { revision: 'spec-rev-6', planId: 'plan-feature-6', planVersion: 2 };

function row<T extends { identity: FeatureAssuranceIdentity }>(value: T, source = CURRENT): T & { sourceIdentity: FeatureAssuranceIdentity } {
  return { ...value, sourceIdentity: source };
}

export function completeFeatureAssuranceFixture(): FeatureAssuranceMapInput {
  return {
    feature: { id: 'feature-assurance', title: 'Feature assurance map', identity: CURRENT },
    requirements: [row({ id: 'REQ-001', text: 'Every assurance relationship is inspectable.', identity: CURRENT, acceptanceCriterionIds: ['AC-001'], controlIds: ['CTRL-001'] })],
    acceptanceCriteria: [row({ id: 'AC-001', text: 'A reviewer can navigate the complete chain.', requirementId: 'REQ-001', storyIds: ['STORY-001'], identity: CURRENT })],
    stories: [row({ id: 'STORY-001', title: 'Render the assurance chain', acceptanceCriterionIds: ['AC-001'], controlIds: ['CTRL-001'], workPackageId: 'WP-001', identity: CURRENT })],
    controls: [row({ id: 'CTRL-001', title: 'Traceability control', evidenceRequirementIds: ['EVIDENCE-001'], identity: CURRENT })],
    evidence: [
      row({ id: 'EVIDENCE-NARRATIVE', source: 'generated_narrative', sourceSystem: 'planner', observedAt: '2026-08-18T10:00:00.000Z', binding: { requirementId: 'REQ-001', acceptanceCriterionId: 'AC-001', storyId: 'STORY-001', controlId: 'CTRL-001', workPackageId: 'WP-001', evidenceRequirementIds: ['EVIDENCE-001'] }, trustLevel: 'agent_proposed', lineageVerified: false, outcome: 'passed', identity: CURRENT }),
      row({ id: 'EVIDENCE-HOST', source: 'host_observed', sourceSystem: 'vitest', observedAt: '2026-08-18T10:05:00.000Z', binding: { requirementId: 'REQ-001', acceptanceCriterionId: 'AC-001', storyId: 'STORY-001', controlId: 'CTRL-001', workPackageId: 'WP-001', evidenceRequirementIds: ['EVIDENCE-001'] }, trustLevel: 'host_observed', lineageVerified: true, outcome: 'passed', identity: CURRENT }),
    ],
    decisions: [row({ id: 'DECISION-001', source: 'reviewer', decisionType: 'release_approval', createdAt: '2026-08-18T10:10:00.000Z', binding: { requirementId: 'REQ-001', acceptanceCriterionId: 'AC-001', storyId: 'STORY-001', controlId: 'CTRL-001', workPackageId: 'WP-001' }, outcome: 'approved', identity: CURRENT })],
    workPackages: [row({ id: 'WP-001', storyId: 'STORY-001', facts: [{ label: 'run', value: '42' }, { label: 'allowed paths', value: 'src/feature-assurance-map.ts' }], identity: CURRENT })],
  };
}

export function missingLinkFeatureAssuranceFixture(): FeatureAssuranceMapInput {
  const fixture = completeFeatureAssuranceFixture();
  return {
    ...fixture,
    // Keep both provenance sources visible while removing the decision and
    // work-package links. The projector must show their sources and report
    // the missing relationships instead of inferring a pass.
    decisions: [],
    workPackages: [],
  };
}

export function staleFeatureAssuranceFixture(): FeatureAssuranceMapInput {
  const fixture = completeFeatureAssuranceFixture();
  return {
    ...fixture,
    stories: [row({ ...fixture.stories[0], identity: STALE }, CURRENT)],
  };
}

export function mismatchedPlanIdentityFeatureAssuranceFixture(): FeatureAssuranceMapInput {
  const fixture = completeFeatureAssuranceFixture();
  return {
    ...fixture,
    decisions: [row({
      ...fixture.decisions[0],
      identity: { ...CURRENT, planId: 'plan-feature-old' },
    }, CURRENT)],
  };
}

export function mismatchedFeatureAssuranceFixture(): FeatureAssuranceMapInput {
  const fixture = completeFeatureAssuranceFixture();
  return {
    ...fixture,
    evidence: [row({ ...fixture.evidence[1], id: 'EVIDENCE-WRONG-STORY', binding: { ...fixture.evidence[1].binding, storyId: 'STORY-OTHER' } }, CURRENT)],
    decisions: [],
  };
}

export function developmentAssuranceFeatureFixture(): FeatureAssuranceMapInput {
  const required: DevelopmentAssuranceCheck = {
    checkId: 'DAC-required', checkKind: 'requirement-implementation', selection: 'selected',
    disposition: 'required', state: 'pending',
    requirement: { requirementId: 'REQ-001', text: 'Every assurance relationship is inspectable.' },
    change: { changeId: 'change-map', path: 'src/components/FeatureAssuranceMap.tsx', kind: 'modified' },
    componentOrBoundary: 'feature-assurance-ui',
    expectedEvidence: [{
      evidenceRequirementId: 'EVIDENCE-001', gateId: 'gate-development', kind: 'change_review',
      description: 'Review the exact Feature Assurance Map change.', minimumTrustLevel: 'verified',
    }],
    riskId: null, architectureDecisionId: null,
    rationale: 'The UI change must preserve the inspectable requirement chain.',
    reasonCodes: ['evidence-pending'],
  };
  const excluded: DevelopmentAssuranceCheck = {
    checkId: 'DAC-excluded', checkKind: 'risk-mitigation', selection: 'excluded',
    disposition: 'not_applicable', state: 'not_applicable',
    requirement: null, change: null, componentOrBoundary: 'billing-api', expectedEvidence: [],
    riskId: 'RISK-BILLING', architectureDecisionId: null,
    rationale: 'Billing risk does not apply to the bound Feature Assurance Map change.',
    reasonCodes: ['check-not-applicable'],
  };
  const unresolved: DevelopmentAssuranceCheck = {
    checkId: 'DAC-unresolved', checkKind: 'architecture-conformance', selection: 'selected',
    disposition: 'unresolved', state: 'unresolved',
    requirement: { requirementId: 'REQ-001', text: 'Every assurance relationship is inspectable.' },
    change: { changeId: 'change-map', path: 'src/components/FeatureAssuranceMap.tsx', kind: 'boundary' },
    componentOrBoundary: 'feature-assurance-api', expectedEvidence: [],
    riskId: null, architectureDecisionId: null,
    rationale: 'The changed API boundary has no bound architecture decision.',
    reasonCodes: ['architecture-decision-unresolved'],
  };
  const blocked: DevelopmentAssuranceCheck = {
    checkId: 'DAC-blocked', checkKind: 'scope-conformance', selection: 'selected',
    disposition: 'blocked', state: 'blocked',
    requirement: null, change: null, componentOrBoundary: 'WP-001', expectedEvidence: [],
    riskId: null, architectureDecisionId: null,
    rationale: 'The changed path differs from the exact work-package scope.',
    reasonCodes: ['scope-drift'],
  };
  const checks = [required, excluded, unresolved, blocked];
  return {
    ...completeFeatureAssuranceFixture(),
    developmentAssurance: {
      compilerVersion: 'development-assurance.v1',
      obligationSetId: 'development-assurance:fixture',
      obligationSetHash: `sha256:${'a'.repeat(64)}`,
      binding: {
        featureId: 'feature-assurance', revision: 'spec-rev-7', candidateId: 'candidate-map',
        planId: 'plan-feature-7', planVersion: 3, workPackageId: 'WP-001', workPackageRevision: 1,
        workPackageHash: `sha256:${'b'.repeat(64)}`, scopeIdentity: `sha256:${'c'.repeat(64)}`,
      },
      obligations: [required, unresolved, blocked],
      excludedChecks: [excluded],
      checks,
      summary: { required: 1, notApplicable: 1, unresolved: 1, blocked: 1, readyForEvidence: false },
    },
  };
}

export function reviewTrustStatesFeatureAssuranceFixture(): FeatureAssuranceMapInput {
  const subjectId = `sha256:${'d'.repeat(64)}`;
  const currentSource = [{ path: 'src/components/FeatureAssuranceMap.tsx', startLine: 177, endLine: 288 }];
  const independentReviewer = {
    reviewerId: 'agent:standards',
    reviewerKind: 'agent' as const,
    executionId: 'review-execution:standards:17',
    model: 'openai-codex/gpt-5.6-sol',
  };
  const selfReviewer = {
    reviewerId: 'agent:implementer',
    reviewerKind: 'agent' as const,
    executionId: 'review-execution:self:17',
  };
  const staleReviewer = {
    reviewerId: 'agent:red-team',
    reviewerKind: 'agent' as const,
    executionId: 'review-execution:stale:16',
  };
  return {
    ...completeFeatureAssuranceFixture(),
    reviewView: {
      subjectId,
      independentReviewRequired: true,
      requiredAxes: ['standards', 'design', 'adversarial'],
      evidenceState: 'insufficient_evidence',
      reason: 'Independent review evidence is unavailable for required axes: adversarial, design.',
      trustStateCounts: {
        independent: 1,
        'self-review': 1,
        'stale-review': 1,
        'unattributed-review': 0,
      },
      axes: [
        {
          axis: 'standards',
          required: true,
          evidenceState: 'available',
          independentReviewCount: 1,
          reviews: [{
            reviewId: 'review:standards:17',
            axis: 'standards',
            subjectId,
            submittedSubjectId: subjectId,
            subjectMatches: true,
            reviewedSourceLocations: currentSource,
            startedAt: '2026-08-19T14:57:00.000Z',
            completedAt: '2026-08-19T14:58:00.000Z',
            freshness: 'current',
            trustState: 'independent',
            reviewer: independentReviewer,
            findings: [{
              findingId: `sha256:${'e'.repeat(64)}`,
              axis: 'standards',
              subjectId,
              detection: 'standards-nonconformance',
              title: 'Trust labels require explicit provenance',
              description: 'The review row must identify the reviewer and exact execution.',
              severity: 'medium',
              disposition: 'open',
              freshness: 'current',
              reviewer: independentReviewer,
              sourceLocations: [{ path: 'src/components/FeatureAssuranceMap.tsx', startLine: 177, endLine: 190 }],
            }],
            evidenceUsable: true,
            issues: [],
            evidencePurpose: 'inspection',
            authorization: 'none',
          }],
        },
        {
          axis: 'design',
          required: true,
          evidenceState: 'insufficient_evidence',
          independentReviewCount: 0,
          reviews: [{
            reviewId: 'review:design:self:17',
            axis: 'design',
            subjectId,
            submittedSubjectId: subjectId,
            subjectMatches: true,
            reviewedSourceLocations: currentSource,
            startedAt: '2026-08-19T14:57:00.000Z',
            completedAt: '2026-08-19T14:58:00.000Z',
            freshness: 'current',
            trustState: 'self-review',
            reviewer: selfReviewer,
            findings: [],
            evidenceUsable: true,
            issues: [],
            evidencePurpose: 'inspection',
            authorization: 'none',
          }],
        },
        {
          axis: 'adversarial',
          required: true,
          evidenceState: 'insufficient_evidence',
          independentReviewCount: 0,
          reviews: [{
            reviewId: 'review:adversarial:stale:16',
            axis: 'adversarial',
            subjectId,
            submittedSubjectId: `sha256:${'f'.repeat(64)}`,
            subjectMatches: false,
            reviewedSourceLocations: currentSource,
            startedAt: '2026-08-19T12:57:00.000Z',
            completedAt: '2026-08-19T12:58:00.000Z',
            freshness: 'stale',
            trustState: 'stale-review',
            reviewer: staleReviewer,
            findings: [{
              findingId: `sha256:${'a'.repeat(64)}`,
              axis: 'adversarial',
              subjectId,
              detection: 'stale-replay',
              title: 'stale-replay',
              description: 'Replayed review evidence belongs to another bounded subject.',
              severity: 'high',
              disposition: 'open',
              freshness: 'stale',
              reviewer: staleReviewer,
              sourceLocations: [{ path: 'src/components/FeatureAssuranceMap.tsx', startLine: 230, endLine: 250 }],
            }],
            evidenceUsable: false,
            issues: ['review does not bind the exact current subject.'],
            evidencePurpose: 'inspection',
            authorization: 'none',
          }],
        },
      ],
      readOnly: true,
      approvalIssued: false,
      authorization: 'none',
    },
  };
}
