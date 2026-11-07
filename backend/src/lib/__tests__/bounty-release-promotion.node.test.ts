/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import receipt from '../../../../tests/fixtures/bounty-qualification/qualification-receipt.v1.json' with { type: 'json' };
import {
  bountyPromotionSignerKeyHash,
  verifyBountyReleasePromotion,
} from '../bounty-release-promotion';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('trusted exact post-commit promotion verifies and stale or untrusted authority fails closed', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const payload = {
    schemaVersion: 'bounty.release-promotion.v1' as const,
    promotionId: '11111111-1111-4111-8111-111111111111',
    candidateId: receipt.candidateId,
    qualificationReceiptHash: receipt.receiptHash,
    workerImageDigest: `sha256:${'9'.repeat(64)}`,
    bindings: receipt.bindings,
    issuedAt: '2026-08-03T00:00:00.000Z',
    expiresAt: '2026-08-03T01:00:00.000Z',
    nonce: 'one-use-promotion-nonce',
    action: 'enable-bounty-release' as const,
  };
  const envelope = {
    payload,
    signerSpkiDerBase64: spki.toString('base64'),
    signatureBase64: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64'),
  };
  const trusted = bountyPromotionSignerKeyHash(spki);
  const verified = verifyBountyReleasePromotion({ envelope, qualificationReceipt: receipt, currentBindings: receipt.bindings, expectedWorkerImageDigest: payload.workerImageDigest, trustedKeyHashes: [trusted], now: new Date('2026-08-03T00:30:00.000Z') });
  assert.equal(verified.payload.promotionId, payload.promotionId);
  assert.throws(() => verifyBountyReleasePromotion({ envelope, qualificationReceipt: receipt, currentBindings: receipt.bindings, expectedWorkerImageDigest: payload.workerImageDigest, trustedKeyHashes: [], now: new Date('2026-08-03T00:30:00.000Z') }), /trust root/);
  assert.throws(() => verifyBountyReleasePromotion({ envelope, qualificationReceipt: receipt, currentBindings: { ...receipt.bindings, adapterHash: `sha256:${'0'.repeat(64)}` }, expectedWorkerImageDigest: payload.workerImageDigest, trustedKeyHashes: [trusted], now: new Date('2026-08-03T00:30:00.000Z') }), /stale/);
  assert.throws(() => verifyBountyReleasePromotion({ envelope, qualificationReceipt: receipt, currentBindings: receipt.bindings, expectedWorkerImageDigest: `sha256:${'8'.repeat(64)}`, trustedKeyHashes: [trusted], now: new Date('2026-08-03T00:30:00.000Z') }), /worker image/);
});
