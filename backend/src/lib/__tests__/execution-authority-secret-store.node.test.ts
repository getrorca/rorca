/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  EXECUTION_AUTHORITY_SCHEMA_VERSION,
  type CredentialLeaseRecord,
  type CredentialLeaseStatus,
  type ProviderBindingRecord,
} from '../../db/execution-authority';
import {
  AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  type AuthorityProviderAdapter,
} from '../authority-provider-adapter';
import { AuthorityProviderBrokerError, BrokeredAuthorityProviderAdapter } from '../authority-provider-broker';
import {
  RUNTIME_SECRET_BINDING_ADAPTER_CONTRACT_VERSION,
  SecretStoreRuntimeBindingAdapter,
  type RuntimeSecretBindingAdapter,
  type RuntimeSecretBindingContext,
} from '../runtime-secret-binding-adapter';
import {
  DatabaseVaultSecretStore,
  InfisicalSecretStore,
  SECRET_STORE_CONTRACT_VERSION,
  SecretStoreError,
  type EphemeralSecretMaterial,
  type InfisicalTransport,
  type SecretAccessAuditWriter,
  type SecretAccessRequest,
  type SecretStore,
} from '../secret-store';
import { createConfiguredSecretStore, parseAuthoritySecretStoreConfig } from '../secret-store-config';
import {
  TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION,
  type TrustedOperationAdapterContext,
} from '../trusted-operation-executor';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const SECRET_CANARY = 'rea-005-secret-canary-value';
const SECRET_FINGERPRINT = `sha256:${crypto.createHash('sha256').update(SECRET_CANARY).digest('hex')}`;
const VAULT_REFERENCE = 'vault://integration-tokens/token-row-1';
const INFISICAL_REFERENCE = 'infisical://projects/project-1/secrets/provider-key';

function binding(secretReference = VAULT_REFERENCE): ProviderBindingRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    bindingReference: 'binding-1',
    generation: 1,
    capabilityId: 'provider.effect.write',
    provider: 'github',
    environment: 'production',
    providerResourceId: 'getrorca/rorca',
    secretReference,
    secretFingerprint: SECRET_FINGERPRINT,
    status: 'active',
    configuration: {},
    provenance: { source: 'rea-005-test' },
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function lease(secretReference = VAULT_REFERENCE, status: CredentialLeaseStatus = 'prepared'): CredentialLeaseRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    grantId: '33333333-3333-4333-8333-333333333333',
    bindingReference: 'binding-1',
    bindingGeneration: 1,
    runId: 41,
    storyId: 'REA-005',
    environment: 'production',
    providerResourceId: 'getrorca/rorca',
    operation: 'provider.effect.write',
    leasePurpose: 'execute-approved-effect',
    idempotencyKey: 'operation-1',
    secretReference,
    secretFingerprint: SECRET_FINGERPRINT,
    fencingGeneration: 1,
    maximumUses: 1,
    usesConsumed: status === 'exhausted' ? 1 : 0,
    status,
    provenance: { source: 'rea-005-test' },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date('2026-08-23T12:05:00.000Z'),
    revokedAt: status === 'revoked' ? NOW : null,
  };
}

function request(secretReference = VAULT_REFERENCE): SecretAccessRequest {
  return {
    workspaceId: 'workspace-1',
    environment: 'production',
    provider: 'github',
    providerResourceId: 'getrorca/rorca',
    action: 'provider.effect.write',
    leasePurpose: 'execute-approved-effect',
    principal: 'execution:run-41:story-REA-005',
    leaseId: lease().id,
    bindingReference: 'binding-1',
    bindingGeneration: 1,
    secretReference,
    secretFingerprint: SECRET_FINGERPRINT,
  };
}

function trustedContext(): TrustedOperationAdapterContext {
  return {
    schemaVersion: TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION,
    workspaceId: 'workspace-1',
    runId: 41,
    storyId: 'REA-005',
    environment: 'production',
    providerResourceId: 'getrorca/rorca',
    operation: 'provider.effect.write',
    attemptId: 'attempt-1',
    intentId: 'intent-1',
    grantId: 'grant-1',
    leaseId: lease().id,
    requestingPrincipal: 'execution:run-41:story-REA-005',
    capabilityId: 'provider.effect.write',
    bindingReference: 'binding-1',
    bindingGeneration: 1,
    provider: 'github',
    leasePurpose: 'execute-approved-effect',
    leaseFencingGeneration: 1,
    requestDigest: `sha256:${'a'.repeat(64)}`,
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    idempotencyKey: 'operation-1',
    fencingGeneration: 1,
    constraints: { protected: false },
    secretReference: VAULT_REFERENCE,
    secretFingerprint: SECRET_FINGERPRINT,
  };
}

function ephemeralMaterial(): EphemeralSecretMaterial {
  let bytes: Buffer | null = Buffer.from(SECRET_CANARY);
  let inUse = false;
  return {
    fingerprint: SECRET_FINGERPRINT,
    get disposed() { return bytes === null; },
    async use<TResult>(consumer: (value: Uint8Array) => Promise<TResult> | TResult): Promise<TResult> {
      if (!bytes || inUse) throw new Error('material unavailable');
      inUse = true;
      try {
        return await consumer(bytes);
      } finally {
        bytes.fill(0);
        bytes = null;
        inUse = false;
      }
    },
    dispose() {
      bytes?.fill(0);
      bytes = null;
      inUse = false;
    },
  };
}

function databaseStore(auditEvents: Parameters<SecretAccessAuditWriter>[0][]): DatabaseVaultSecretStore {
  return new DatabaseVaultSecretStore({
    getLease: async () => lease(),
    getBinding: async () => binding(),
    loadVaultValue: async () => SECRET_CANARY,
    audit: async (event) => { auditEvents.push(event); },
    now: () => NOW,
  });
}

function infisicalStore(
  transport: InfisicalTransport,
  auditEvents: Parameters<SecretAccessAuditWriter>[0][],
  online = true,
  timeoutMs = 50,
): InfisicalSecretStore {
  return new InfisicalSecretStore(
    { online, timeoutMs, maximumStalenessMs: 60_000 },
    { transport, audit: async (event) => { auditEvents.push(event); }, now: () => NOW },
  );
}

function infisicalTransport(overrides: Partial<InfisicalTransport> = {}): InfisicalTransport {
  return {
    health: async () => 'available',
    resolve: async (input) => ({
      value: SECRET_CANARY,
      fingerprint: SECRET_FINGERPRINT,
      observedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      scope: {
        workspaceId: input.workspaceId,
        environment: input.environment,
        provider: input.provider,
        providerResourceId: input.providerResourceId,
        action: input.action,
        leasePurpose: input.leasePurpose,
      },
    }),
    revoke: async () => undefined,
    ...overrides,
  };
}

test('database vault is the default, stays reference-only, audits principal/purpose, and zeroes borrowed material', async () => {
  assert.deepEqual(parseAuthoritySecretStoreConfig({}), { backend: 'database' });
  const configured = createConfiguredSecretStore({ backend: 'database' });
  assert.equal(configured.backend, 'database');
  assert.equal(configured.contractVersion, SECRET_STORE_CONTRACT_VERSION);

  const auditEvents: Parameters<SecretAccessAuditWriter>[0][] = [];
  const material = await databaseStore(auditEvents).resolve(request());
  let observed = '';
  await material.use((bytes) => { observed = Buffer.from(bytes).toString('utf8'); });
  assert.equal(observed, SECRET_CANARY);
  assert.equal(material.disposed, true);
  assert.deepEqual(auditEvents.map((event) => event.event), ['resolution_started', 'resolution_succeeded']);
  assert.ok(auditEvents.every((event) => event.principal === request().principal
    && event.leasePurpose === request().leasePurpose
    && event.secretReference === VAULT_REFERENCE
    && !JSON.stringify(event).includes(SECRET_CANARY)));
});

test('database resolution rejects reuse across every authority scope dimension before loading ciphertext', async () => {
  const altered: readonly Partial<SecretAccessRequest>[] = [
    { workspaceId: 'workspace-2' },
    { environment: 'staging' },
    { provider: 'linear' },
    { providerResourceId: 'other/resource' },
    { action: 'provider.effect.read' },
    { leasePurpose: 'different-purpose' },
  ];
  for (const change of altered) {
    let loadCalls = 0;
    const store = new DatabaseVaultSecretStore({
      getLease: async () => lease(),
      getBinding: async () => binding(),
      loadVaultValue: async () => { loadCalls += 1; return SECRET_CANARY; },
      audit: async () => undefined,
      now: () => NOW,
    });
    await assert.rejects(store.resolve({ ...request(), ...change }), (error: unknown) => (
      error instanceof SecretStoreError && error.code === 'SECRET_SCOPE_MISMATCH'
    ));
    assert.equal(loadCalls, 0);
  }
});

test('Infisical sends references and attribution only, enforces exact returned scope, and never reads ambient fallback', async () => {
  const transportRequests: unknown[] = [];
  const auditEvents: Parameters<SecretAccessAuditWriter>[0][] = [];
  const transport = infisicalTransport({
    resolve: async (input) => {
      transportRequests.push(input);
      return infisicalTransport().resolve(input);
    },
  });
  const externalRequest = request(INFISICAL_REFERENCE);
  const material = await infisicalStore(transport, auditEvents).resolve(externalRequest);
  await material.use(() => undefined);
  const payload = JSON.stringify(transportRequests);
  assert.ok(payload.includes(INFISICAL_REFERENCE));
  assert.ok(payload.includes(externalRequest.principal));
  assert.ok(payload.includes(externalRequest.leasePurpose));
  assert.ok(!payload.includes(SECRET_CANARY));
  assert.ok(!Object.keys(transportRequests[0] as object).some((key) => /token|password|credential/i.test(key)));

  const wrongScope = infisicalStore(infisicalTransport({
    resolve: async (input) => ({
      ...(await infisicalTransport().resolve(input)),
      scope: { ...externalRequest, workspaceId: 'workspace-2' },
    }),
  }), []);
  await assert.rejects(wrongScope.resolve(externalRequest), (error: unknown) => (
    error instanceof SecretStoreError && error.code === 'SECRET_SCOPE_MISMATCH'
  ));
});

test('Infisical has bounded latency, explicit offline behavior, and no database fallback', async () => {
  let calls = 0;
  const never = new Promise<never>(() => undefined);
  const transport = infisicalTransport({
    health: async () => { calls += 1; return 'available'; },
    resolve: async () => { calls += 1; return never; },
    revoke: async () => { calls += 1; return never; },
  });
  const externalRequest = request(INFISICAL_REFERENCE);
  const timed = infisicalStore(transport, [], true, 10);
  await assert.rejects(timed.resolve(externalRequest), (error: unknown) => (
    error instanceof SecretStoreError && error.code === 'SECRET_STORE_TIMEOUT'
  ));
  await assert.rejects(timed.revoke(externalRequest), (error: unknown) => (
    error instanceof SecretStoreError && error.code === 'SECRET_STORE_TIMEOUT'
  ));

  const offline = infisicalStore(transport, [], false, 10);
  assert.deepEqual(await offline.healthPreflight(externalRequest), {
    status: 'offline', checkedAt: NOW.toISOString(), reasonCode: 'SECRET_STORE_OFFLINE',
  });
  await assert.rejects(offline.resolve(externalRequest), (error: unknown) => (
    error instanceof SecretStoreError && error.code === 'SECRET_STORE_OFFLINE'
  ));
  assert.equal(calls, 2);
  assert.throws(
    () => createConfiguredSecretStore({
      backend: 'infisical', endpoint: 'https://app.infisical.com', online: true, timeoutMs: 50, maximumStalenessMs: 60_000,
    }),
    /explicit credential-free transport/,
  );
});

test('runtime binding consumes one exact use and marks resolution or revocation failures for reconciliation', async () => {
  let currentLease = lease();
  const transitions: Array<{ from: CredentialLeaseStatus; to: CredentialLeaseStatus }> = [];
  let shouldFailRevoke = false;
  const store: SecretStore = {
    contractVersion: SECRET_STORE_CONTRACT_VERSION,
    backend: 'database',
    healthPreflight: async () => ({ status: 'available', checkedAt: NOW.toISOString(), reasonCode: null }),
    resolve: async () => ephemeralMaterial(),
    revoke: async () => { if (shouldFailRevoke) throw new SecretStoreError('SECRET_REVOCATION_FAILED'); },
  };
  const adapter = new SecretStoreRuntimeBindingAdapter(store, {
    getLease: async () => currentLease,
    getBinding: async () => binding(),
    transitionLease: async (input) => {
      if (currentLease.status !== input.from) return false;
      transitions.push({ from: input.from, to: input.to });
      currentLease = {
        ...currentLease,
        status: input.to,
        usesConsumed: input.usesConsumed,
        revokedAt: input.to === 'revoked' ? NOW : null,
      };
      return true;
    },
    now: () => NOW,
  });
  const runtimeInput: RuntimeSecretBindingContext = { ...request(), fencingGeneration: 1 };
  const prepared = await adapter.prepareLease(runtimeInput);
  const material = await adapter.resolve(prepared);
  await material.use(() => undefined);
  assert.equal(currentLease.status, 'exhausted');
  assert.equal(currentLease.usesConsumed, 1);

  shouldFailRevoke = true;
  await assert.rejects(adapter.revoke(runtimeInput));
  assert.equal(currentLease.status, 'reconciliation_required');
  assert.deepEqual(transitions.map(({ from, to }) => `${from}->${to}`), [
    'prepared->active', 'active->exhausted', 'exhausted->reconciliation_required',
  ]);
});

class FixtureRuntimeBinding implements RuntimeSecretBindingAdapter {
  readonly contractVersion = RUNTIME_SECRET_BINDING_ADAPTER_CONTRACT_VERSION;
  readonly material = ephemeralMaterial();
  reconciliationMarks = 0;
  failResolution = false;
  failRevocation = false;

  healthPreflight = async () => ({ status: 'available', checkedAt: NOW.toISOString(), reasonCode: null } as const);
  prepareLease = async (input: RuntimeSecretBindingContext) => ({
    ...input, maximumUses: 1, usesConsumed: 0, expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  resolve = async () => {
    if (this.failResolution) throw new SecretStoreError('SECRET_NOT_FOUND');
    return this.material;
  };
  revoke = async () => {
    if (this.failRevocation) throw new SecretStoreError('SECRET_REVOCATION_FAILED');
  };
  markReconciliationRequired = async () => { this.reconciliationMarks += 1; };
}

function providerAdapter(overrides: Partial<AuthorityProviderAdapter> = {}): AuthorityProviderAdapter {
  return {
    contractVersion: AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
    provider: 'github',
    allowedHosts: ['api.github.com'],
    describeCapability: async () => ({
      contractVersion: AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
      provider: 'github', capabilityId: 'provider.effect.write', operations: ['provider.effect.write'], mutationCapable: true,
    }),
    healthPreflight: async () => ({ status: 'available', reasonCode: null, checkedAt: NOW.toISOString() }),
    prepareLease: async () => ({
      providerLeaseReference: 'provider-lease:1',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      redactedMetadata: { mode: 'ephemeral' },
    }),
    execute: async (input) => {
      assert.equal(Buffer.from(input.credential).toString('utf8'), SECRET_CANARY);
      return {
        state: 'settled', outcome: 'succeeded', providerOperationReference: 'operation:1',
        providerReceiptReference: 'receipt:1', redactedResult: { state: 'accepted' },
      };
    },
    reconcile: async () => ({ state: 'not_accepted' }),
    revoke: async () => undefined,
    projectReceipt: async (input) => ({
      providerOperationReference: input.providerOperationReference,
      providerReceiptReference: input.providerReceiptReference,
      redactedPayload: input.redactedResult,
    }),
    ...overrides,
  };
}

test('broker admits only redacted execute/reconcile/receipt results and discards raw provider errors', async () => {
  const runtime = new FixtureRuntimeBinding();
  const broker = new BrokeredAuthorityProviderAdapter(providerAdapter(), runtime);
  const result = await broker.execute(trustedContext());
  assert.equal(broker.contractVersion, TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION);
  assert.equal(result.state, 'settled');
  assert.ok(!JSON.stringify(result).includes(SECRET_CANARY));
  assert.equal(runtime.material.disposed, true);

  const maliciousRuntime = new FixtureRuntimeBinding();
  const malicious = new BrokeredAuthorityProviderAdapter(providerAdapter({
    execute: async () => ({
      state: 'settled', outcome: 'succeeded', providerOperationReference: 'operation:2',
      providerReceiptReference: 'receipt:2', redactedResult: { token: SECRET_CANARY },
    }),
  }), maliciousRuntime);
  await assert.rejects(malicious.execute(trustedContext()), (error: unknown) => (
    error instanceof AuthorityProviderBrokerError
    && error.code === 'PROVIDER_EXECUTION_FAILED'
    && !error.message.includes(SECRET_CANARY)
  ));
  assert.equal(maliciousRuntime.reconciliationMarks, 1);

  const throwingRuntime = new FixtureRuntimeBinding();
  const throwing = new BrokeredAuthorityProviderAdapter(providerAdapter({
    execute: async () => { throw new Error(SECRET_CANARY); },
  }), throwingRuntime);
  await assert.rejects(throwing.execute(trustedContext()), (error: unknown) => (
    error instanceof AuthorityProviderBrokerError && !JSON.stringify(error).includes(SECRET_CANARY)
  ));
});

test('broker fails resolution and revocation closed and marks reconciliation required without ambient fallback', async () => {
  const resolutionRuntime = new FixtureRuntimeBinding();
  resolutionRuntime.failResolution = true;
  const resolutionBroker = new BrokeredAuthorityProviderAdapter(providerAdapter(), resolutionRuntime);
  await assert.rejects(resolutionBroker.execute(trustedContext()), (error: unknown) => (
    error instanceof AuthorityProviderBrokerError && error.code === 'PROVIDER_EXECUTION_FAILED'
  ));
  assert.equal(resolutionRuntime.reconciliationMarks, 1);

  const revocationRuntime = new FixtureRuntimeBinding();
  revocationRuntime.failRevocation = true;
  const revocationBroker = new BrokeredAuthorityProviderAdapter(providerAdapter(), revocationRuntime);
  await assert.rejects(revocationBroker.revoke(trustedContext()), (error: unknown) => (
    error instanceof AuthorityProviderBrokerError && error.code === 'PROVIDER_REVOCATION_FAILED'
  ));
  assert.equal(revocationRuntime.reconciliationMarks, 1);
});

test('REA-005 migration is append-only, scoped, forward-fix-only, and leaves ciphertext schemas untouched', async () => {
  const migration = await readFile(
    new URL('../../db/pg-migrations/20260823120000_execution_authority_secret_access.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /CREATE TABLE rorca\.authority_secret_access_audit/);
  assert.match(migration, /workspace_id, lease_id/);
  assert.match(migration, /principal TEXT NOT NULL/);
  assert.match(migration, /lease_purpose TEXT NOT NULL/);
  assert.match(migration, /authority_secret_access_audit_update_guard/);
  assert.match(migration, /authority_secret_access_audit_delete_guard/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+(integration_tokens|integration_vault_secrets)/i);
  assert.doesNotMatch(migration, /(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)[^;]*pgboss\./i);
});
