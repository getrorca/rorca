/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeatureAssuranceMapInput } from '../feature-assurance-map';
import { compileDevelopmentAssurance } from '../development-assurance-compiler';
import { deriveRequirementReference, type LifecyclePlan } from '../ssdlc-contracts';

const storyId = 'AFM-001';
const criterionText = 'The assurance chain is visible for the selected feature.';
const requirementId = deriveRequirementReference(storyId, criterionText);
const currentIdentity = { revision: 'spec-rev-7', planId: 'plan-feature-7', planVersion: 3 };
const plan = {
  planId: currentIdentity.planId,
  planVersion: currentIdentity.planVersion,
  requirementReferences: [requirementId],
  requirementMappings: [{
    requirementReference: requirementId,
    targetReferences: [{ type: 'story', reference: storyId }],
    gateIds: ['gate-assurance'],
    evidenceRequirementIds: ['evidence-assurance'],
  }],
  gates: [{
    gateId: 'gate-assurance',
    title: 'Feature assurance traceability',
    evidenceRequirementIds: ['evidence-assurance'],
  }],
} as LifecyclePlan;

const evidenceRow = {
  id: 'evidence-host-1',
  source_type: 'host_observed',
  source_system: 'vitest',
  source_idempotency_key: 'validation:feature-assurance',
  spec_version: currentIdentity.revision,
  revision: currentIdentity.revision,
  compiled_plan_id: 'compiled-plan-db-7',
  story_id: storyId,
  gate_id: 'gate-assurance',
  observed_at: '2026-08-18T10:05:00.000Z',
  evidence_status: 'passed',
  trust_level: 'host_observed',
  subject_type: 'commit_sha',
  subject_value: 'abc123',
  revision_mismatch: false,
  lineage_verified: true,
  metadata: {
    details: {
      requirementReference: requirementId,
      acceptanceCriterionId: requirementId,
      storyId,
      controlId: 'ASSURANCE',
      workPackageId: 'WP-AFM-001',
      specRevision: currentIdentity.revision,
      planId: currentIdentity.planId,
      planVersion: currentIdentity.planVersion,
      evidenceRequirementIds: ['evidence-assurance'],
      gateId: 'gate-assurance',
    },
  },
};

const decisionRow = {
  id: 'decision-1',
  decision_type: 'release_approval',
  spec_version: currentIdentity.revision,
  created_at: '2026-08-18T10:10:00.000Z',
  gate_id: 'gate-assurance',
  story_id: storyId,
  rationale: 'Host-observed evidence satisfies the control.',
  revoked_at: null,
  compiled_plan_id: 'compiled-plan-db-7',
  plan_id: currentIdentity.planId,
};

const content = {
  userStories: [{
    id: storyId,
    title: 'Project the feature assurance map',
    acceptanceCriteria: [criterionText],
    workPackageId: 'WP-AFM-001',
    workPackage: { runId: 42, branch: 'feature/assurance-map' },
  }],
};

test('projects lifecycle plan rows with exact provenance, bindings, work-package facts, and stale identities', () => {
  const developmentAssurance = compileDevelopmentAssurance({
    feature: { featureId: 'feature-assurance-map', revision: currentIdentity.revision },
    candidate: null,
    lifecyclePlan: null,
  });
  const complete = buildFeatureAssuranceMapInput({
    specId: 'feature-assurance-map',
    title: 'Feature Assurance Map',
    specRevision: currentIdentity.revision,
    compiledPlanId: 'compiled-plan-db-7',
    plan,
    content,
    evidenceRows: [evidenceRow],
    decisionRows: [decisionRow],
    developmentAssurance,
  });
  assert.strictEqual(complete.developmentAssurance, developmentAssurance);

  assert.equal(complete.requirements[0]?.id, requirementId);
  assert.equal(complete.acceptanceCriteria[0]?.id, requirementId);
  assert.deepEqual(complete.stories[0]?.controlIds, ['ASSURANCE']);
  assert.deepEqual(complete.evidence[0], {
    id: 'evidence-host-1',
    source: 'host_observed',
    sourceSystem: 'vitest',
    observedAt: '2026-08-18T10:05:00.000Z',
    binding: {
      requirementId,
      acceptanceCriterionId: requirementId,
      storyId,
      controlId: 'ASSURANCE',
      workPackageId: 'WP-AFM-001',
      evidenceRequirementIds: ['evidence-assurance'],
      subject: { type: 'commit_sha', value: 'abc123' },
    },
    trustLevel: 'host_observed',
    lineageVerified: true,
    outcome: 'passed',
    identity: currentIdentity,
    sourceIdentity: currentIdentity,
    detail: 'validation:feature-assurance',
  });
  assert.deepEqual(complete.decisions[0]?.binding, {
    requirementId,
    acceptanceCriterionId: requirementId,
    storyId,
    controlId: 'ASSURANCE',
    workPackageId: 'WP-AFM-001',
  });
  assert.deepEqual(complete.workPackages[0]?.facts, [
    { label: 'runId', value: '42' },
    { label: 'branch', value: 'feature/assurance-map' },
  ]);

  const stale = buildFeatureAssuranceMapInput({
    specId: 'feature-assurance-map',
    title: 'Feature Assurance Map',
    specRevision: currentIdentity.revision,
    compiledPlanId: 'compiled-plan-db-7',
    plan,
    content,
    evidenceRows: [{
      ...evidenceRow,
      spec_version: 'spec-rev-6',
      revision: 'spec-rev-6',
      compiled_plan_id: 'compiled-plan-db-6',
      revision_mismatch: true,
      metadata: { details: { ...evidenceRow.metadata.details, specRevision: 'spec-rev-6' } },
    }],
    decisionRows: [{ ...decisionRow, spec_version: 'spec-rev-6', compiled_plan_id: 'compiled-plan-db-6' }],
  });

  assert.deepEqual(stale.evidence[0]?.identity, {
    revision: 'spec-rev-6',
    planId: 'compiled-plan:compiled-plan-db-6',
    planVersion: currentIdentity.planVersion,
  });
  assert.deepEqual(stale.evidence[0]?.sourceIdentity, currentIdentity);
  assert.deepEqual(stale.decisions[0]?.identity, {
    revision: 'spec-rev-6',
    planId: 'compiled-plan:compiled-plan-db-6',
    planVersion: null,
  });
  assert.deepEqual(stale.decisions[0]?.sourceIdentity, currentIdentity);
  const planVersionStale = buildFeatureAssuranceMapInput({
    specId: 'feature-assurance-map',
    title: 'Feature Assurance Map',
    specRevision: currentIdentity.revision,
    compiledPlanId: 'compiled-plan-db-7',
    plan,
    content,
    evidenceRows: [{
      ...evidenceRow,
      metadata: {
        details: {
          ...evidenceRow.metadata.details,
          planVersion: currentIdentity.planVersion - 1,
        },
      },
    }],
    decisionRows: [decisionRow],
  });

  assert.deepEqual(planVersionStale.evidence[0]?.identity, {
    revision: currentIdentity.revision,
    planId: currentIdentity.planId,
    planVersion: currentIdentity.planVersion - 1,
  });
  assert.deepEqual(planVersionStale.evidence[0]?.sourceIdentity, currentIdentity);

});

test('keeps persisted story and gate columns authoritative over conflicting metadata', () => {
  const projected = buildFeatureAssuranceMapInput({
    specId: 'feature-assurance-map',
    title: 'Feature Assurance Map',
    specRevision: currentIdentity.revision,
    compiledPlanId: 'compiled-plan-db-7',
    plan,
    content,
    evidenceRows: [{
      ...evidenceRow,
      story_id: 'STORY-OTHER',
      gate_id: 'gate-other',
      metadata: {
        details: {
          ...evidenceRow.metadata.details,
          storyId,
          gateId: 'gate-assurance',
        },
      },
    }],
    decisionRows: [],
  });

  assert.equal(projected.evidence[0]?.binding.storyId, 'STORY-OTHER');
  assert.equal(projected.evidence[0]?.binding.controlId, 'OTHER');
});

test('resolves canonical metadata aliases when persisted row columns are absent', () => {
  const ambiguousPlan = {
    ...plan,
    requirementReferences: [requirementId, 'REQ-OTHER'],
    requirementMappings: [
      ...plan.requirementMappings,
      {
        requirementReference: 'REQ-OTHER',
        targetReferences: [{ type: 'story', reference: 'OTHER-STORY' }],
        gateIds: ['gate-other'],
        evidenceRequirementIds: ['evidence-other'],
      },
    ],
    gates: [
      ...plan.gates,
      { gateId: 'gate-other', title: 'Other control', evidenceRequirementIds: ['evidence-other'] },
    ],
  } as LifecyclePlan;
  const projected = buildFeatureAssuranceMapInput({
    specId: 'feature-assurance-map',
    title: 'Feature Assurance Map',
    specRevision: currentIdentity.revision,
    compiledPlanId: 'compiled-plan-db-7',
    plan: ambiguousPlan,
    content,
    evidenceRows: [{
      ...evidenceRow,
      story_id: null,
      gate_id: null,
      metadata: {
        details: {
          requirementId,
          acceptanceCriterionReference: requirementId,
          storyId,
          controlId: 'ASSURANCE',
          workPackageId: 'WP-AFM-001',
          evidenceRequirementIds: ['evidence-assurance'],
        },
      },
    }],
    decisionRows: [],
  });

  assert.deepEqual(projected.evidence[0]?.binding, {
    requirementId,
    acceptanceCriterionId: requirementId,
    storyId,
    controlId: 'ASSURANCE',
    workPackageId: 'WP-AFM-001',
    evidenceRequirementIds: ['evidence-assurance'],
    subject: { type: 'commit_sha', value: 'abc123' },
  });
});

