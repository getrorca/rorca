/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { hashBountyContract } from '../bounty-contracts';
import {
  BOUNTY_BOUNDARY_PROBES,
  BOUNTY_PROPOSAL_SCHEMA_HASH,
  BountyProviderInferenceRequestSchema,
  BountyProviderInferenceResponseSchema,
  BountyTargetBrokerRequestSchema,
  BountyTargetBrokerResponseSchema,
  assertRuleOfTwo,
  buildBwrapInvocation,
  validateBountyWorkerProposal,
  verifyIsolatedPackage,
  type BountyIsolatedPackage,
  type IsolatedRuntimeConfig,
} from '../bounty-isolated-runtime';

const hash = (seed: string): string => hashBountyContract('test-value', seed);

function fixture(): { workPackage: BountyIsolatedPackage; config: IsolatedRuntimeConfig } {
  const missionId = randomUUID();
  const body: Omit<BountyIsolatedPackage, 'immutablePayloadHash'> = {
    version: 'bounty-isolated-package.v1', routePackageHash: hash('route'), missionId,
    workPackageId: randomUUID(), attemptId: randomUUID(), authorityEpoch: 7,
    capabilityExpiresAt: new Date(Date.now() + 60_000).toISOString(), contextNonce: randomUUID(),
    objective: { id: 'objective-1', objectiveClass: 'active-verification', prompt: 'Assess the pinned target observations.' },
    targetBroker: { socketIdentity: hash('target-socket'), allowedTools: ['target.observe.v1', 'target.test.v1'] },
    provider: { policyHash: hash('provider-policy'), exactOriginHash: hashBountyContract('provider-origin', 'https://api.provider.example') },
    evidenceRefs: [{ evidenceId: 'evidence-ref-1', evidenceHash: hash('evidence') }],
    outputSchema: { schemaId: 'bounty-worker-proposal.v1', schemaHash: BOUNTY_PROPOSAL_SCHEMA_HASH },
  };
  const workPackage: BountyIsolatedPackage = { immutablePayloadHash: hashBountyContract('isolated-worker-package', body), ...body };
  const config: IsolatedRuntimeConfig = {
    bwrapExecutable: '/usr/bin/bwrap', workerExecutable: '/opt/rorca/bounty-worker', workerExecutableHash: hash('worker'),
    targetBrokerRoot: '/run/rorca-target', targetBrokerSocket: `/run/rorca-target/${missionId}.sock`, targetBrokerSocketIdentity: body.targetBroker.socketIdentity,
    providerBrokerRoot: '/run/rorca-provider', providerBrokerSocket: '/run/rorca-provider/inference.sock', providerExactOrigin: 'https://api.provider.example',
    providerPolicyHash: body.provider.policyHash, expectedMissionId: missionId, expectedWorkPackageId: body.workPackageId,
    expectedRoutePackageHash: body.routePackageHash, expectedAuthorityEpoch: 7,
  };
  return { workPackage, config };
}

test('bwrap plan exposes one immutable package, one mission target socket, and a distinct provider socket', () => {
  const { workPackage, config } = fixture();
  const verified = verifyIsolatedPackage(workPackage, config);
  const invocation = buildBwrapInvocation(verified, config);
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--clearenv', '--cap-drop', '--new-session', '--die-with-parent']) {
    assert.ok(invocation.args.includes(flag), flag);
  }
  assert.deepEqual(invocation.env, {});
  assert.deepEqual(invocation.stdio, ['ignore', 'pipe', 'pipe', 3]);
  assert.ok(invocation.args.includes('/run/rorca/package.json'));
  assert.ok(invocation.args.includes('/run/rorca/target.sock'));
  assert.ok(invocation.args.includes('/run/rorca/provider.sock'));
  assert.equal(invocation.args.filter((value) => value === config.targetBrokerSocket).length, 1);
  assert.equal(invocation.args.filter((value) => value === config.providerBrokerSocket).length, 1);
  assert.ok(invocation.args.includes('--proc'));
  assert.ok(invocation.args.includes('--tmpfs'));
  assert.ok(!invocation.args.includes('/bin'));
  assert.ok(!invocation.args.includes('/usr'));
  assert.ok(!invocation.args.some((value) => /git|mcp|cdp|browser|skill|schedule|memory/i.test(value)));
});

test('target and provider brokers cannot substitute for one another', () => {
  const { workPackage, config } = fixture();
  assert.throws(() => buildBwrapInvocation(workPackage, { ...config, providerBrokerSocket: config.targetBrokerSocket }), /distinct/);
  assert.throws(() => buildBwrapInvocation(workPackage, { ...config, targetBrokerSocket: '/run/rorca-target/another-mission.sock' }), /mission-bound/);
  assert.throws(() => verifyIsolatedPackage(workPackage, { ...config, targetBrokerSocketIdentity: hash('substitute') }), /target broker identity/);
  assert.throws(() => verifyIsolatedPackage(workPackage, { ...config, providerExactOrigin: 'https://target.example' }), /provider broker policy/);
});

test('Rule-of-Two rejects the three-way risk combination', () => {
  assert.doesNotThrow(() => assertRuleOfTwo({ untrustedTargetInput: true, sensitiveCredentialsOrEvidence: false, unrestrictedEgress: false }));
  assert.doesNotThrow(() => assertRuleOfTwo({ untrustedTargetInput: true, sensitiveCredentialsOrEvidence: true, unrestrictedEgress: false }));
  assert.throws(() => assertRuleOfTwo({ untrustedTargetInput: true, sensitiveCredentialsOrEvidence: true, unrestrictedEgress: true }), /Rule-of-Two/);
});

test('boundary probe manifest covers every required escape surface', () => {
  assert.deepEqual(BOUNTY_BOUNDARY_PROBES.map((probe) => probe.id), [
    'localhost', 'arbitrary-unix-socket', 'dns', 'tcp', 'udp', 'inherited-descriptors',
    'host-proc', 'executable-roots', 'secret-files', 'stale-capabilities',
  ]);
  assert.ok(BOUNTY_BOUNDARY_PROBES.every((probe) => probe.expected === 'denied'));
});

test('stale epochs/expiry and package mutations fail before launch', () => {
  const { workPackage, config } = fixture();
  assert.throws(() => verifyIsolatedPackage(workPackage, { ...config, expectedAuthorityEpoch: 8 }), /stale/);
  assert.throws(() => verifyIsolatedPackage(workPackage, { ...config, expectedWorkPackageId: randomUUID() }), /dispatched work/);
  assert.throws(() => verifyIsolatedPackage({ ...workPackage, capabilityExpiresAt: new Date(0).toISOString() }, config), /payload hash mismatch/);
  assert.throws(() => verifyIsolatedPackage({ ...workPackage, immutablePayloadHash: hash('tampered') }, config), /payload hash mismatch/);
});

test('broker protocols are typed and provider inference cannot carry URLs, sessions, tools, or continuation', () => {
  const { workPackage } = fixture();
  const request = { version: 'bounty-provider-inference.v1' as const, packageHash: workPackage.immutablePayloadHash, contextNonce: workPackage.contextNonce, prompt: workPackage.objective.prompt };
  assert.deepEqual(BountyProviderInferenceRequestSchema.parse(request), request);
  for (const forbidden of ['url', 'conversationId', 'sessionId', 'tools', 'headers']) {
    assert.throws(() => BountyProviderInferenceRequestSchema.parse({ ...request, [forbidden]: 'forbidden' }), ZodError);
  }
  const requestId = randomUUID();
  const targetRequest = {
    version: 'bounty-target-broker.v1' as const, immutablePayloadHash: workPackage.immutablePayloadHash,
    missionId: workPackage.missionId, workPackageId: workPackage.workPackageId, attemptId: workPackage.attemptId,
    contextNonce: workPackage.contextNonce,
    request: { tool: 'target.observe.v1' as const, requestId, targetId: 'target-1', inputHash: hash('input') },
  };
  assert.deepEqual(BountyTargetBrokerRequestSchema.parse(targetRequest), targetRequest);
  assert.throws(() => BountyTargetBrokerRequestSchema.parse({ ...targetRequest, arbitrarySocket: '/tmp/other.sock' }), ZodError);
  assert.doesNotThrow(() => BountyTargetBrokerResponseSchema.parse({ version: 'bounty-target-broker-result.v1', requestId, outcome: 'observed', resultHash: hash('result'), untrustedText: 'bounded target response' }));
  assert.doesNotThrow(() => BountyProviderInferenceResponseSchema.parse({ version: 'bounty-provider-inference-result.v1', packageHash: workPackage.immutablePayloadHash, contextNonce: workPackage.contextNonce, text: 'proposal', usage: { inputTokens: 10, outputTokens: 2 } }));
});

test('only a schema-valid proposal linked to the fresh context can leave the worker', () => {
  const { workPackage } = fixture();
  const proposal = {
    version: 'bounty-worker-proposal.v1', disposition: 'proposal-only', authorityEffect: 'none', evidenceAdmission: false, findingAdmission: false,
    immutablePayloadHash: workPackage.immutablePayloadHash, routePackageHash: workPackage.routePackageHash,
    missionId: workPackage.missionId, workPackageId: workPackage.workPackageId, attemptId: workPackage.attemptId, contextNonce: workPackage.contextNonce,
    summary: 'A bounded hypothesis for controller review.',
    claims: [{ claim: 'The response may differ by account role.', confidence: 0.5, citationHashes: [hash('citation')] }],
    proposedToolRequests: [{ tool: 'target.observe.v1', requestId: randomUUID(), targetId: 'target-1', inputHash: hash('request') }],
  };
  assert.deepEqual(validateBountyWorkerProposal(JSON.stringify(proposal), workPackage), proposal);
  assert.throws(() => validateBountyWorkerProposal(JSON.stringify({ ...proposal, authorityEffect: 'approve' }), workPackage));
  assert.throws(() => validateBountyWorkerProposal(JSON.stringify({ ...proposal, admittedEvidence: [{ secret: true }] }), workPackage));
  assert.throws(() => validateBountyWorkerProposal(JSON.stringify({ ...proposal, contextNonce: randomUUID() }), workPackage), /contextNonce/);
  assert.throws(() => validateBountyWorkerProposal(JSON.stringify(proposal), workPackage, Date.parse(workPackage.capabilityExpiresAt) + 1), /expired/);
});
