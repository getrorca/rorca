/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { UnprocessableError } from '../errors';
import type { OperationIntentProjection, ReleaseIntent } from '../release-intent';
import {
  CoolifyProductionDeploymentService,
  type ProductionDeploymentStore,
  type ProductionDispatchAdapter,
} from '../production-deployment';
import {
  PRODUCTION_HEALTH_EVIDENCE_VERSION,
  evaluateProductionHealth,
  type ProductionActionAcceptance,
  type ProductionActionObservation,
  type ProductionCanaryAcceptance,
  type ProductionHealthEvidence,
  type ProductionHealthEvaluation,
  type ProductionRevokedLease,
  type ProductionRolloutAdapter,
  type ProductionRolloutAuthority,
  type ProductionRolloutReceipt,
  type ProductionTarget,
} from '../production-rollout';
import type {
  ProductionRolloutStore,
  StartProductionRolloutInput,
  StoredProductionAction,
  StoredProductionRollout,
} from '../production-rollout-store';

const SELECTOR_DIGEST = `sha256:${'a'.repeat(64)}`;

function intent(): ReleaseIntent {
  return {
    schemaVersion: 'rorca.release-intent.v1',
    sourceRevision: '1'.repeat(40),
    artifacts: {
      artifactDigests: [`sha256:${'2'.repeat(64)}`],
      imageDigests: [`sha256:${'3'.repeat(64)}`],
    },
    migrationSetDigest: `sha256:${'4'.repeat(64)}`,
    configurationBindingGeneration: 8,
    featureFlagDigest: `sha256:${'5'.repeat(64)}`,
    rolloutCohort: {
      cohortId: 'approved-canary',
      percentage: 10,
      selectorDigest: SELECTOR_DIGEST,
    },
    changeWindow: {
      startsAt: '2026-08-24T11:00:00.000Z',
      endsAt: '2026-08-24T13:00:00.000Z',
    },
    providerApprovalReference: {
      provider: 'github',
      approvalId: 'approval-17',
      environment: 'production',
      evidenceDigest: `sha256:${'6'.repeat(64)}`,
    },
    rollback: {
      owner: 'release-owner',
      procedure: {
        procedureId: 'restore-prior-revision',
        procedureDigest: `sha256:${'7'.repeat(64)}`,
      },
    },
    healthSignals: [{
      signalId: 'error-rate',
      source: 'metrics',
      evidenceKey: 'http.error-rate',
      aggregation: 'maximum',
      unit: 'percent',
    }, {
      signalId: 'success-rate',
      source: 'metrics',
      evidenceKey: 'http.success-rate',
      aggregation: 'minimum',
      unit: 'percent',
    }],
    abortConditions: [{
      conditionId: 'error-rate-high',
      signalId: 'error-rate',
      operator: 'gte',
      threshold: 5,
      observationWindowSeconds: 60,
      requiredSamples: 2,
    }, {
      conditionId: 'success-rate-low',
      signalId: 'success-rate',
      operator: 'lt',
      threshold: 99,
      observationWindowSeconds: 60,
      requiredSamples: 2,
    }],
  };
}

function evidence(samples: ProductionHealthEvidence['samples']): ProductionHealthEvidence {
  return {
    schemaVersion: PRODUCTION_HEALTH_EVIDENCE_VERSION,
    providerDeploymentId: 'coolify-deployment-canary-1',
    rolloutCohort: {
      cohortId: 'approved-canary',
      percentage: 10,
      selectorDigest: SELECTOR_DIGEST,
    },
    revision: {
      sourceRevision: '1'.repeat(40),
      imageDigest: `sha256:${'3'.repeat(64)}`,
      configurationBindingGeneration: 8,
    },
    providerStatus: 'running',
    providerOutcome: 'healthy',
    samples,
    observedAt: '2026-08-24T12:00:00.000Z',
  };
}

const HEALTHY_SAMPLES: ProductionHealthEvidence['samples'] = [{
  signalId: 'error-rate',
  source: 'metrics',
  evidenceKey: 'http.error-rate',
  value: 1,
  sampledAt: '2026-08-24T11:59:20.000Z',
}, {
  signalId: 'error-rate',
  source: 'metrics',
  evidenceKey: 'http.error-rate',
  value: 2,
  sampledAt: '2026-08-24T11:59:50.000Z',
}, {
  signalId: 'success-rate',
  source: 'metrics',
  evidenceKey: 'http.success-rate',
  value: 99.8,
  sampledAt: '2026-08-24T11:59:15.000Z',
}, {
  signalId: 'success-rate',
  source: 'metrics',
  evidenceKey: 'http.success-rate',
  value: 99.9,
  sampledAt: '2026-08-24T11:59:45.000Z',
}];

test('health evaluation is canonical and deterministic for the same evidence', () => {
  const forward = evaluateProductionHealth(intent(), evidence(HEALTHY_SAMPLES));
  const reversed = evaluateProductionHealth(intent(), evidence([...HEALTHY_SAMPLES].reverse()));

  assert.deepEqual(reversed, forward);
  assert.equal(forward.decision, 'expand');
  assert.equal(forward.evaluatedAt, '2026-08-24T12:00:00.000Z');
  assert.match(forward.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(forward.conditions.map((condition) => ({
    conditionId: condition.conditionId,
    threshold: condition.threshold,
    aggregatedValue: condition.aggregatedValue,
    triggered: condition.triggered,
    windowStartedAt: condition.windowStartedAt,
    windowEndedAt: condition.windowEndedAt,
    inputValues: condition.inputSamples.map((sample) => sample.value),
  })), [{
    conditionId: 'error-rate-high',
    threshold: 5,
    aggregatedValue: 2,
    triggered: false,
    windowStartedAt: '2026-08-24T11:59:00.000Z',
    windowEndedAt: '2026-08-24T12:00:00.000Z',
    inputValues: [1, 2],
  }, {
    conditionId: 'success-rate-low',
    threshold: 99,
    aggregatedValue: 99.8,
    triggered: false,
    windowStartedAt: '2026-08-24T11:59:00.000Z',
    windowEndedAt: '2026-08-24T12:00:00.000Z',
    inputValues: [99.8, 99.9],
  }]);
});

test('an exact abort threshold changes the decision and preserves the triggering evidence', () => {
  const unhealthySamples = HEALTHY_SAMPLES.map((sample) =>
    sample.signalId === 'error-rate' && sample.sampledAt.endsWith('50.000Z')
      ? { ...sample, value: 5 }
      : sample);
  const healthy = evaluateProductionHealth(intent(), evidence(HEALTHY_SAMPLES));
  const unhealthy = evaluateProductionHealth(intent(), evidence(unhealthySamples));

  assert.equal(unhealthy.decision, 'abort');
  assert.notEqual(unhealthy.evidenceDigest, healthy.evidenceDigest);
  assert.deepEqual(unhealthy.conditions[0], {
    conditionId: 'error-rate-high',
    signalId: 'error-rate',
    operator: 'gte',
    threshold: 5,
    observationWindowSeconds: 60,
    requiredSamples: 2,
    windowStartedAt: '2026-08-24T11:59:00.000Z',
    windowEndedAt: '2026-08-24T12:00:00.000Z',
    inputSamples: [unhealthySamples[0], unhealthySamples[1]],
    aggregatedValue: 5,
    triggered: true,
  });
});

test('provider outcome fails closed even when numeric thresholds look healthy', () => {
  const healthyEvidence = evidence(HEALTHY_SAMPLES);
  const unhealthy = evaluateProductionHealth(intent(), {
    ...healthyEvidence,
    providerStatus: 'failed',
    providerOutcome: 'unhealthy',
  });
  const unresolved = evaluateProductionHealth(intent(), {
    ...healthyEvidence,
    providerStatus: 'running',
    providerOutcome: 'pending',
  });

  assert.equal(unhealthy.conditions.every((condition) => condition.triggered === false), true);
  assert.equal(unhealthy.decision, 'abort');
  assert.equal(unresolved.decision, 'pending');
});

test('insufficient samples wait and undeclared evidence fails closed', () => {
  const incomplete = evaluateProductionHealth(intent(), evidence(HEALTHY_SAMPLES.slice(0, 1)));
  assert.equal(incomplete.decision, 'pending');
  assert.equal(incomplete.conditions[0]?.aggregatedValue, null);
  assert.equal(incomplete.conditions[0]?.triggered, null);

  assert.throws(() => evaluateProductionHealth(intent(), evidence([{
    ...HEALTHY_SAMPLES[0]!,
    evidenceKey: 'unreviewed.metric',
  }])), /does not match a declared signal/);
  assert.throws(() => evaluateProductionHealth(intent(), evidence([{
    ...HEALTHY_SAMPLES[0]!,
    sampledAt: '2026-08-24T12:00:01.000Z',
  }])), /cannot postdate/);
});

const ROLLOUT_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const ROLLOUT_INTENT_ID = '22222222-2222-4222-8222-222222222222';
const ROLLOUT_AUTHORIZATION_ID = '33333333-3333-4333-8333-333333333333';
const ROLLOUT_BINDING_ID = '44444444-4444-4444-8444-444444444444';
const ROLLOUT_GRANT_ID = '55555555-5555-4555-8555-555555555555';
const ROLLOUT_GATE_ID = '66666666-6666-4666-8666-666666666666';
const CANARY_LEASE_ID = '77777777-7777-4777-8777-777777777777';
const EXPANSION_ACTION_ID = '88888888-8888-4888-8888-888888888888';
const EXPANSION_LEASE_ID = '99999999-9999-4999-8999-999999999999';
const ROLLBACK_ACTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROLLBACK_LEASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECEIPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROLLOUT_INTENT_DIGEST = `sha256:${'8'.repeat(64)}`;
const ROLLOUT_CI_DIGEST = `sha256:${'9'.repeat(64)}`;
const ROLLOUT_NOW = '2026-08-24T12:00:00.000Z';

const ROLLOUT_TARGET: ProductionTarget = {
  providerId: 'coolify',
  bindingId: ROLLOUT_BINDING_ID,
  projectUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  applicationUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  environmentUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

const ROLLOUT_AUTHORITY: ProductionRolloutAuthority = {
  authorizationId: ROLLOUT_AUTHORIZATION_ID,
  operationId: ROLLOUT_OPERATION_ID,
  workspaceId: 'workspace-rollout',
  bindingId: ROLLOUT_BINDING_ID,
  bindingGeneration: 4,
  operationIntentId: ROLLOUT_INTENT_ID,
  intentDigest: ROLLOUT_INTENT_DIGEST,
  ciEvidenceDigest: ROLLOUT_CI_DIGEST,
  grantId: ROLLOUT_GRANT_ID,
  gateEvidenceId: ROLLOUT_GATE_ID,
  authorizedAt: ROLLOUT_NOW,
};

function rolloutProjection(): OperationIntentProjection {
  const releaseIntent = intent();
  return {
    schemaVersion: 'rorca.operation-intent-projection.v1',
    operationIntentId: ROLLOUT_INTENT_ID,
    workspaceId: ROLLOUT_AUTHORITY.workspaceId,
    intentKind: 'release',
    intentDigest: ROLLOUT_INTENT_DIGEST,
    ciEvidenceDigest: ROLLOUT_CI_DIGEST,
    releaseIntent,
    provenance: {
      schemaVersion: 'rorca.release-intent-provenance.v1',
      ciEvidence: [{
        provider: 'github',
        pipelineId: 'pipeline-rollout',
        jobId: 'job-rollout',
        sourceRevision: releaseIntent.sourceRevision,
        artifactDigest: releaseIntent.artifacts.artifactDigests[0]!,
        result: 'passed',
        evidenceDigest: `sha256:${'d'.repeat(64)}`,
        observedAt: '2026-08-24T11:00:00.000Z',
      }],
      stagingReceiptDigests: [`sha256:${'e'.repeat(64)}`],
      attestationDigests: [],
    },
    immutable: true,
    createdBy: 'local-operator',
    createdAt: '2026-08-24T11:05:00.000Z',
  };
}

function canaryAcceptance(): ProductionActionAcceptance {
  const releaseIntent = intent();
  return {
    actionId: ROLLOUT_OPERATION_ID,
    phase: 'canary',
    leaseId: CANARY_LEASE_ID,
    providerDeploymentId: 'coolify-canary-1',
    acceptedAt: ROLLOUT_NOW,
    cohort: releaseIntent.rolloutCohort,
    targetRevision: {
      sourceRevision: releaseIntent.sourceRevision,
      imageDigest: releaseIntent.artifacts.imageDigests[0]!,
      configurationBindingGeneration: releaseIntent.configurationBindingGeneration,
    },
  };
}

function initialRollout(): StoredProductionRollout {
  const releaseIntent = intent();
  const canary = canaryAcceptance();
  return {
    authority: ROLLOUT_AUTHORITY,
    target: ROLLOUT_TARGET,
    approvedCohort: releaseIntent.rolloutCohort,
    priorState: {
      revision: {
        sourceRevision: '0'.repeat(40),
        imageDigest: `sha256:${'0'.repeat(64)}`,
        configurationBindingGeneration: 7,
      },
      authorityBindingGeneration: ROLLOUT_AUTHORITY.bindingGeneration,
      capturedAt: '2026-08-24T11:59:00.000Z',
    },
    status: 'canary_dispatched',
    actions: [{
      actionId: canary.actionId,
      phase: canary.phase,
      status: 'dispatched',
      targetRevision: canary.targetRevision,
      cohort: canary.cohort,
      acceptance: canary,
      observation: null,
      revocation: null,
    }],
    evaluation: null,
    receipt: null,
  };
}

class ReconcileOnlyProductionStore implements ProductionDeploymentStore {
  async ensureOperation(): Promise<never> { throw new Error('deploy not used'); }
  async getPolicy(): Promise<never> { throw new Error('deploy not used'); }
  async getVerifiedExternalGateEvidence(): Promise<never> { throw new Error('deploy not used'); }
  async markWaitingForAuthorization(): Promise<never> { throw new Error('deploy not used'); }
  async markWaitingForChangeWindow(): Promise<never> { throw new Error('deploy not used'); }
  async authorize(): Promise<never> { throw new Error('deploy not used'); }
  async markDispatched(): Promise<never> { throw new Error('deploy not used'); }
}

class MemoryRolloutStore implements ProductionRolloutStore {
  rollout = initialRollout();

  async start(_input: StartProductionRolloutInput): Promise<StoredProductionRollout> {
    throw new Error('deploy not used');
  }

  async read(workspaceId: string, operationId: string): Promise<StoredProductionRollout | null> {
    return workspaceId === this.rollout.authority.workspaceId
      && operationId === this.rollout.authority.operationId
      ? this.rollout
      : null;
  }

  async prepareAction(input: {
    phase: 'expansion' | 'rollback';
    targetRevision: StoredProductionAction['targetRevision'];
  }): Promise<StoredProductionAction> {
    const existing = this.rollout.actions.find((action) => action.phase === input.phase);
    if (existing) return existing;
    const action: StoredProductionAction = {
      actionId: input.phase === 'expansion' ? EXPANSION_ACTION_ID : ROLLBACK_ACTION_ID,
      phase: input.phase,
      status: 'prepared',
      targetRevision: input.targetRevision,
      cohort: this.rollout.approvedCohort,
      acceptance: null,
      observation: null,
      revocation: null,
    };
    this.rollout.actions.push(action);
    return action;
  }

  async recordActionAcceptance(
    _workspaceId: string,
    _operationId: string,
    acceptance: ProductionActionAcceptance,
  ): Promise<StoredProductionRollout> {
    const action = this.rollout.actions.find((candidate) => candidate.actionId === acceptance.actionId)!;
    action.status = 'dispatched';
    action.acceptance = acceptance;
    return this.rollout;
  }


  async recordActionObservation(
    _workspaceId: string,
    _operationId: string,
    observation: ProductionActionObservation,
  ): Promise<StoredProductionRollout> {
    const action = this.rollout.actions.find((candidate) => candidate.actionId === observation.actionId)!;
    action.status = 'observed';
    action.observation = observation;
    return this.rollout;
  }

  async recordEvaluation(
    _workspaceId: string,
    _operationId: string,
    evaluation: ProductionHealthEvaluation,
  ): Promise<StoredProductionRollout> {
    if (this.rollout.evaluation && this.rollout.evaluation.evidenceDigest !== evaluation.evidenceDigest) {
      throw new Error('evaluation changed');
    }
    this.rollout.evaluation = evaluation;
    this.rollout.status = evaluation.decision === 'abort' ? 'rollback_pending' : 'expansion_pending';
    return this.rollout;
  }

  async recordRevocation(
    _workspaceId: string,
    _operationId: string,
    revocation: ProductionRevokedLease,
  ): Promise<StoredProductionRollout> {
    const action = this.rollout.actions.find((candidate) => candidate.actionId === revocation.actionId)!;
    action.status = 'revoked';
    action.revocation = revocation;
    return this.rollout;
  }

  async settle(receipt: ProductionRolloutReceipt): Promise<ProductionRolloutReceipt> {
    this.rollout.receipt = receipt;
    this.rollout.status = 'settled';
    return receipt;
  }
}

class FakeRolloutAdapter implements ProductionDispatchAdapter, ProductionRolloutAdapter {
  readonly dispatches: Record<'expansion' | 'rollback', number> = {
    expansion: 0,
    rollback: 0,
  };
  readonly reconciliations: Record<'expansion' | 'rollback', number> = {
    expansion: 0,
    rollback: 0,
  };
  readonly revoked: ProductionRevokedLease[] = [];
  readonly crashOnce = new Set<'expansion' | 'rollback'>();
  private readonly accepted = new Set<'expansion' | 'rollback'>();

  constructor(
    private readonly canaryDecision: 'healthy' | 'unhealthy',
    private readonly expansionOutcome: 'healthy' | 'unhealthy' = 'healthy',
  ) {}

  async dispatchAuthorizedProduction(): Promise<ProductionCanaryAcceptance> {
    throw new Error('deploy not used');
  }

  async observeProductionAction(input: {
    action: ProductionActionAcceptance;
    releaseIntent: ReleaseIntent;
  }): Promise<ProductionActionObservation> {
    assert.deepEqual(input.action.cohort, input.releaseIntent.rolloutCohort);
    const unhealthy = input.action.phase === 'canary'
      ? this.canaryDecision === 'unhealthy'
      : input.action.phase === 'expansion'
        ? this.expansionOutcome === 'unhealthy'
        : false;
    const errorRate = unhealthy ? 5 : 1;
    const samples = [{
      signalId: 'error-rate',
      source: 'metrics' as const,
      evidenceKey: 'http.error-rate',
      value: errorRate,
      sampledAt: '2026-08-24T11:59:20.000Z',
    }, {
      signalId: 'error-rate',
      source: 'metrics' as const,
      evidenceKey: 'http.error-rate',
      value: errorRate,
      sampledAt: '2026-08-24T11:59:50.000Z',
    }, {
      signalId: 'success-rate',
      source: 'metrics' as const,
      evidenceKey: 'http.success-rate',
      value: 99.9,
      sampledAt: '2026-08-24T11:59:15.000Z',
    }, {
      signalId: 'success-rate',
      source: 'metrics' as const,
      evidenceKey: 'http.success-rate',
      value: 99.9,
      sampledAt: '2026-08-24T11:59:45.000Z',
    }];
    return {
      actionId: input.action.actionId,
      phase: input.action.phase,
      evidence: {
        schemaVersion: PRODUCTION_HEALTH_EVIDENCE_VERSION,
        providerDeploymentId: input.action.providerDeploymentId,
        rolloutCohort: input.action.cohort,
        revision: input.action.targetRevision,
        providerStatus: unhealthy ? 'failed' : 'running',
        providerOutcome: unhealthy ? 'unhealthy' : 'healthy',
        samples,
        observedAt: ROLLOUT_NOW,
      },
    };
  }

  async dispatchProductionAction(input: {
    actionId: string;
    phase: 'expansion' | 'rollback';
    releaseIntent: ReleaseIntent;
    priorState: StoredProductionRollout['priorState'];
  }): Promise<ProductionActionAcceptance> {
    if (this.accepted.has(input.phase)) {
      this.reconciliations[input.phase] += 1;
      return this.acceptance(input);
    }
    this.accepted.add(input.phase);
    this.dispatches[input.phase] += 1;
    if (this.crashOnce.delete(input.phase)) {
      throw new UnprocessableError('simulated provider acceptance loss', 'SIMULATED_CRASH');
    }
    return this.acceptance(input);
  }

  async reconcileProductionAction(input: {
    actionId: string;
    phase: 'expansion' | 'rollback';
    releaseIntent: ReleaseIntent;
    priorState: StoredProductionRollout['priorState'];
  }): Promise<ProductionActionAcceptance> {
    this.reconciliations[input.phase] += 1;
    return this.acceptance(input);
  }

  async revokeProductionActionLease(input: {
    action: ProductionActionAcceptance;
  }): Promise<ProductionRevokedLease> {
    const revocation = {
      actionId: input.action.actionId,
      phase: input.action.phase,
      leaseId: input.action.leaseId,
      providerDeploymentId: input.action.providerDeploymentId,
      revokedAt: ROLLOUT_NOW,
    };
    this.revoked.push(revocation);
    return revocation;
  }

  private acceptance(input: {
    actionId: string;
    phase: 'expansion' | 'rollback';
    releaseIntent: ReleaseIntent;
    priorState: StoredProductionRollout['priorState'];
  }): ProductionActionAcceptance {
    return {
      actionId: input.actionId,
      phase: input.phase,
      leaseId: input.phase === 'expansion' ? EXPANSION_LEASE_ID : ROLLBACK_LEASE_ID,
      providerDeploymentId: input.phase === 'expansion'
        ? 'coolify-expansion-1'
        : 'coolify-rollback-1',
      acceptedAt: ROLLOUT_NOW,
      cohort: input.releaseIntent.rolloutCohort,
      targetRevision: input.phase === 'rollback'
        ? input.priorState.revision
        : {
          sourceRevision: input.releaseIntent.sourceRevision,
          imageDigest: input.releaseIntent.artifacts.imageDigests[0]!,
          configurationBindingGeneration: input.releaseIntent.configurationBindingGeneration,
        },
    };
  }
}

function rolloutService(input: {
  canaryDecision: 'healthy' | 'unhealthy';
  expansionOutcome?: 'healthy' | 'unhealthy';
}): {
  adapter: FakeRolloutAdapter;
  store: MemoryRolloutStore;
  service: CoolifyProductionDeploymentService;
} {
  const adapter = new FakeRolloutAdapter(input.canaryDecision, input.expansionOutcome);
  const store = new MemoryRolloutStore();
  const projection = rolloutProjection();
  return {
    adapter,
    store,
    service: new CoolifyProductionDeploymentService(
      adapter,
      new ReconcileOnlyProductionStore(),
      {
        get: async () => projection,
        validate: async () => { throw new Error('deploy not used'); },
      },
      {
        now: () => new Date(ROLLOUT_NOW),
        randomUUID: () => RECEIPT_ID,
      },
      store,
    ),
  };
}

test('healthy canary expands only the exact approved cohort and settles linked revocations', async () => {
  const fixture = rolloutService({ canaryDecision: 'healthy' });
  const result = await fixture.service.reconcile(
    ROLLOUT_AUTHORITY.workspaceId,
    ROLLOUT_OPERATION_ID,
  );

  assert.equal(result.status, 'settled');
  if (result.status !== 'settled') return;
  assert.deepEqual(fixture.adapter.dispatches, { expansion: 1, rollback: 0 });
  assert.deepEqual(result.receipt.actions.map((action) => action.phase), ['canary', 'expansion']);
  assert.ok(result.receipt.actions.every((action) =>
    JSON.stringify(action.cohort) === JSON.stringify(intent().rolloutCohort)));
  assert.equal(result.receipt.health.evaluation.decision, 'expand');
  assert.equal(result.receipt.rollback, null);
  assert.deepEqual(
    result.receipt.revokedLeases.map((lease) => lease.leaseId),
    [CANARY_LEASE_ID, EXPANSION_LEASE_ID],
  );
  assert.equal(JSON.stringify(result.receipt).includes('credential'), false);
  assert.equal(result.receipt.externalGateEvidenceId, ROLLOUT_GATE_ID);
  assert.equal(result.receipt.releaseIntentDigest, ROLLOUT_INTENT_DIGEST);
});

test('declared canary abort invokes exact rollback and restores prior revision and generation', async () => {
  const fixture = rolloutService({ canaryDecision: 'unhealthy' });
  const result = await fixture.service.reconcile(
    ROLLOUT_AUTHORITY.workspaceId,
    ROLLOUT_OPERATION_ID,
  );

  assert.equal(result.status, 'settled');
  if (result.status !== 'settled') return;
  assert.deepEqual(fixture.adapter.dispatches, { expansion: 0, rollback: 1 });
  assert.equal(result.receipt.health.evaluation.decision, 'abort');
  assert.equal(result.receipt.health.evaluation.conditions[0]?.threshold, 5);
  assert.equal(result.receipt.health.evaluation.conditions[0]?.aggregatedValue, 5);
  assert.deepEqual(result.receipt.rollback, {
    owner: intent().rollback.owner,
    procedure: intent().rollback.procedure,
    providerDeploymentId: 'coolify-rollback-1',
    restoredRevision: initialRollout().priorState.revision,
    healthVerified: true,
    completedAt: ROLLOUT_NOW,
  });
  assert.deepEqual(
    result.receipt.actions.find((action) => action.phase === 'rollback')?.targetRevision,
    initialRollout().priorState.revision,
  );
});

test('crashes during expansion and rollback reconcile action ids without double deploy or skipped rollback', async () => {
  const fixture = rolloutService({
    canaryDecision: 'healthy',
    expansionOutcome: 'unhealthy',
  });
  fixture.adapter.crashOnce.add('expansion');
  fixture.adapter.crashOnce.add('rollback');

  await assert.rejects(
    fixture.service.reconcile(ROLLOUT_AUTHORITY.workspaceId, ROLLOUT_OPERATION_ID),
    /simulated provider acceptance loss/,
  );
  assert.deepEqual(fixture.adapter.dispatches, { expansion: 1, rollback: 0 });

  await assert.rejects(
    fixture.service.reconcile(ROLLOUT_AUTHORITY.workspaceId, ROLLOUT_OPERATION_ID),
    /simulated provider acceptance loss/,
  );
  assert.deepEqual(fixture.adapter.dispatches, { expansion: 1, rollback: 1 });
  assert.deepEqual(fixture.adapter.reconciliations, { expansion: 1, rollback: 0 });

  const result = await fixture.service.reconcile(
    ROLLOUT_AUTHORITY.workspaceId,
    ROLLOUT_OPERATION_ID,
  );
  assert.equal(result.status, 'settled');
  if (result.status !== 'settled') return;
  assert.deepEqual(fixture.adapter.dispatches, { expansion: 1, rollback: 1 });
  assert.deepEqual(fixture.adapter.reconciliations, { expansion: 1, rollback: 1 });
  assert.deepEqual(
    result.receipt.actions.map((action) => [action.phase, action.providerDeploymentId]),
    [
      ['canary', 'coolify-canary-1'],
      ['expansion', 'coolify-expansion-1'],
      ['rollback', 'coolify-rollback-1'],
    ],
  );
  assert.equal(result.receipt.rollback?.healthVerified, true);
  assert.equal(new Set(result.receipt.revokedLeases.map((lease) => lease.leaseId)).size, 3);
});
