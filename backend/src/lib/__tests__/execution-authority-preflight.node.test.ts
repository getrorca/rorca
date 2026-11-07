/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXECUTION_AUTHORITY_SCHEMA_VERSION,
  type AuthorityGrantRecord,
  type AuthorityRequestRecord,
  type CreateOperationIntentInput,
  type OperationIntentRecord,
  type ProviderBindingRecord,
} from '../../db/execution-authority';
import {
  EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION,
  type AuthorityPreflightRequirementRecord,
  type AuthorityRunPreflightRecord,
  type AuthorityRunWaitState,
} from '../../db/execution-authority-preflight';
import type { AuthorityRequestProjection } from '../execution-authority-policy';
import { authorityDigest } from '../execution-authority-policy';
import {
  EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION,
  ExecutionAuthorityPreflightAdapterRegistry,
  prepareExecutionAuthorityPreflight,
  settleExecutionAuthorityPreflight,
  type AuthorityPreflightAdapterAssessment,
  type AuthorityPreflightStore,
  type ExecutionAuthorityPreflightAdapter,
  type PreparedAuthorityPreflight,
} from '../execution-authority-preflight';
import { REQUIRED_CAPABILITY_SCHEMA_VERSION } from '../required-capability';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const SPEC_REVISION = authorityDigest('test-spec', 'revision-1');
const POLICY_REVISION = authorityDigest('test-policy', 'revision-1');

function declaration(capabilityId = 'provider.fixture.write', bindingGeneration = 1) {
  return {
    schemaVersion: REQUIRED_CAPABILITY_SCHEMA_VERSION,
    capabilityId,
    bindingReference: 'fixture-main',
    bindingGeneration,
    scope: { environment: 'staging', resource: 'fixture/repository' },
    requestedMode: 'repository.push',
    evidenceRequirements: [{ kind: 'evidence.validation', required: true }],
    constraints: { branch: 'feat/rea-003' },
  };
}

function binding(generation = 1): ProviderBindingRecord {
  return {
    id: `00000000-0000-4000-8000-${String(generation).padStart(12, '0')}`,
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    workspaceId: 'workspace-1',
    bindingReference: 'fixture-main',
    generation,
    capabilityId: 'provider.fixture.write',
    provider: 'fixture',
    environment: 'staging',
    providerResourceId: 'fixture/repository',
    secretReference: 'vault://workspaces/workspace-1/providers/fixture/key',
    secretFingerprint: authorityDigest('test-secret', generation),
    status: 'active',
    configuration: {},
    provenance: {},
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function registry(input: {
  policyRevision?: string;
  assessment?: AuthorityPreflightAdapterAssessment;
  capabilityIds?: string[];
} = {}): ExecutionAuthorityPreflightAdapterRegistry {
  const adapter: ExecutionAuthorityPreflightAdapter = {
    contractVersion: EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION,
    adapterId: 'fixture-adapter',
    policyRevision: input.policyRevision ?? POLICY_REVISION,
    describeCapabilities: () => (input.capabilityIds ?? ['provider.fixture.write']).map((capabilityId) => ({
      capabilityId,
      requestedModes: ['repository.push'],
    })),
    validatePreflight: async () => input.assessment ?? {
      bindingHealth: 'healthy',
      credentialMintability: 'mintable',
      changeWindow: 'open',
    },
  };
  const result = new ExecutionAuthorityPreflightAdapterRegistry();
  result.register(adapter);
  return result;
}

async function prepare(input: {
  stories?: Array<{ id: string; requiredCapabilities?: unknown }>;
  adapterRegistry?: ExecutionAuthorityPreflightAdapterRegistry;
  latestBinding?: ProviderBindingRecord | null;
  exactBinding?: ProviderBindingRecord | null;
  specRevision?: string;
} = {}): Promise<PreparedAuthorityPreflight | null> {
  const currentBinding = input.latestBinding === undefined ? binding() : input.latestBinding;
  return prepareExecutionAuthorityPreflight({
    workspaceId: 'workspace-1',
    specRevision: input.specRevision ?? SPEC_REVISION,
    environment: 'staging',
    stories: input.stories ?? [{ id: 'REA-003-A', requiredCapabilities: [declaration()] }],
    registry: input.adapterRegistry ?? registry(),
    dependencies: {
      getLatestBinding: async () => currentBinding,
      getExactBinding: async () => input.exactBinding === undefined ? currentBinding : input.exactBinding,
    },
  });
}

class MemoryPreflightStore implements AuthorityPreflightStore {
  active: AuthorityRunPreflightRecord | null = null;
  requirements: AuthorityPreflightRequirementRecord[] = [];
  intents = new Map<string, OperationIntentRecord>();
  requests = new Map<string, AuthorityRequestRecord>();
  grants = new Map<string, AuthorityGrantRecord>();
  completedStoryIds = new Set<string>();
  createRequestCount = 0;
  runState: 'AUTHORIZED' | AuthorityRunWaitState | null = null;
  invalidatedPreflightIds: string[] = [];
  private nextId = 1;

  private id(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async getActivePreflight(): Promise<AuthorityRunPreflightRecord | null> {
    return this.active;
  }

  async invalidatePreflight(preflightId: string): Promise<boolean> {
    if (!this.active || this.active.id !== preflightId) return false;
    this.invalidatedPreflightIds.push(preflightId);
    for (const grant of this.grants.values()) {
      if (grant.status === 'active') grant.status = 'revoked';
    }
    this.active = null;
    return true;
  }

  async createPreflight(input: Parameters<AuthorityPreflightStore['createPreflight']>[0]): Promise<AuthorityRunPreflightRecord> {
    this.active = {
      id: this.id(),
      schemaVersion: EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      runId: input.runId,
      specRevision: input.specRevision,
      environment: input.environment,
      policyRevision: input.policyRevision,
      preflightDigest: input.preflightDigest,
      status: input.status,
      waitExpiresAt: input.waitExpiresAt,
      pendingStoryPosition: input.pendingStoryPosition,
      invalidationReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      invalidatedAt: null,
    };
    return this.active;
  }

  async listRequirements(): Promise<AuthorityPreflightRequirementRecord[]> {
    return this.requirements;
  }

  async createRequirement(input: Parameters<AuthorityPreflightStore['createRequirement']>[0]): Promise<AuthorityPreflightRequirementRecord> {
    const record: AuthorityPreflightRequirementRecord = {
      id: this.id(),
      schemaVersion: EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      runId: input.runId,
      preflightId: input.preflightId,
      ordinal: input.ordinal,
      storyId: input.storyId,
      capabilityId: input.capabilityId,
      bindingReference: input.bindingReference,
      bindingGeneration: input.bindingGeneration,
      environment: input.environment,
      providerResourceId: input.providerResourceId,
      requestedMode: input.requestedMode,
      constraints: input.constraints,
      evidenceDigest: input.evidenceDigest,
      requirementDigest: input.requirementDigest,
      adapterId: input.adapterId,
      adapterPolicyRevision: input.adapterPolicyRevision,
      bindingHealth: input.bindingHealth,
      credentialMintability: input.credentialMintability,
      changeWindow: input.changeWindow,
      outcome: input.outcome,
      operationIntentId: input.operationIntentId,
      authorityRequestId: input.authorityRequestId,
      authorityGrantId: input.authorityGrantId,
      waitExpiresAt: input.waitExpiresAt,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.requirements.push(record);
    return record;
  }

  async updateRequirement(input: Parameters<AuthorityPreflightStore['updateRequirement']>[0]): Promise<AuthorityPreflightRequirementRecord | null> {
    const record = this.requirements.find((candidate) => candidate.id === input.requirementId);
    if (!record) return null;
    record.bindingHealth = input.bindingHealth;
    record.credentialMintability = input.credentialMintability;
    record.changeWindow = input.changeWindow;
    record.outcome = input.outcome;
    record.operationIntentId ??= input.operationIntentId ?? null;
    record.authorityRequestId ??= input.authorityRequestId ?? null;
    record.authorityGrantId ??= input.authorityGrantId ?? null;
    record.waitExpiresAt = input.waitExpiresAt;
    return record;
  }

  async updatePreflight(input: Parameters<AuthorityPreflightStore['updatePreflight']>[0]): Promise<AuthorityRunPreflightRecord | null> {
    if (!this.active || this.active.id !== input.preflightId) return null;
    this.active.status = input.status;
    this.active.waitExpiresAt = input.waitExpiresAt;
    this.active.pendingStoryPosition = Math.max(this.active.pendingStoryPosition, input.pendingStoryPosition);
    return this.active;
  }

  async createIntent(input: CreateOperationIntentInput): Promise<OperationIntentRecord> {
    const intent: OperationIntentRecord = {
      id: this.id(),
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      runId: input.runId,
      storyId: input.storyId,
      environment: input.environment,
      providerResourceId: input.providerResourceId,
      operation: input.operation,
      requestingPrincipal: input.requestingPrincipal,
      capabilityId: input.capabilityId,
      bindingReference: input.bindingReference,
      bindingGeneration: input.bindingGeneration,
      constraints: input.constraints,
      evidenceDigest: input.evidenceDigest,
      canonicalDigest: input.canonicalDigest,
      idempotencyKey: input.idempotencyKey,
      status: 'proposed',
      provenance: input.provenance,
      createdAt: NOW,
      updatedAt: NOW,
      settledAt: null,
    };
    this.intents.set(intent.id, intent);
    return intent;
  }

  async createRequest(input: Parameters<AuthorityPreflightStore['createRequest']>[0]): Promise<AuthorityRequestProjection> {
    const intent = this.intents.get(input.intentId);
    assert.ok(intent);
    const id = this.id();
    const requestDigest = authorityDigest('test-request', { intentId: intent.id, expiresAt: input.expiresAt.toISOString() });
    const record: AuthorityRequestRecord = {
      id,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      workspaceId: intent.workspaceId,
      intentId: intent.id,
      runId: intent.runId,
      storyId: intent.storyId,
      environment: intent.environment,
      providerResourceId: intent.providerResourceId,
      operation: intent.operation,
      requestingPrincipal: intent.requestingPrincipal,
      capabilityId: intent.capabilityId,
      bindingReference: intent.bindingReference,
      bindingGeneration: intent.bindingGeneration,
      constraints: intent.constraints,
      evidenceDigest: intent.evidenceDigest,
      requestDigest,
      idempotencyKey: input.idempotencyKey,
      status: 'pending',
      maximumUses: input.maximumUses,
      expiresAt: input.expiresAt,
      provenance: {},
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: null,
    };
    this.requests.set(id, record);
    this.createRequestCount += 1;
    return {
      schemaVersion: 'rorca.execution-authority-policy.v1',
      id,
      workspaceId: record.workspaceId,
      intentId: record.intentId,
      runId: record.runId,
      storyId: record.storyId,
      requestingPrincipal: record.requestingPrincipal,
      environment: record.environment,
      providerResourceId: record.providerResourceId,
      operation: record.operation,
      capabilityId: record.capabilityId,
      bindingReference: record.bindingReference,
      bindingGeneration: record.bindingGeneration,
      constraints: record.constraints,
      evidenceDigest: record.evidenceDigest,
      requestDigest: record.requestDigest,
      status: record.status,
      maximumUses: record.maximumUses,
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      resolvedAt: null,
    };
  }

  async getRequest(_workspaceId: string, requestId: string): Promise<AuthorityRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async getGrant(_workspaceId: string, requestId: string): Promise<AuthorityGrantRecord | null> {
    return this.grants.get(requestId) ?? null;
  }

  async getCompletedStoryIds(): Promise<Set<string>> {
    return this.completedStoryIds;
  }

  async setRunState(_runId: number, status: 'AUTHORIZED' | AuthorityRunWaitState): Promise<boolean> {
    this.runState = status;
    return true;
  }

  approveAll(): void {
    for (const request of this.requests.values()) {
      request.status = 'approved';
      request.resolvedAt = new Date(NOW.getTime() + 1_000);
      const intent = this.intents.get(request.intentId);
      assert.ok(intent);
      const grant: AuthorityGrantRecord = {
        id: this.id(),
        schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
        workspaceId: request.workspaceId,
        requestId: request.id,
        decisionId: this.id(),
        requestDigest: request.requestDigest,
        runId: request.runId,
        storyId: request.storyId,
        environment: request.environment,
        providerResourceId: request.providerResourceId,
        operation: request.operation,
        capabilityId: request.capabilityId,
        bindingReference: request.bindingReference,
        bindingGeneration: request.bindingGeneration,
        constraints: request.constraints,
        evidenceDigest: request.evidenceDigest,
        secretReference: 'vault://workspaces/workspace-1/providers/fixture/key',
        secretFingerprint: authorityDigest('test-secret', 1),
        maximumUses: request.maximumUses,
        usesConsumed: 0,
        fencingGeneration: 1,
        status: 'active',
        idempotencyKey: authorityDigest('test-grant-key', request.id),
        provenance: {},
        createdAt: new Date(NOW.getTime() + 1_000),
        updatedAt: new Date(NOW.getTime() + 1_000),
        expiresAt: request.expiresAt,
        revokedAt: null,
      };
      this.grants.set(request.id, grant);
    }
  }
}

test('legacy stories require no adapter, binding read, request, or preflight batch', async () => {
  let bindingReads = 0;
  const result = await prepareExecutionAuthorityPreflight({
    workspaceId: 'workspace-1',
    specRevision: SPEC_REVISION,
    environment: 'staging',
    stories: [{ id: 'LEGACY-001' }],
    registry: new ExecutionAuthorityPreflightAdapterRegistry(),
    dependencies: {
      getLatestBinding: async () => { bindingReads += 1; return null; },
      getExactBinding: async () => { bindingReads += 1; return null; },
    },
  });
  assert.equal(result, null);
  assert.equal(bindingReads, 0);
  const settled = await settleExecutionAuthorityPreflight({ runId: 42, prepared: null, specRevision: SPEC_REVISION });
  assert.equal(settled.status, 'NOT_REQUIRED');
  assert.equal(settled.dispatchAllowed, true);
});

test('enqueue preparation rejects malformed scopes, unknown capabilities, missing bindings, and stale generations', async () => {
  await assert.rejects(prepare({
    stories: [{ id: 'BAD-SCOPE', requiredCapabilities: [{
      ...declaration(),
      scope: { environment: 'staging', resource: '../credential' },
    }] }],
  }), /canonical resource scope|unsupported scope/);

  await assert.rejects(prepare({
    stories: [{ id: 'UNKNOWN', requiredCapabilities: [declaration('provider.unknown.write')] }],
  }), /Unknown execution capability/);

  await assert.rejects(prepare({ latestBinding: null }), /Missing provider binding/);
  await assert.rejects(prepare({
    stories: [{ id: 'STALE', requiredCapabilities: [declaration('provider.fixture.write', 1)] }],
    latestBinding: binding(2),
  }), /generation is stale/);
});

test('multiple missing capabilities create one durable batch and preserve requests, progress, and wait expiry across restart', async () => {
  const prepared = await prepare({
    stories: [
      { id: 'REA-003-A', requiredCapabilities: [declaration()] },
      { id: 'REA-003-B', requiredCapabilities: [declaration()] },
    ],
  });
  assert.ok(prepared);
  const store = new MemoryPreflightStore();
  const first = await settleExecutionAuthorityPreflight({
    runId: 72,
    prepared,
    specRevision: SPEC_REVISION,
    now: NOW,
    store,
  });
  assert.equal(first.status, 'WAITING_FOR_AUTHORIZATION');
  assert.equal(first.dispatchAllowed, false);
  assert.equal(first.requirements.length, 2);
  assert.equal(new Set(first.requirements.map((item) => item.authorityRequestId)).size, 2);
  assert.equal(store.createRequestCount, 2);
  assert.ok(first.waitExpiresAt);
  assert.equal(store.active?.specRevision, SPEC_REVISION);

  store.completedStoryIds.add('REA-003-A');
  const restarted = await settleExecutionAuthorityPreflight({
    runId: 72,
    prepared,
    specRevision: SPEC_REVISION,
    now: new Date(NOW.getTime() + 5_000),
    store,
  });
  assert.equal(restarted.preflightId, first.preflightId);
  assert.equal(restarted.waitExpiresAt, first.waitExpiresAt);
  assert.equal(restarted.pendingStoryPosition, 1);
  assert.equal(store.createRequestCount, 2);
  assert.equal(store.completedStoryIds.has('REA-003-A'), true);
});

test('an exact pre-authorized batch dispatches on resume without another approval request', async () => {
  const prepared = await prepare();
  assert.ok(prepared);
  const store = new MemoryPreflightStore();
  const waiting = await settleExecutionAuthorityPreflight({
    runId: 73,
    prepared,
    specRevision: SPEC_REVISION,
    now: NOW,
    store,
  });
  assert.equal(waiting.status, 'WAITING_FOR_AUTHORIZATION');
  store.approveAll();
  const resumed = await settleExecutionAuthorityPreflight({
    runId: 73,
    prepared,
    specRevision: SPEC_REVISION,
    now: new Date(NOW.getTime() + 10_000),
    store,
  });
  assert.equal(resumed.status, 'AUTHORIZED');
  assert.equal(resumed.dispatchAllowed, true);
  assert.equal(resumed.waitExpiresAt, null);
  assert.equal(store.createRequestCount, 1);
  assert.equal(store.runState, 'AUTHORIZED');
});

test('authentication and change-window waits are typed and do not create operator approval requests', async () => {
  for (const fixture of [
    {
      assessment: { bindingHealth: 'unhealthy', credentialMintability: 'unavailable', changeWindow: 'open' } as const,
      expected: 'WAITING_FOR_AUTHENTICATION' as const,
    },
    {
      assessment: { bindingHealth: 'healthy', credentialMintability: 'mintable', changeWindow: 'closed' } as const,
      expected: 'WAITING_FOR_CHANGE_WINDOW' as const,
    },
  ]) {
    const prepared = await prepare({ adapterRegistry: registry({ assessment: fixture.assessment }) });
    assert.ok(prepared);
    const store = new MemoryPreflightStore();
    const result = await settleExecutionAuthorityPreflight({
      runId: fixture.expected === 'WAITING_FOR_AUTHENTICATION' ? 74 : 75,
      prepared,
      specRevision: SPEC_REVISION,
      now: NOW,
      store,
    });
    assert.equal(result.status, fixture.expected);
    assert.equal(result.dispatchAllowed, false);
    assert.equal(store.createRequestCount, 0);
    assert.ok(result.waitExpiresAt);
  }
});

test('spec revision, binding generation, environment, and adapter policy all change preflight identity', async () => {
  const base = await prepare();
  const specChanged = await prepare({ specRevision: authorityDigest('test-spec', 'revision-2') });
  const bindingChanged = await prepare({
    stories: [{ id: 'REA-003-A', requiredCapabilities: [declaration('provider.fixture.write', 2)] }],
    latestBinding: binding(2),
  });
  const policyChanged = await prepare({
    adapterRegistry: registry({ policyRevision: authorityDigest('test-policy', 'revision-2') }),
  });
  const environmentDeclaration = declaration();
  environmentDeclaration.scope.environment = 'production';
  const environmentBinding = binding();
  environmentBinding.environment = 'production';
  const environmentChanged = await prepareExecutionAuthorityPreflight({
    workspaceId: 'workspace-1',
    specRevision: SPEC_REVISION,
    environment: 'production',
    stories: [{ id: 'REA-003-A', requiredCapabilities: [environmentDeclaration] }],
    registry: registry(),
    dependencies: {
      getLatestBinding: async () => environmentBinding,
      getExactBinding: async () => environmentBinding,
    },
  });
  assert.ok(base && specChanged && bindingChanged && policyChanged && environmentChanged);
  assert.equal(new Set([
    base.preflightDigest,
    specChanged.preflightDigest,
    bindingChanged.preflightDigest,
    policyChanged.preflightDigest,
    environmentChanged.preflightDigest,
  ]).size, 5);

  const store = new MemoryPreflightStore();
  await settleExecutionAuthorityPreflight({ runId: 76, prepared: base, specRevision: SPEC_REVISION, now: NOW, store });
  const oldId = store.active?.id;
  await settleExecutionAuthorityPreflight({
    runId: 76,
    prepared: policyChanged,
    specRevision: SPEC_REVISION,
    now: new Date(NOW.getTime() + 1_000),
    store,
  });
  assert.deepEqual(store.invalidatedPreflightIds, [oldId]);
  assert.notEqual(store.active?.id, oldId);
});
