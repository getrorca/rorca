/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOUNTY_VALIDATION_POLICY_VERSION,
  INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD,
  INITIAL_FINDING_CLASS_POLICY,
  RELEASE_ROUTABLE_FINDING_CLASSES,
  authorizeActiveFalsification,
  createBlindValidationPacket,
  evaluateIndependentValidation,
  type BountyCandidate,
  type IndependentValidationReport,
  type ValidationActorIdentity,
  type ValidatorBrokerGrant,
} from '../bounty-finding-validation';

const producer: ValidationActorIdentity = {
  workerId: 'hunter-1', processId: 'process-hunter', contextNonce: 'context-hunter',
  credentialLineage: ['credential-hunter'], operationLineage: ['operation-hunter'],
};
const validator: ValidationActorIdentity = {
  workerId: 'validator-1', processId: 'process-validator', contextNonce: 'context-validator',
  credentialLineage: ['credential-validator'], operationLineage: ['operation-validator'],
};
const producerGrant: ValidatorBrokerGrant = {
  brokerId: 'broker-1', grantId: 'producer-grant', targets: ['target-1'],
  actions: ['target.observe', 'callback.check'], credentialLineage: producer.credentialLineage,
  maxHarm: 2, maxOperations: 4,
};
const validatorGrant: ValidatorBrokerGrant = {
  brokerId: 'broker-1', grantId: 'validator-grant', targets: ['target-1'],
  actions: ['target.observe'], credentialLineage: validator.credentialLineage,
  maxHarm: 1, maxOperations: 2,
};
const candidate = (findingClass = 'reflected-xss'): BountyCandidate => ({
  candidateId: `candidate-${findingClass}`, workspaceId: 'workspace-1', programId: 'program-1', missionId: 'mission-1',
  affectedTargetId: 'target-1', findingClass, claimHash: `sha256:${'a'.repeat(64)}`,
  evidenceRefs: ['evidence-1', 'evidence-2'], sensitivity: 'public', harmCeiling: 1,
  producer, hunterReasoning: 'trust me because the payload fired', proposedSeverity: 'critical',
});
const packet = (findingClass = 'reflected-xss') => createBlindValidationPacket({
  candidate: candidate(findingClass), validator, validationNonce: 'fresh-nonce', brokerGrant: validatorGrant,
});
const report = (findingClass = 'reflected-xss'): IndependentValidationReport => ({
  candidateId: `candidate-${findingClass}`, policyVersion: BOUNTY_VALIDATION_POLICY_VERSION,
  validationNonce: 'fresh-nonce', validator, findingClass,
  oracleSatisfied: true, negativeControlPassed: true, baselineOracleTriggered: false, alternativesFalsified: true,
  reproductions: [
    { operationId: 'validation-operation-1', evidenceDigest: 'digest-1', freshEnvironment: true },
    { operationId: 'validation-operation-2', evidenceDigest: 'digest-2', freshEnvironment: true },
  ],
  evidence: { expected: 10, integrityVerified: 9, lineageVerified: 8 },
  observedHarm: 1, prohibitedProofUsed: false, facts: { crossPrincipalImpact: true }, modelSelfRating: 0,
});

test('blind packets enforce independent process/context/credential/operation lineage and omit hunter opinion', () => {
  const blind = packet();
  const serialized = JSON.stringify(blind);
  assert.equal(serialized.includes('trust me'), false);
  assert.equal(serialized.includes('critical'), false);
  assert.equal('hunterReasoning' in blind, false);
  assert.equal('proposedSeverity' in blind, false);
  for (const collision of [
    { processId: producer.processId }, { contextNonce: producer.contextNonce },
    { credentialLineage: producer.credentialLineage }, { operationLineage: producer.operationLineage },
  ]) {
    assert.throws(() => createBlindValidationPacket({ candidate: candidate(), validator: { ...validator, ...collision }, validationNonce: 'fresh', brokerGrant: validatorGrant }));
  }
});

test('every release-routable class has an oracle, negative control, reproducibility minimum, and disposition', () => {
  assert.deepEqual(Object.keys(INITIAL_FINDING_CLASS_POLICY).sort(), [...RELEASE_ROUTABLE_FINDING_CLASSES].sort());
  for (const findingClass of RELEASE_ROUTABLE_FINDING_CLASSES) {
    const policy = INITIAL_FINDING_CLASS_POLICY[findingClass];
    assert.ok(policy.oracle);
    assert.ok(policy.negativeControl);
    assert.ok(policy.minimumIndependentRuns >= 2);
    assert.ok(policy.disposition === 'auto' || policy.disposition === 'human');
  }
  const unsupported = evaluateIndependentValidation(packet('novel-sensitive-class'), report('novel-sensitive-class'));
  assert.equal(unsupported.disposition, 'human-required');
  assert.equal(unsupported.humanAdmissionRequired, true);
  const confidentialPacket = createBlindValidationPacket({ candidate: { ...candidate(), sensitivity: 'program-confidential' }, validator, validationNonce: 'fresh-nonce', brokerGrant: validatorGrant });
  assert.equal(evaluateIndependentValidation(confidentialPacket, report()).disposition, 'human-required');
});

test('initial confidence policy is versioned at 0.85 and ignores model self-rating', () => {
  assert.equal(BOUNTY_VALIDATION_POLICY_VERSION, 'bounty.validation.v1');
  assert.equal(INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD, 0.85);
  const exactThreshold = evaluateIndependentValidation(packet(), { ...report(), modelSelfRating: 0 });
  assert.equal(exactThreshold.evidenceConfidence, 0.85);
  assert.equal(exactThreshold.disposition, 'admitted');
  const below = evaluateIndependentValidation(packet(), { ...report(), evidence: { expected: 10, integrityVerified: 8, lineageVerified: 8 }, modelSelfRating: 1 });
  assert.equal(below.disposition, 'inconclusive');
  assert.ok(below.reasonCodes.includes('CONFIDENCE_BELOW_THRESHOLD'));
});

test('anti-cheat fixtures deny baseline, stale nonce, self-XSS, false IDOR, and duplicate runs', () => {
  const fixtures: Array<[string, ReturnType<typeof packet>, IndependentValidationReport]> = [
    ['baseline trigger', packet(), { ...report(), baselineOracleTriggered: true }],
    ['stale nonce', packet(), { ...report(), validationNonce: 'stale-nonce' }],
    ['self-XSS', packet(), { ...report(), facts: { crossPrincipalImpact: false } }],
    ['false IDOR', packet('idor'), { ...report('idor'), facts: { controlAccountDenied: false, objectOwnersDiffer: false } }],
    ['duplicate', packet(), { ...report(), reproductions: [
      { operationId: 'duplicate-operation', evidenceDigest: 'digest-1', freshEnvironment: true },
      { operationId: 'duplicate-operation', evidenceDigest: 'digest-1', freshEnvironment: true },
    ] }],
  ];
  for (const [name, blind, result] of fixtures) assert.notEqual(evaluateIndependentValidation(blind, result).disposition, 'admitted', name);
});

test('anti-cheat fixtures deny browser callbacks, public keys, banner CVEs, inferred edges, and prohibited proof', () => {
  const fixtures: Array<[string, ReturnType<typeof packet>, IndependentValidationReport]> = [
    ['browser-origin callback', packet('server-side-callback'), { ...report('server-side-callback'), facts: { callbackReceiptSource: 'browser' } }],
    ['public key', packet('exposed-private-key'), { ...report('exposed-private-key'), facts: { materialKind: 'public-key' } }],
    ['banner-only CVE', packet('known-vulnerability'), { ...report('known-vulnerability'), facts: { safeExploitObserved: false, bannerOnly: true } }],
    ['inferred code edge', packet('source-code-control-edge'), { ...report('source-code-control-edge'), facts: { runtimeReachabilityObserved: false, inferredOnly: true } }],
    ['prohibited proof', packet(), { ...report(), prohibitedProofUsed: true }],
  ];
  for (const [name, blind, result] of fixtures) assert.notEqual(evaluateIndependentValidation(blind, result).disposition, 'admitted', name);
});

test('active falsification uses the same broker, a narrower grant, and never replays unknown effects or increases harm', async () => {
  const calls: string[] = [];
  const broker = { brokerId: 'broker-1', authorize: async (grantId: string) => { calls.push(grantId); return { operationId: 'fresh-operation', state: 'prepared' as const }; } };
  const request = { target: 'target-1', action: 'target.observe', requestHash: 'request-1', harm: 1, operationLineage: ['fresh-operation-lineage'] };
  const base = { producerGrant, producerOperationLineage: producer.operationLineage, validatorGrant, request, priorEffects: [], broker };
  await assert.doesNotReject(authorizeActiveFalsification(base));
  assert.deepEqual(calls, ['validator-grant']);
  await assert.rejects(authorizeActiveFalsification({ ...base, priorEffects: [{ requestHash: request.requestHash, state: 'unknown' }] }));
  await assert.rejects(authorizeActiveFalsification({ ...base, validatorGrant: { ...validatorGrant, maxHarm: 3 } }));
  await assert.rejects(authorizeActiveFalsification({ ...base, request: { ...request, harm: 2 } }));
  await assert.rejects(authorizeActiveFalsification({ ...base, request: { ...request, operationLineage: producer.operationLineage } }));
  await assert.rejects(authorizeActiveFalsification({ ...base, broker: { ...broker, brokerId: 'other-broker' } }));
});
