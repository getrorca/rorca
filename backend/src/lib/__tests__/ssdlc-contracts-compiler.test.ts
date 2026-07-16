/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  AgentProcessOutcomeSchema,
  EvaluationSnapshotIdentitySchema,
  EvidenceRecordSchema,
  GovernedDecisionSchema,
  LifecycleCompilerInputSchema,
  LifecyclePlanSchema,
  LifecycleReadModelSchema,
  PhaseDispositionSchema,
  StoryCompletionPacketSchema,
  deriveEvaluationSnapshotIdentity,
  deriveEvidenceReference,
  deriveRequirementReference,
  fingerprintAcceptanceCriterion,
  normalizeAcceptanceCriterionText,
} from '../ssdlc-contracts';
import { compileLifecyclePlan } from '../ssdlc-plan-compiler';
import {
  COMPILER_PROFILE_FIXTURES,
  CONTRACT_SPEC_HASH,
  CONTRACT_TIME,
  compilerInput,
} from './fixtures/ssdlc-lifecycle-contract.fixtures';

const DECISION = `DEC-sha256:${'d'.repeat(64)}`;
const EVIDENCE_CONTENT_HASH = `sha256:${'e'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);

function validEvidence() {
  const identity = {
    workspaceId: 'workspace-contract',
    source: 'ci' as const,
    stableSourceId: 'check-run-22',
    subject: { type: 'commit_sha' as const, value: COMMIT },
  };
  return {
    schemaVersion: 1 as const,
    evidenceReference: deriveEvidenceReference(identity),
    workspaceId: identity.workspaceId,
    specId: 'lifecycle-contract',
    phaseId: 'validation' as const,
    gateId: 'gate-validation',
    source: identity.source,
    stableSourceId: identity.stableSourceId,
    observedAt: CONTRACT_TIME,
    subject: identity.subject,
    classification: 'test_result' as const,
    redactedPayload: {
      redacted: true as const,
      content: { status: 'passed' },
      contentHash: EVIDENCE_CONTENT_HASH,
      redactionPolicyVersion: 'redaction-v1',
    },
    trustLevel: 'verified' as const,
    provenance: {
      capturedBy: 'rorca-host',
      adapterVersion: 'ci-adapter-v1',
      originalReference: 'check-run:22',
      contentHash: EVIDENCE_CONTENT_HASH,
      redactionPolicyVersion: 'redaction-v1',
      immutable: true as const,
    },
    recordedAt: CONTRACT_TIME,
  };
}

describe('SSDLC contract validators', () => {
  test('normalizes criterion identity without allowing empty or malformed story references', () => {
    expect(normalizeAcceptanceCriterionText('  Current\tREVISION  ')).toBe('current revision');
    expect(fingerprintAcceptanceCriterion('Current revision')).toBe(fingerprintAcceptanceCriterion(' current   REVISION '));
    expect(deriveRequirementReference('LFC-022', 'Current revision')).toMatch(/^LFC-022:ac:sha256:[a-f0-9]{64}$/);
    expect(() => deriveRequirementReference('story-22', 'Current revision')).toThrow();
    expect(() => deriveRequirementReference('LFC-022', '   ')).toThrow('non-empty');
  });

  test('rejects duplicate canonical identities and cross-workspace compiler sources', () => {
    const duplicateStory = compilerInput();
    duplicateStory.canonicalSpec.json.userStories.push(structuredClone(duplicateStory.canonicalSpec.json.userStories[0]));
    expect(LifecycleCompilerInputSchema.safeParse(duplicateStory).success).toBe(false);

    const duplicateCriterion = compilerInput();
    duplicateCriterion.canonicalSpec.json.userStories[0].acceptanceCriteria.push(' the CURRENT immutable revision has matching evidence. ');
    expect(LifecycleCompilerInputSchema.safeParse(duplicateCriterion).success).toBe(false);

    const crossWorkspace = compilerInput();
    crossWorkspace.workspaceTags = [{ workspaceId: 'workspace-other', tag: 'security' }];
    expect(LifecycleCompilerInputSchema.safeParse(crossWorkspace).success).toBe(false);
  });

  test.each([
    [{ disposition: 'required', rationale: 'Required.' }, true],
    [{ disposition: 'required', rationale: 'Required.', approvalReference: DECISION }, false],
    [{ disposition: 'deferred', rationale: 'Deferred.', approvalReference: DECISION, expiryPolicy: 'after 30 days' }, true],
    [{ disposition: 'deferred', rationale: 'Deferred.' }, false],
    [{ disposition: 'not_applicable', rationale: 'No runtime subject.' }, true],
    [{ disposition: 'not_applicable', rationale: 'No runtime subject.', expiryPolicy: 'after 30 days' }, false],
  ] as const)('enforces phase-disposition governance %#', (candidate, expected) => {
    expect(PhaseDispositionSchema.safeParse(candidate).success).toBe(expected);
  });

  test('binds evidence identity to workspace, source event, and immutable subject', () => {
    const evidence = validEvidence();
    expect(EvidenceRecordSchema.safeParse(evidence).success).toBe(true);
    expect(EvidenceRecordSchema.safeParse({ ...evidence, stableSourceId: 'forged-event' }).success).toBe(false);
    expect(EvidenceRecordSchema.safeParse({ ...evidence, subject: { ...evidence.subject, value: 'b'.repeat(40) } }).success).toBe(false);
  });

  test('rejects impossible process/closeout combinations and unbounded completion claims', () => {
    expect(AgentProcessOutcomeSchema.safeParse({
      outcome: 'succeeded', exitCode: 1, signal: null, startedAt: CONTRACT_TIME, finishedAt: CONTRACT_TIME,
    }).success).toBe(false);

    const evidence = validEvidence();
    const completion = {
      schemaVersion: 1,
      completionReference: `CMP-sha256:${'c'.repeat(64)}`,
      workspaceId: 'workspace-contract',
      specId: 'lifecycle-contract',
      phaseId: 'validation',
      gateId: 'gate-validation',
      source: 'execution_engine',
      stableSourceId: 'attempt-22',
      observedAt: CONTRACT_TIME,
      subject: { type: 'commit_sha', value: COMMIT },
      classification: 'test_result',
      redactedPayload: evidence.redactedPayload,
      trustLevel: 'verified',
      provenance: evidence.provenance,
      storyReference: 'LFC-022',
      executionMode: 'implementation',
      processOutcome: {
        outcome: 'failed', exitCode: 1, signal: null, startedAt: CONTRACT_TIME, finishedAt: CONTRACT_TIME,
      },
      closeoutDecision: {
        outcome: 'accepted', decisionReference: DECISION, decidedAt: CONTRACT_TIME,
        decidedBy: 'execution_engine', rationale: 'Host checks passed.',
      },
      evidenceReferences: [evidence.evidenceReference],
      completedAt: CONTRACT_TIME,
    };
    expect(StoryCompletionPacketSchema.safeParse(completion).success).toBe(false);
    expect(StoryCompletionPacketSchema.safeParse({
      ...completion,
      processOutcome: { ...completion.processOutcome, outcome: 'succeeded', exitCode: 0 },
      evidenceReferences: [],
    }).success).toBe(false);
  });

  test('requires expiry for an approved governed deferral', () => {
    const decision = {
      schemaVersion: 1,
      decisionReference: DECISION,
      workspaceId: 'workspace-contract',
      specId: 'lifecycle-contract',
      phaseId: 'security',
      gateId: 'gate-security',
      subject: { type: 'commit_sha', value: COMMIT },
      decisionType: 'defer',
      outcome: 'approved',
      rationale: 'A bounded exception is approved.',
      policyReference: 'policy/security',
      evidenceReferences: [validEvidence().evidenceReference],
      decidedBy: 'security-reviewer',
      decidedAt: CONTRACT_TIME,
      provenance: validEvidence().provenance,
    };
    expect(GovernedDecisionSchema.safeParse(decision).success).toBe(false);
    expect(GovernedDecisionSchema.safeParse({ ...decision, expiresAt: '2026-07-16T12:00:00.000Z' }).success).toBe(true);
  });

  test('rejects every relational plan mutation instead of returning a partial plan', () => {
    const plan = compileLifecyclePlan(compilerInput()).plan;
    const mutations: Array<(candidate: typeof plan) => void> = [
      (candidate) => { [candidate.phases[0], candidate.phases[1]] = [candidate.phases[1], candidate.phases[0]]; },
      (candidate) => { candidate.requirementMappings[0].gateIds = ['gate-missing']; },
      (candidate) => { candidate.gates[0].acceptedSubjectTypes = ['spec_hash', 'spec_hash']; },
      (candidate) => { candidate.evidenceRequirements[0].gateId = 'gate-validation'; },
      (candidate) => { candidate.phases[0].gateIds = ['gate-validation']; },
    ];

    expect(LifecyclePlanSchema.safeParse(plan).success).toBe(true);
    for (const mutate of mutations) {
      const candidate = structuredClone(plan);
      mutate(candidate);
      expect(LifecyclePlanSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test('binds lifecycle reads to a validated matching snapshot and canonical phase order', () => {
    const plan = compileLifecyclePlan(compilerInput()).plan;
    const snapshot = deriveEvaluationSnapshotIdentity({
      planId: plan.planId,
      planVersion: plan.planVersion,
      inputHash: plan.inputHash,
      evidenceHighWaterMark: 'evidence:22',
      decisionHighWaterMark: 'decision:9',
      activeReleaseSubject: { type: 'commit_sha', value: COMMIT },
      policyVersion: plan.policyVersion,
      compilerVersion: plan.compilerVersion,
      evaluatedAt: CONTRACT_TIME,
    });
    expect(EvaluationSnapshotIdentitySchema.safeParse(snapshot).success).toBe(true);
    expect(EvaluationSnapshotIdentitySchema.safeParse({ ...snapshot, planVersion: 2 }).success).toBe(false);

    const readModel = {
      schemaVersion: 1,
      snapshot,
      workspaceId: plan.workspaceId,
      specId: plan.specId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      phases: plan.phases.map((phase) => ({
        phaseId: phase.phaseId,
        disposition: phase.disposition,
        evaluatedStatus: 'passed',
        rationale: 'All current evidence is accepted.',
        gates: [],
      })),
    };
    expect(LifecycleReadModelSchema.safeParse(readModel).success).toBe(true);
    const mixed = structuredClone(readModel);
    mixed.snapshot = { ...mixed.snapshot, planVersion: 2 };
    expect(LifecycleReadModelSchema.safeParse(mixed).success).toBe(false);
  });
});

describe('fixed compiler profile matrix', () => {
  test.each(COMPILER_PROFILE_FIXTURES)('$name compiles the matching complete profile', (fixture) => {
    const first = compileLifecyclePlan(compilerInput(fixture));
    const replay = compileLifecyclePlan(compilerInput(fixture));
    const implementationRequirement = first.plan.evidenceRequirements.find((item) => item.gateId === 'gate-implementation');

    expect(first.profiles).toEqual(fixture.expectedProfiles);
    expect(implementationRequirement?.classification).toBe(fixture.expectedImplementationClassification);
    expect(replay).toEqual(first);
    expect(first.plan.inputHash).toBe(replay.plan.inputHash);
    expect(first.plan.phases).toHaveLength(11);
    expect(first.plan.gates).toHaveLength(11);
    expect(first.plan.evidenceRequirements).toHaveLength(11);
  });

  test('docs-only narrows only governed runtime phases while release/security remain required', () => {
    const docs = compileLifecyclePlan(compilerInput(COMPILER_PROFILE_FIXTURES[0]));
    const release = compileLifecyclePlan(compilerInput(COMPILER_PROFILE_FIXTURES[5]));
    const security = compileLifecyclePlan(compilerInput(COMPILER_PROFILE_FIXTURES[3]));
    const disposition = (result: typeof docs, phaseId: string) => result.plan.phases.find((phase) => phase.phaseId === phaseId)?.disposition.disposition;

    expect(disposition(docs, 'production')).toBe('not_applicable');
    expect(disposition(docs, 'validation')).toBe('required');
    expect(disposition(release, 'production')).toBe('required');
    expect(disposition(security, 'security')).toBe('required');
    expect(docs.plan.inputHash).not.toBe(CONTRACT_SPEC_HASH);
  });
});
