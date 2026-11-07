/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  ANTI_FALSE_POSITIVE_CLAUSE,
  BOUNTY_ROUTE_DEFINITIONS,
  BOUNTY_ROUTE_FIXTURES,
  BOUNTY_STATIC_PREFIX_HASHES,
  getBountyStaticPromptPrefix,
  routeBountyWorkPackages,
  type BountyRouteInput,
  type BountyObjectiveClass,
} from '../bounty-work-package-router';
import { BOUNTY_CAPABILITIES, hashBountyContract } from '../bounty-contracts';

const hash = (seed: string): string => `sha256:${createHash('sha256').update(seed).digest('hex')}`;

function inputFor(objectiveClass: BountyObjectiveClass, evidenceType?: BountyRouteInput['evidenceRefs'][number]['evidenceType']): BountyRouteInput {
  const definition = BOUNTY_ROUTE_DEFINITIONS.find((entry) => entry.objectiveClass === objectiveClass)!;
  const observedType = evidenceType ?? definition.evidenceTypes[0];
  return {
    version: 'bounty-route.v1', missionId: '00000000-0000-4000-8000-000000000001',
    objective: { id: `objective-${objectiveClass}`, objectiveClass, summaryHash: hash(`objective:${objectiveClass}`) },
    phase: definition.phase, role: `role-${objectiveClass}`,
    targets: [{ targetId: 'target-1', targetKind: 'service', targetHash: hash('target-1') }],
    accountRoles: ['researcher', 'anonymous'],
    evidenceRefs: [{ evidenceId: 'evidence-1', evidenceType: observedType, evidenceHash: hash(`evidence:${observedType}`), contextTokens: 1_000 }],
    outputSchema: { schemaId: 'finding-output.v1', schemaHash: hash('output') },
    effectBudget: { maxOperations: 3, maxCostCents: 100, allowedCapabilities: [...BOUNTY_CAPABILITIES] },
    availableCapabilities: [...BOUNTY_CAPABILITIES],
    skillManifests: [{
      skillId: `skill-${objectiveClass}`, manifestHash: hash(`manifest:${objectiveClass}`), contentHash: hash(`content:${objectiveClass}`),
      objectiveClasses: [objectiveClass], phases: [definition.phase], evidenceTypes: [observedType],
      capabilities: [...definition.capabilities], contextTokens: objectiveClass === 'whitebox-focused-review' ? 7_000 : 5_000,
      priority: 10, staticPromptPrefixId: definition.prefixId,
      staticPromptPrefixHash: BOUNTY_STATIC_PREFIX_HASHES[definition.prefixId], available: true,
    }],
    authorityHashes: { missionHash: hash('mission'), scopeHash: hash('scope'), grantHash: hash('grant'), modelPolicyHash: hash('model-policy'), runtimeHash: hash('runtime') },
  };
}

test('all 16 routes have executable positive/negative fixtures and explicit successor edges', () => {
  assert.equal(BOUNTY_ROUTE_DEFINITIONS.length, 16);
  assert.equal(BOUNTY_ROUTE_FIXTURES.length, 16);
  for (const fixture of BOUNTY_ROUTE_FIXTURES) {
    const positive = routeBountyWorkPackages(inputFor(fixture.objectiveClass, fixture.positiveEvidenceType));
    assert.equal(positive.canCreate, true, `${fixture.objectiveClass} positive fixture`);
    if (positive.canCreate) assert.deepEqual(positive.packages[0].successorObjectiveClasses, fixture.successorObjectiveClasses);

    const negative = routeBountyWorkPackages(inputFor(fixture.objectiveClass, fixture.negativeEvidenceType));
    assert.equal(negative.canCreate, false, `${fixture.objectiveClass} negative fixture`);
    assert.ok(negative.reasonCodes.includes('EVIDENCE_TYPE_UNSUPPORTED'));
  }
});

test('identical input hashes produce identical ordered routes and reason codes', () => {
  const input = inputFor('authorization-testing');
  input.skillManifests.push({
    ...input.skillManifests[0], skillId: 'skill-first', priority: 1,
    manifestHash: hash('manifest:first'), contentHash: hash('content:first'),
  });
  const first = routeBountyWorkPackages(structuredClone(input));
  const second = routeBountyWorkPackages(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.inputHash, hashBountyContract('route-input', { policyHash: first.policyHash, input }));
  assert.equal(first.routeHash, second.routeHash);
  assert.equal(first.canCreate, true);
  if (first.canCreate) {
    assert.deepEqual(first.packages[0].selectedSkills.map((skill) => skill.skillId), ['skill-first', 'skill-authorization-testing']);
    assert.deepEqual(first.reasonCodes, second.reasonCodes);
  }
});

test('unsupported or unauthorized capabilities block package creation with stable reasons', () => {
  const unavailableInput = inputFor('active-verification');
  unavailableInput.availableCapabilities = unavailableInput.availableCapabilities.filter((entry) => entry !== 'target:test');
  const unavailable = routeBountyWorkPackages(unavailableInput);
  assert.equal(unavailable.canCreate, false);
  assert.ok(unavailable.reasonCodes.includes('CAPABILITY_UNAVAILABLE'));
  assert.deepEqual(unavailable.reports.availability.unavailableRequiredCapabilities, ['target:test']);
  assert.equal(unavailable.reports.authorization.authorized, true);
  assert.deepEqual(unavailable.reports.authorization.unauthorizedCapabilities, []);
  assert.deepEqual(unavailable.reports.effects, { status: 'not-executed', actualOperations: 0, actualCostCents: 0, receiptHashes: [] });
  assert.equal(unavailable.telemetry.cache.status, 'blocked');
  assert.equal(unavailable.telemetry.context.plannedPartCount, 0);

  const unauthorizedInput = inputFor('active-verification');
  unauthorizedInput.effectBudget.allowedCapabilities = unauthorizedInput.effectBudget.allowedCapabilities.filter((entry) => entry !== 'target:test');
  const unauthorized = routeBountyWorkPackages(unauthorizedInput);
  assert.equal(unauthorized.canCreate, false);
  assert.ok(unauthorized.reasonCodes.includes('CAPABILITY_UNAUTHORIZED'));
  assert.deepEqual(unauthorized.reports.availability.unavailableRequiredCapabilities, []);
  assert.equal(unauthorized.reports.authorization.authorized, false);
  assert.deepEqual(unauthorized.reports.authorization.unauthorizedCapabilities, ['target:test']);
  assert.equal(unauthorized.telemetry.model.routePolicyHash, unauthorized.policyHash);
});

test('skill capability availability and authorization omissions remain distinct', () => {
  const unauthorizedInput = inputFor('program-intake');
  unauthorizedInput.effectBudget.allowedCapabilities = unauthorizedInput.effectBudget.allowedCapabilities.filter((entry) => entry !== 'finding:draft');
  unauthorizedInput.skillManifests.push({
    ...unauthorizedInput.skillManifests[0], skillId: 'skill-needs-unauthorized-capability', priority: 20,
    manifestHash: hash('manifest:unauthorized'), contentHash: hash('content:unauthorized'),
    capabilities: ['repository:read', 'finding:draft'],
  });
  const unauthorized = routeBountyWorkPackages(unauthorizedInput);
  assert.equal(unauthorized.canCreate, true);
  assert.ok(unauthorized.reports.routing.omitted.some((omission) => omission.reasonCode === 'SKILL_CAPABILITY_UNAUTHORIZED'));
  assert.equal(unauthorized.reports.authorization.authorized, true, 'selected route capabilities remain authorized');
  assert.deepEqual(unauthorized.reports.availability.unavailableRequiredCapabilities, []);

  const unavailableInput = structuredClone(unauthorizedInput);
  unavailableInput.effectBudget.allowedCapabilities = [...BOUNTY_CAPABILITIES];
  unavailableInput.availableCapabilities = unavailableInput.availableCapabilities.filter((entry) => entry !== 'finding:draft');
  const unavailable = routeBountyWorkPackages(unavailableInput);
  assert.equal(unavailable.canCreate, true);
  assert.ok(unavailable.reports.routing.omitted.some((omission) => omission.reasonCode === 'SKILL_CAPABILITY_UNAVAILABLE'));
  assert.ok(!unavailable.reports.routing.omitted.some((omission) => omission.reasonCode === 'SKILL_CAPABILITY_UNAUTHORIZED'));
});

test('database and pinned identities are rejected before hashing or routing', () => {
  const invalidMission = inputFor('program-intake');
  invalidMission.missionId = 'not-a-database-uuid';
  assert.throws(() => routeBountyWorkPackages(invalidMission), /Invalid UUID/);

  const duplicateTarget = inputFor('program-intake');
  duplicateTarget.targets.push({ ...duplicateTarget.targets[0] });
  assert.throws(() => routeBountyWorkPackages(duplicateTarget), /duplicate pinned identity/);

  const duplicateManifest = inputFor('program-intake');
  duplicateManifest.skillManifests.push({
    ...duplicateManifest.skillManifests[0],
    skillId: 'different-name-for-same-manifest',
  });
  assert.throws(() => routeBountyWorkPackages(duplicateManifest), /duplicate pinned identity/);
});

test('ordinary context publishes 25-30K targets and splits above 40K', () => {
  const input = inputFor('program-intake');
  input.skillManifests[0].contextTokens = 21_000;
  input.skillManifests.push({
    ...input.skillManifests[0], skillId: 'skill-program-intake-two', priority: 20,
    manifestHash: hash('manifest:two'), contentHash: hash('content:two'),
  });
  const routed = routeBountyWorkPackages(input);
  assert.equal(routed.canCreate, true);
  if (!routed.canCreate) return;
  assert.equal(routed.packages.length, 2);
  assert.ok(routed.reasonCodes.includes('CONTEXT_SPLIT'));
  for (const workPackage of routed.packages) {
    assert.deepEqual([workPackage.context.targetMinTokens, workPackage.context.targetTokens, workPackage.context.targetMaxTokens], [25_000, 28_000, 30_000]);
    assert.ok(workPackage.context.totalTokens <= 40_000);
    assert.equal(workPackage.omissions.filter((omission) => omission.reasonCode === 'CONTEXT_SPLIT').length, 1);
  }

  const unsplittable = inputFor('program-intake');
  unsplittable.skillManifests[0].contextTokens = 40_000;
  const blocked = routeBountyWorkPackages(unsplittable);
  assert.equal(blocked.canCreate, false);
  assert.deepEqual(blocked.reasonCodes, ['CONTEXT_LIMIT_EXCEEDED']);
});

test('whitebox focused and synthesis limits are exactly 8K and 32K', () => {
  const focused = routeBountyWorkPackages(inputFor('whitebox-focused-review'));
  assert.equal(focused.canCreate, true);
  if (focused.canCreate) assert.equal(focused.packages[0].context.hardLimitTokens, 8_000);

  const synthesisInput = inputFor('whitebox-synthesis');
  synthesisInput.skillManifests[0].contextTokens = 31_000;
  const synthesis = routeBountyWorkPackages(synthesisInput);
  assert.equal(synthesis.canCreate, true);
  if (synthesis.canCreate) assert.equal(synthesis.packages[0].context.hardLimitTokens, 32_000);

  const tooLarge = inputFor('whitebox-focused-review');
  tooLarge.skillManifests[0].contextTokens = 7_001;
  const blocked = routeBountyWorkPackages(tooLarge);
  assert.equal(blocked.canCreate, false);
  assert.deepEqual(blocked.reasonCodes, ['CONTEXT_LIMIT_EXCEEDED']);
});

test('static prefixes are hash-pinned, anti-FP first, and contain no route values', () => {
  for (const definition of BOUNTY_ROUTE_DEFINITIONS) {
    const prefix = getBountyStaticPromptPrefix(definition.prefixId);
    assert.equal(prefix.split('\n')[0], ANTI_FALSE_POSITIVE_CLAUSE);
    assert.ok(!prefix.includes('00000000-0000-4000-8000-000000000001'));
    assert.ok(!prefix.includes('target-1'));
    assert.equal(BOUNTY_STATIC_PREFIX_HASHES[definition.prefixId], hashBountyContract('static-prompt-prefix', prefix));
  }
});

test('model proposals, including unsupported values, are advisory and authority dimensions stay separate', () => {
  const input = inputFor('program-intake');
  input.modelProposal = { objectiveClass: 'model-invented-objective', modelTier: 'unbounded-supermodel' };
  const routed = routeBountyWorkPackages(input);
  assert.equal(routed.canCreate, true);
  if (!routed.canCreate) return;
  const workPackage = routed.packages[0];
  assert.equal(workPackage.objective.objectiveClass, 'program-intake');
  assert.equal(workPackage.modelTier, 'standard');
  assert.equal(workPackage.telemetry.model.proposalAuthorized, false);
  assert.equal(workPackage.telemetry.model.routePolicyHash, routed.policyHash);
  assert.equal(routed.telemetry.model.authorityPolicyHash, input.authorityHashes.modelPolicyHash);
  assert.equal(routed.telemetry.cache.status, 'eligible');
  assert.ok(routed.reasonCodes.includes('MODEL_PROPOSAL_IGNORED'));
  assert.deepEqual(Object.keys(workPackage.reports), ['availability', 'routing', 'authorization', 'effects']);
  assert.deepEqual(workPackage.reports.effects, { status: 'not-executed', actualOperations: 0, actualCostCents: 0, receiptHashes: [] });
  assert.equal(workPackage.telemetry.cache.routeKey, routed.inputHash);
  assert.equal(workPackage.telemetry.context.selectedTokens, workPackage.context.totalTokens);
  assert.deepEqual(workPackage.objective, input.objective);
  assert.equal(workPackage.role, input.role);
  assert.deepEqual(workPackage.targetTuples, input.targets);
  assert.equal('targets' in workPackage, false);
  assert.deepEqual(workPackage.accountRoles, ['anonymous', 'researcher']);
  assert.deepEqual(workPackage.evidenceRefs, input.evidenceRefs);
  assert.deepEqual(workPackage.outputSchema, input.outputSchema);
  assert.deepEqual(workPackage.effectBudget, input.effectBudget);
  assert.ok(workPackage.selectedHashes.includes(input.objective.summaryHash));
  assert.ok(workPackage.selectedHashes.includes(hashBountyContract('effect-budget', input.effectBudget)));
});
