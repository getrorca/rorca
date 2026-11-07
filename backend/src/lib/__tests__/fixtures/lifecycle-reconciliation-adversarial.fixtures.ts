/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const EXACT_RECONCILIATION_SPEC_ID = 'exact-reconciliation-spec';

/** More than the portfolio bound, deliberately ordered around the exact slug. */
export const UNRELATED_RECONCILIATION_SPEC_IDS = Array.from(
  { length: 620 },
  (_, index) => `unrelated-${String(index).padStart(4, '0')}`,
);

export const EXACT_RECONCILIATION_SPEC = {
  title: 'Exact reconciliation subject',
  assurance: { override: 'current-exact-subject' },
  userStories: [{
    id: 'EXACT-001',
    title: 'Reconcile one exact subject',
    description: 'Ignore unrelated workspace candidates and contradictory historical evidence.',
    acceptanceCriteria: ['Only exact current immutable evidence can authorize.'],
    dependsOn: [],
    passes: false,
  }],
};

export const CONTRADICTORY_RECONCILIATION_SPEC = {
  ...EXACT_RECONCILIATION_SPEC,
  assurance: { override: 'contradictory-legacy-subject' },
};

export const ADVERSARIAL_LIFECYCLE_EVIDENCE = [
  {
    id: '9004',
    phase_subject_type: 'commit_sha',
    phase_subject_value: 'current-failed-commit',
    release_identity: { commitSha: 'current-failed-commit' },
    source_type: 'github_check',
    source_system: 'github-pr-delivery',
    evidence_status: 'failed',
    subject_type: 'commit_sha',
    subject_value: 'current-failed-commit',
    revision_mismatch: false,
    trust_level: 'provider_verified',
    lineage_verified: true,
  },
  {
    id: '9003',
    phase_subject_type: 'commit_sha',
    phase_subject_value: 'superseded-passed-commit',
    release_identity: { commitSha: 'superseded-passed-commit' },
    source_type: 'github_check',
    source_system: 'github-pr-delivery',
    evidence_status: 'passed',
    subject_type: 'commit_sha',
    subject_value: 'superseded-passed-commit',
    revision_mismatch: false,
    trust_level: 'provider_verified',
    lineage_verified: true,
  },
  {
    id: '9002',
    phase_subject_type: 'commit_sha',
    phase_subject_value: 'stale-passed-commit',
    release_identity: { commitSha: 'stale-passed-commit' },
    source_type: 'github_check',
    source_system: 'github-pr-delivery',
    evidence_status: 'passed',
    subject_type: 'commit_sha',
    subject_value: 'stale-passed-commit',
    revision_mismatch: true,
    trust_level: 'provider_verified',
    lineage_verified: true,
  },
  {
    id: '9001',
    phase_subject_type: 'commit_sha',
    phase_subject_value: 'untrusted-passed-commit',
    release_identity: { commitSha: 'untrusted-passed-commit' },
    source_type: 'unknown_legacy_source',
    source_system: 'malformed-loader-fixture',
    evidence_status: 'passed',
    subject_type: 'commit_sha',
    subject_value: 'untrusted-passed-commit',
    revision_mismatch: false,
    trust_level: 'agent_proposed',
    lineage_verified: false,
  },
  {
    id: '9000',
    phase_subject_type: 'commit_sha',
    phase_subject_value: 'superseded-passed-commit',
    release_identity: { commitSha: 'superseded-passed-commit' },
    source_type: 'github_check',
    source_system: 'github-pr-delivery',
    evidence_status: 'passed',
    subject_type: 'commit_sha',
    subject_value: 'superseded-passed-commit',
    revision_mismatch: false,
    trust_level: 'provider_verified',
    lineage_verified: true,
  },
] as const;
