/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { assertLocalFixtureDeploymentBinding, localFixtureLaunchTargetHash, localFixtureProviderKeyHash, verifyLocalFixtureProviderApproval, type LocalFixtureLaunchTarget } from '../bounty-local-fixture-launch';

const old = process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES;
afterEach(() => { if (old === undefined) delete process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES; else process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES = old; });
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES = localFixtureProviderKeyHash(publicKeyPem);
  const now = new Date('2026-08-04T12:00:00.000Z');
  const target: LocalFixtureLaunchTarget = { version:'bounty.local-fixture-launch.v1', action:'mission.launch.local-fixture', workspaceId:'rorca-bounty', programId:randomUUID(), missionId:randomUUID(), previewReceiptId:randomUUID(), previewRequestHash:'sha256:'+'1'.repeat(64), contractHash:'sha256:'+'2'.repeat(64), policyContractHash:'sha256:'+'3'.repeat(64), deployedSourceSha:'a'.repeat(40), deployedQualificationReceiptHash:'sha256:'+'4'.repeat(64), workerImageDigest:'sha256:'+'5'.repeat(64), expectedProgramRevision:1, requesterId:'requester', nonce:randomUUID(), issuedAt:now.toISOString(), expiresAt:new Date(now.getTime()+300000).toISOString() };
  const eventBase = { eventId:randomUUID(), targetHash:localFixtureLaunchTargetHash(target), decision:'approve' as const, actor:{id:'provider-human',role:'provider_owner' as const,kind:'provider_human' as const}, signedAt:new Date(now.getTime()+1000).toISOString() };
  const signature = sign(null, Buffer.from(JSON.stringify(eventBase)), privateKey).toString('base64');
  return { now:new Date(now.getTime()+2000), target, event:{...eventBase,publicKeyPem,signature} };
}
test('accepts only an exact trusted distinct one-use launch authority envelope', () => { const f=fixture(); assert.equal(verifyLocalFixtureProviderApproval(f.target,f.event,f.now).targetHash,f.event.targetHash); assert.throws(()=>verifyLocalFixtureProviderApproval({...f.target,workerImageDigest:'sha256:'+'6'.repeat(64)},f.event,f.now),/different authority/); });
test('rejects untrusted keys and expired targets', () => { const f=fixture(); process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES='sha256:'+'0'.repeat(64); assert.throws(()=>verifyLocalFixtureProviderApproval(f.target,f.event,f.now),/not trusted/); process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES=localFixtureProviderKeyHash(f.event.publicKeyPem); assert.throws(()=>verifyLocalFixtureProviderApproval(f.target,f.event,new Date('2026-08-04T12:06:00Z')),/temporally valid/); });
test('rejects active promotion drift after preview', () => {
  const { target } = fixture();
  assert.doesNotThrow(() => assertLocalFixtureDeploymentBinding(target, {
    deployedSourceSha: target.deployedSourceSha,
    deployedQualificationReceiptHash: target.deployedQualificationReceiptHash,
    workerImageDigest: target.workerImageDigest,
  }));
  assert.throws(() => assertLocalFixtureDeploymentBinding(target, {
    deployedSourceSha: 'b'.repeat(40),
    deployedQualificationReceiptHash: target.deployedQualificationReceiptHash,
    workerImageDigest: target.workerImageDigest,
  }), /active promoted deployment/);
});
