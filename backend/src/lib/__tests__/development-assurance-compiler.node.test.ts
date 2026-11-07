/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assuranceScopeIdentity, type AssuranceWorkPackageScope } from '../assurance-candidate';
import {
  compileDevelopmentAssurance,
  validateDevelopmentAssuranceCompilation,
  type DevelopmentAssuranceCompilerInput,
} from '../development-assurance-compiler';

const scope: AssuranceWorkPackageScope = {
  workPackageId: 'work-package:AFM-003',
  workPackageRevision: 3,
  workPackageHash: `sha256:${'a'.repeat(64)}`,
  changedPaths: ['src/api/billing.ts'],
  requiredPaths: ['src/api/billing.ts'],
  allowedPaths: ['src'],
  forbiddenPaths: ['src/secrets'],
};

const lifecyclePlan: NonNullable<DevelopmentAssuranceCompilerInput['lifecyclePlan']> = {
  planId: 'plan:AFM-003',
  planVersion: 7,
  requirementReferences: ['REQ-API', 'REQ-UI'],
  requirementMappings: [
    {
      requirementReference: 'REQ-API',
      targetReferences: [{ type: 'story', reference: 'AFM-003' }],
      gateIds: ['gate-development', 'gate-testing', 'gate-design', 'gate-security', 'gate-qa'],
      evidenceRequirementIds: ['evidence-change', 'evidence-test', 'evidence-architecture', 'evidence-security', 'evidence-qa'],
    },
    {
      requirementReference: 'REQ-UI',
      targetReferences: [{ type: 'story', reference: 'AFM-003' }],
      gateIds: ['gate-development', 'gate-testing', 'gate-design', 'gate-security', 'gate-qa'],
      evidenceRequirementIds: ['evidence-change', 'evidence-test', 'evidence-architecture', 'evidence-security', 'evidence-qa'],
    },
  ],
  gates: [
    {
      gateId: 'gate-development', phaseId: 'development', title: 'Change review', evidenceKind: 'change_review',
      subjectRevisionRequirement: 'current_commit', approvalRequirement: 'none', expirationPolicy: 'when_subject_changes',
      blockingSeverity: 'blocking', evidenceRequirementIds: ['evidence-change'], acceptedSubjectTypes: ['commit_sha'],
      downstreamSubjectCoherence: { rule: 'not_applicable', targetSubjectType: null },
    },
    {
      gateId: 'gate-testing', phaseId: 'testing', title: 'Automated validation', evidenceKind: 'automated_validation',
      subjectRevisionRequirement: 'current_commit', approvalRequirement: 'none', expirationPolicy: 'when_subject_changes',
      blockingSeverity: 'blocking', evidenceRequirementIds: ['evidence-test'], acceptedSubjectTypes: ['commit_sha'],
      downstreamSubjectCoherence: { rule: 'not_applicable', targetSubjectType: null },
    },
    {
      gateId: 'gate-design', phaseId: 'design', title: 'Architecture review', evidenceKind: 'architecture_review',
      subjectRevisionRequirement: 'current_spec_revision', approvalRequirement: 'none', expirationPolicy: 'when_spec_changes',
      blockingSeverity: 'blocking', evidenceRequirementIds: ['evidence-architecture'], acceptedSubjectTypes: ['spec_revision'],
      downstreamSubjectCoherence: { rule: 'not_applicable', targetSubjectType: null },
    },
    {
      gateId: 'gate-security', phaseId: 'testing', title: 'Security assessment', evidenceKind: 'security_assessment',
      subjectRevisionRequirement: 'current_commit', approvalRequirement: 'none', expirationPolicy: 'when_subject_changes',
      blockingSeverity: 'blocking', evidenceRequirementIds: ['evidence-security'], acceptedSubjectTypes: ['commit_sha'],
      downstreamSubjectCoherence: { rule: 'not_applicable', targetSubjectType: null },
    },
    {
      gateId: 'gate-qa', phaseId: 'testing', title: 'QA assessment', evidenceKind: 'qa_assessment',
      subjectRevisionRequirement: 'current_commit', approvalRequirement: 'none', expirationPolicy: 'when_subject_changes',
      blockingSeverity: 'blocking', evidenceRequirementIds: ['evidence-qa'], acceptedSubjectTypes: ['commit_sha'],
      downstreamSubjectCoherence: { rule: 'not_applicable', targetSubjectType: null },
    },
  ],
  evidenceRequirements: [
    { evidenceRequirementId: 'evidence-change', gateId: 'gate-development', description: 'Review the exact change.', classification: 'code_change', minimumTrustLevel: 'verified' },
    { evidenceRequirementId: 'evidence-test', gateId: 'gate-testing', description: 'Run exact-bound automated tests.', classification: 'test_result', minimumTrustLevel: 'verified' },
    { evidenceRequirementId: 'evidence-architecture', gateId: 'gate-design', description: 'Review changed architecture boundaries.', classification: 'documentation', minimumTrustLevel: 'verified' },
    { evidenceRequirementId: 'evidence-security', gateId: 'gate-security', description: 'Assess applicable security risk.', classification: 'security_finding', minimumTrustLevel: 'verified' },
    { evidenceRequirementId: 'evidence-qa', gateId: 'gate-qa', description: 'Assess behavior against requirements.', classification: 'test_result', minimumTrustLevel: 'verified' },
  ],
};

function exactInput(): DevelopmentAssuranceCompilerInput {
  return {
    feature: { featureId: 'feature:billing', revision: 'spec-revision:7' },
    candidate: {
      candidateId: 'candidate:billing:7',
      identity: {
        specificationRevision: { specId: 'feature:billing', revision: 'spec-revision:7' },
        plan: { planId: lifecyclePlan.planId, planVersion: lifecyclePlan.planVersion },
        commit: 'commit:abc123', tree: 'tree:def456', diff: 'diff:789abc', scope: assuranceScopeIdentity(scope),
      },
      scope,
    },
    lifecyclePlan,
    requirements: [
      { requirementId: 'REQ-UI', text: 'The billing UI reports a settled payment.' },
      { requirementId: 'REQ-API', text: 'The billing API preserves its public contract.' },
    ],
    risks: [
      {
        riskId: 'RISK-API-AUTH', title: 'Authorization regression', componentOrBoundary: 'billing-api',
        requirementIds: ['REQ-API'], rationale: 'The endpoint crosses an authenticated boundary.',
      },
      {
        riskId: 'RISK-REPORTING', title: 'Report drift', componentOrBoundary: 'reporting',
        requirementIds: ['REQ-UI'], rationale: 'Reporting changes can drift from settled balances.',
      },
    ],
    architectureDecisions: [
      {
        decisionId: 'ADR-BILLING-API', title: 'Stable billing API', componentOrBoundary: 'billing-api',
        requirementIds: ['REQ-API'], rationale: 'Consumers depend on the versioned response contract.',
      },
      {
        decisionId: 'ADR-REPORTING', title: 'Read-model reporting', componentOrBoundary: 'reporting',
        requirementIds: ['REQ-UI'], rationale: 'Reporting reads projections rather than transactional tables.',
      },
    ],
    changes: [{
      changeId: 'change:billing-api', path: 'src/api/billing.ts', kind: 'modified',
      componentOrBoundary: 'billing-api', requirementIds: ['REQ-API'],
      rationale: 'Return the new settlement state while retaining the public response shape.',
    }],
  };
}

function withChange(
  input: DevelopmentAssuranceCompilerInput,
  change: NonNullable<DevelopmentAssuranceCompilerInput['changes']>[number],
): DevelopmentAssuranceCompilerInput {
  return { ...input, candidate: structuredClone(input.candidate), changes: [change] };
}

describe('Development Assurance compiler', () => {
  it('emits a byte-stable obligation set with complete applicable-check context', () => {
    const first = compileDevelopmentAssurance(exactInput());
    const reordered = exactInput();
    reordered.requirements = [...(reordered.requirements ?? [])].reverse();
    reordered.risks = [...(reordered.risks ?? [])].reverse();
    reordered.architectureDecisions = [...(reordered.architectureDecisions ?? [])].reverse();
    const second = compileDevelopmentAssurance(reordered);

    assert.deepEqual(second, first);
    assert.equal(first.summary.readyForEvidence, true);
    assert.ok(first.obligations.length > 0);
    for (const check of first.obligations) {
      assert.equal(check.selection, 'selected');
      assert.equal(check.disposition, 'required');
      assert.equal(check.state, 'pending');
      assert.equal(check.requirement?.requirementId, 'REQ-API');
      assert.equal(check.change?.kind, 'modified');
      assert.ok(check.componentOrBoundary);
      assert.ok(check.expectedEvidence.length > 0);
      assert.ok(check.rationale.trim());
      assert.doesNotMatch(check.state, /pass/i);
    }
    assert.equal(validateDevelopmentAssuranceCompilation(exactInput(), first).valid, true);
    const truncated = structuredClone(first);
    truncated.obligations = truncated.obligations.slice(1);
    const truncatedValidation = validateDevelopmentAssuranceCompilation(exactInput(), truncated);
    assert.equal(truncatedValidation.valid, false);
    assert.ok(truncatedValidation.findings.includes('obligation-projection-mismatch'));
  });

  it('reports selected and excluded requirement, risk, architecture, boundary, and deletion checks', () => {
    const boundaryInput = withChange(exactInput(), {
      changeId: 'change:billing-api', path: 'src/api/billing.ts', kind: 'boundary',
      componentOrBoundary: 'billing-api', requirementIds: ['REQ-API'], rationale: 'Change the versioned API boundary.',
    });
    const boundary = compileDevelopmentAssurance(boundaryInput);
    assert.ok(boundary.obligations.some((check) => check.checkKind === 'boundary-contract'));
    assert.ok(boundary.obligations.some((check) => check.checkKind === 'risk-mitigation' && check.riskId === 'RISK-API-AUTH'));
    assert.ok(boundary.obligations.some((check) => check.checkKind === 'architecture-conformance' && check.architectureDecisionId === 'ADR-BILLING-API'));
    assert.ok(boundary.excludedChecks.some((check) => check.riskId === 'RISK-REPORTING' && check.rationale.includes('does not apply')));
    assert.ok(boundary.excludedChecks.some((check) => check.architectureDecisionId === 'ADR-REPORTING' && check.rationale.includes('does not govern')));

    const deleted = compileDevelopmentAssurance(withChange(exactInput(), {
      changeId: 'change:billing-api', path: 'src/api/billing.ts', kind: 'deleted',
      componentOrBoundary: 'billing-api', requirementIds: ['REQ-API'], rationale: 'Remove superseded behavior.',
    }));
    assert.ok(deleted.obligations.some((check) => check.checkKind === 'deletion-regression'));
    assert.ok(deleted.excludedChecks.some((check) => check.checkKind === 'boundary-contract'));
    assert.ok([...boundary.checks, ...deleted.checks].every((check) => check.rationale.length > 0));
  });

  it('emits one applicable check per bound change and resolves boundary architecture from matching decisions only', () => {
    const multiChangeInput = exactInput();
    multiChangeInput.changes = [
      ...(multiChangeInput.changes ?? []),
      {
        changeId: 'change:billing-api-contract',
        path: 'src/api/billing.ts',
        kind: 'modified',
        componentOrBoundary: 'billing-api',
        requirementIds: ['REQ-API'],
        rationale: 'Exercise a second change bound to the same requirement and boundary.',
      },
    ];
    const multiChange = compileDevelopmentAssurance(multiChangeInput);
    const riskChecks = multiChange.obligations.filter((check) => (
      check.checkKind === 'risk-mitigation' && check.riskId === 'RISK-API-AUTH'
    ));
    const architectureChecks = multiChange.obligations.filter((check) => (
      check.checkKind === 'architecture-conformance' && check.architectureDecisionId === 'ADR-BILLING-API'
    ));
    assert.deepEqual(riskChecks.map((check) => check.change?.changeId).sort(), [
      'change:billing-api',
      'change:billing-api-contract',
    ]);
    assert.deepEqual(architectureChecks.map((check) => check.change?.changeId).sort(), [
      'change:billing-api',
      'change:billing-api-contract',
    ]);
    const reversedChangesInput = { ...multiChangeInput, changes: [...(multiChangeInput.changes ?? [])].reverse() };
    assert.deepEqual(compileDevelopmentAssurance(reversedChangesInput), multiChange);

    const unrelatedDecisionInput = withChange(exactInput(), {
      changeId: 'change:billing-api',
      path: 'src/api/billing.ts',
      kind: 'boundary',
      componentOrBoundary: 'billing-api',
      requirementIds: ['REQ-API'],
      rationale: 'Change the versioned API boundary.',
    });
    unrelatedDecisionInput.architectureDecisions = [{
      decisionId: 'ADR-REPORTING',
      title: 'Read-model reporting',
      componentOrBoundary: 'reporting',
      requirementIds: ['REQ-UI'],
      rationale: 'Reporting reads projections rather than transactional tables.',
    }];
    const unrelatedDecision = compileDevelopmentAssurance(unrelatedDecisionInput);
    assert.ok(unrelatedDecision.obligations.some((check) => (
      check.checkKind === 'boundary-contract'
      && check.reasonCodes.includes('architecture-decision-unresolved')
      && check.disposition === 'unresolved'
    )));
    assert.ok(unrelatedDecision.excludedChecks.some((check) => (
      check.architectureDecisionId === 'ADR-REPORTING'
      && check.rationale.includes('does not govern')
    )));
  });

  it('uses explicit not-applicable, unresolved, and blocked dispositions without inventing success', () => {
    const absent = compileDevelopmentAssurance({
      feature: { featureId: 'feature:absent', revision: 'revision:1' },
      candidate: null,
      lifecyclePlan: null,
    });
    assert.ok(absent.checks.some((check) => check.disposition === 'not_applicable'));
    assert.ok(absent.checks.some((check) => check.disposition === 'blocked'));
    assert.equal(absent.summary.readyForEvidence, false);

    const unresolvedInput = exactInput();
    unresolvedInput.changes = [{
      changeId: 'change:billing-api', path: 'src/api/billing.ts', kind: 'modified',
      componentOrBoundary: 'billing-api', requirementIds: ['REQ-MISSING'], rationale: 'Exercise missing requirement binding.',
    }];
    const unresolved = compileDevelopmentAssurance(unresolvedInput);
    assert.ok(unresolved.checks.some((check) => check.reasonCodes.includes('requirement-unresolved') && check.disposition === 'unresolved'));

    const conflictInput = exactInput();
    conflictInput.risks = [
      ...(conflictInput.risks ?? []),
      {
        riskId: 'RISK-API-AUTH', title: 'Conflicting title', componentOrBoundary: 'billing-api',
        requirementIds: ['REQ-API'], rationale: 'Conflicts with the canonical risk input.',
      },
    ];
    conflictInput.architectureDecisions = [
      ...(conflictInput.architectureDecisions ?? []),
      {
        decisionId: 'ADR-REPORTING',
        title: 'Conflicting reporting architecture',
        componentOrBoundary: 'reporting-v2',
        requirementIds: ['REQ-UI'],
        rationale: 'Conflicts with the canonical reporting decision.',
      },
    ];
    const conflict = compileDevelopmentAssurance(conflictInput);
    assert.ok(conflict.checks.some((check) => check.reasonCodes.includes('conflicting-risk-input') && check.disposition === 'blocked'));
    assert.ok(conflict.obligations.some((check) => (
      check.reasonCodes.includes('conflicting-architecture-input')
      && check.disposition === 'blocked'
      && check.architectureDecisionId === 'ADR-REPORTING'
    )));
    assert.ok(conflict.obligations.every((check) => !String(check.state).toLowerCase().includes('pass')));
    const reversedConflictInput = {
      ...conflictInput,
      risks: [...(conflictInput.risks ?? [])].reverse(),
      architectureDecisions: [...(conflictInput.architectureDecisions ?? [])].reverse(),
    };
    assert.deepEqual(compileDevelopmentAssurance(reversedConflictInput), conflict);
  });

  it('invalidates stale changed-boundary and deleted-behavior sets and blocks scope drift and missing rationale', () => {
    const originalInput = exactInput();
    const original = compileDevelopmentAssurance(originalInput);
    const changedBoundary = withChange(exactInput(), {
      ...(exactInput().changes?.[0] as NonNullable<DevelopmentAssuranceCompilerInput['changes']>[number]),
      kind: 'boundary',
    });
    const deletedBehavior = withChange(exactInput(), {
      ...(exactInput().changes?.[0] as NonNullable<DevelopmentAssuranceCompilerInput['changes']>[number]),
      kind: 'deleted',
    });
    assert.equal(validateDevelopmentAssuranceCompilation(changedBoundary, original).valid, false);
    assert.equal(validateDevelopmentAssuranceCompilation(deletedBehavior, original).valid, false);

    const driftInput = exactInput();
    driftInput.changes = [{
      ...(driftInput.changes?.[0] as NonNullable<DevelopmentAssuranceCompilerInput['changes']>[number]),
      path: 'src/api/drifted.ts',
    }];
    const drift = compileDevelopmentAssurance(driftInput);
    assert.ok(drift.obligations.some((check) => check.reasonCodes.includes('scope-drift') && check.disposition === 'blocked'));
    assert.equal(validateDevelopmentAssuranceCompilation(driftInput, original).valid, false);

    const missingRationaleInput = exactInput();
    missingRationaleInput.changes = [{
      ...(missingRationaleInput.changes?.[0] as NonNullable<DevelopmentAssuranceCompilerInput['changes']>[number]),
      rationale: '',
    }];
    const missingRationale = compileDevelopmentAssurance(missingRationaleInput);
    assert.ok(missingRationale.obligations.some((check) => check.reasonCodes.includes('change-rationale-missing') && check.disposition === 'blocked'));
    assert.equal(validateDevelopmentAssuranceCompilation(missingRationaleInput, original).valid, false);
    assert.equal(drift.summary.readyForEvidence, false);
    assert.equal(missingRationale.summary.readyForEvidence, false);
  });
});
