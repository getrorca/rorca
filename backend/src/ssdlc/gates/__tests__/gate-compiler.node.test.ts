/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASES, type Phase } from '../../schema/control-schema';
import { completeApplicability, completeGateControls } from '../__fixtures__/gate-controls';
import { FAMILY_MAP, MISSION_STAGES, compileGates } from '../gate-compiler';

// Keep this independent of FAMILY_MAP so a removed or renamed mandatory family cannot make both
// the generated fixture and its assertion drift together.
const expectedFamilies = {
  planning: ['need-validity', 'scope-boundaries', 'risk-classification'],
  requirements: ['completeness', 'verifiability', 'traceability', 'quality-attributes'],
  design: ['architecture-decisions', 'quality-attribute-design', 'threat-model', 'dependency-boundaries'],
  development: ['secure-coding', 'code-review', 'change-traceability', 'unit-verification'],
  testing: [
    'requirements-verification', 'regression-testing', 'quality-attribute-verification',
    'threat-control-verification', 'authz-boundaries', 'secrets', 'supply-chain', 'vulnerability-response',
    'acceptance-validation', 'independent-evidence-review',
  ],
  deployment: [
    'deployment-readiness', 'environment-parity', 'release-evidence',
    'change-approval', 'protected-integration', 'evidence-completeness',
    'release-approval', 'deployment-verification', 'rollback-readiness', 'observability',
  ],
  maintenance: ['incident-analysis', 'prediction-vs-outcome', 'delivery-metrics', 'control-effectiveness', 'improvement-candidates'],
} as const satisfies Readonly<Record<Phase, readonly string[]>>;

const expectedStagePhases = PHASES.map((phase) => [phase]);

test('compiles every mandatory family into exactly seven ordered canonical phase groups', () => {
  const result = compileGates(completeGateControls, completeApplicability);

  assert.equal(result.phaseGroups.length, 7);
  assert.deepEqual(result.phaseGroups.map(({ phase }) => phase), [...PHASES]);
  assert.deepEqual(FAMILY_MAP, expectedFamilies);
  assert.deepEqual(result.missingFamilies, []);
  for (const group of result.phaseGroups) {
    assert.deepEqual(Object.keys(group.families), [...expectedFamilies[group.phase]]);
    assert.ok(group.controlIds.length > 0);
    assert.ok(group.controlIds.every((id) => Object.values(group.families).some((ids) => ids.includes(id))));
    assert.ok(group.evidenceRequirements.length > 0);
  }
});

test('projects canonical phases into seven ordered Mission stages', () => {
  const result = compileGates({
    controls: completeGateControls,
    applicability: completeApplicability,
    resolvedControlIds: completeApplicability.activeControlIds,
  });

  assert.deepEqual(result.readiness.map(({ stage }) => stage), [...MISSION_STAGES]);
  assert.deepEqual(result.readiness.map(({ phases }) => phases), expectedStagePhases);
  assert.ok(result.readiness.every(({ status }) => status === 'ready' || status === 'non-blocking'));
});

test('blocks unresolved controls only in their projected stage and never blocks maintenance', () => {
  const planningId = completeGateControls.find(({ phase }) => phase === 'planning')!.controlId;
  const maintenanceId = completeGateControls.find(({ phase }) => phase === 'maintenance')!.controlId;
  const result = compileGates({
    controls: completeGateControls,
    applicability: completeApplicability,
    unresolvedControlIds: [planningId, maintenanceId],
  });

  const planning = result.readiness.find(({ stage }) => stage === 'planning')!;
  const maintenance = result.readiness.find(({ stage }) => stage === 'maintenance')!;
  assert.equal(planning.blocking, true);
  assert.deepEqual(planning.unresolvedControlIds, [planningId]);
  assert.ok(result.readiness.filter(({ stage }) => stage !== 'planning' && stage !== 'maintenance').every(({ blocking }) => !blocking));
  assert.deepEqual(maintenance.unresolvedControlIds, [maintenanceId]);
  assert.equal(maintenance.blocking, false);
  assert.equal(maintenance.status, 'non-blocking');
});

test('keeps evidence and governed-exception approvals inside their projected stage', () => {
  const controls = structuredClone(completeGateControls);
  const evidenceApproval = controls.find(({ phase }) => phase === 'deployment')!;
  evidenceApproval.requiredEvidence[0].classification = 'approval';
  const exceptionApprovals = controls
    .filter(({ phase, exceptionPolicy }) => phase === 'testing' && exceptionPolicy.approvalRequired)
    .map(({ controlId }) => controlId);

  const result = compileGates(controls, completeApplicability, {
    resolvedControlIds: completeApplicability.activeControlIds,
  });

  assert.deepEqual(result.readiness.find(({ stage }) => stage === 'testing')!.approvalControlIds, exceptionApprovals);
  assert.deepEqual(result.readiness.find(({ stage }) => stage === 'deployment')!.approvalControlIds, [evidenceApproval.controlId]);
  assert.ok(result.readiness
    .filter(({ stage }) => stage !== 'testing' && stage !== 'deployment')
    .every(({ approvalControlIds }) => approvalControlIds.length === 0));
});

test('retains US-001 evidence structure and applies each US-003 evidence depth', () => {
  const result = compileGates(completeGateControls, completeApplicability);
  const expectedDepth = {
    'self-attestation': 'declaration',
    artifact: 'demonstrated',
    'independent-verification': 'independent-verification',
  } as const;

  for (const requirement of result.phaseGroups.flatMap(({ evidenceRequirements }) => evidenceRequirements)) {
    const source = completeGateControls.find(({ controlId }) => controlId === requirement.controlId)!;
    const resolvedDepth = completeApplicability.evidenceDepthByControlId[requirement.controlId];
    assert.equal(requirement.evidenceDepth, expectedDepth[resolvedDepth]);
    assert.deepEqual(requirement.sourceReferences, source.sourceReferences);
    assert.equal(requirement.classification, source.requiredEvidence[0].classification);
    assert.deepEqual(requirement.requiredBindings, source.requiredEvidence[0].requiredBindings);
  }
});

test('reports a missing testing independent-evidence-review family', () => {
  const omitted = completeGateControls.find(({ phase, skillRefs }) =>
    phase === 'testing' && skillRefs.includes('family:testing/independent-evidence-review'),
  )!;
  const controls = completeGateControls.filter(({ controlId }) => controlId !== omitted.controlId);
  const applicability = {
    activeControlIds: completeApplicability.activeControlIds.filter((id) => id !== omitted.controlId),
    evidenceDepthByControlId: completeApplicability.evidenceDepthByControlId,
  };

  const result = compileGates(controls, applicability);
  assert.ok(result.missingFamilies.some(({ phase, family }) =>
    phase === 'testing' && family === 'independent-evidence-review',
  ));
  assert.deepEqual(
    result.phaseGroups.find(({ phase }) => phase === 'testing')!.missingFamilies,
    ['independent-evidence-review'],
  );
});

test('fails closed when US-003 selects an unknown catalog control', () => {
  assert.throws(() => compileGates(completeGateControls, {
    activeControlIds: [...completeApplicability.activeControlIds, 'CTRL-UNKNOWN'],
    evidenceDepthByControlId: completeApplicability.evidenceDepthByControlId,
  }), /CTRL-UNKNOWN/);
});
