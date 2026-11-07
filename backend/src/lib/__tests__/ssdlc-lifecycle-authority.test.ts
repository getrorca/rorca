/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import {
  canSelectActiveReleaseIdentity,
  lifecycleEvidenceContractIdentity,
  selectActiveReleaseIdentities,
  type ReleaseIdentityPrecedenceEvidence,
} from '../ssdlc-lifecycle-read';
import { PhaseEvidenceSchema } from '../ssdlc-phase-evaluator';
import { ADVERSARIAL_LIFECYCLE_EVIDENCE } from './fixtures/lifecycle-reconciliation-adversarial.fixtures';

const authoritativeCommit = {
  source_type: 'story_commit',
  subject_type: 'commit_sha' as const,
  evidence_status: 'passed',
  trust_level: 'host_observed',
  revision_mismatch: false,
  lineage_verified: true,
};

describe('active lifecycle release identity authority', () => {
  test('failed, unknown, stale, manual, and agent-proposed observations cannot select release identity', () => {
    expect(canSelectActiveReleaseIdentity({ ...authoritativeCommit, evidence_status: 'unknown' })).toBe(false);
    expect(canSelectActiveReleaseIdentity({ ...authoritativeCommit, evidence_status: 'story_caused_failure' })).toBe(false);
    expect(canSelectActiveReleaseIdentity({ ...authoritativeCommit, revision_mismatch: true })).toBe(false);
    expect(canSelectActiveReleaseIdentity({ ...authoritativeCommit, trust_level: 'agent_proposed' })).toBe(false);
    expect(canSelectActiveReleaseIdentity({
      ...authoritativeCommit,
      source_type: 'manual_qa',
      trust_level: 'authenticated_manual',
      subject_type: 'artifact_digest',
    })).toBe(false);
  });

  test('accepts only source-appropriate host/provider identities with required lineage', () => {
    expect(canSelectActiveReleaseIdentity(authoritativeCommit)).toBe(true);
    expect(canSelectActiveReleaseIdentity({
      ...authoritativeCommit,
      source_type: 'staging_result',
      subject_type: 'artifact_digest',
      trust_level: 'provider_verified',
      lineage_verified: true,
    })).toBe(true);
    expect(canSelectActiveReleaseIdentity({
      ...authoritativeCommit,
      source_type: 'staging_result',
      subject_type: 'artifact_digest',
      trust_level: 'provider_verified',
      lineage_verified: false,
    })).toBe(false);
    expect(canSelectActiveReleaseIdentity({
      ...authoritativeCommit,
      source_type: 'deployment_proof',
      subject_type: 'deployment_id',
      trust_level: 'provider_verified',
      lineage_verified: true,
    })).toBe(true);
  });

  test('newest contradictory current evidence defeats stale, duplicate, malformed, and untrusted passes', () => {
    const selected = selectActiveReleaseIdentities(
      ADVERSARIAL_LIFECYCLE_EVIDENCE as unknown as ReleaseIdentityPrecedenceEvidence[],
    );

    expect(selected).toEqual({ subjects: {}, lineage: {} });
  });

  test('malformed legacy metadata cannot inherit current plan identity and authorize', () => {
    const projected = {
      evidenceId: 'legacy-malformed',
      gateId: 'gate-current',
      source: 'github_check:github-pr-delivery',
      collectedAt: '2026-08-17T00:00:00.000Z',
      subjectRevision: { type: 'spec_hash', value: `sha256:${'a'.repeat(64)}` },
      status: 'passed',
      classification: 'test_result',
      trustLevel: 'provider_verified',
      evidenceRequirementIds: [],
      dependencyReferences: [],
      ...lifecycleEvidenceContractIdentity({ details: { policyVersion: 42 } }),
    };

    expect(lifecycleEvidenceContractIdentity({ malformed: true })).toEqual({});
    expect(PhaseEvidenceSchema.safeParse(projected)).toMatchObject({ success: false });
  });

  test('rejects downstream evidence that contradicts the selected exact commit lineage', () => {
    const selected = selectActiveReleaseIdentities([
      {
        ...authoritativeCommit,
        subject_value: 'commit-current',
        phase_subject_type: 'commit_sha',
        phase_subject_value: 'commit-current',
        release_identity: { commitSha: 'commit-current' },
      },
      {
        ...authoritativeCommit,
        source_type: 'staging_result',
        subject_type: 'artifact_digest',
        subject_value: 'artifact-stale',
        phase_subject_type: 'artifact_digest',
        phase_subject_value: 'artifact-stale',
        trust_level: 'provider_verified',
        release_identity: { commitSha: 'commit-stale', artifactDigest: 'artifact-stale' },
      },
    ]);

    expect(selected).toEqual({
      subjects: { commit_sha: { type: 'commit_sha', value: 'commit-current' } },
      lineage: { commitSha: 'commit-current' },
    });
  });
});
