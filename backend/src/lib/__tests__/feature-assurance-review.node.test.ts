/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AssuranceCandidateIdentity } from '../assurance-candidate';
import {
  ADVERSARIAL_ASSURANCE_DETECTIONS,
  buildFeatureAssuranceReviewView,
  createFeatureAssuranceReviewSubject,
  recordFeatureAssuranceReview,
  runAdversarialFeatureAssuranceReview,
  type AdversarialAssuranceDetection,
  type AdversarialFeatureAssuranceReviewInput,
  type AdversarialReviewObservations,
  type FeatureAssuranceFindingDraft,
  type FeatureAssuranceReviewSubmission,
  type FeatureAssuranceReviewSubject,
  type FeatureAssuranceReviewerProvenance,
  type FeatureAssuranceSourceLocation,
} from '../feature-assurance-review';

const CURRENT_TIME = '2026-08-19T15:00:00.000Z';
const STARTED_AT = '2026-08-19T14:57:00.000Z';
const COMPLETED_AT = '2026-08-19T14:58:00.000Z';
const SOURCE: FeatureAssuranceSourceLocation = {
  path: 'backend/src/lib/feature-assurance-review.ts',
  startLine: 1,
  endLine: 700,
};
const TEST_SOURCE: FeatureAssuranceSourceLocation = {
  path: 'backend/src/lib/__tests__/feature-assurance-review.node.test.ts',
  startLine: 1,
  endLine: 500,
};
const STANDARD_LOCATION: FeatureAssuranceSourceLocation = { ...SOURCE, startLine: 20, endLine: 28 };
const DESIGN_LOCATION: FeatureAssuranceSourceLocation = { ...SOURCE, startLine: 430, endLine: 470 };
const INCIDENT_LOCATION: FeatureAssuranceSourceLocation = { ...TEST_SOURCE, startLine: 100, endLine: 130 };

const INDEPENDENT_REVIEWER: FeatureAssuranceReviewerProvenance = {
  reviewerId: 'agent:assurance-independent',
  reviewerKind: 'agent',
  executionId: 'review-execution:independent:17',
  model: 'openai-codex/gpt-5.6-sol',
};

function candidate(): AssuranceCandidateIdentity {
  return {
    specificationRevision: { specId: 'rorca-spec-aligned-feature-assurance-ssdlc', revision: 'revision:17' },
    plan: { planId: 'plan:feature-assurance', planVersion: 4 },
    commit: '0123456789abcdef0123456789abcdef01234567',
    tree: '1123456789abcdef0123456789abcdef01234567',
    diff: `sha256:${'b'.repeat(64)}`,
    scope: `sha256:${'c'.repeat(64)}`,
  };
}

function reviewSubject(): FeatureAssuranceReviewSubject {
  return createFeatureAssuranceReviewSubject({
    featureId: 'AFM-006',
    candidate: candidate(),
    workPackageId: 'work-package:AFM-006',
    workPackageRevision: 3,
    workPackageHash: `sha256:${'d'.repeat(64)}`,
    sourceLocations: [SOURCE, TEST_SOURCE],
    changedPaths: [SOURCE.path, TEST_SOURCE.path],
    requiredTestObligationIds: ['OBL:AFM-006:REVIEW-FIXTURES'],
    baselineAssertionIds: ['ASSERT:EXACT-SUBJECT', 'ASSERT:NO-SELF-APPROVAL'],
    requiredNegativeScenarioIds: ['NEG:WRONG-SUBJECT', 'NEG:STALE-REPLAY'],
  });
}


function submission(input: {
  reviewId: string;
  axis: 'standards' | 'design' | 'adversarial';
  reviewer?: FeatureAssuranceReviewerProvenance;
  completedAt?: string;
  subject?: FeatureAssuranceReviewSubject;
  findings?: readonly FeatureAssuranceFindingDraft[];
  reviewedSourceLocations?: readonly FeatureAssuranceSourceLocation[];
}): FeatureAssuranceReviewSubmission {
  const subject = input.subject ?? reviewSubject();
  return {
    reviewId: input.reviewId,
    axis: input.axis,
    subjectId: subject.subjectId,
    subject: subject.candidate,
    reviewer: input.reviewer ?? INDEPENDENT_REVIEWER,
    startedAt: STARTED_AT,
    completedAt: input.completedAt ?? COMPLETED_AT,
    reviewedSourceLocations: input.reviewedSourceLocations ?? subject.sourceLocations,
    findings: input.findings ?? [],
  };
}

function standardsAndDesignFixtures(subject: FeatureAssuranceReviewSubject): FeatureAssuranceReviewSubmission[] {
  return [
    submission({
      reviewId: 'review:standards:17',
      axis: 'standards',
      subject,
      reviewer: { ...INDEPENDENT_REVIEWER, reviewerId: 'agent:standards', executionId: 'review-execution:standards:17' },
      findings: [{
        detection: 'standards-nonconformance',
        title: 'Finding identifiers must remain deterministic',
        description: 'The draft contract did not state the deterministic finding identity invariant.',
        severity: 'medium',
        disposition: 'open',
        sourceLocations: [STANDARD_LOCATION],
      }],
    }),
    submission({
      reviewId: 'review:design:17',
      axis: 'design',
      subject,
      reviewer: { ...INDEPENDENT_REVIEWER, reviewerId: 'agent:design', executionId: 'review-execution:design:17' },
      findings: [{
        detection: 'design-risk',
        title: 'Trust and freshness need separate dimensions',
        description: 'A review can be independent at creation and stale at inspection time.',
        severity: 'high',
        disposition: 'unresolved',
        sourceLocations: [DESIGN_LOCATION],
      }],
    }),
  ];
}

function adversarialInput(
  detection: AdversarialAssuranceDetection,
  observations: AdversarialReviewObservations,
): AdversarialFeatureAssuranceReviewInput {
  return {
    reviewId: `review:adversarial:${detection}`,
    subject: reviewSubject(),
    reviewer: { ...INDEPENDENT_REVIEWER, reviewerId: 'agent:red-team', executionId: `review-execution:${detection}` },
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    observedAt: CURRENT_TIME,
    maximumEvidenceAgeSeconds: 600,
    requestedDetections: [detection],
    observations,
  };
}

function testObservation(overrides: Partial<NonNullable<AdversarialReviewObservations['testExecutions']>[number]> = {}) {
  const subject = reviewSubject();
  const rawOutput = JSON.stringify({ tests: 1, passed: 1 });
  return {
    recordId: 'test-execution:AFM-006',
    subjectId: subject.subjectId,
    obligationIds: [...subject.requiredTestObligationIds],
    rawOutput,
    outputDigest: `sha256:${createHash('sha256').update(rawOutput).digest('hex')}`,
    assertionIds: [...subject.baselineAssertionIds],
    negativeScenarioIds: [...subject.requiredNegativeScenarioIds],
    location: INCIDENT_LOCATION,
    ...overrides,
  };
}

const ADVERSARIAL_FIXTURES: Readonly<Record<AdversarialAssuranceDetection, AdversarialReviewObservations>> = {
  'story-pass-without-tests': {
    storyOutcome: { status: 'passed', location: INCIDENT_LOCATION },
    testExecutions: [],
  },
  'stale-replay': {
    replayedReview: { subjectId: 'sha256:replayed-other-subject', completedAt: '2026-08-19T12:00:00.000Z', location: INCIDENT_LOCATION },
  },
  'wrong-subject-evidence': {
    evidenceSubjects: [{ evidenceId: 'evidence:other-candidate', subjectId: 'sha256:other-subject', location: INCIDENT_LOCATION }],
  },
  'fake-output': {
    testExecutions: [testObservation({ outputDigest: `sha256:${'f'.repeat(64)}` })],
  },
  'weakened-assertions': {
    assertionInventory: {
      baselineAssertionIds: ['ASSERT:EXACT-SUBJECT', 'ASSERT:NO-SELF-APPROVAL'],
      currentAssertionIds: ['ASSERT:EXACT-SUBJECT'],
      location: INCIDENT_LOCATION,
    },
  },
  'missing-negative-coverage': {
    negativeCoverage: {
      requiredScenarioIds: ['NEG:WRONG-SUBJECT', 'NEG:STALE-REPLAY'],
      coveredScenarioIds: ['NEG:WRONG-SUBJECT'],
      location: INCIDENT_LOCATION,
    },
  },
  'scope-expansion': {
    observedScope: {
      changedPaths: [SOURCE.path, TEST_SOURCE.path, 'backend/src/routes/pipeline.ts'],
      manifestLocation: INCIDENT_LOCATION,
    },
  },
};

const REGRESSION_FIXTURES = [
  {
    incidentId: 'incident:zero-tests-green-story',
    expectedDetection: 'story-pass-without-tests' as const,
    observations: ADVERSARIAL_FIXTURES['story-pass-without-tests'],
  },
  {
    incidentId: 'incident:replayed-review-from-prior-revision',
    expectedDetection: 'stale-replay' as const,
    observations: ADVERSARIAL_FIXTURES['stale-replay'],
  },
  {
    incidentId: 'incident:assertion-count-preserved-semantics-removed',
    expectedDetection: 'weakened-assertions' as const,
    observations: ADVERSARIAL_FIXTURES['weakened-assertions'],
  },
  {
    incidentId: 'incident:evidence-substituted-from-other-candidate',
    expectedDetection: 'wrong-subject-evidence' as const,
    observations: ADVERSARIAL_FIXTURES['wrong-subject-evidence'],
  },
  {
    incidentId: 'incident:captured-output-digest-forged',
    expectedDetection: 'fake-output' as const,
    observations: ADVERSARIAL_FIXTURES['fake-output'],
  },
  {
    incidentId: 'incident:required-negative-case-removed',
    expectedDetection: 'missing-negative-coverage' as const,
    observations: ADVERSARIAL_FIXTURES['missing-negative-coverage'],
  },
  {
    incidentId: 'incident:changed-path-outside-work-package',
    expectedDetection: 'scope-expansion' as const,
    observations: ADVERSARIAL_FIXTURES['scope-expansion'],
  },
];

describe('independent Standards and Design review fixtures', () => {
  it('records independently attributable, bounded, exact-location findings without approval authority', () => {
    const subject = reviewSubject();
    const view = buildFeatureAssuranceReviewView({
      subject,
      implementerId: 'agent:implementer',
      observedAt: CURRENT_TIME,
      maximumEvidenceAgeSeconds: 600,
      independentReviewRequired: true,
      requiredAxes: ['standards', 'design'],
      submissions: standardsAndDesignFixtures(subject),
    });

    assert.equal(view.evidenceState, 'available');
    assert.equal(view.readOnly, true);
    assert.equal(view.approvalIssued, false);
    assert.equal(view.authorization, 'none');
    for (const axis of ['standards', 'design'] as const) {
      const axisView = view.axes.find((item) => item.axis === axis);
      assert.equal(axisView?.independentReviewCount, 1);
      assert.equal(axisView?.evidenceState, 'available');
      const review = axisView?.reviews[0];
      assert.equal(review?.trustState, 'independent');
      assert.equal(review?.freshness, 'current');
      assert.equal(review?.authorization, 'none');
      assert.equal(review?.findings.length, 1);
      assert.equal(review?.findings[0]?.axis, axis);
      assert.equal(review?.findings[0]?.subjectId, subject.subjectId);
      assert.equal(review?.findings[0]?.reviewer.reviewerId, review?.reviewer.reviewerId);
      assert.equal(review?.findings[0]?.freshness, 'current');
      assert.ok(review?.findings[0]?.sourceLocations.every((location) => subject.sourceLocations.some((bound) => location.path === bound.path)));
    }
  });

  it('rejects unbounded review locations from independent evidence satisfaction', () => {
    const subject = reviewSubject();
    const invalid = submission({
      reviewId: 'review:standards:out-of-scope',
      axis: 'standards',
      subject,
      reviewedSourceLocations: [{ path: 'backend/src/routes/pipeline.ts', startLine: 1, endLine: 2 }],
    });
    const record = recordFeatureAssuranceReview({
      subject,
      implementerId: 'agent:implementer',
      observedAt: CURRENT_TIME,
      maximumEvidenceAgeSeconds: 600,
      submission: invalid,
    });

    assert.equal(record.evidenceUsable, false);
    assert.ok(record.issues.includes('reviewed source location is outside the bounded subject.'));
  });

  it('rejects malformed finding fields at the runtime reviewer boundary', () => {
    const subject = reviewSubject();
    const baseFinding = {
      title: 'Malformed reviewer output',
      description: 'This draft must remain inspectable as invalid evidence.',
      severity: 'medium',
      disposition: 'open',
      sourceLocations: [STANDARD_LOCATION],
    } satisfies FeatureAssuranceFindingDraft;
    const invalid = submission({
      reviewId: 'review:standards:malformed-findings',
      axis: 'standards',
      subject,
      findings: [
        { ...baseFinding, detection: 'design-risk' },
        { ...baseFinding, detection: 'toString' },
        { ...baseFinding, detection: 'standards-nonconformance', severity: 'toString' },
        { ...baseFinding, detection: 'standards-nonconformance', disposition: '__proto__' },
      ] as unknown as FeatureAssuranceFindingDraft[],
    });
    const record = recordFeatureAssuranceReview({
      subject,
      implementerId: 'agent:implementer',
      observedAt: CURRENT_TIME,
      maximumEvidenceAgeSeconds: 600,
      submission: invalid,
    });

    assert.equal(record.evidenceUsable, false);
    assert.deepEqual(record.findings, []);
    assert.ok(record.issues.includes('finding "design-risk" is invalid for standards review.'));
    assert.ok(record.issues.includes('finding "toString" is invalid for standards review.'));
    assert.ok(record.issues.includes('finding "standards-nonconformance" has invalid severity "toString".'));
    assert.ok(record.issues.includes('finding "standards-nonconformance" has invalid disposition "__proto__".'));
  });
});

describe('adversarial assurance fixtures', () => {
  it('returns each named detection with current provenance and a bounded exact source location', () => {
    for (const detection of ADVERSARIAL_ASSURANCE_DETECTIONS) {
      const input = adversarialInput(detection, ADVERSARIAL_FIXTURES[detection]);
      const generated = runAdversarialFeatureAssuranceReview(input);
      const record = recordFeatureAssuranceReview({
        subject: input.subject,
        implementerId: 'agent:implementer',
        observedAt: input.observedAt,
        maximumEvidenceAgeSeconds: input.maximumEvidenceAgeSeconds,
        submission: generated,
      });

      assert.equal(record.evidenceUsable, true, `${detection}: ${record.issues.join(', ')}`);
      assert.equal(record.trustState, 'independent');
      assert.equal(record.findings.length, 1, detection);
      assert.equal(record.findings[0]?.detection, detection);
      assert.equal(record.findings[0]?.disposition, 'open');
      assert.equal(record.findings[0]?.freshness, 'current');
      assert.equal(record.findings[0]?.reviewer.reviewerId, 'agent:red-team');
      assert.deepEqual(record.findings[0]?.sourceLocations, [INCIDENT_LOCATION]);
    }
  });

  it('returns a bounded unresolved finding when a requested check has no inspectable observation', () => {
    const input = adversarialInput('fake-output', {});
    const record = recordFeatureAssuranceReview({
      subject: input.subject,
      implementerId: 'agent:implementer',
      observedAt: input.observedAt,
      maximumEvidenceAgeSeconds: input.maximumEvidenceAgeSeconds,
      submission: runAdversarialFeatureAssuranceReview(input),
    });

    assert.equal(record.findings[0]?.detection, 'fake-output');
    assert.equal(record.findings[0]?.disposition, 'unresolved');
    assert.deepEqual(record.findings[0]?.sourceLocations, [input.subject.sourceLocations[0]]);
  });
});

describe('review trust projection', () => {
  it('displays independent, self-review, and stale-review records as separate trust states', () => {
    const subject = reviewSubject();
    const records = [
      submission({ reviewId: 'review:independent', axis: 'standards', subject }),
      submission({
        reviewId: 'review:self',
        axis: 'design',
        subject,
        reviewer: { reviewerId: 'agent:implementer', reviewerKind: 'agent', executionId: 'review-execution:self' },
      }),
      submission({ reviewId: 'review:stale', axis: 'adversarial', subject, completedAt: '2026-08-19T12:00:00.000Z' }),
    ];
    const view = buildFeatureAssuranceReviewView({
      subject,
      implementerId: 'agent:implementer',
      observedAt: CURRENT_TIME,
      maximumEvidenceAgeSeconds: 600,
      independentReviewRequired: false,
      submissions: records,
    });

    assert.deepEqual(view.trustStateCounts, {
      independent: 1,
      'self-review': 1,
      'stale-review': 1,
      'unattributed-review': 0,
    });
    assert.deepEqual(view.axes.flatMap((axis) => axis.reviews.map((review) => review.trustState)), [
      'independent', 'self-review', 'stale-review',
    ]);
  });


  it('normalizes reviewer identities before deciding whether evidence is independent', () => {
    const subject = reviewSubject();
    const record = recordFeatureAssuranceReview({
      subject,
      implementerId: 'agent:implementer',
      observedAt: CURRENT_TIME,
      maximumEvidenceAgeSeconds: 600,
      submission: submission({
        reviewId: 'review:self-padded-identity',
        axis: 'standards',
        subject,
        reviewer: {
          reviewerId: ' agent:implementer ',
          reviewerKind: 'agent',
          executionId: 'review-execution:self-padded',
        },
      }),
    });

    assert.equal(record.trustState, 'self-review');
    assert.equal(record.evidenceUsable, true);
  });
  it('returns insufficient evidence when required independent review is unavailable', () => {
    const subject = reviewSubject();
    const view = buildFeatureAssuranceReviewView({
      subject,
      implementerId: 'agent:implementer',
      observedAt: CURRENT_TIME,
      maximumEvidenceAgeSeconds: 600,
      independentReviewRequired: true,
      requiredAxes: ['design', 'adversarial'],
      submissions: [
        submission({
          reviewId: 'review:self-design',
          axis: 'design',
          subject,
          reviewer: { reviewerId: 'agent:implementer', reviewerKind: 'agent', executionId: 'review-execution:self-design' },
        }),
        submission({ reviewId: 'review:stale-adversarial', axis: 'adversarial', subject, completedAt: '2026-08-19T12:00:00.000Z' }),
      ],
    });

    assert.equal(view.evidenceState, 'insufficient_evidence');
    assert.match(view.reason, /adversarial, design|design, adversarial/);
    assert.equal(view.axes.find((axis) => axis.axis === 'design')?.evidenceState, 'insufficient_evidence');
    assert.equal(view.axes.find((axis) => axis.axis === 'adversarial')?.evidenceState, 'insufficient_evidence');
    assert.equal(view.approvalIssued, false);
  });
});

describe('reproducible assurance incident regressions', () => {
  it('preserves the expected detection outcome for every incident fixture', () => {
    for (const fixture of REGRESSION_FIXTURES) {
      const result = runAdversarialFeatureAssuranceReview(adversarialInput(fixture.expectedDetection, fixture.observations));
      assert.equal(result.findings[0]?.detection, fixture.expectedDetection, fixture.incidentId);
      assert.equal(result.findings[0]?.disposition, 'open', fixture.incidentId);
    }
  });

  it('does not detect an incident when current evidence satisfies the bounded invariant', () => {
    const subject = reviewSubject();
    const complete = testObservation();
    const cases: Array<[AdversarialAssuranceDetection, AdversarialReviewObservations]> = [
      ['story-pass-without-tests', { storyOutcome: { status: 'passed', location: INCIDENT_LOCATION }, testExecutions: [complete] }],
      ['stale-replay', { replayedReview: { subjectId: subject.subjectId, completedAt: COMPLETED_AT, location: INCIDENT_LOCATION } }],
      ['wrong-subject-evidence', { evidenceSubjects: [{ evidenceId: 'evidence:current', subjectId: subject.subjectId, location: INCIDENT_LOCATION }] }],
      ['fake-output', { testExecutions: [complete] }],
      ['weakened-assertions', { assertionInventory: { baselineAssertionIds: subject.baselineAssertionIds, currentAssertionIds: subject.baselineAssertionIds, location: INCIDENT_LOCATION } }],
      ['missing-negative-coverage', { negativeCoverage: { requiredScenarioIds: subject.requiredNegativeScenarioIds, coveredScenarioIds: subject.requiredNegativeScenarioIds, location: INCIDENT_LOCATION } }],
      ['scope-expansion', { observedScope: { changedPaths: subject.changedPaths, manifestLocation: INCIDENT_LOCATION } }],
    ];

    for (const [detection, observations] of cases) {
      assert.deepEqual(runAdversarialFeatureAssuranceReview(adversarialInput(detection, observations)).findings, [], detection);
    }
  });
});
