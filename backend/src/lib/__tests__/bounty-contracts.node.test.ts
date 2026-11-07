/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOUNTY_CONTRACT_VERSION,
  MissionContractSchema,
  WorkPackageSchema,
  canonicalizeBountyValue,
  hashBountyContract,
  issueMissionContract,
  parseCanonicalJson,
} from '../bounty-contracts';

const H = `sha256:${'a'.repeat(64)}`;
const authority = { version: BOUNTY_CONTRACT_VERSION, kind: 'mission' as const, id: 'mission-1', issuedAt: '2026-01-01T00:00:00.000Z', workspaceId: 'ws-1', programId: 'program-1' };
const content = {
  sourceCitations: [{ sourceId: 'source-1', sourceHash: H, locator: 'policy#scope' }],
  scope: { includedTargetIds: ['target-1'], excludedTargetIds: ['target-2'] },
  capabilities: ['repository:read' as const],
  skillHashes: [H], modelHash: H, runtimeHash: H,
  budget: { maximum: { currency: 'USD', minorUnits: 10000 }, maxOperations: 20 },
  retentionDays: 30, expiresAt: '2099-01-02T00:00:00.000Z',
};

test('golden valid mission is strict, bounded, and authority is trusted', () => {
  const mission = issueMissionContract(authority, content);
  assert.equal(mission.workspaceId, 'ws-1');
  assert.throws(() => MissionContractSchema.parse({ ...mission, surprise: true }));
  assert.equal(issueMissionContract(authority, { ...content, workspaceId: 'attacker' } as never).workspaceId, 'ws-1');
});

test('golden stale, ambiguous, contradictory, oversized, and out-of-scope contracts reject', () => {
  assert.throws(() => MissionContractSchema.parse({ ...authority, ...content, expiresAt: '2020-01-01T00:00:00.000Z' }));
  assert.throws(() => MissionContractSchema.parse({ ...authority, ...content, capabilities: ['shell:anything'] }));
  assert.throws(() => MissionContractSchema.parse({ ...authority, ...content, scope: { includedTargetIds: ['same'], excludedTargetIds: ['same'] } }));
  assert.throws(() => MissionContractSchema.parse({ ...authority, ...content, sourceCitations: Array.from({ length: 65 }, () => content.sourceCitations[0]) }));
  assert.throws(() => MissionContractSchema.parse({ ...authority, ...content, scope: { includedTargetIds: [], excludedTargetIds: [] } }));
});

test('canonical hashes specify Unicode, numbers, arrays, null, absent and domains', () => {
  const left = { z: null, name: 'e\u0301', number: -0, array: [2, 1] };
  const right = { array: [2, 1], number: 0, name: 'é', z: null };
  assert.equal(canonicalizeBountyValue(left), canonicalizeBountyValue(right));
  assert.equal(hashBountyContract('mission', left), hashBountyContract('mission', right));
  assert.notEqual(hashBountyContract('mission', left), hashBountyContract('evidence', left));
  assert.throws(() => canonicalizeBountyValue({ absent: undefined }));
  assert.throws(() => canonicalizeBountyValue(Number.POSITIVE_INFINITY));
});

test('governed work package binds objective, targets, roles, evidence, schema, effects, context, model and selected hashes', () => {
  const workPackage = WorkPackageSchema.parse({
    version: BOUNTY_CONTRACT_VERSION, kind: 'workPackage', id: 'package-1', issuedAt: '2026-01-01T00:00:00.000Z',
    missionId: 'mission-1', routeInputHash: H, routeHash: H, routePolicyHash: H,
    objective: { id: 'objective-1', objectiveClass: 'scope-validation', summaryHash: H },
    phase: 'scope', role: 'scope-reviewer',
    targetTuples: [{ targetId: 'target-1', targetKind: 'service', targetHash: H }],
    accountRoles: ['researcher'], evidenceRefs: [{ evidenceId: 'evidence-1', evidenceType: 'scope-record', evidenceHash: H }],
    outputSchema: { schemaId: 'scope-output.v1', schemaHash: H },
    effectBudget: { maxOperations: 0, maxCostCents: 0, allowedCapabilities: ['repository:read'] },
    selectedHashes: [H], contextCost: { selectedTokens: 7000, evidenceTokens: 1000, totalTokens: 8000 }, modelTier: 'standard',
  });
  assert.equal(workPackage.objective.id, 'objective-1');
  assert.throws(() => WorkPackageSchema.parse({ ...workPackage, instructions: 'unbound model prose' }));
  assert.throws(() => WorkPackageSchema.parse({ ...workPackage, contextCost: { ...workPackage.contextCost, totalTokens: 7999 } }));
});

test('duplicate JSON keys reject per object, including NFC-equivalent keys', () => {
  assert.throws(() => parseCanonicalJson('{"a":1,"a":2}'));
  assert.throws(() => parseCanonicalJson('{"é":1,"e\\u0301":2}'));
  assert.deepEqual(parseCanonicalJson('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
});
