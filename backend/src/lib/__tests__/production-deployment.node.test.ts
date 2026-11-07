/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CoolifyCapabilityPolicySchema } from '../authority-provider-adapter';
import { ForbiddenError, UnprocessableError } from '../errors';
import type {
  OperationIntentProjection,
  ReleaseIntentValidation,
} from '../release-intent';
import {
  CoolifyProductionDeploymentService,
  PRODUCTION_AUTHORIZATION_VERSION,
  PRODUCTION_GATE_CONFIGURATION_VERSION,
  PRODUCTION_GATE_EVIDENCE_VERSION,
  type ExternalGateEvidenceReference,
  type ProductionAuthorizationTicket,
  type ProductionAuthorizationWaitReason,
  type ProductionDeploymentRequest,
  type ProductionDeploymentStore,
  type ProductionDispatchAdapter,
  type ProductionPolicyProjection,
  type ReviewedExternalGateConfiguration,
  type VerifiedExternalGateEvidence,
} from '../production-deployment';
import type {
  ProductionActionAcceptance,
  ProductionActionObservation,
  ProductionCanaryAcceptance,
  ProductionRevokedLease,
  ProductionRolloutAdapter,
} from '../production-rollout';
import type {
  ProductionRolloutStore,
  StartProductionRolloutInput,
  StoredProductionAction,
  StoredProductionRollout,
} from '../production-rollout-store';

const WORKSPACE_ID = 'workspace-production';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const REPLAY_OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_INTENT_ID = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
const CONFIGURATION_ID = '66666666-6666-4666-8666-666666666666';
const EVIDENCE_ID = '77777777-7777-4777-8777-777777777777';
const AUTHORIZATION_ID = '88888888-8888-4888-8888-888888888888';
const NOW = '2026-08-24T12:00:00.000Z';
const INTENT_DIGEST = `sha256:${'a'.repeat(64)}`;
const CI_EVIDENCE_DIGEST = `sha256:${'b'.repeat(64)}`;
const APPROVAL_EVIDENCE_DIGEST = `sha256:${'c'.repeat(64)}`;
const CONFIGURATION_DIGEST = `sha256:${'d'.repeat(64)}`;
const SELECTOR_DIGEST = `sha256:${'e'.repeat(64)}`;

function projection(input: {
  startsAt?: string;
  endsAt?: string;
} = {}): OperationIntentProjection {
  return {
    schemaVersion: 'rorca.operation-intent-projection.v1',
    operationIntentId: OPERATION_INTENT_ID,
    workspaceId: WORKSPACE_ID,
    intentKind: 'release',
    intentDigest: INTENT_DIGEST,
    ciEvidenceDigest: CI_EVIDENCE_DIGEST,
    releaseIntent: {
      schemaVersion: 'rorca.release-intent.v1',
      sourceRevision: 'f'.repeat(40),
      artifacts: {
        artifactDigests: [`sha256:${'1'.repeat(64)}`],
        imageDigests: [`sha256:${'2'.repeat(64)}`],
      },
      migrationSetDigest: `sha256:${'3'.repeat(64)}`,
      configurationBindingGeneration: 9,
      featureFlagDigest: `sha256:${'4'.repeat(64)}`,
      rolloutCohort: {
        cohortId: 'production-canary',
        percentage: 10,
        selectorDigest: SELECTOR_DIGEST,
      },
      changeWindow: {
        startsAt: input.startsAt ?? '2026-08-24T11:00:00.000Z',
        endsAt: input.endsAt ?? '2026-08-24T13:00:00.000Z',
      },
      providerApprovalReference: {
        provider: 'github',
        approvalId: 'environment-approval-42',
        environment: 'production',
        evidenceDigest: APPROVAL_EVIDENCE_DIGEST,
      },
      rollback: {
        owner: 'release-owner',
        procedure: {
          procedureId: 'restore-prior-revision',
          procedureDigest: `sha256:${'5'.repeat(64)}`,
        },
      },
      healthSignals: [{
        signalId: 'http-success',
        source: 'metrics',
        evidenceKey: 'http.success.rate',
        aggregation: 'minimum',
        unit: 'percent',
      }],
      abortConditions: [{
        conditionId: 'http-failure',
        signalId: 'http-success',
        operator: 'lt',
        threshold: 99,
        observationWindowSeconds: 60,
        requiredSamples: 3,
      }],
    },
    provenance: {
      schemaVersion: 'rorca.release-intent-provenance.v1',
      ciEvidence: [{
        provider: 'github',
        pipelineId: 'pipeline-42',
        jobId: 'build-42',
        sourceRevision: 'f'.repeat(40),
        artifactDigest: `sha256:${'1'.repeat(64)}`,
        result: 'passed',
        evidenceDigest: `sha256:${'6'.repeat(64)}`,
        observedAt: '2026-08-24T10:30:00.000Z',
      }],
      stagingReceiptDigests: [`sha256:${'7'.repeat(64)}`],
      attestationDigests: [],
    },
    immutable: true,
    createdBy: 'local-operator',
    createdAt: '2026-08-24T10:45:00.000Z',
  };
}

function request(input: Partial<ProductionDeploymentRequest> = {}): ProductionDeploymentRequest {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    bindingGeneration: 3,
    operationId: OPERATION_ID,
    operationIntentId: OPERATION_INTENT_ID,
    grantId: GRANT_ID,
    intentDigest: INTENT_DIGEST,
    ciEvidenceDigest: CI_EVIDENCE_DIGEST,
    rolloutCohort: {
      cohortId: 'production-canary',
      percentage: 10,
      selectorDigest: SELECTOR_DIGEST,
    },
    approval: {
      kind: 'external_gate',
      evidence: { provider: 'github', evidenceId: EVIDENCE_ID },
    },
    requestedLeaseSeconds: 120,
    ...input,
  };
}

function configuration(): ReviewedExternalGateConfiguration {
  return {
    schemaVersion: PRODUCTION_GATE_CONFIGURATION_VERSION,
    configurationId: CONFIGURATION_ID,
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    provider: 'github',
    gateId: 'protected-environment',
    environment: 'production',
    configurationDigest: CONFIGURATION_DIGEST,
    reviewReceiptDigest: `sha256:${'8'.repeat(64)}`,
    reviewedAt: '2026-08-24T10:00:00.000Z',
    status: 'reviewed',
  };
}

function evidence(input: Partial<VerifiedExternalGateEvidence> = {}): VerifiedExternalGateEvidence {
  return {
    schemaVersion: PRODUCTION_GATE_EVIDENCE_VERSION,
    evidenceId: EVIDENCE_ID,
    configurationId: CONFIGURATION_ID,
    workspaceId: WORKSPACE_ID,
    provider: 'github',
    providerEvidenceId: 'deployment-review-42',
    gateId: 'protected-environment',
    environment: 'production',
    configurationDigest: CONFIGURATION_DIGEST,
    decision: 'approved',
    operationIntentId: OPERATION_INTENT_ID,
    intentDigest: INTENT_DIGEST,
    ciEvidenceDigest: CI_EVIDENCE_DIGEST,
    rolloutCohort: {
      cohortId: 'production-canary',
      percentage: 10,
      selectorDigest: SELECTOR_DIGEST,
    },
    providerApprovalId: 'environment-approval-42',
    evidenceDigest: APPROVAL_EVIDENCE_DIGEST,
    reviewerSubjects: ['github:user:independent-reviewer'],
    issuedAt: '2026-08-24T11:30:00.000Z',
    expiresAt: '2026-08-24T12:30:00.000Z',
    verifiedAt: '2026-08-24T11:31:00.000Z',
    ...input,
  };
}

class MemoryReleaseIntents {
  currentProjection = projection();
  validationError: Error | null = null;

  async get(): Promise<OperationIntentProjection> {
    return this.currentProjection;
  }

  async validate(): Promise<ReleaseIntentValidation> {
    if (this.validationError) throw this.validationError;
    return {
      schemaVersion: 'rorca.release-intent-validation.v1',
      valid: true,
      operationIntentId: OPERATION_INTENT_ID,
      workspaceId: WORKSPACE_ID,
      intentDigest: INTENT_DIGEST,
      ciEvidenceDigest: CI_EVIDENCE_DIGEST,
      grantId: GRANT_ID,
      grantExpiresAt: '2026-08-24T12:30:00.000Z',
    };
  }
}

class MemoryProductionStore implements ProductionDeploymentStore {
  policy: ProductionPolicyProjection = {
    mode: 'independent_external',
    externalGate: configuration(),
  };
  verifiedEvidence: VerifiedExternalGateEvidence | null = evidence();
  waits: Array<ProductionAuthorizationWaitReason | 'window_not_started' | 'window_closed'> = [];
  authorizedEvidence = new Set<string>();
  authorizedGrants = new Set<string>();
  events: string[] = [];
  tickets = new Map<string, ProductionAuthorizationTicket>();

  async ensureOperation(): Promise<void> {
    this.events.push('operation');
  }

  async getPolicy(): Promise<ProductionPolicyProjection> {
    return this.policy;
  }

  async getVerifiedExternalGateEvidence(
    _configuration: ReviewedExternalGateConfiguration,
    _reference: ExternalGateEvidenceReference,
  ): Promise<VerifiedExternalGateEvidence | null> {
    return this.verifiedEvidence;
  }

  async markWaitingForAuthorization(
    _request: ProductionDeploymentRequest,
    reason: ProductionAuthorizationWaitReason,
  ): Promise<void> {
    this.waits.push(reason);
  }

  async markWaitingForChangeWindow(
    _request: ProductionDeploymentRequest,
    reason: 'window_not_started' | 'window_closed',
  ): Promise<void> {
    this.waits.push(reason);
  }

  async authorize(
    input: Parameters<ProductionDeploymentStore['authorize']>[0],
  ): Promise<ProductionAuthorizationTicket | null> {
    const existing = this.tickets.get(input.request.operationId);
    if (existing) return existing;
    const evidenceId = input.evidence?.evidenceId;
    if (this.authorizedGrants.has(input.validation.grantId)
      || (evidenceId !== undefined && this.authorizedEvidence.has(evidenceId))) return null;
    this.authorizedGrants.add(input.validation.grantId);
    if (evidenceId !== undefined) this.authorizedEvidence.add(evidenceId);
    this.events.push('authorized');
    const ticket: ProductionAuthorizationTicket = {
      schemaVersion: PRODUCTION_AUTHORIZATION_VERSION,
      authorizationId: AUTHORIZATION_ID,
      operationId: input.request.operationId,
      workspaceId: input.request.workspaceId,
      bindingId: input.request.bindingId,
      bindingGeneration: input.request.bindingGeneration,
      operationIntentId: input.request.operationIntentId,
      intentDigest: input.validation.intentDigest,
      ciEvidenceDigest: input.validation.ciEvidenceDigest,
      grantId: input.validation.grantId,
      gateEvidenceId: evidenceId ?? null,
      authorizedAt: input.authorizedAt,
    };
    this.tickets.set(input.request.operationId, ticket);
    return ticket;
  }

  async markDispatched(): Promise<void> {
    this.events.push('recorded');
  }
}

class FakeProductionAdapter implements ProductionDispatchAdapter, ProductionRolloutAdapter {
  dispatches = 0;
  providerMutations = 0;
  loseCanaryAcceptanceOnce = false;
  private acceptedCanary: ProductionCanaryAcceptance | null = null;
  events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async dispatchAuthorizedProduction(
    input: Parameters<ProductionDispatchAdapter['dispatchAuthorizedProduction']>[0],
  ): Promise<ProductionCanaryAcceptance> {
    this.dispatches += 1;
    this.events.push('trusted-adapter');
    if (this.acceptedCanary === null) {
      this.providerMutations += 1;
      this.acceptedCanary = {
        action: {
          actionId: input.ticket.operationId,
          phase: 'canary',
          leaseId: '99999999-9999-4999-8999-999999999999',
          providerDeploymentId: 'production-deployment-42',
          acceptedAt: NOW,
          cohort: input.releaseIntent.rolloutCohort,
          targetRevision: {
            sourceRevision: input.releaseIntent.sourceRevision,
            imageDigest: input.releaseIntent.artifacts.imageDigests[0]!,
            configurationBindingGeneration: input.releaseIntent.configurationBindingGeneration,
          },
        },
        priorState: {
          revision: {
            sourceRevision: 'e'.repeat(40),
            imageDigest: `sha256:${'e'.repeat(64)}`,
            configurationBindingGeneration: 8,
          },
          authorityBindingGeneration: input.ticket.bindingGeneration,
          capturedAt: NOW,
        },
        target: {
          providerId: 'coolify',
          bindingId: input.ticket.bindingId,
          projectUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          applicationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          environmentUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        },
      };
      if (this.loseCanaryAcceptanceOnce) {
        this.loseCanaryAcceptanceOnce = false;
        throw new UnprocessableError(
          'simulated canary acceptance loss',
          'SIMULATED_CANARY_CRASH',
        );
      }
    }
    return this.acceptedCanary;
  }

  async observeProductionAction(): Promise<ProductionActionObservation> {
    throw new Error('not used by authorization tests');
  }

  async dispatchProductionAction(): Promise<ProductionActionAcceptance> {
    throw new Error('not used by authorization tests');
  }

  async reconcileProductionAction(): Promise<ProductionActionAcceptance | null> {
    throw new Error('not used by authorization tests');
  }

  async revokeProductionActionLease(): Promise<ProductionRevokedLease> {
    throw new Error('not used by authorization tests');
  }
}

class MemoryProductionRolloutStore implements ProductionRolloutStore {
  started: StoredProductionRollout[] = [];

  async start(input: StartProductionRolloutInput): Promise<StoredProductionRollout> {
    const rollout: StoredProductionRollout = {
      authority: input.authority,
      target: input.target,
      approvedCohort: input.approvedCohort,
      priorState: input.priorState,
      status: 'canary_dispatched',
      actions: [{
        actionId: input.canary.actionId,
        phase: 'canary',
        status: 'dispatched',
        targetRevision: input.canary.targetRevision,
        cohort: input.canary.cohort,
        acceptance: input.canary,
        observation: null,
        revocation: null,
      }],
      evaluation: null,
      receipt: null,
    };
    this.started.push(rollout);
    return rollout;
  }

  async read(): Promise<StoredProductionRollout | null> {
    return this.started[0] ?? null;
  }

  async prepareAction(): Promise<StoredProductionAction> {
    throw new Error('not used by authorization tests');
  }

  async recordActionAcceptance(): Promise<StoredProductionRollout> {
    throw new Error('not used by authorization tests');
  }


  async recordActionObservation(): Promise<StoredProductionRollout> {
    throw new Error('not used by authorization tests');
  }

  async recordEvaluation(): Promise<StoredProductionRollout> {
    throw new Error('not used by authorization tests');
  }

  async recordRevocation(): Promise<StoredProductionRollout> {
    throw new Error('not used by authorization tests');
  }

  async settle(): Promise<never> {
    throw new Error('not used by authorization tests');
  }
}

interface ProductionServiceFixture {
  adapter: FakeProductionAdapter;
  store: MemoryProductionStore;
  releases: MemoryReleaseIntents;
  deployment: CoolifyProductionDeploymentService;
  rollouts: MemoryProductionRolloutStore;
}

function service(input: {
  store?: MemoryProductionStore;
  releases?: MemoryReleaseIntents;
} = {}): ProductionServiceFixture {
  const store = input.store ?? new MemoryProductionStore();
  const releases = input.releases ?? new MemoryReleaseIntents();
  const adapter = new FakeProductionAdapter(store.events);
  const rollouts = new MemoryProductionRolloutStore();
  return {
    adapter,
    store,
    releases,
    rollouts,
    deployment: new CoolifyProductionDeploymentService(
      adapter,
      store,
      releases,
      { now: () => new Date(NOW), randomUUID: () => AUTHORIZATION_ID },
      rollouts,
    ),
  };
}

test('independent approval accepts exact verified external-gate evidence before trusted dispatch', async () => {
  const fixture = service();
  const result = await fixture.deployment.deploy(request(), 'local-operator');

  assert.deepEqual(result, {
    status: 'dispatched',
    operationId: OPERATION_ID,
    providerDeploymentId: 'production-deployment-42',
    acceptedAt: NOW,
  });
  assert.equal(fixture.adapter.dispatches, 1);
  assert.deepEqual(fixture.store.events, [
    'operation',
    'authorized',
    'trusted-adapter',
    'recorded',
  ]);
});

test('canary acceptance loss reconciles the same provider mutation before rollout persistence', async () => {
  const fixture = service();
  fixture.adapter.loseCanaryAcceptanceOnce = true;

  await assert.rejects(
    fixture.deployment.deploy(request(), 'local-operator'),
    (error: unknown) => error instanceof UnprocessableError
      && error.code === 'SIMULATED_CANARY_CRASH',
  );
  assert.equal(fixture.adapter.providerMutations, 1);
  assert.equal(fixture.rollouts.started.length, 0);

  const recovered = await fixture.deployment.deploy(request(), 'local-operator');
  assert.deepEqual(recovered, {
    status: 'dispatched',
    operationId: OPERATION_ID,
    providerDeploymentId: 'production-deployment-42',
    acceptedAt: NOW,
  });
  assert.equal(fixture.adapter.dispatches, 2);
  assert.equal(fixture.adapter.providerMutations, 1);
  assert.equal(fixture.rollouts.started.length, 1);
});

test('independent approval rejects local self-attestation without calling trusted dispatch', async () => {
  const fixture = service();
  const result = await fixture.deployment.deploy(request({
    approval: { kind: 'local_operator' },
  }), 'local-operator');

  assert.deepEqual(result, {
    status: 'waiting_for_authorization',
    operationId: OPERATION_ID,
    reason: 'local_self_attestation_rejected',
  });
  assert.equal(fixture.adapter.dispatches, 0);
});

test('local production policy accepts the authenticated local operator but not an unbound caller identity', async () => {
  const store = new MemoryProductionStore();
  store.policy = { mode: 'local_operator', externalGate: null };
  const accepted = service({ store });
  const result = await accepted.deployment.deploy(request({
    approval: { kind: 'local_operator' },
  }), 'local-operator');
  assert.equal(result.status, 'dispatched');
  assert.equal(accepted.adapter.dispatches, 1);

  const unauthenticatedStore = new MemoryProductionStore();
  unauthenticatedStore.policy = { mode: 'local_operator', externalGate: null };
  const unauthenticated = service({ store: unauthenticatedStore });
  const denied = await unauthenticated.deployment.deploy(request({
    approval: { kind: 'local_operator' },
  }));
  assert.equal(denied.status, 'waiting_for_authorization');
  assert.equal(unauthenticated.adapter.dispatches, 0);
});

test('authorization and change-window waits return immediately without dispatch', async (t) => {
  const scenarios: Array<{
    name: string;
    configure(fixture: ProductionServiceFixture): ProductionDeploymentRequest;
    expectedStatus: 'waiting_for_authorization' | 'waiting_for_change_window';
    expectedReason: string;
  }> = [
    {
      name: 'no reviewed external gate',
      configure: (fixture) => {
        fixture.store.policy = { mode: 'independent_external', externalGate: null };
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
      expectedReason: 'external_gate_not_configured',
    },
    {
      name: 'gate evidence still pending',
      configure: (fixture) => {
        fixture.store.verifiedEvidence = null;
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
      expectedReason: 'external_gate_pending',
    },
    {
      name: 'change window not started',
      configure: (fixture) => {
        fixture.releases.currentProjection = projection({
          startsAt: '2026-08-24T12:30:00.000Z',
          endsAt: '2026-08-24T13:30:00.000Z',
        });
        return request();
      },
      expectedStatus: 'waiting_for_change_window',
      expectedReason: 'window_not_started',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = service();
      const result = await fixture.deployment.deploy(scenario.configure(fixture), 'local-operator');
      assert.equal(result.status, scenario.expectedStatus);
      assert.equal(result.reason, scenario.expectedReason);
      assert.equal(fixture.adapter.dispatches, 0);
      assert.deepEqual(fixture.store.events, ['operation']);
    });
  }
});

test('closed window, changed material, denied or expired authority execute no production deploy', async (t) => {
  const scenarios: Array<{
    name: string;
    configure(fixture: ProductionServiceFixture): ProductionDeploymentRequest;
    expectedStatus: 'waiting_for_authorization' | 'waiting_for_change_window';
  }> = [
    {
      name: 'closed window',
      configure: (fixture) => {
        fixture.releases.currentProjection = projection({
          startsAt: '2026-08-24T10:00:00.000Z',
          endsAt: '2026-08-24T11:00:00.000Z',
        });
        return request();
      },
      expectedStatus: 'waiting_for_change_window',
    },
    {
      name: 'changed intent digest',
      configure: () => request({ intentDigest: `sha256:${'9'.repeat(64)}` }),
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'changed CI evidence digest',
      configure: () => request({ ciEvidenceDigest: `sha256:${'9'.repeat(64)}` }),
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'changed requested cohort',
      configure: () => request({
        rolloutCohort: {
          cohortId: 'production-canary',
          percentage: 20,
          selectorDigest: SELECTOR_DIGEST,
        },
      }),
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'changed gate evidence cohort',
      configure: (fixture) => {
        fixture.store.verifiedEvidence = evidence({
          rolloutCohort: {
            cohortId: 'production-canary',
            percentage: 20,
            selectorDigest: SELECTOR_DIGEST,
          },
        });
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'changed gate evidence identity',
      configure: (fixture) => {
        fixture.store.verifiedEvidence = evidence({
          evidenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'gate configuration bound to another production target',
      configure: (fixture) => {
        fixture.store.policy = {
          mode: 'independent_external',
          externalGate: {
            ...configuration(),
            bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        };
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'reviewer identity is not external-provider qualified',
      configure: (fixture) => {
        fixture.store.verifiedEvidence = evidence({
          reviewerSubjects: ['invented-local-reviewer'],
        });
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'denied external gate',
      configure: (fixture) => {
        fixture.store.verifiedEvidence = evidence({ decision: 'denied' });
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'expired external gate evidence',
      configure: (fixture) => {
        fixture.store.verifiedEvidence = evidence({ expiresAt: '2026-08-24T11:59:59.000Z' });
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
    {
      name: 'expired or mismatched grant',
      configure: (fixture) => {
        fixture.releases.validationError = new ForbiddenError('Authorization grant has expired');
        return request();
      },
      expectedStatus: 'waiting_for_authorization',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = service();
      const result = await fixture.deployment.deploy(scenario.configure(fixture), 'local-operator');
      assert.equal(result.status, scenario.expectedStatus);
      assert.equal(fixture.adapter.dispatches, 0);
    });
  }
});

test('an external gate evidence or grant replay cannot dispatch a second operation', async () => {
  const fixture = service();
  const first = await fixture.deployment.deploy(request(), 'local-operator');
  const replay = await fixture.deployment.deploy(request({
    operationId: REPLAY_OPERATION_ID,
  }), 'local-operator');

  assert.equal(first.status, 'dispatched');
  assert.deepEqual(replay, {
    status: 'waiting_for_authorization',
    operationId: REPLAY_OPERATION_ID,
    reason: 'authorization_replayed',
  });
  assert.equal(fixture.adapter.dispatches, 1);
});

test('missing production external gate does not remove staging preauthorization capability', async () => {
  const fixture = service();
  fixture.store.policy = { mode: 'independent_external', externalGate: null };
  const production = await fixture.deployment.deploy(request(), 'local-operator');
  const stagingPolicy = CoolifyCapabilityPolicySchema.parse({
    allowedActions: ['deploy.staging'],
    preauthorizedStaging: true,
    maxLeaseSeconds: 300,
  });

  assert.equal(production.status, 'waiting_for_authorization');
  assert.deepEqual(stagingPolicy.allowedActions, ['deploy.staging']);
  assert.equal(stagingPolicy.preauthorizedStaging, true);
  assert.equal(fixture.adapter.dispatches, 0);
});
