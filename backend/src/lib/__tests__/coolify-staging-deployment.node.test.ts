/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StagingExecutionReceiptSchema,
  type CoolifyProviderBinding,
  type ProviderDeploymentObservation,
  type StagingDeploymentRequest,
  type StagingExecutionReceipt,
} from '../authority-provider-adapter';
import {
  CoolifyStagingDeploymentService,
  stagingDeploymentRequestDigest,
  type StagingDeploymentAdapter,
  type StagingDeploymentStore,
  type StoredStagingOperation,
} from '../coolify-staging-deployment';

const WORKSPACE_ID = 'workspace-staging';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_UUID = '55555555-5555-4555-8555-555555555555';
const APPLICATION_UUID = '66666666-6666-4666-8666-666666666666';
const ENVIRONMENT_UUID = '77777777-7777-4777-8777-777777777777';
const PRODUCTION_APPLICATION_UUID = '88888888-8888-4888-8888-888888888888';
const REVISION = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-08-23T12:00:00.000Z';

function binding(input: {
  environmentKind?: 'staging' | 'production';
  preauthorized?: boolean;
} = {}): CoolifyProviderBinding {
  const environmentKind = input.environmentKind ?? 'staging';
  const applicationUuid = environmentKind === 'staging' ? APPLICATION_UUID : PRODUCTION_APPLICATION_UUID;
  const action = environmentKind === 'staging' ? 'deploy.staging' as const : 'deploy.production' as const;
  return {
    providerId: 'coolify',
    bindingId: BINDING_ID,
    workspaceId: WORKSPACE_ID,
    bindingStatus: 'active',
    environmentKind,
    baseUrl: 'https://coolify.example.test',
    target: { projectUuid: PROJECT_UUID, applicationUuid, environmentUuid: ENVIRONMENT_UUID },
    capabilityPolicy: {
      allowedActions: [action],
      preauthorizedStaging: environmentKind === 'staging' && (input.preauthorized ?? true),
      maxLeaseSeconds: 300,
    },
    bindingGeneration: 7,
    secretReference: {
      store: 'api-key-vault',
      secretId: '99999999-9999-4999-8999-999999999999',
      purpose: 'control-token',
    },
    verifiedProfile: {
      schemaVersion: 'rorca.coolify-verified-profile.v1',
      providerVersion: '4.0.0',
      target: {
        project: { uuid: PROJECT_UUID, numericId: 1 },
        application: { uuid: applicationUuid, numericId: 2 },
        environment: { uuid: ENVIRONMENT_UUID, numericId: 3 },
      },
      principal: { subjectId: 'operator', teamId: 'team', scopes: ['applications.deploy'] },
      allowedActions: [action],
      verifiedAt: NOW,
      expiresAt: '2026-08-23T12:15:00.000Z',
    },
    lastValidationError: null,
  };
}

function request(): StagingDeploymentRequest {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    bindingGeneration: 7,
    operationId: OPERATION_ID,
    revision: { sourceRevision: REVISION, imageDigest: IMAGE_DIGEST },
    configurationBindingGeneration: 12,
    healthSignals: [{
      name: 'application.health',
      source: 'application',
      field: 'health_status',
      expectedValue: 'healthy',
    }],
    requestedLeaseSeconds: 180,
  };
}

class MemoryStore implements StagingDeploymentStore {
  operation: StoredStagingOperation | null = null;
  settledWrites = 0;

  async reserve(value: StagingDeploymentRequest, requestDigest: string): Promise<StoredStagingOperation> {
    if (!this.operation) {
      this.operation = {
        request: value,
        requestDigest,
        status: 'requested',
        leaseId: null,
        providerDeploymentId: null,
        providerAcceptedAt: null,
        receipt: null,
      };
    }
    if (this.operation.requestDigest !== requestDigest) throw new Error('request conflict');
    return this.operation;
  }

  async read(workspaceId: string, operationId: string): Promise<StoredStagingOperation | null> {
    if (this.operation?.request.workspaceId !== workspaceId
      || this.operation.request.operationId !== operationId) return null;
    return this.operation;
  }

  async markWaiting(): Promise<StoredStagingOperation> {
    this.operation!.status = 'waiting_for_authorization';
    return this.operation!;
  }

  async bindLease(_workspaceId: string, _operationId: string, leaseId: string): Promise<StoredStagingOperation> {
    this.operation!.leaseId = leaseId;
    this.operation!.status = 'leased';
    return this.operation!;
  }

  async markAccepted(
    _workspaceId: string,
    _operationId: string,
    acceptance: { providerDeploymentId: string; acceptedAt: string },
  ): Promise<StoredStagingOperation> {
    this.operation!.providerDeploymentId = acceptance.providerDeploymentId;
    this.operation!.providerAcceptedAt = acceptance.acceptedAt;
    this.operation!.status = 'dispatched';
    return this.operation!;
  }

  async markOutcomeUnknown(): Promise<void> {
    this.operation!.status = 'outcome_unknown';
  }

  async settle(receipt: StagingExecutionReceipt): Promise<StagingExecutionReceipt> {
    if (!this.operation!.receipt) {
      this.operation!.receipt = receipt;
      this.operation!.status = 'settled';
      this.settledWrites += 1;
    }
    return this.operation!.receipt;
  }
}

class FakeAdapter implements StagingDeploymentAdapter {
  preflightBinding: CoolifyProviderBinding = binding();
  dispatches: Array<Parameters<StagingDeploymentAdapter['dispatchDeployment']>[0]> = [];
  observations = 0;
  revocations = 0;
  leases = 0;
  gets = 0;
  leaseOperationId = OPERATION_ID;
  observation: ProviderDeploymentObservation = {
    providerDeploymentId: 'deployment-staging-1',
    providerStatus: 'finished',
    outcome: 'healthy',
    signals: [{
      name: 'application.health',
      source: 'application',
      field: 'health_status',
      expectedValue: 'healthy',
      actualValue: 'healthy',
      passed: true,
    }],
    observedAt: NOW,
  };

  async getProviderBinding(): Promise<CoolifyProviderBinding> {
    this.gets += 1;
    return this.preflightBinding;
  }

  async preflight(): Promise<CoolifyProviderBinding> {
    return this.preflightBinding;
  }

  async acquireLease(): Promise<{
    leaseId: string;
    bindingId: string;
    bindingGeneration: number;
    capability: 'deploy.staging';
    operationId: string;
    status: 'leased';
    issuedAt: string;
    expiresAt: string;
  }> {
    this.leases += 1;
    return {
      leaseId: LEASE_ID,
      bindingId: BINDING_ID,
      bindingGeneration: 7,
      capability: 'deploy.staging',
      operationId: this.leaseOperationId,
      status: 'leased',
      issuedAt: NOW,
      expiresAt: '2026-08-23T12:03:00.000Z',
    };
  }

  async dispatchDeployment(
    input: Parameters<StagingDeploymentAdapter['dispatchDeployment']>[0],
  ): Promise<{ providerDeploymentId: string; acceptedAt: string }> {
    this.dispatches.push(input);
    return { providerDeploymentId: 'deployment-staging-1', acceptedAt: NOW };
  }

  async observeDeployment(): Promise<ProviderDeploymentObservation> {
    this.observations += 1;
    return this.observation;
  }

  async revokeLease(): Promise<{ revokedAt: string }> {
    this.revocations += 1;
    return { revokedAt: NOW };
  }
}

function service(adapter: FakeAdapter, store: MemoryStore): CoolifyStagingDeploymentService {
  return new CoolifyStagingDeploymentService(adapter, store, {
    now: () => new Date(NOW),
    randomUUID: () => RECEIPT_ID,
  });
}

test('pre-authorized staging deploys the exact immutable request and settles a redacted receipt', async () => {
  const adapter = new FakeAdapter();
  const store = new MemoryStore();
  const result = await service(adapter, store).deploy(request());

  assert.equal(result.status, 'settled');
  assert.equal(adapter.leases, 1);
  assert.equal(adapter.dispatches.length, 1);
  assert.deepEqual(adapter.dispatches[0], {
    binding: adapter.preflightBinding,
    leaseId: LEASE_ID,
    operationId: OPERATION_ID,
    revision: { sourceRevision: REVISION, imageDigest: IMAGE_DIGEST },
    configurationBindingGeneration: 12,
  });
  assert.equal(adapter.observations, 1);
  assert.equal(adapter.revocations, 1);
  assert.equal(store.settledWrites, 1);
  if (result.status !== 'settled') return;
  assert.deepEqual(result.receipt.target, {
    providerId: 'coolify',
    bindingId: BINDING_ID,
    projectUuid: PROJECT_UUID,
    applicationUuid: APPLICATION_UUID,
    environmentUuid: ENVIRONMENT_UUID,
  });
  assert.equal(result.receipt.providerDeploymentId, 'deployment-staging-1');
  assert.equal(result.receipt.bindingGeneration, 7);
  assert.equal(result.receipt.configurationBindingGeneration, 12);
  assert.equal(result.receipt.health.outcome, 'healthy');
  assert.equal(result.receipt.lease.revoked, true);
  assert.doesNotMatch(JSON.stringify(result.receipt), /control.?token|secretReference|api-key-vault/i);
});

test('an unqualified staging binding waits before lease acquisition or provider dispatch', async () => {
  const adapter = new FakeAdapter();
  adapter.preflightBinding = binding({ preauthorized: false });
  const store = new MemoryStore();

  const result = await service(adapter, store).deploy(request());
  assert.deepEqual(result, { status: 'waiting_for_authorization', operationId: OPERATION_ID });
  assert.equal(store.operation?.status, 'waiting_for_authorization');
  assert.equal(adapter.leases, 0);
  assert.equal(adapter.dispatches.length, 0);
  assert.equal(adapter.gets, 0);
});

test('a mismatched lease is rejected before provider dispatch', async () => {
  const adapter = new FakeAdapter();
  adapter.leaseOperationId = OTHER_OPERATION_ID;
  const store = new MemoryStore();

  await assert.rejects(
    service(adapter, store).deploy(request()),
    /mismatched or unbounded capability lease/,
  );
  assert.equal(adapter.leases, 1);
  assert.equal(adapter.dispatches.length, 0);
  assert.equal(adapter.observations, 0);
  assert.equal(adapter.revocations, 0);
});

test('staging authority rejects a production target before resolving or mutating provider state', async () => {
  const adapter = new FakeAdapter();
  adapter.preflightBinding = binding({ environmentKind: 'production' });
  const store = new MemoryStore();

  await assert.rejects(service(adapter, store).deploy(request()), /different provider target/);
  assert.equal(adapter.leases, 0);
  assert.equal(adapter.dispatches.length, 0);
  assert.equal(adapter.observations, 0);
  assert.equal(adapter.revocations, 0);
  assert.equal(adapter.gets, 0);
});

test('crash after provider acceptance reconciles the captured deployment id without redispatch', async () => {
  const adapter = new FakeAdapter();
  const store = new MemoryStore();
  const markAccepted = store.markAccepted.bind(store);
  let crashAfterAcceptance = true;
  store.markAccepted = async (...args) => {
    const operation = await markAccepted(...args);
    if (crashAfterAcceptance) {
      crashAfterAcceptance = false;
      throw new Error('injected crash after provider acceptance');
    }
    return operation;
  };
  const deploymentService = service(adapter, store);

  await assert.rejects(
    deploymentService.deploy(request()),
    /injected crash after provider acceptance/,
  );
  assert.equal(store.operation?.status, 'outcome_unknown');
  assert.equal(store.operation?.providerDeploymentId, 'deployment-staging-1');

  const recovered = await deploymentService.reconcile(WORKSPACE_ID, OPERATION_ID);
  const replay = await deploymentService.reconcile(WORKSPACE_ID, OPERATION_ID);

  assert.equal(recovered.status, 'settled');
  assert.deepEqual(replay, recovered);
  assert.equal(adapter.dispatches.length, 1);
  assert.equal(adapter.gets, 1);
  assert.equal(adapter.observations, 1);
  assert.equal(adapter.revocations, 1);
  assert.equal(store.settledWrites, 1);
});

test('reconciliation rejects a production binding before provider observation or secret access', async () => {
  const adapter = new FakeAdapter();
  adapter.preflightBinding = binding({ environmentKind: 'production' });
  const store = new MemoryStore();
  store.operation = {
    request: request(),
    requestDigest: stagingDeploymentRequestDigest(request()),
    status: 'outcome_unknown',
    leaseId: LEASE_ID,
    providerDeploymentId: 'deployment-staging-1',
    providerAcceptedAt: NOW,
    receipt: null,
  };

  await assert.rejects(
    service(adapter, store).reconcile(WORKSPACE_ID, OPERATION_ID),
    /different provider target/,
  );
  assert.equal(adapter.gets, 1);
  assert.equal(adapter.dispatches.length, 0);
  assert.equal(adapter.observations, 0);
  assert.equal(adapter.revocations, 0);
  assert.equal(store.settledWrites, 0);
});

test('a mismatched provider observation cannot revoke the lease or settle a receipt', async () => {
  const adapter = new FakeAdapter();
  adapter.observation = {
    ...adapter.observation,
    providerDeploymentId: 'deployment-staging-other',
  };
  const store = new MemoryStore();

  await assert.rejects(
    service(adapter, store).deploy(request()),
    /different provider deployment/,
  );
  assert.equal(store.operation?.status, 'outcome_unknown');
  assert.equal(adapter.dispatches.length, 1);
  assert.equal(adapter.observations, 1);
  assert.equal(adapter.revocations, 0);
  assert.equal(store.settledWrites, 0);
});

test('receipt contract rejects credential-bearing or pending projections', () => {
  const receipt = {
    schemaVersion: 'rorca.staging-execution-receipt.v1',
    receiptId: RECEIPT_ID,
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    capability: 'deploy.staging',
    target: {
      providerId: 'coolify',
      bindingId: BINDING_ID,
      projectUuid: PROJECT_UUID,
      applicationUuid: APPLICATION_UUID,
      environmentUuid: ENVIRONMENT_UUID,
    },
    revision: { sourceRevision: REVISION, imageDigest: IMAGE_DIGEST },
    configurationBindingGeneration: 12,
    bindingGeneration: 7,
    providerDeploymentId: 'deployment-staging-1',
    health: {
      providerStatus: 'finished',
      outcome: 'healthy',
      signals: [],
      observedAt: NOW,
    },
    lease: { leaseId: LEASE_ID, revoked: true, revokedAt: NOW },
    settledAt: NOW,
  };
  assert.equal(StagingExecutionReceiptSchema.safeParse(receipt).success, true);
  assert.equal(StagingExecutionReceiptSchema.safeParse({ ...receipt, controlToken: 'forbidden' }).success, false);
  assert.equal(StagingExecutionReceiptSchema.safeParse({
    ...receipt,
    health: { ...receipt.health, outcome: 'pending' },
  }).success, false);
});
