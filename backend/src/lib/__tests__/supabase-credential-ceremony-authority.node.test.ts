/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  SUPABASE_CREDENTIAL_CEREMONY_CATALOG,
  SupabaseCredentialCeremonyAuthority,
  SupabaseCredentialCeremonyRequestSchema,
  credentialBindingInventoryDigest,
  credentialCeremonyRequestDigest,
  type CapturedCredentialReference,
  type CredentialBindingInventoryEntry,
  type CredentialCeremonyReceipt,
  type CredentialCeremonySnapshot,
  type CredentialCeremonyStore,
  type CredentialReplacementSlot,
  type CredentialSecretStore,
  type RuntimeSecretBindingAdapter,
  type SupabaseCredentialCeremonyCapability,
  type SupabaseCredentialCeremonyRequest,
  type SupabaseCredentialCeremonyType,
} from '../supabase-credential-ceremony-authority';
import { AppError } from '../errors';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const CEREMONY_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_BINDING_ID = '33333333-3333-4333-8333-333333333333';
const OLD_SECRET = Buffer.from('fixture-secret-value-never-serialize');

function hash(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function inventory(
  consumerId: string,
  materialClass: CredentialBindingInventoryEntry['materialClass'],
  ordinal: number,
): CredentialBindingInventoryEntry {
  return {
    consumerId,
    bindingId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
    component: `fixture-component-${ordinal}`,
    environment: 'staging',
    materialClass,
    referenceId: `secret-store://fixture/old/${consumerId}`,
    fingerprint: hash(`old-${consumerId}`),
    generation: 7,
  };
}

function requestFor(type: SupabaseCredentialCeremonyType): SupabaseCredentialCeremonyRequest {
  let capability: SupabaseCredentialCeremonyCapability;
  let bindingInventory: CredentialBindingInventoryEntry[];
  let replacementSlots: CredentialReplacementSlot[];
  let canaryKind: 'runtime-auth' | 'consumer-replacement' | 'jwt-zero-downtime';
  if (type === 'api-key-rotation') {
    capability = 'credential.supabase.api-key.rotate';
    bindingInventory = [
      inventory('browser-runtime', 'application-publishable', 1),
      inventory('api-runtime', 'application-secret', 2),
    ];
    replacementSlots = [
      { slotId: 'publishable', materialClass: 'application-publishable', consumerIds: ['browser-runtime'] },
      { slotId: 'secret', materialClass: 'application-secret', consumerIds: ['api-runtime'] },
    ];
    canaryKind = 'runtime-auth';
  } else if (type === 'legacy-key-migration') {
    capability = 'credential.supabase.legacy-key.migrate';
    bindingInventory = [
      inventory('legacy-browser', 'application-anon', 3),
      inventory('legacy-server', 'application-service-role', 4),
    ];
    replacementSlots = [
      { slotId: 'publishable', materialClass: 'application-publishable', consumerIds: ['legacy-browser'] },
      { slotId: 'secret', materialClass: 'application-secret', consumerIds: ['legacy-server'] },
    ];
    canaryKind = 'consumer-replacement';
  } else {
    capability = 'credential.supabase.jwt-signing.rotate';
    bindingInventory = [inventory('auth-signing-runtime', 'jwt-signing', 5)];
    replacementSlots = [
      { slotId: 'signing-key', materialClass: 'jwt-signing', consumerIds: ['auth-signing-runtime'] },
    ];
    canaryKind = 'jwt-zero-downtime';
  }
  const bindingInventoryDigest = credentialBindingInventoryDigest(bindingInventory);
  return SupabaseCredentialCeremonyRequestSchema.parse({
    ceremonyId: CEREMONY_ID,
    authorityGrantId: GRANT_ID,
    idempotencyKey: `fixture-${type}`,
    ceremonyType: type,
    capability,
    scope: {
      workspaceId: 'rorca-fixture',
      projectRef: 'rorca-disposable',
      environment: 'staging',
      credentialBindingId: CREDENTIAL_BINDING_ID,
      bindingGeneration: 7,
    },
    bindingInventory,
    replacementSlots,
    bindingInventoryDigest,
    canary: {
      canaryId: `canary-${type}`,
      kind: canaryKind,
      expectedResultDigest: hash(`canary-${type}`),
      verifierId: 'fixture-verifier',
    },
    cutover: {
      cutoverId: `cutover-${type}`,
      strategy: 'atomic',
      targetBindingGeneration: 8,
      maxPropagationSeconds: 60,
    },
    revocation: {
      gracePeriodSeconds: 0,
      revokeNotBefore: NOW.toISOString(),
      requireExactCanaryReplay: true,
      requireRollbackReadiness: true,
    },
    recovery: {
      procedureId: `rollback-${type}`,
      owner: 'fixture-operator',
      rollbackBindingInventoryDigest: bindingInventoryDigest,
      testedAt: NOW.toISOString(),
    },
  });
}

class MemoryStore implements CredentialCeremonyStore {
  snapshot: CredentialCeremonySnapshot | null = null;

  constructor(private readonly grant: {
    ceremonyType: SupabaseCredentialCeremonyType;
    capability: SupabaseCredentialCeremonyCapability;
  }) {}

  async start(
    request: SupabaseCredentialCeremonyRequest,
    requestDigest: `sha256:${string}`,
    now: Date,
  ): Promise<{ snapshot: CredentialCeremonySnapshot; created: boolean }> {
    if (request.ceremonyType !== this.grant.ceremonyType
      || request.capability !== this.grant.capability
      || requestDigest !== credentialCeremonyRequestDigest(request)) {
      const error = new Error('typed grant rejected') as Error & { details: { reason: string } };
      error.details = { reason: 'credential_ceremony_grant_unauthorized' };
      throw error;
    }
    if (this.snapshot) return { snapshot: this.snapshot, created: false };
    this.snapshot = {
      request,
      requestDigest,
      state: 'planned',
      captures: [],
      canaryEvidence: null,
      cutoverEvidence: null,
      revocationEvidence: null,
      receipt: null,
      revision: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    return { snapshot: this.snapshot, created: true };
  }

  async load(ceremonyId: string): Promise<CredentialCeremonySnapshot | null> {
    return this.snapshot?.request.ceremonyId === ceremonyId ? this.snapshot : null;
  }

  async save(snapshot: CredentialCeremonySnapshot, expectedRevision: number): Promise<CredentialCeremonySnapshot> {
    assert.equal(this.snapshot?.revision, expectedRevision);
    this.snapshot = { ...snapshot, revision: expectedRevision + 1 };
    return this.snapshot;
  }

  async settle(
    snapshot: CredentialCeremonySnapshot,
    receipt: CredentialCeremonyReceipt,
    expectedRevision: number,
  ): Promise<CredentialCeremonySnapshot> {
    assert.equal(this.snapshot?.revision, expectedRevision);
    this.snapshot = { ...snapshot, receipt, revision: expectedRevision + 1 };
    return this.snapshot;
  }
}

class MemorySecretStore implements CredentialSecretStore {
  capturedMaterial: Buffer[] = [];
  revoked: string[] = [];

  async storeCapturedMaterial(input: {
    workspaceId: string;
    ceremonyId: string;
    slotId: string;
    materialClass: 'application-publishable' | 'application-secret' | 'jwt-signing';
    material: Buffer;
    capturedAt: Date;
  }): Promise<Omit<CapturedCredentialReference, 'slotId' | 'keyState'>> {
    this.capturedMaterial.push(Buffer.from(input.material));
    return {
      materialClass: input.materialClass,
      referenceId: `secret-store://fixture/new/${input.slotId}`,
      fingerprint: `sha256:${crypto.createHash('sha256').update(input.material).digest('hex')}`,
      capturedAt: input.capturedAt.toISOString(),
    };
  }

  async revokeMany(referenceIds: readonly string[]): Promise<readonly string[]> {
    this.revoked = [...new Set(referenceIds)].sort();
    return this.revoked;
  }
}

class MemoryRuntimeBindings implements RuntimeSecretBindingAdapter {
  bound: Array<{ slot: CredentialReplacementSlot; replacement: CapturedCredentialReference }> = [];
  activations = 0;
  revocations = 0;

  async bindReplacement(input: {
    ceremonyId: string;
    slot: CredentialReplacementSlot;
    replacement: CapturedCredentialReference;
    targetBindingGeneration: number;
  }): Promise<void> {
    this.bound.push({ slot: input.slot, replacement: input.replacement });
  }

  async activateReplacement(): Promise<void> {
    this.activations += 1;
  }

  async revokePrevious(input: {
    ceremonyId: string;
    previousBindings: readonly CredentialBindingInventoryEntry[];
    replacements: readonly CapturedCredentialReference[];
  }): Promise<readonly string[]> {
    this.revocations += 1;
    return [...new Set(input.previousBindings.map((binding) => binding.referenceId))].sort();
  }
}
interface CeremonyFixture {
  authority: SupabaseCredentialCeremonyAuthority;
  request: SupabaseCredentialCeremonyRequest;
  store: MemoryStore;
  secretStore: MemorySecretStore;
  runtimeBindings: MemoryRuntimeBindings;
}


function fixture(type: SupabaseCredentialCeremonyType): CeremonyFixture {
  const request = requestFor(type);
  const store = new MemoryStore({ ceremonyType: type, capability: request.capability });
  const secretStore = new MemorySecretStore();
  const runtimeBindings = new MemoryRuntimeBindings();
  const authority = new SupabaseCredentialCeremonyAuthority({
    store,
    secretStore,
    runtimeBindings,
    now: () => NOW,
  });
  return { authority, request, store, secretStore, runtimeBindings };
}

async function captureAll(
  authority: SupabaseCredentialCeremonyAuthority,
  request: SupabaseCredentialCeremonyRequest,
): Promise<CredentialCeremonySnapshot> {
  let snapshot = await authority.start(request);
  for (const slot of request.replacementSlots) {
    snapshot = await authority.capture(request.ceremonyId, slot.slotId, Buffer.from(`new-${slot.slotId}`));
  }
  return snapshot;
}

function consumerResults(snapshot: CredentialCeremonySnapshot) {
  return snapshot.request.bindingInventory.map((consumer) => {
    const slot = snapshot.request.replacementSlots.find((candidate) => candidate.consumerIds.includes(consumer.consumerId));
    const capture = snapshot.captures.find((candidate) => candidate.slotId === slot?.slotId);
    assert.ok(capture);
    return {
      consumerId: consumer.consumerId,
      replacementFingerprint: capture.fingerprint,
      passed: true as const,
      evidenceDigest: hash(`consumer-${consumer.consumerId}`),
    };
  });
}

function canaryEvidence(snapshot: CredentialCeremonySnapshot) {
  const common = {
    ceremonyType: snapshot.request.ceremonyType,
    canaryId: snapshot.request.canary.canaryId,
    observedResultDigest: snapshot.request.canary.expectedResultDigest,
    verifierId: snapshot.request.canary.verifierId,
    verifiedAt: NOW.toISOString(),
    consumerResults: consumerResults(snapshot),
  };
  return snapshot.request.ceremonyType === 'jwt-signing-rotation'
    ? {
        ...common,
        ceremonyType: 'jwt-signing-rotation' as const,
        tokenBehavior: {
          oldTokenAccepted: true as const,
          newTokenAccepted: true as const,
          overlapVerified: true as const,
          evidenceDigest: hash('jwt-overlap'),
        },
      }
    : common;
}

function revocationEvidence(snapshot: CredentialCeremonySnapshot) {
  const common = {
    ceremonyType: snapshot.request.ceremonyType,
    canaryId: snapshot.request.canary.canaryId,
    observedResultDigest: snapshot.request.canary.expectedResultDigest,
    recoveryProcedureId: snapshot.request.recovery.procedureId,
    rollbackBindingInventoryDigest: snapshot.request.recovery.rollbackBindingInventoryDigest,
    rollbackReadinessPassed: true as const,
    verifiedAt: NOW.toISOString(),
    evidenceDigest: hash('revocation'),
  };
  return snapshot.request.ceremonyType === 'jwt-signing-rotation'
    ? {
        ...common,
        ceremonyType: 'jwt-signing-rotation' as const,
        postRevocationTokenBehavior: {
          oldTokenRejected: true as const,
          newTokenAccepted: true as const,
          evidenceDigest: hash('jwt-post-revocation'),
        },
      }
    : common;
}

async function cutover(fixtureValue: CeremonyFixture, snapshot: CredentialCeremonySnapshot) {
  await fixtureValue.authority.verifyCanary(snapshot.request.ceremonyId, canaryEvidence(snapshot));
  return fixtureValue.authority.cutover(snapshot.request.ceremonyId, {
    cutoverId: snapshot.request.cutover.cutoverId,
    targetBindingGeneration: snapshot.request.cutover.targetBindingGeneration,
    completedAt: NOW.toISOString(),
    evidenceDigest: hash('cutover'),
  });
}

test('catalog and schemas expose three non-interchangeable ceremony contracts', async () => {
  assert.deepEqual(
    SUPABASE_CREDENTIAL_CEREMONY_CATALOG.map((entry) => [entry.ceremonyType, entry.capability, entry.receiptVersion]),
    [
      ['api-key-rotation', 'credential.supabase.api-key.rotate', 'rorca.supabase-api-key-rotation-receipt.v1'],
      ['legacy-key-migration', 'credential.supabase.legacy-key.migrate', 'rorca.supabase-legacy-key-migration-receipt.v1'],
      ['jwt-signing-rotation', 'credential.supabase.jwt-signing.rotate', 'rorca.supabase-jwt-signing-rotation-receipt.v1'],
    ],
  );
  const apiGrantStore = new MemoryStore({
    ceremonyType: 'api-key-rotation',
    capability: 'credential.supabase.api-key.rotate',
  });
  const authority = new SupabaseCredentialCeremonyAuthority({
    store: apiGrantStore,
    secretStore: new MemorySecretStore(),
    runtimeBindings: new MemoryRuntimeBindings(),
    now: () => NOW,
  });
  await assert.rejects(authority.start(requestFor('jwt-signing-rotation')), /typed grant rejected/);
  assert.throws(() => SupabaseCredentialCeremonyRequestSchema.parse({
    ...requestFor('api-key-rotation'),
    capability: 'credential.supabase.jwt-signing.rotate',
  }));
});

test('secure captures persist only references/fingerprints and bind no raw material to runtime targets', async () => {
  const value = fixture('api-key-rotation');
  const snapshot = await captureAll(value.authority, value.request);
  assert.equal(snapshot.state, 'replacement-bound');
  assert.equal(value.secretStore.capturedMaterial.length, 2);
  assert.equal(value.runtimeBindings.bound.length, 2);
  assert.equal(Object.hasOwn(value.runtimeBindings.bound[0]!.replacement, 'material'), false);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /new-publishable|new-secret|fixture-secret-value/);
  assert.match(serialized, /secret-store:\/\/fixture\/new\//);
  assert.throws(() => SupabaseCredentialCeremonyRequestSchema.parse({ ...value.request, secret: OLD_SECRET.toString() }));
});

test('capture rejects reused or duplicate material before runtime binding', async () => {
  const value = fixture('api-key-rotation');
  await value.authority.start(value.request);
  await assert.rejects(
    value.authority.capture(value.request.ceremonyId, 'secret', Buffer.from('old-api-runtime')),
    (error: unknown) => error instanceof AppError && error.code === 'CREDENTIAL_REPLACEMENT_INVALID',
  );
  assert.equal(value.runtimeBindings.bound.length, 0);
  assert.deepEqual(value.secretStore.revoked, ['secret-store://fixture/new/secret']);
  const publishable = await value.authority.capture(
    value.request.ceremonyId,
    'publishable',
    Buffer.from('one-shared-replacement'),
  );
  await assert.rejects(
    value.authority.capture(value.request.ceremonyId, 'secret', Buffer.from('one-shared-replacement')),
    (error: unknown) => error instanceof AppError && error.code === 'CREDENTIAL_REPLACEMENT_INVALID',
  );
  assert.equal(publishable.captures.length, 1);
  assert.equal(value.runtimeBindings.bound.length, 1);
});

test('legacy migration proves every inventoried consumer before cutover or old-key revocation', async () => {
  const value = fixture('legacy-key-migration');
  const captured = await captureAll(value.authority, value.request);
  const incomplete = {
    ...canaryEvidence(captured),
    ceremonyType: 'legacy-key-migration',
    consumerResults: consumerResults(captured).slice(0, 1),
  };
  await assert.rejects(
    value.authority.verifyCanary(value.request.ceremonyId, incomplete),
    (error: unknown) => error instanceof AppError && error.code === 'CONSUMER_REPLACEMENT_UNPROVEN',
  );
  assert.equal(value.runtimeBindings.activations, 0);
  assert.equal(value.runtimeBindings.revocations, 0);
  const current = await cutover(value, captured);
  const settled = await value.authority.revokePrevious(value.request.ceremonyId, revocationEvidence(current));
  assert.equal(settled.state, 'revoked');
  assert.equal(value.runtimeBindings.revocations, 1);
  assert.deepEqual(value.secretStore.revoked, value.request.bindingInventory.map((entry) => entry.referenceId).sort());
  assert.equal(settled.receipt?.ceremonyType, 'legacy-key-migration');
  assert.equal(settled.receipt?.capability, 'credential.supabase.legacy-key.migrate');
});

test('JWT rotation enforces standby, current, and revoked states with old/new token proofs', async () => {
  const value = fixture('jwt-signing-rotation');
  const standby = await captureAll(value.authority, value.request);
  assert.equal(standby.state, 'standby');
  assert.deepEqual(standby.captures.map((capture) => capture.keyState), ['standby']);
  const missingOverlap = {
    ...canaryEvidence(standby),
    tokenBehavior: {
      oldTokenAccepted: false,
      newTokenAccepted: true,
      overlapVerified: true,
      evidenceDigest: hash('bad-overlap'),
    },
  };
  await assert.rejects(value.authority.verifyCanary(value.request.ceremonyId, missingOverlap));
  const current = await cutover(value, standby);
  assert.equal(current.state, 'current');
  assert.deepEqual(current.captures.map((capture) => capture.keyState), ['current']);
  const invalidRevocation = {
    ...revocationEvidence(current),
    postRevocationTokenBehavior: {
      oldTokenRejected: false,
      newTokenAccepted: true,
      evidenceDigest: hash('bad-post-revocation'),
    },
  };
  await assert.rejects(value.authority.revokePrevious(value.request.ceremonyId, invalidRevocation));
  assert.equal(value.runtimeBindings.revocations, 0);
  const revoked = await value.authority.revokePrevious(value.request.ceremonyId, revocationEvidence(current));
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.receipt?.version, 'rorca.supabase-jwt-signing-rotation-receipt.v1');
  assert.deepEqual(
    revoked.receipt?.finalKeyStates.map((state) => state.state).sort(),
    ['current', 'revoked'],
  );
  assert.doesNotMatch(JSON.stringify(revoked.receipt), /new-signing-key|fixture-secret-value/);
});

test('revocation requires exact canary replay and exact rollback readiness after cutover', async () => {
  const value = fixture('api-key-rotation');
  const captured = await captureAll(value.authority, value.request);
  await assert.rejects(
    value.authority.revokePrevious(value.request.ceremonyId, revocationEvidence(captured)),
    (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
  );
  const current = await cutover(value, captured);
  await assert.rejects(value.authority.revokePrevious(value.request.ceremonyId, {
    ...revocationEvidence(current),
    observedResultDigest: hash('different-canary'),
  }), (error: unknown) => error instanceof AppError && error.code === 'REVOCATION_READINESS_MISMATCH');
  await assert.rejects(value.authority.revokePrevious(value.request.ceremonyId, {
    ...revocationEvidence(current),
    rollbackBindingInventoryDigest: hash('different-rollback'),
  }), (error: unknown) => error instanceof AppError && error.code === 'REVOCATION_READINESS_MISMATCH');
  await assert.rejects(value.authority.revokePrevious(value.request.ceremonyId, {
    ...revocationEvidence(current),
    verifiedAt: '2026-08-24T11:59:59.000Z',
  }), (error: unknown) => error instanceof AppError && error.code === 'REVOCATION_EVIDENCE_TIME_INVALID');
  assert.equal(value.runtimeBindings.revocations, 0);
  assert.equal(value.secretStore.revoked.length, 0);
});
