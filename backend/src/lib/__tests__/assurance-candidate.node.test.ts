/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASSURANCE_CANDIDATE_IDENTITY_FIELDS,
  assuranceScopeIdentity,
  evaluateAssuranceScope,
  validateAssuranceCandidate,
  type AssuranceCandidateIdentity,
  type AssuranceCandidateIdentityField,
  type AssuranceCandidateInput,
  type AssuranceWorkPackageScope,
  type CandidateBoundSubjectRecord,
} from '../assurance-candidate';

function exactScope(): AssuranceWorkPackageScope {
  return {
    workPackageId: 'work-package:AFM-002',
    workPackageRevision: 3,
    workPackageHash: `sha256:${'a'.repeat(64)}`,
    changedPaths: [
      'backend/src/lib/assurance-candidate.ts',
      'backend/src/lib/__tests__/assurance-candidate.node.test.ts',
    ],
    requiredPaths: [
      'backend/src/lib/assurance-candidate.ts',
      'backend/src/lib/__tests__/assurance-candidate.node.test.ts',
    ],
    allowedPaths: ['backend/src/lib'],
    forbiddenPaths: ['backend/src/lib/private'],
  };
}

function exactIdentity(scope: AssuranceWorkPackageScope): AssuranceCandidateIdentity {
  return {
    specificationRevision: { specId: 'rorca-spec-aligned-feature-assurance-ssdlc', revision: 'revision:17' },
    plan: { planId: 'plan:feature-assurance', planVersion: 4 },
    commit: '0123456789abcdef0123456789abcdef01234567',
    tree: '1123456789abcdef0123456789abcdef01234567',
    diff: `sha256:${'b'.repeat(64)}`,
    scope: assuranceScopeIdentity(scope),
  };
}

function boundRecord(recordId: string, identity: AssuranceCandidateIdentity): CandidateBoundSubjectRecord {
  return {
    recordId,
    subject: {
      ...identity,
      specificationRevision: { ...identity.specificationRevision },
      plan: { ...identity.plan },
    },
  };
}
function identityWithMismatch(
  field: AssuranceCandidateIdentityField,
  identity: AssuranceCandidateIdentity,
): AssuranceCandidateIdentity {
  switch (field) {
    case 'specificationRevision':
      return {
        ...identity,
        specificationRevision: { ...identity.specificationRevision, revision: 'revision:wrong' },
      };
    case 'plan':
      return { ...identity, plan: { ...identity.plan, planVersion: identity.plan.planVersion + 1 } };
    case 'commit':
      return { ...identity, commit: 'f123456789abcdef0123456789abcdef01234567' };
    case 'tree':
      return { ...identity, tree: 'f123456789abcdef0123456789abcdef01234567' };
    case 'diff':
      return { ...identity, diff: `sha256:${'f'.repeat(64)}` };
    case 'scope':
      return { ...identity, scope: `sha256:${'f'.repeat(64)}` };
  }
}


function exactCandidate(): AssuranceCandidateInput {
  const scope = exactScope();
  const identity = exactIdentity(scope);
  return {
    candidateId: 'candidate:AFM-002',
    identity,
    scope,
    evidence: [boundRecord('evidence:host-test', identity)],
    decisions: [boundRecord('decision:review', identity)],
    testExecutions: [boundRecord('test-execution:node', identity)],
    producedArtifacts: [boundRecord('artifact:test-report', identity)],
  };
}

describe('canonical assurance candidate validation', () => {
  it('accepts an exact identity and records every bound scope and optional subject', () => {
    const result = validateAssuranceCandidate(exactCandidate());

    assert.equal(result.valid, true);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.scope.changedPaths, [
      'backend/src/lib/__tests__/assurance-candidate.node.test.ts',
      'backend/src/lib/assurance-candidate.ts',
    ]);
    assert.deepEqual(result.scope.requiredPaths, result.scope.changedPaths);
    assert.deepEqual(result.scope.allowedPaths, ['backend/src/lib']);
    assert.deepEqual(result.scope.forbiddenPaths, ['backend/src/lib/private']);
    assert.deepEqual(result.scope.unexpectedPaths, []);
    assert.deepEqual(result.scope.forbiddenChangedPaths, []);
    assert.deepEqual(result.scope.missingPaths, []);
    assert.deepEqual(result.satisfiedRecordIds, {
      evidence: ['evidence:host-test'],
      decisions: ['decision:review'],
      testExecutions: ['test-execution:node'],
      producedArtifacts: ['artifact:test-report'],
    });
  });

  it('names every required identity field when that field is missing', () => {
    for (const field of ASSURANCE_CANDIDATE_IDENTITY_FIELDS) {
      const candidate = exactCandidate();
      const identity = { ...candidate.identity } as Partial<AssuranceCandidateIdentity>;
      delete identity[field];
      candidate.identity = identity;
      candidate.evidence = [];
      candidate.decisions = [];
      candidate.testExecutions = [];
      candidate.producedArtifacts = [];

      const result = validateAssuranceCandidate(candidate);
      const missing = result.findings.filter((finding) => finding.kind === 'missing-identity');
      assert.equal(result.valid, false, `${field} must reject the candidate`);
      assert.deepEqual(missing.map((finding) => finding.field), [field]);
    }
  });

  it('records all path categories and rejects unexpected, forbidden, and missing paths', () => {
    const scope: AssuranceWorkPackageScope = {
      workPackageId: 'work-package:scope-fixture',
      workPackageRevision: 1,
      workPackageHash: `sha256:${'c'.repeat(64)}`,
      changedPaths: ['src/changed.ts', 'src/private/secret.ts', 'docs/drift.md'],
      requiredPaths: ['src/changed.ts', 'src/missing.ts'],
      allowedPaths: ['src'],
      forbiddenPaths: ['src/private'],
    };

    const result = evaluateAssuranceScope(scope);

    assert.equal(result.valid, false);
    assert.deepEqual(result.changedPaths, ['docs/drift.md', 'src/changed.ts', 'src/private/secret.ts']);
    assert.deepEqual(result.requiredPaths, ['src/changed.ts', 'src/missing.ts']);
    assert.deepEqual(result.allowedPaths, ['src']);
    assert.deepEqual(result.forbiddenPaths, ['src/private']);
    assert.deepEqual(result.unexpectedPaths, ['docs/drift.md']);
    assert.deepEqual(result.forbiddenChangedPaths, ['src/private/secret.ts']);
    assert.deepEqual(result.missingPaths, ['src/missing.ts']);
    assert.deepEqual(result.findings.map((finding) => finding.kind), [
      'unexpected-path',
      'forbidden-path',
      'missing-path',
    ]);
  });

  it('rejects path drift even when the submitted scope identity describes the prior paths', () => {
    const candidate = exactCandidate();
    candidate.evidence = [];
    candidate.decisions = [];
    candidate.testExecutions = [];
    candidate.producedArtifacts = [];
    candidate.scope = {
      ...candidate.scope,
      changedPaths: [...candidate.scope.changedPaths, 'docs/path-drift.md'],
    };

    const result = validateAssuranceCandidate(candidate);

    assert.equal(result.valid, false);
    assert.deepEqual(result.scope.unexpectedPaths, ['docs/path-drift.md']);
    assert.equal(result.findings.some((finding) => finding.kind === 'scope-identity-mismatch'), true);
    assert.equal(result.findings.some((finding) => finding.kind === 'unexpected-path' && finding.path === 'docs/path-drift.md'), true);
  });

  it('rejects a forbidden change even when every changed path is under an allowed parent', () => {
    const candidate = exactCandidate();
    const scope = {
      ...candidate.scope,
      changedPaths: [...candidate.scope.changedPaths, 'backend/src/lib/private/secret.ts'],
    };
    candidate.scope = scope;
    candidate.identity = { ...candidate.identity, scope: assuranceScopeIdentity(scope) };
    candidate.evidence = [];
    candidate.decisions = [];
    candidate.testExecutions = [];
    candidate.producedArtifacts = [];

    const result = validateAssuranceCandidate(candidate);

    assert.equal(result.valid, false);
    assert.deepEqual(result.scope.unexpectedPaths, []);
    assert.deepEqual(result.scope.forbiddenChangedPaths, ['backend/src/lib/private/secret.ts']);
    assert.equal(result.findings.some((finding) => finding.kind === 'forbidden-path'), true);
  });

  it('rejects wrong-subject evidence and decisions and excludes both from satisfaction', () => {
    const candidate = exactCandidate();
    const identity = candidate.identity as AssuranceCandidateIdentity;
    const wrongSubject = {
      ...identity,
      specificationRevision: { ...identity.specificationRevision },
      plan: { ...identity.plan },
      commit: 'f123456789abcdef0123456789abcdef01234567',
    };
    candidate.evidence = [
      boundRecord('evidence:exact', identity),
      boundRecord('evidence:wrong-commit', wrongSubject),
    ];
    candidate.decisions = [boundRecord('decision:wrong-commit', wrongSubject)];
    candidate.testExecutions = [];
    candidate.producedArtifacts = [];

    const result = validateAssuranceCandidate(candidate);

    assert.equal(result.valid, false);
    assert.deepEqual(result.satisfiedRecordIds.evidence, ['evidence:exact']);
    assert.deepEqual(result.satisfiedRecordIds.decisions, []);
    assert.deepEqual(result.subjectResults.evidence.map((item) => item.status), [
      'accepted-subject',
      'rejected-subject',
    ]);
    assert.equal(result.subjectResults.evidence[1]?.includedInSatisfaction, false);
    assert.deepEqual(result.subjectResults.evidence[1]?.mismatchedFields, ['commit']);
    assert.equal(result.subjectResults.decisions[0]?.status, 'rejected-subject');
    assert.equal(result.subjectResults.decisions[0]?.includedInSatisfaction, false);
    assert.deepEqual(
      result.findings
        .filter((finding) => finding.kind === 'rejected-subject')
        .map((finding) => `${finding.recordType}:${finding.recordId}`),
      ['evidence:evidence:wrong-commit', 'decision:decision:wrong-commit'],
    );
  });
  it('rejects every wrong subject identity field across all bound record categories', () => {
    for (const field of ASSURANCE_CANDIDATE_IDENTITY_FIELDS) {
      const candidate = exactCandidate();
      const identity = candidate.identity as AssuranceCandidateIdentity;
      const wrongSubject = identityWithMismatch(field, identity);
      candidate.evidence = [boundRecord(`evidence:wrong-${field}`, wrongSubject)];
      candidate.decisions = [boundRecord(`decision:wrong-${field}`, wrongSubject)];
      candidate.testExecutions = [boundRecord(`test-execution:wrong-${field}`, wrongSubject)];
      candidate.producedArtifacts = [boundRecord(`artifact:wrong-${field}`, wrongSubject)];

      const result = validateAssuranceCandidate(candidate);
      const subjectResults = [
        ...result.subjectResults.evidence,
        ...result.subjectResults.decisions,
        ...result.subjectResults.testExecutions,
        ...result.subjectResults.producedArtifacts,
      ];

      assert.equal(result.valid, false, `${field} subject mismatch must reject the candidate`);
      assert.deepEqual(
        subjectResults.map((item) => ({
          status: item.status,
          includedInSatisfaction: item.includedInSatisfaction,
          mismatchedFields: item.mismatchedFields,
        })),
        Array.from({ length: 4 }, () => ({
          status: 'rejected-subject',
          includedInSatisfaction: false,
          mismatchedFields: [field],
        })),
      );
      assert.deepEqual(result.satisfiedRecordIds, {
        evidence: [],
        decisions: [],
        testExecutions: [],
        producedArtifacts: [],
      });
      assert.equal(
        result.findings.filter((finding) => finding.kind === 'rejected-subject').length,
        4,
      );
    }
  });


  it('rejects omitted path manifests instead of treating them as empty canonical scope', () => {
    const scope = {
      ...exactScope(),
      allowedPaths: undefined,
    } as unknown as AssuranceWorkPackageScope;

    const result = evaluateAssuranceScope(scope);

    assert.equal(result.valid, false);
    assert.equal(result.findings.some((finding) =>
      finding.kind === 'invalid-scope' && finding.pathCategory === 'allowed'), true);
    assert.deepEqual(result.unexpectedPaths, result.changedPaths);
  });

  it('uses locale-independent repository path ordering for the canonical scope identity', () => {
    const scope: AssuranceWorkPackageScope = {
      ...exactScope(),
      changedPaths: ['src/é.ts', 'src/z.ts', 'src/A.ts'],
      requiredPaths: [],
      allowedPaths: ['src'],
    };

    const first = evaluateAssuranceScope(scope);
    const replay = evaluateAssuranceScope({ ...scope, changedPaths: [...scope.changedPaths].reverse() });

    assert.deepEqual(first.changedPaths, ['src/A.ts', 'src/z.ts', 'src/é.ts']);
    assert.equal(first.scopeIdentity, replay.scopeIdentity);
  });

});
