/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import controlsArtifact from '../../catalog/controls.json';
import type { StageReadiness } from '../../gates/gate-compiler';
import { parseControl } from '../../schema/control-schema';
import { StructuredFindingStore } from '../findings';
import { SkillRegistry } from '../skill-registry';

const controls = controlsArtifact.map((control) => parseControl(control));
const traceability = controls.find(({ controlId }) => controlId === 'CTRL-REQUIREMENTS-TRACEABILITY')!;

function readiness(): StageReadiness[] {
  return [{
    stage: 'requirements',
    phases: ['requirements'],
    controlIds: [traceability.controlId],
    unresolvedControlIds: [],
    approvalControlIds: [],
    blocking: false,
    status: 'ready',
  }];
}

function finding(status: 'pass' | 'fail' | 'blocker' = 'pass') {
  return {
    findingId: `finding-${status}`,
    controlId: traceability.controlId,
    skillId: traceability.skillRefs[0],
    storyId: 'US-006',
    status,
    evidenceRefs: ['evidence:phase-review:1'],
    message: `${status} from AAV phase review`,
  };
}

test('binds a skill to a catalog control and resolves its current version', () => {
  const registry = new SkillRegistry(controls);
  registry.bindSkill({
    skillId: traceability.skillRefs[0], name: 'Traceability', version: '1.0.0',
    controlIds: [traceability.controlId], implementationRef: 'skills/traceability.ts',
  });

  const [resolved] = registry.resolveSkillRefs(traceability);
  assert.equal(resolved.skillId, traceability.skillRefs[0]);
  assert.equal(resolved.version, '1.0.0');
  assert.equal(registry.getSkill(resolved.skillId)?.implementationRef, 'skills/traceability.ts');
});

test('rejects skill bindings to controls outside the US-001 catalog', () => {
  const registry = new SkillRegistry(controls);
  assert.throws(() => registry.bindSkill({
    skillId: 'aav:unknown', name: 'Unknown', version: '1.0.0',
    controlIds: ['CTRL-NOT-IN-CATALOG'], implementationRef: 'skills/unknown.ts',
  }), /CTRL-NOT-IN-CATALOG/);
});

test('names an unresolved stable skill reference', () => {
  const registry = new SkillRegistry(controls);
  assert.throws(() => registry.resolveSkillRefs(traceability), /rorca:requirements-traceability/);
});

test('upgrades the resolved version without changing the control skillRefs', () => {
  const registry = new SkillRegistry(controls);
  const originalRefs = [...traceability.skillRefs];
  const base = {
    skillId: traceability.skillRefs[0], name: 'Traceability',
    controlIds: [traceability.controlId], implementationRef: 'skills/traceability.ts',
  };
  registry.bindSkill({ ...base, version: '1.0.0' });
  registry.bindSkill({ ...base, version: '2.0.0', implementationRef: 'skills/traceability-v2.ts' });

  const [resolved] = registry.resolveSkillRefs(traceability);
  assert.deepEqual(traceability.skillRefs, originalRefs);
  assert.equal(resolved.version, '2.0.0');
  assert.match(resolved.upgradeNote ?? '', /1\.0\.0.*2\.0\.0.*stable/);
});

test('stores a blocker finding intact and blocks its active US-004 stage', () => {
  const store = new StructuredFindingStore();
  const blocker = finding('blocker');
  const compilation = { readiness: readiness() };
  const result = store.ingestFindings({
    findings: [blocker], controls, activeControlIds: [traceability.controlId], compilation,
  });

  assert.equal(result.gateVerdict, 'blocked');
  assert.equal(result.readiness[0].status, 'blocked');
  assert.equal(result.readiness[0].blocking, true);
  assert.deepEqual(compilation.readiness, readiness(), 'US-004 input remains immutable');
  assert.deepEqual(store.getFinding(blocker.findingId), blocker);
  assert.deepEqual(result.findings[0], blocker);
});

test('keeps a pass verdict when every finding passes', () => {
  const result = new StructuredFindingStore().ingestFindings({
    findings: [finding('pass')], controls, activeControlIds: [traceability.controlId],
    compilation: { readiness: readiness() },
  });
  assert.equal(result.gateVerdict, 'pass');
  assert.equal(result.readiness[0].status, 'ready');
});

test('rejects missing controlId, missing skillId, and alternate phase-review shapes atomically', () => {
  const input = {
    controls, activeControlIds: [traceability.controlId], compilation: { readiness: readiness() },
  };
  const valid = finding('pass');
  const { controlId: _controlId, ...withoutControl } = valid;
  const { skillId: _skillId, ...withoutSkill } = valid;

  assert.throws(() => new StructuredFindingStore().ingestFindings({ ...input, findings: [withoutControl] }), /controlId/);
  assert.throws(() => new StructuredFindingStore().ingestFindings({ ...input, findings: [withoutSkill] }), /skillId/);

  const store = new StructuredFindingStore();
  assert.throws(() => store.ingestFindings({
    ...input,
    findings: [valid, { ...valid, findingId: 'alternate-shape', phaseReview: { verdict: 'pass' } }],
  }), /unrecognized key/i);
  assert.deepEqual(store.listFindings(), [], 'an alternate shape rejects the complete phase-review batch');
});

test('rejects findings that do not identify valid control-skill and evidence bindings', () => {
  const input = {
    controls, activeControlIds: [traceability.controlId], compilation: { readiness: readiness() },
  };
  const valid = finding('pass');
  const store = new StructuredFindingStore();

  assert.throws(() => store.ingestFindings({
    ...input,
    findings: [{ ...valid, controlId: 'CTRL-NOT-IN-CATALOG' }],
  }), /CTRL-NOT-IN-CATALOG/);
  assert.throws(() => store.ingestFindings({
    ...input,
    findings: [{ ...valid, skillId: 'aav:not-bound-to-control' }],
  }), /not referenced by control/);
  assert.throws(() => store.ingestFindings({
    ...input,
    findings: [{ ...valid, evidenceRefs: [] }],
  }), /evidenceRefs/);
  assert.deepEqual(store.listFindings(), [], 'invalid findings never partially populate the canonical store');
});
