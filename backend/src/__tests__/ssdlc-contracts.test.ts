/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import {
  CANONICAL_PHASE_IDS,
  COMPLETE_PRODUCT_CONTRACT,
  EVALUATED_STATUSES,
  EvidenceRecordSchema,
  LifecycleCompilerInputSchema,
  LifecyclePlanSchema,
  LifecycleReadModelSchema,
  PHASE_DISPOSITIONS,
  PhaseDispositionSchema,
  PhaseEvaluationSchema,
  RELEASE_SUBJECT_TYPES,
  SSDLC_WIRE_JSON_SCHEMA,
  STATUS_PRECEDENCE,
  StoryCompletionPacketSchema,
  deriveAcceptanceCriterionReferences,
  deriveEvaluationSnapshotIdentity,
  deriveEvidenceReference,
  deriveRequirementReference,
  normalizeSsdlcContractJson,
} from '../lib/ssdlc-contracts';
import {
  SSDLC_CONTRACT_FIXTURES,
  SSDLC_FIXTURE_PROFILES,
  SSDLC_FIXTURE_TIME,
  buildSsdlcContractFixtures,
} from './fixtures/ssdlc-contract-fixtures';

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function stableReference(prefix: 'DEC' | 'CMP', value: string): string {
  return `${prefix}-sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function firstFixturePlan() {
  return structuredClone(SSDLC_CONTRACT_FIXTURES[0].plan);
}

function validEvidenceInput() {
  const identity = {
    workspaceId: 'workspace-code-change',
    source: 'ci' as const,
    stableSourceId: 'ci-run-551:test-backend',
    subject: { type: 'commit_sha' as const, value: 'a'.repeat(40) },
  };
  return {
    schemaVersion: 1 as const,
    evidenceReference: deriveEvidenceReference(identity),
    ...identity,
    specId: 'fixture-code-change',
    phaseId: 'validation' as const,
    gateId: 'gate-validation',
    observedAt: SSDLC_FIXTURE_TIME,
    classification: 'test_result' as const,
    redactedPayload: {
      redacted: true as const,
      content: { passed: 84, failed: 0 },
      contentHash: sha256('redacted-test-payload'),
      redactionPolicyVersion: 'redaction-1',
    },
    trustLevel: 'verified' as const,
    provenance: {
      capturedBy: 'ci-adapter',
      adapterVersion: '1.0.0',
      originalReference: 'ci://run/551/test-backend',
      contentHash: sha256('original-test-payload'),
      redactionPolicyVersion: 'redaction-1',
      immutable: true as const,
    },
    recordedAt: SSDLC_FIXTURE_TIME,
  };
}

describe('canonical SSDLC contract', () => {
  test('exports the fixed production phase order and exact enums', () => {
    expect(CANONICAL_PHASE_IDS).toEqual([
      'intake',
      'requirements',
      'architecture',
      'implementation',
      'validation',
      'security',
      'staging',
      'qa',
      'merge',
      'production',
      'learn',
    ]);
    expect(PHASE_DISPOSITIONS).toEqual(['required', 'deferred', 'not_applicable']);
    expect(EVALUATED_STATUSES).toEqual([
      'not_started',
      'in_progress',
      'blocked',
      'awaiting_approval',
      'passed',
      'deferred',
      'not_applicable',
      'stale',
    ]);
    expect(STATUS_PRECEDENCE).toEqual([
      'stale',
      'blocked',
      'awaiting_approval',
      'deferred',
      'not_applicable',
      'passed',
      'in_progress',
      'not_started',
    ]);
    expect(RELEASE_SUBJECT_TYPES).toEqual([
      'spec_hash',
      'commit_sha',
      'artifact_digest',
      'deployment_id',
    ]);
  });

  test('emits a JSON schema with schemaVersion 1 as a compatibility discriminant', () => {
    expect(SSDLC_WIRE_JSON_SCHEMA.type).toBe('object');
    expect(JSON.stringify(SSDLC_WIRE_JSON_SCHEMA)).toContain('schemaVersion');
    expect(JSON.stringify(SSDLC_WIRE_JSON_SCHEMA)).toContain('const');
  });

  test('rejects unknown schema versions and duplicate or reordered phases actionably', () => {
    const unknownVersion = { ...firstFixturePlan(), schemaVersion: 2 };
    const unknownResult = LifecyclePlanSchema.safeParse(unknownVersion);
    expect(unknownResult.success).toBe(false);
    expect(unknownResult.error?.issues.some((issue) => issue.path.join('.') === 'schemaVersion')).toBe(true);

    const duplicatePhase = firstFixturePlan();
    duplicatePhase.phases[1].phaseId = 'intake';
    const duplicateResult = LifecyclePlanSchema.safeParse(duplicatePhase);
    expect(duplicateResult.success).toBe(false);
    expect(duplicateResult.error?.issues.map((issue) => issue.message).join(' ')).toContain('Duplicate phases');
    expect(duplicateResult.error?.issues.map((issue) => issue.message).join(' ')).toContain('display position');
  });
});

describe('dispositions, statuses, and references', () => {
  test('enforces disposition-specific approval, expiry, and rationale fields', () => {
    expect(PhaseDispositionSchema.safeParse({ disposition: 'required', rationale: '' }).success).toBe(false);
    const missingDeferredFields = PhaseDispositionSchema.safeParse({
      disposition: 'deferred',
      rationale: 'A governed temporary exception.',
    });
    expect(missingDeferredFields.success).toBe(false);
    expect(missingDeferredFields.error?.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['approvalReference', 'expiryPolicy']),
    );
    expect(PhaseDispositionSchema.safeParse({ disposition: 'not_applicable', rationale: '   ' }).success).toBe(false);
  });

  test('rejects status and disposition conflation', () => {
    expect(PhaseEvaluationSchema.safeParse({
      phaseId: 'validation',
      disposition: { disposition: 'required', rationale: 'Validation is required.' },
      evaluatedStatus: 'not_applicable',
      rationale: 'Invalid combination.',
      gates: [],
    }).success).toBe(false);
    expect(PhaseEvaluationSchema.safeParse({
      phaseId: 'security',
      disposition: { disposition: 'not_applicable', rationale: 'No security behavior changes.' },
      evaluatedStatus: 'passed',
      rationale: 'Invalid combination.',
      gates: [],
    }).success).toBe(false);
  });

  test('derives reorder-stable requirement references and rejects normalized duplicates', () => {
    const baseInput = structuredClone(SSDLC_CONTRACT_FIXTURES[0].compilerInput);
    baseInput.canonicalSpec.json.stories[0].acceptanceCriteria = [
      'First criterion passes.',
      'Second criterion passes.',
    ];
    const reversedInput = structuredClone(baseInput);
    reversedInput.canonicalSpec.json.stories[0].acceptanceCriteria.reverse();

    const first = deriveAcceptanceCriterionReferences(baseInput)
      .map((item) => item.requirementReference).sort();
    const reversed = deriveAcceptanceCriterionReferences(reversedInput)
      .map((item) => item.requirementReference).sort();
    expect(reversed).toEqual(first);
    expect(first[0]).toContain(`${baseInput.canonicalSpec.json.stories[0].id}:ac:sha256:`);
    expect(deriveRequirementReference('LFC-001', '  SAME   Criterion '))
      .toBe(deriveRequirementReference('LFC-001', 'same criterion'));

    const duplicateInput = structuredClone(baseInput);
    duplicateInput.canonicalSpec.json.stories[0].acceptanceCriteria = ['Same criterion', ' same   criterion '];
    const duplicate = LifecycleCompilerInputSchema.safeParse(duplicateInput);
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0].message).toContain('Duplicate acceptance criterion after normalization');
  });

  test('validates explicit requirement IDs and all plan references', () => {
    expect(SSDLC_CONTRACT_FIXTURES.find((fixture) => fixture.profile === 'security-sensitive')
      ?.plan.requirementReferences).toContain('SEC-101');

    const invalidReference = firstFixturePlan();
    invalidReference.requirementMappings[0].targetReferences[0].reference = 'FIX-UNKNOWN-999';
    const result = LifecyclePlanSchema.safeParse(invalidReference);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('Unknown story reference');
  });
});

describe('compiler inputs, subjects, and snapshots', () => {
  test('joins workspace-scoped optional sources with deterministic empty defaults', () => {
    const docsInput = SSDLC_CONTRACT_FIXTURES.find((fixture) => fixture.profile === 'docs-only')!.compilerInput;
    expect(docsInput.workspaceTags).toEqual([]);
    expect(docsInput.riskAssignments).toEqual([]);
    expect(docsInput.ownerAssignments).toEqual([]);
    expect(docsInput.policyAnnotations).toEqual([]);

    const wrongWorkspace = structuredClone(SSDLC_CONTRACT_FIXTURES[0].compilerInput);
    wrongWorkspace.workspaceTags[0].workspaceId = 'workspace-other';
    const result = LifecycleCompilerInputSchema.safeParse(wrongWorkspace);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('must be scoped to compiler workspace');
  });

  test('requires every gate to declare accepted subjects and QA/Merge/Production coherence', () => {
    for (const fixture of SSDLC_CONTRACT_FIXTURES) {
      for (const gate of fixture.plan.gates) {
        expect(gate.acceptedSubjectTypes.length).toBeGreaterThan(0);
        expect(Object.keys(gate.downstreamSubjectCoherence).sort()).toEqual(['merge', 'production', 'qa']);
      }
    }
  });

  test('derives and verifies evaluation snapshot identity from every required input', () => {
    const plan = firstFixturePlan();
    const snapshot = deriveEvaluationSnapshotIdentity({
      planId: plan.planId,
      planVersion: plan.planVersion,
      inputHash: plan.inputHash,
      evidenceHighWaterMark: 'evidence-sequence-551',
      decisionHighWaterMark: 'decision-sequence-22',
      activeReleaseSubject: { type: 'commit_sha', value: 'b'.repeat(40) },
      policyVersion: plan.policyVersion,
      compilerVersion: plan.compilerVersion,
      evaluatedAt: SSDLC_FIXTURE_TIME,
    });
    const phases = plan.phases.map((phase) => ({
      phaseId: phase.phaseId,
      disposition: phase.disposition,
      evaluatedStatus: phase.disposition.disposition === 'not_applicable' ? 'not_applicable' as const : 'passed' as const,
      rationale: 'Evaluated from immutable evidence and governed decisions.',
      gates: [],
    }));
    expect(LifecycleReadModelSchema.safeParse({
      schemaVersion: 1,
      snapshot,
      workspaceId: plan.workspaceId,
      specId: plan.specId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      phases,
    }).success).toBe(true);

    const tampered = { ...snapshot, evidenceHighWaterMark: 'evidence-sequence-552' };
    const result = LifecycleReadModelSchema.safeParse({
      schemaVersion: 1,
      snapshot: tampered,
      workspaceId: plan.workspaceId,
      specId: plan.specId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      phases,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('snapshot ID');
  });
});

describe('evidence, closeout, completeness, and fixtures', () => {
  test('validates immutable redacted evidence with stable identity and provenance', () => {
    const evidence = validEvidenceInput();
    expect(EvidenceRecordSchema.safeParse(evidence).success).toBe(true);
    const invalid = { ...evidence, stableSourceId: 'different-run' };
    const result = EvidenceRecordSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('Evidence reference must be derived');
  });

  test('keeps process outcome, accepted story closeout, and lifecycle status distinct', () => {
    const evidence = validEvidenceInput();
    const completion = {
      schemaVersion: 1,
      completionReference: stableReference('CMP', 'completion-551'),
      workspaceId: evidence.workspaceId,
      specId: evidence.specId,
      phaseId: 'implementation',
      gateId: 'gate-implementation-closeout',
      source: 'execution_engine',
      stableSourceId: 'run-551:story-FIX-CODE-CHANGE-001',
      observedAt: SSDLC_FIXTURE_TIME,
      subject: evidence.subject,
      classification: 'code_change',
      redactedPayload: evidence.redactedPayload,
      trustLevel: 'verified',
      provenance: evidence.provenance,
      storyReference: 'FIX-CODE-CHANGE-001',
      executionMode: 'implementation',
      processOutcome: {
        outcome: 'succeeded',
        exitCode: 0,
        signal: null,
        startedAt: '2026-06-15T11:00:00.000Z',
        finishedAt: SSDLC_FIXTURE_TIME,
      },
      closeoutDecision: {
        outcome: 'accepted',
        decisionReference: stableReference('DEC', 'closeout-551'),
        decidedAt: SSDLC_FIXTURE_TIME,
        decidedBy: 'execution_engine',
        rationale: 'Meaningful changes and required local validation evidence were accepted.',
      },
      evidenceReferences: [evidence.evidenceReference],
      completedAt: SSDLC_FIXTURE_TIME,
    };
    expect(StoryCompletionPacketSchema.safeParse(completion).success).toBe(true);
    expect(completion.processOutcome.outcome).toBe('succeeded');
    expect(completion.closeoutDecision.outcome).toBe('accepted');
    expect(completion).not.toHaveProperty('evaluatedStatus');
  });

  test('makes incomplete-product deferrals structurally impossible', () => {
    expect(COMPLETE_PRODUCT_CONTRACT.requiredJourneyClasses).toEqual([
      'normal',
      'negative',
      'recovery',
      'responsive',
      'accessibility',
      'light_theme',
    ]);
    const plan = firstFixturePlan();
    const incomplete = {
      ...plan,
      completeness: { ...plan.completeness, fakeSuccessStatesForbidden: false },
    };
    expect(LifecyclePlanSchema.safeParse(incomplete).success).toBe(false);
  });

  test('covers five profiles with deterministic normalized bytes and fixed timestamps', () => {
    expect(SSDLC_CONTRACT_FIXTURES.map((fixture) => fixture.profile)).toEqual(SSDLC_FIXTURE_PROFILES);
    const firstBytes = normalizeSsdlcContractJson(buildSsdlcContractFixtures());
    const secondBytes = normalizeSsdlcContractJson(buildSsdlcContractFixtures());
    expect(secondBytes).toBe(firstBytes);
    expect(firstBytes).toContain(SSDLC_FIXTURE_TIME);
    expect(firstBytes).not.toContain(new Date().toISOString());
  });
});
