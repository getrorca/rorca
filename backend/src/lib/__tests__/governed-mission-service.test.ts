/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { classifyDeltaReuse, evaluateContextEpochRetirement, evaluateEvidenceStatusPolicy, maximumWorkPackageAuthorityCeilings } from '../governed-mission-service';

const allowed = {
  stableScopeMatches: true, baseAvailable: true, baseIntegrityValid: true, versionSupported: true,
  redactionUncertain: false, chainDepth: 8, targetBytesMatch: true, targetHashMatches: true,
  onlyAllowedDifferences: true, gitDescendantProved: true, interveningPathsAllowed: true,
};

test('stale-base delta is used only for byte-exact verified reconstruction', () => {
  expect(classifyDeltaReuse(allowed)).toEqual({ mode: 'delta', reason: 'verified_reconstruction' });
});

test.each([
  ['baseAvailable', false, 'base_missing'], ['baseIntegrityValid', false, 'base_corrupt'],
  ['versionSupported', false, 'unsupported_version'], ['stableScopeMatches', false, 'stable_scope_changed'],
  ['redactionUncertain', true, 'redaction_uncertain'], ['chainDepth', 9, 'delta_chain_exceeded'],
  ['onlyAllowedDifferences', false, 'forbidden_difference'], ['gitDescendantProved', false, 'git_or_path_unverified'],
  ['interveningPathsAllowed', false, 'git_or_path_unverified'], ['targetBytesMatch', false, 'target_reconstruction_mismatch'],
  ['targetHashMatches', false, 'target_reconstruction_mismatch'],
] as const)('stale-base dimension %s forces a new full bundle', (field, value, reason) => {
  expect(classifyDeltaReuse({ ...allowed, [field]: value })).toEqual({ mode: 'full', reason });
});

test.each([
  ['passed','passed','satisfied'],
  ['passed','failed','failed'],
  ['failed','failed','failed'],
  ['failed','passed','failed'],
  ['passed','unknown','conflicting'],
  ['failed','conflicted','conflicting'],
] as const)('required %s with observed %s resolves to %s', (required,observed,outcome) => {
  expect(evaluateEvidenceStatusPolicy(required,observed)).toBe(outcome);
});

test('every work-package category stays at or below every mission execution ceiling across posture booleans',()=>{
  const ceilings=['none','observe','propose','execute_bounded'] as const;
  for(const execution of ceilings){
    for(const autoMerge of [false,true])for(const deployment of [false,true])for(const providerMutation of [false,true]){
      const actual=maximumWorkPackageAuthorityCeilings({execution,autoMerge,deployment,providerMutation});
      for(const maximum of Object.values(actual))expect(ceilings.indexOf(maximum)).toBeLessThanOrEqual(ceilings.indexOf(execution));
      expect(actual.delivery).toBe(ceilings[Math.min(ceilings.indexOf(execution),ceilings.indexOf(autoMerge?'execute_bounded':'propose'))]);
      expect(actual.operational).toBe(ceilings[Math.min(ceilings.indexOf(execution),ceilings.indexOf(deployment||providerMutation?'execute_bounded':'observe'))]);
      expect(actual.knowledge).toBe(execution);
      expect(actual.interactive).toBe(ceilings[Math.min(ceilings.indexOf(execution),ceilings.indexOf(providerMutation?'execute_bounded':'propose'))]);
    }
  }
});

test('ContextEpoch retirement requires every two-minor/90-day/zero-use/client/fixture/break/review gate', () => {
  const passing = { consecutiveMinorReleases: 2, daysSinceWriteCurrent: 90, zeroReadDays: 30,
    supportedConsumersRemaining: 0, migrationFixturesPass: true, rollbackFixturesPass: true,
    breakMarkersPresent: true, releaseNotesPresent: true, nextMajorDeclared: true, independentReviewAccepted: true };
  expect(evaluateContextEpochRetirement(passing)).toEqual(expect.objectContaining({ eligible: true, failedReasons: [] }));
  for (const field of Object.keys(passing)) {
    const value = typeof passing[field as keyof typeof passing] === 'boolean' ? false : field === 'supportedConsumersRemaining' ? 1 : 0;
    expect(evaluateContextEpochRetirement({ ...passing, [field]: value }).eligible).toBe(false);
  }
});
