/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { UnprocessableError, ValidationError } from '../lib/errors';
import {
  CANONICAL_PHASE_IDS,
  LifecyclePlanSchema,
  normalizeSsdlcContractJson,
} from '../lib/ssdlc-contracts';
import {
  SSDLC_PLAN_COMPILER_VERSION,
  compileLifecyclePlan,
  findStaleRequirementMappings,
  type AssembledLifecycleCompileInput,
} from '../lib/ssdlc-plan-compiler';

type CompilerFixture = {
  name: string;
  input: AssembledLifecycleCompileInput;
  expected: {
    profiles: string[];
    notApplicablePhases: string[];
    capabilityHint: string | null;
    acceptedAnnotations: string[];
    rejectedAnnotations: string[];
    defaultedInputs: string[];
  };
};

const fixtureDirectory = path.join(__dirname, 'fixtures', 'ssdlc');
const fixtures: CompilerFixture[] = fs.readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, file), 'utf8')) as CompilerFixture);

function fixture(name: string): CompilerFixture {
  return structuredClone(fixtures.find((candidate) => candidate.name === name)!);
}

function decisionReference(seed: string): string {
  return `DEC-sha256:${seed.repeat(64).slice(0, 64)}`;
}

describe('deterministic SSDLC plan compiler fixtures', () => {
  test('compiles all six fixed profiles into expected complete plans', () => {
    expect(fixtures).toHaveLength(6);

    for (const anchor of fixtures) {
      const first = compileLifecyclePlan(structuredClone(anchor.input));
      const second = compileLifecyclePlan(structuredClone(anchor.input));

      expect(normalizeSsdlcContractJson(second)).toBe(normalizeSsdlcContractJson(first));
      expect(first.profiles).toEqual(anchor.expected.profiles);
      expect(first.plan.phaseOrder).toEqual(CANONICAL_PHASE_IDS);
      expect(first.plan.phases.map((phase) => phase.phaseId)).toEqual(CANONICAL_PHASE_IDS);
      expect(first.plan.phases.filter((phase) => phase.disposition.disposition === 'not_applicable')
        .map((phase) => phase.phaseId)).toEqual(anchor.expected.notApplicablePhases);
      expect(first.plan.gates.map((gate) => gate.gateId)).toEqual(
        CANONICAL_PHASE_IDS.map((phaseId) => `gate-${phaseId}`),
      );
      expect(first.capabilityHint?.mode ?? null).toBe(anchor.expected.capabilityHint);
      expect(first.annotationReviews.filter((review) => review.status === 'accepted')
        .map((review) => review.annotationId)).toEqual(anchor.expected.acceptedAnnotations);
      expect(first.annotationReviews.filter((review) => review.status === 'rejected')
        .map((review) => review.annotationId)).toEqual(anchor.expected.rejectedAnnotations);
      expect(first.defaultedInputs).toEqual(anchor.expected.defaultedInputs);
      expect(LifecyclePlanSchema.safeParse(first.plan).success).toBe(true);
    }
  });

  test('emits declarative gate templates without claiming evidence or evaluated status', () => {
    const result = compileLifecyclePlan(fixture('production release operations').input);

    for (const gate of result.plan.gates) {
      expect(gate.evidenceKind).toBeTruthy();
      expect(gate.subjectRevisionRequirement).toMatch(/^current_/);
      expect(gate.approvalRequirement).toMatch(/^(none|policy|human)$/);
      expect(gate.expirationPolicy).toBeTruthy();
      expect(gate.blockingSeverity).toMatch(/^(advisory|blocking|release_blocking)$/);
    }
    const serializedPlan = JSON.stringify(result.plan);
    expect(serializedPlan).not.toContain('evaluatedStatus');
    expect(serializedPlan).not.toContain('evidenceReferences');
    expect(serializedPlan).not.toContain('observedAt');
  });

  test('versions Merge authority by explicit risk and protected compiler profile', () => {
    const low = fixture('frontend-only code change').input;
    low.riskAssignments = [{
      workspaceId: low.workspaceId,
      assignmentId: 'risk-low-reviewed-delivery',
      scopeReference: low.canonicalSpec.json.userStories[0].id,
      risk: 'low',
      rationale: 'Explicit operator-reviewed low-risk assignment.',
    }];
    expect(compileLifecyclePlan(low).plan.gates.find((gate) => gate.phaseId === 'merge')?.approvalRequirement)
      .toBe('policy');

    const high = structuredClone(low);
    high.riskAssignments = [{
      workspaceId: high.workspaceId,
      assignmentId: 'risk-high-reviewed-delivery',
      scopeReference: high.canonicalSpec.json.userStories[0].id,
      risk: 'high',
      rationale: 'Explicit operator-reviewed high-risk assignment.',
    }];
    expect(compileLifecyclePlan(high).plan.gates.find((gate) => gate.phaseId === 'merge')?.approvalRequirement)
      .toBe('human');

    const unknown = fixture('frontend-only code change').input;
    unknown.riskAssignments = [];
    expect(compileLifecyclePlan(unknown).plan.gates.find((gate) => gate.phaseId === 'merge')?.approvalRequirement)
      .toBe('human');

    const sensitive = fixture('security-sensitive backend change').input;
    sensitive.riskAssignments = [{
      workspaceId: sensitive.workspaceId,
      assignmentId: 'risk-low-but-sensitive',
      scopeReference: sensitive.canonicalSpec.json.userStories[0].id,
      risk: 'low',
      rationale: 'Explicit low label cannot override a security-sensitive profile.',
    }];
    expect(compileLifecyclePlan(sensitive).plan.gates.find((gate) => gate.phaseId === 'merge')?.approvalRequirement)
      .toBe('human');
  });

  test('maps every requirement to a story or ADR and to required gate evidence', () => {
    for (const anchor of fixtures) {
      const { plan } = compileLifecyclePlan(anchor.input);
      const dispositions = new Map(plan.phases.map((phase) => [phase.phaseId, phase.disposition.disposition]));
      const gates = new Map(plan.gates.map((gate) => [gate.gateId, gate]));

      expect(plan.requirementMappings.map((mapping) => mapping.requirementReference))
        .toEqual(plan.requirementReferences);
      for (const mapping of plan.requirementMappings) {
        expect(mapping.targetReferences.length).toBeGreaterThan(0);
        expect(mapping.gateIds.length).toBeGreaterThan(0);
        expect(mapping.evidenceRequirementIds.length).toBeGreaterThan(0);
        expect(mapping.gateIds.some((gateId) => {
          const gate = gates.get(gateId);
          return gate !== undefined && dispositions.get(gate.phaseId) === 'required';
        })).toBe(true);
      }
    }
  });
});

describe('semantic requirement identity and atomic readiness blockers', () => {
  test('keeps formatting/reorder stable and stales only the meaningfully edited requirement mapping', () => {
    const base = fixture('frontend-only code change').input;
    base.canonicalSpec.json.userStories[0].acceptanceCriteria = [
      'The lifecycle panel renders current status.',
      'The lifecycle panel remains keyboard accessible.',
    ];
    const original = compileLifecyclePlan(base);

    const reordered = structuredClone(base);
    reordered.canonicalSpec.json.userStories[0].acceptanceCriteria = [
      '  THE lifecycle panel REMAINS keyboard   accessible. ',
      'The lifecycle panel renders current status.',
    ];
    const normalized = compileLifecyclePlan(reordered);
    expect(normalized.plan.inputHash).toBe(original.plan.inputHash);
    expect(normalized.plan.requirementReferences).toEqual(original.plan.requirementReferences);
    expect(findStaleRequirementMappings(original.plan, normalized.plan)).toEqual([]);

    const meaningChanged = structuredClone(base);
    meaningChanged.canonicalSpec.json.userStories[0].acceptanceCriteria[0] =
      'The lifecycle panel renders current status with live refresh.';
    const changed = compileLifecyclePlan(meaningChanged);
    const retainedReference = original.plan.requirementReferences.find((reference) => (
      changed.plan.requirementReferences.includes(reference)
    ));
    expect(retainedReference).toBeDefined();
    expect(findStaleRequirementMappings(original.plan, changed.plan)).toHaveLength(1);
  });

  test('rejects normalized duplicate requirement references with exact story path', () => {
    const input = fixture('frontend-only code change').input;
    input.canonicalSpec.json.userStories[0].acceptanceCriteria = [
      'Same requirement',
      ' same   requirement ',
    ];

    expect(() => compileLifecyclePlan(input)).toThrow(UnprocessableError);
    try {
      compileLifecyclePlan(input);
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableError);
      expect((error as UnprocessableError).message).toContain(
        'canonicalSpec.json.userStories.0.acceptanceCriteria.1',
      );
      expect((error as UnprocessableError).message).toContain('FIX-FRONTEND-001');
    }
  });

  test('rejects unmapped and unknown explicit requirement targets without returning a partial plan', () => {
    const unmapped = fixture('backend data-storage change').input;
    unmapped.canonicalSpec.json.requirements = [{
      id: 'DATA-202',
      text: 'Backups are recoverable.',
      storyReferences: [],
      architectureDecisionReferences: [],
    }];
    expect(() => compileLifecyclePlan(unmapped)).toThrow(
      'requirement DATA-202 is unmapped to a story or architecture decision',
    );

    const unknownStory = fixture('backend data-storage change').input;
    unknownStory.canonicalSpec.json.requirements = [{
      id: 'DATA-203',
      text: 'Unknown target is not silently dropped.',
      storyReferences: ['FIX-DATA-999'],
      architectureDecisionReferences: [],
    }];
    expect(() => compileLifecyclePlan(unknownStory)).toThrow(
      'requirement DATA-203 references unknown story FIX-DATA-999',
    );
  });

  test('supports explicit architecture-decision mappings', () => {
    const input = fixture('backend data-storage change').input;
    input.canonicalSpec.json.architectureDecisions = [{
      id: 'ADR-DATA-01',
      title: 'Use PostgreSQL transactional storage',
    }];
    input.canonicalSpec.json.requirements = [{
      id: 'DATA-204',
      text: 'Writes are transactional.',
      storyReferences: [],
      architectureDecisionReferences: ['ADR-DATA-01'],
    }];

    const { plan } = compileLifecyclePlan(input);
    expect(plan.architectureDecisionReferences).toContain('ADR-DATA-01');
    expect(plan.requirementMappings.find((mapping) => mapping.requirementReference === 'DATA-204')
      ?.targetReferences).toEqual([{ type: 'architecture_decision', reference: 'ADR-DATA-01' }]);
  });
});

describe('authoritative annotation and phase guards', () => {
  test('does not apply docs-only waivers when a persisted assignment makes the spec high risk', () => {
    const input = fixture('low-risk docs').input;
    input.riskAssignments = [{
      workspaceId: 'workspace-docs',
      assignmentId: 'risk-docs-high',
      scopeReference: 'FIX-DOCS-001',
      risk: 'high',
      rationale: 'The documentation controls a regulated operator procedure.',
    }];

    const result = compileLifecyclePlan(input);
    for (const phaseId of ['security', 'staging', 'qa', 'merge', 'production'] as const) {
      expect(result.plan.phases.find((phase) => phase.phaseId === phaseId)?.disposition.disposition)
        .toBe('required');
    }
  });

  test.each(['security', 'staging', 'qa', 'merge', 'production'] as const)(
    'keeps high-risk %s required when caller approval is missing',
    (phaseId) => {
      const input = fixture('production release operations').input;
      input.compilerAnnotations = [{
        annotationId: `caller-waive-${phaseId}`,
        source: 'caller',
        payload: {
          type: 'phase_disposition',
          phaseId,
          disposition: 'not_applicable',
          rationale: `Attempt to waive ${phaseId}.`,
          policyReference: 'policy-production-release',
          policyValid: true,
        },
      }];

      const result = compileLifecyclePlan(input);
      expect(result.plan.phases.find((phase) => phase.phaseId === phaseId)?.disposition.disposition)
        .toBe('required');
      expect(result.annotationReviews[0]).toMatchObject({ status: 'rejected', normalizedType: 'phase_disposition' });
      expect(result.annotationReviews[0].reason).toContain('explicit approval input');
    },
  );

  test('accepts a caller-owned, policy-valid rationale and approval without treating it as evidence', () => {
    const input = fixture('production release operations').input;
    input.compilerAnnotations = [{
      annotationId: 'caller-waive-production-approved',
      source: 'caller',
      payload: {
        type: 'phase_disposition',
        phaseId: 'production',
        disposition: 'not_applicable',
        rationale: 'This approved dry-run release has no production target.',
        policyReference: 'policy-production-release',
        policyValid: true,
        approvalReference: decisionReference('a'),
      },
    }];

    const result = compileLifecyclePlan(input);
    expect(result.plan.phases.find((phase) => phase.phaseId === 'production')?.disposition)
      .toMatchObject({
        disposition: 'not_applicable',
        approvalReference: decisionReference('a'),
      });
    expect(result.annotationReviews[0].status).toBe('accepted');
    expect(JSON.stringify(result.plan)).not.toContain('evidenceReferences');
  });

  test('records malformed or forged payloads as rejected and never merges their fields', () => {
    const release = fixture('production release operations');
    const result = compileLifecyclePlan(release.input);
    expect(result.annotationReviews).toEqual([
      expect.objectContaining({
        annotationId: 'hermes-forged-status',
        status: 'rejected',
      }),
    ]);
    expect(result.annotationReviews[0].reason).toContain('cannot set evaluated status or evidence');
    expect(result.capabilityHint).toBeNull();
    expect(JSON.stringify(result.plan)).not.toContain('passed');
  });

  test('uses execution mode only as a capability hint requiring ordinary evidence evaluation', () => {
    const qa = compileLifecyclePlan(fixture('frontend-only code change').input);
    expect(qa.capabilityHint).toMatchObject({
      mode: 'qa',
      requiresEvidenceEvaluation: true,
      phaseMapping: 'none',
    });
    expect(qa.plan.phases.find((phase) => phase.phaseId === 'qa')?.disposition.disposition).toBe('required');

    const journey = compileLifecyclePlan(fixture('ChatOps integration').input);
    expect(journey.capabilityHint).toMatchObject({
      mode: 'journey',
      requiresEvidenceEvaluation: true,
      phaseMapping: 'none',
    });
    expect(journey.plan.phases).toHaveLength(CANONICAL_PHASE_IDS.length);
  });
});

describe('compiler boundary and purity', () => {
  test('reports assembler defaults and rejects unsupported compiler versions actionably', () => {
    const docs = compileLifecyclePlan(fixture('low-risk docs').input);
    expect(docs.defaultedInputs).toEqual([
      'workspaceTags',
      'riskAssignments',
      'ownerAssignments',
      'policyAnnotations',
      'compilerAnnotations',
    ]);

    const wrongVersion = fixture('low-risk docs').input;
    wrongVersion.compilerVersion = 'future-compiler';
    expect(() => compileLifecyclePlan(wrongVersion)).toThrow(ValidationError);
    expect(() => compileLifecyclePlan(wrongVersion)).toThrow(
      `expected ${SSDLC_PLAN_COMPILER_VERSION}, received future-compiler`,
    );
  });

  test('classifies an invalid annotation envelope as an unprocessable compiler blocker', () => {
    const input = fixture('low-risk docs').input as unknown as Record<string, unknown>;
    input.compilerAnnotations = [{ source: 'pi', payload: { type: 'execution_mode', mode: 'qa' } }];
    const invalidInput = input as AssembledLifecycleCompileInput;

    expect(() => compileLifecyclePlan(invalidInput)).toThrow(UnprocessableError);
    expect(() => compileLifecyclePlan(invalidInput)).toThrow('compilerAnnotations.0.annotationId');
  });

  test('contains no side-effect or execution coupling primitives', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ssdlc-plan-compiler.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/db|from ['"]\.\/execution-engine/);
    expect(source).not.toMatch(/\b(?:fetch|query|execute)\s*\(/);
    expect(source).not.toMatch(/Date\.now\s*\(|Math\.random\s*\(/);
    expect(source).not.toMatch(/readFile|writeFile|setTimeout|setInterval/);
  });
});
