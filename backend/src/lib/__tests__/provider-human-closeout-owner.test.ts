/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as crypto from 'node:crypto';

const queryOne = jest.fn();
jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

import {
  providerHumanActionHash,
  verifyAndPersistProviderHumanAuthority,
  type ProviderHumanEvent,
} from '../provider-human-authority';
import { stableWalJson } from '../trusted-wal';

const TARGET = `sha256:${'a'.repeat(64)}`;
let previousIssuers: string | undefined;

function signedEvent(actorId: string): ProviderHumanEvent {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = JSON.stringify([{
    issuerId: 'external-owner-service',
    keyId: 'owner-key-1',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    provider: 'slack',
    providerTenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    ownerActorIds: ['genesis-owner', 'proof-owner'],
  }]);
  const unsigned = {
    schemaVersion: 'provider-human-event.v1' as const,
    issuerId: 'external-owner-service',
    keyId: 'owner-key-1',
    provider: 'slack',
    providerTenantId: 'tenant-a',
    actorId,
    conversationId: 'conversation-a',
    threadId: 'thread-a',
    messageId: `message-${actorId}`,
    occurredAt: new Date().toISOString(),
    normalizedCommandHash: TARGET,
    ingressIdempotencyKey: `ingress-${actorId}`,
  };
  return {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(stableWalJson(unsigned)), privateKey).toString('base64url'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  previousIssuers = process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
});

afterEach(() => {
  if (previousIssuers === undefined) delete process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
  else process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = previousIssuers;
});

test('persists closeout authority only for an explicitly configured workspace owner', async () => {
  const event = signedEvent('genesis-owner');
  queryOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: '11111111-1111-4111-8111-111111111111' });
  await expect(verifyAndPersistProviderHumanAuthority({
    workspaceId: 'workspace-a',
    purpose: 'run_closeout_reconciliation',
    targetHash: TARGET,
    event,
    requesterActorId: 'local-admin',
    requireDistinctActor: true,
    requireWorkspaceOwner: true,
  })).resolves.toEqual({
    receiptId: '11111111-1111-4111-8111-111111111111',
    replayed: false,
    actorId: 'genesis-owner',
  });
  const insert = queryOne.mock.calls[1];
  expect(String(insert[0])).toContain('workspace_owner_verified');
  expect(insert[1]).toEqual(expect.arrayContaining([
    'workspace-a', 'run_closeout_reconciliation', TARGET, 'genesis-owner', true,
  ]));
});

test('issuer/workspace binding alone cannot substitute for configured owner principal', async () => {
  const event = signedEvent('local-repairer');
  await expect(verifyAndPersistProviderHumanAuthority({
    workspaceId: 'workspace-a',
    purpose: 'run_closeout_reconciliation',
    targetHash: TARGET,
    event,
    requesterActorId: 'local-admin',
    requireDistinctActor: true,
    requireWorkspaceOwner: true,
  })).rejects.toThrow('not a configured owner');
  expect(queryOne).not.toHaveBeenCalled();
});

test('the local repair requester can never self-authorize the exact target', async () => {
  const event = signedEvent('proof-owner');
  await expect(verifyAndPersistProviderHumanAuthority({
    workspaceId: 'workspace-a',
    purpose: 'run_closeout_reconciliation',
    targetHash: TARGET,
    event,
    requesterActorId: 'proof-owner',
    requireDistinctActor: true,
    requireWorkspaceOwner: true,
  })).rejects.toThrow('distinct human approver');
  expect(queryOne).not.toHaveBeenCalled();
});

test('a prior non-owner-verified receipt cannot be replayed as closeout authority', async () => {
  const event = signedEvent('proof-owner');
  queryOne.mockResolvedValueOnce({
    id: '22222222-2222-4222-8222-222222222222',
    target_hash: TARGET,
    purpose: 'run_closeout_reconciliation',
    actor_id: 'proof-owner',
    attestation_hash: providerHumanActionHash(event),
    workspace_owner_verified: false,
    requester_actor_id: 'local-admin',
  });
  // The owner-verification bit is the independent reason this replay is rejected.
  await expect(verifyAndPersistProviderHumanAuthority({
    workspaceId: 'workspace-a',
    purpose: 'run_closeout_reconciliation',
    targetHash: TARGET,
    event,
    requesterActorId: 'local-admin',
    requireDistinctActor: true,
    requireWorkspaceOwner: true,
  })).rejects.toThrow('different authority target');
});
