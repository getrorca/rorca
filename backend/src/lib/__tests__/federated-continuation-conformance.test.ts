/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  FederatedNormativeContinuationAdapter, ManagedNormativeContinuationAdapter, type NormativeContinuationLane,
} from '../federated-continuation-adapter';
import { FederatedLeaseBindingSchema, FederatedRecoveryRequestSchema } from '../federated-runtime-contracts';
import type { FederatedRuntimeService } from '../federated-runtime-service';
import { AppError, AuthError } from '../errors';
import { createFederatedRuntimeRouter } from '../../routes/federated-runtime';
import {
  ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ContinuationDispatchV1Schema, governedHash,
} from '../governed-contracts';
import {
  PiManagedContinuationController, type ManagedContinuationCheckpointInput, type ManagedContinuationOutcome,
} from '../pi-managed-continuation-controller';

const h = (value: string): string => `sha256:${value.repeat(64)}`;
const BASE_INPUT = { scope: { workspaceId: 'workspace:one', missionId: 'mission:one', missionRevision: 1, missionHash: h('1'),
  workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: h('2'),
  spec: { specId: 'spec:one', specVersion: 1, specHash: h('3'), canonicalSpecPath: 'forge/spec.json', storyId: 'story:one',
    storyVersion: 1, storyHash: h('4'), criteriaManifestHash: h('5') }, runId: 1, attemptId: 'attempt:one',
  leaseId: 'lease:one', fencingToken: 1, leaseExpiresAt: '2026-08-05T13:00:00.000Z', cancellationId: 'cancellation:one',
  runtimeId: 'runtime:pilot', controllerGeneration: 1, runtimeGeneration: 1, sessionId: 'session:one', sessionFileHash: h('6'),
  turnId: 'turn:one', turnAttempt: 1, originatingGeneration: 1, cursor: 7, cursorHash: h('7'), priorEntryId: 'entry:one',
  repository: { repositoryId: 'repository:one', remoteAuthorityHash: h('8'), gitObjectFormat: 'sha1', baseSha: 'a'.repeat(40),
    currentSha: 'b'.repeat(40), expectedHeadSha: 'c'.repeat(40), worktreeId: 'worktree:one', allowedPathManifestHash: h('9'),
    requiredPathManifestHash: h('a'), changedPathManifestHash: h('b'), forbiddenPathManifestHash: h('c') },
  validationStateHash: h('d'), rootCauseClassification: 'code', rootCauseHash: h('e'), policyDefinitionId: 'policy:one',
  policyDefinitionVersion: '1.0.0', policyDefinitionHash: h('f'), policyActivationId: 'activation:one', policyActivationRevision: 1,
  policyActivationHash: h('0') }, checkpoint: {}, policyActivation: {}, retryCycleId: null, retryPhase: 'settled',
  completionCandidateState: 'none', priorProcessGroupDead: false, priorWriterDeathReceiptHash: null } as ManagedContinuationCheckpointInput;

function outcome(kind: ManagedContinuationOutcome['kind'], promptSent: boolean, resultProposalRequired = false): ManagedContinuationOutcome {
  return { kind, continuationKey: h('1'), dispatchId: promptSent ? 'dispatch:one' : null, promptSent, resultProposalRequired,
    restartProposal: null, storyLifecycleMutation: false, closeoutDecision: false };
}

function fakeController(expected: ManagedContinuationOutcome) {
  return { continue: jest.fn().mockResolvedValue(expected), reconcile: jest.fn().mockResolvedValue(expected) } as unknown as jest.Mocked<PiManagedContinuationController>;
}

function lanes(expected: ManagedContinuationOutcome): NormativeContinuationLane[] {
  return [new ManagedNormativeContinuationAdapter(fakeController(expected)),
    new FederatedNormativeContinuationAdapter(fakeController(expected), { runtimeId: 'runtime:pilot', workspaceId: 'workspace:one',
      credentialVersion: 1, keyVersion: 1, status: 'active', allowedContractVersions: ['1.0.0'], mutationBoundsHash: h('1') })];
}

describe('identical managed-versus-federated normative continuation assertions', () => {
  const matrix: Array<[string, Partial<ManagedContinuationCheckpointInput>, ManagedContinuationOutcome]> = [
    ['successful matching compaction and settled writer dispatches once', { retryPhase: 'settled' }, outcome('settled', true)],
    ['Pi retry started suppresses controller continuation', { retryPhase: 'started' }, outcome('suppressed_retry', false)],
    ['Pi retry ended suppresses controller continuation', { retryPhase: 'ended' }, outcome('suppressed_retry', false)],
    ['validated execution-turn candidate proposes without closeout', { completionCandidateState: 'controller_validated' }, outcome('completion_candidate', false, true)],
    ['submitted execution-turn candidate remains proposal-only', { completionCandidateState: 'submitted_to_closeout' }, outcome('completion_candidate', false, true)],
    ['pre-CAS crash may resume identical work', {}, outcome('observing_existing', false)],
    ['post-CAS crash observes without a second prompt', {}, outcome('settled', false)],
    ['retry budget exhaustion quarantines', {}, outcome('quarantined', false)],
    ['settled timeout fences and proposes a new generation', {}, { ...outcome('fenced_timeout', true), restartProposal: {
      priorRuntimeGeneration: 1, newRuntimeGeneration: 2, sessionId: 'session:one', cursor: 7,
      priorWriterDeathReceiptHash: h('2'), forceFullCanonicalContext: true, newLeaseAndFenceRequired: true, authority: 'proposal_only' } }],
  ];
  test.each(matrix)('%s', async (_label, patch, expected) => {
    const input = { ...BASE_INPUT, ...patch };
    for (const lane of lanes(expected)) {
      await expect(lane.continue(input)).resolves.toEqual(expected);
      expect(lane.transport.exactlyOnceDispatchCas).toBe(true);
      expect(lane.transport.sameSessionCursorAdvance).toBe(true);
      expect(lane.transport.callerProjectionAuthority).toBe('none');
      expect(lane.trust).toMatchObject({ runtimeClaims: 'runtime_asserted', hostObservations: 'host_observed',
        canonicalCloseoutOnly: true, terminalLifecycleAuthority: 'none', activityLifecycleAuthority: 'none', candidateLifecycleAuthority: 'none' });
      expect(expected.storyLifecycleMutation).toBe(false);
      expect(expected.closeoutDecision).toBe(false);
    }
  });

  test('federated adapter rejects wrong workspace/runtime before canonical retrieval, dispatch, or prompt', async () => {
    const controller = fakeController(outcome('settled', true));
    const lane = new FederatedNormativeContinuationAdapter(controller, { runtimeId: 'runtime:pilot', workspaceId: 'workspace:one',
      credentialVersion: 1, keyVersion: 1, status: 'active', allowedContractVersions: ['1.0.0'], mutationBoundsHash: h('1') });
    await expect(lane.continue({ ...BASE_INPUT, scope: { ...BASE_INPUT.scope, workspaceId: 'workspace:other' } }))
      .rejects.toMatchObject({ reason: 'scope_mismatch' });
    expect(controller.continue).not.toHaveBeenCalled();
  });
});


describe('shared PiManagedContinuationController federated recovery', () => {
  const now = '2026-08-05T12:00:00.000Z';
  const future = '2026-08-05T13:00:00.000Z';
  const header = (schemaVersion: string, artifactId: string, contentHash: string) => ({
    schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt: now,
    createdBy: 'controller:wave4',
  });
  const scope = BASE_INPUT.scope;
  const activation = ContextPolicyActivationV1Schema.parse({
    ...header('rorca.context-continuation-policy-activation.v1', 'artifact:recovery-activation', scope.policyActivationHash),
    workspaceId: scope.workspaceId, activationId: scope.policyActivationId,
    activationRevision: scope.policyActivationRevision, activationHash: scope.policyActivationHash,
    definitionId: scope.policyDefinitionId, definitionVersion: scope.policyDefinitionVersion,
    definitionHash: scope.policyDefinitionHash, scope: {
      workspaceId: scope.workspaceId, missionId: scope.missionId, missionRevision: scope.missionRevision,
      missionHash: scope.missionHash, workPackageId: scope.workPackageId, workPackageRevision: scope.workPackageRevision,
      workPackageHash: scope.workPackageHash, spec: scope.spec, runId: scope.runId, attemptId: scope.attemptId,
      leaseId: scope.leaseId, fencingToken: scope.fencingToken, cancellationId: scope.cancellationId,
      runtimeId: scope.runtimeId, repositoryId: scope.repository.repositoryId,
      remoteAuthorityHash: scope.repository.remoteAuthorityHash, baseSha: scope.repository.baseSha,
      worktreeId: scope.repository.worktreeId, allowedPathManifestHash: scope.repository.allowedPathManifestHash,
      requiredPathManifestHash: scope.repository.requiredPathManifestHash, policyDefinitionId: scope.policyDefinitionId,
      policyDefinitionVersion: scope.policyDefinitionVersion, policyDefinitionHash: scope.policyDefinitionHash,
    }, effectiveValuesHash: h('1'), authorityReceiptId: 'authority:recovery',
    activatedAt: now, expiresAt: future, state: 'active',
  });
  const checkpoint = ContextCheckpointV1Schema.parse({
    ...header('rorca.context-checkpoint.v1', 'artifact:recovery-checkpoint', h('2')), scope,
    checkpointId: 'checkpoint:recovery', checkpointSequence: 1, priorCheckpointId: 'not_applicable',
    reasonCode: 'recovery', trigger: { type: 'initial_dispatch', launchRequestId: 'launch:recovery',
      launchRequestHash: h('3'), engineRequestId: 'engine:recovery', engineRequestHash: h('4'),
      sourceManifestHash: h('5') }, eventHighWaterMark: 0, planCursorHash: h('6'), completedWorkHash: h('7'),
    pendingWorkHash: h('8'), boundedReferences: [], retry: { retryCycleId: 'not_applicable', phase: 'none',
      attempt: 0, maximum: 2, startEventHash: 'not_applicable', endEventHash: 'not_applicable',
      settledEventHash: 'not_applicable', generation: scope.runtimeGeneration },
    completionCandidate: { state: 'absent', hash: 'not_applicable' }, redactionManifestHash: h('9'), state: 'current',
  });
  const input = { ...BASE_INPUT, checkpoint, policyActivation: activation };
  const continuationKey = governedHash('rorca.managed-continuation-key.v1', {
    scope, checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.contentHash,
    trigger: checkpoint.trigger, retryCycleId: input.retryCycleId, retryPhase: input.retryPhase,
  });
  const dispatch = ContinuationDispatchV1Schema.parse({
    ...header('rorca.continuation-dispatch.v1', 'artifact:recovery-dispatch', h('a')), scope,
    dispatchId: 'dispatch:recovery', continuationKey, trigger: checkpoint.trigger,
    checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.contentHash, receiptId: 'receipt:recovery',
    receiptHash: h('b'), bundleId: 'bundle:recovery', bundleHash: h('c'),
    definitionHash: scope.policyDefinitionHash, activationHash: scope.policyActivationHash,
    targetSessionId: scope.sessionId, targetCursor: scope.cursor, priorEntryId: scope.priorEntryId,
    expectedCursorAdvance: 1, renderedPayloadHash: h('d'), renderedPayloadRef: { referenceId: 'rendered:recovery',
      kind: 'context', hash: h('d'), sensitivity: 'restricted', retentionClass: 'recovery', accessTier: 'admin',
      rawPayloadIncluded: false }, firstLeaseVerificationHash: h('e'), casLeaseVerificationHash: h('f'),
    authorizationExpiresAt: future, controllerId: 'controller:recovery', adapterVersion: '1.0.0', attempt: 1,
    retryBudgetId: 'retry-budget:recovery', state: 'dispatched', reasonCode: 'consumed',
  });

  function controllerFixture(existingState: 'none' | 'dispatch_consumed', retryState: 'backoff' | 'exhausted' = 'backoff',
    settled = true) {
    let tick = Date.parse(now);
    const sendSameSession = jest.fn();
    const abortProcessGroup = jest.fn().mockResolvedValue({ dead: true, deathReceiptHash: h('1') });
    const controller = new PiManagedContinuationController({
      persistBeforeTrigger: jest.fn().mockResolvedValue({ duplicate: false }),
      loadDispatch: jest.fn().mockResolvedValue(existingState === 'none' ? null : {
        state: 'dispatch_consumed', dispatch, sendReceiptHash: h('2'),
      }),
      consumeDispatchCas: jest.fn(), markDispatched: jest.fn(), settle: jest.fn().mockResolvedValue({ duplicate: false }),
      fence: jest.fn(),
    }, {
      retrieve: jest.fn().mockRejectedValue(new Error('partitioned canonical context')),
      createDispatch: jest.fn(),
    }, { verifyActive: jest.fn() }, { verifyExact: jest.fn() }, { authorize: jest.fn() }, {
      sendSameSession,
      observeSettled: jest.fn().mockResolvedValue({ settled, turnId: scope.turnId, generation: scope.runtimeGeneration,
        entryId: settled ? 'entry:next' : null, entryHash: settled ? h('3') : null,
        cursor: settled ? scope.cursor + 1 : scope.cursor }),
      abortProcessGroup,
    }, { emit: jest.fn() }, {
      claim: jest.fn().mockResolvedValue({ claimed: false, fence: 1, state: retryState }),
      settle: jest.fn(),
    }, {
      now: () => new Date(tick).toISOString(),
      sleep: async (milliseconds: number) => { tick += milliseconds; },
    }, 2, 1);
    return { controller, sendSameSession, abortProcessGroup };
  }

  test('crash before dispatch CAS observes the aggregate retry owner and exhaustion quarantines', async () => {
    const backoff = controllerFixture('none');
    await expect(backoff.controller.reconcile(input)).resolves.toMatchObject({
      kind: 'observing_existing', promptSent: false, storyLifecycleMutation: false, closeoutDecision: false,
    });
    expect(backoff.sendSameSession).not.toHaveBeenCalled();
    const exhausted = controllerFixture('none', 'exhausted');
    await expect(exhausted.controller.reconcile(input)).resolves.toMatchObject({
      kind: 'quarantined', promptSent: false, storyLifecycleMutation: false, closeoutDecision: false,
    });
  });

  test('crash after dispatch CAS reconciles one settled cursor without sending a second prompt', async () => {
    const fixture = controllerFixture('dispatch_consumed');
    await expect(fixture.controller.reconcile(input)).resolves.toMatchObject({
      kind: 'settled', dispatchId: dispatch.dispatchId, promptSent: false,
      storyLifecycleMutation: false, closeoutDecision: false,
    });
    expect(fixture.sendSameSession).not.toHaveBeenCalled();
  });

  test('partition timeout fences the prior writer and proposes full-context restart without success inference', async () => {
    const fixture = controllerFixture('dispatch_consumed', 'backoff', false);
    await expect(fixture.controller.reconcile(input)).resolves.toMatchObject({
      kind: 'fenced_timeout', promptSent: false, storyLifecycleMutation: false, closeoutDecision: false,
      restartProposal: { priorRuntimeGeneration: 1, newRuntimeGeneration: 2, forceFullCanonicalContext: true,
        newLeaseAndFenceRequired: true, authority: 'proposal_only' },
    });
    expect(fixture.abortProcessGroup).toHaveBeenCalledTimes(1);
    expect(fixture.sendSameSession).not.toHaveBeenCalled();
  });
});
const HTTP_CASES: ReadonlyArray<readonly [string, Partial<ManagedContinuationCheckpointInput>, ManagedContinuationOutcome]> = [
  ['max_output_success_settled', { retryPhase: 'settled' }, outcome('settled', true)],
  ['compaction_aborted', {}, outcome('observing_existing', false)],
  ['compaction_failed', {}, outcome('observing_existing', false)],
  ['settled_wrong_turn', {}, outcome('observing_existing', false)],
  ['settled_wrong_generation', {}, outcome('observing_existing', false)],
  ['pi_retry_started', { retryPhase: 'started' }, outcome('suppressed_retry', false)],
  ['pi_retry_ended', { retryPhase: 'ended' }, outcome('suppressed_retry', false)],
  ['pi_retry_matching_settled', { retryPhase: 'settled' }, outcome('settled', true)],
  ['candidate_observed', { completionCandidateState: 'observed' }, outcome('observing_existing', false)],
  ['candidate_rejected', { completionCandidateState: 'none' }, outcome('observing_existing', false)],
  ['candidate_validated', { completionCandidateState: 'controller_validated' }, outcome('completion_candidate', false, true)],
  ['candidate_submitted', { completionCandidateState: 'submitted_to_closeout' }, outcome('completion_candidate', false, true)],
  ['crash_before_dispatch_cas', {}, outcome('observing_existing', false)],
  ['crash_after_dispatch_cas', {}, outcome('settled', false)],
  ['verified_delta_reconstruction', {}, outcome('settled', true)],
  ['ambiguous_delta_full_fallback', {}, outcome('observing_existing', false)],
  ['required_context_partition', {}, outcome('observing_existing', false)],
  ['advisory_context_degraded', {}, outcome('settled', true)],
  ['aggregate_retry_exhaustion', {}, outcome('quarantined', false)],
];

describe('fake authenticated-HTTP federated runtime lifecycle', () => {
  let server: Server;
  let endpoint: string;
  const credential = 'federated-http-fixture-credential-at-least-32-bytes';
  const runtime = { runtimeId: 'runtime:pilot', workspaceId: 'workspace:one', credentialVersion: 1, keyVersion: 1,
    status: 'active' as const, allowedContractVersions: ['1.0.0'] as const, mutationBoundsHash: h('1') };
  const calls: Array<{ scenario: string; operation: string; authorization: string | undefined }> = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const authorization = request.headers.authorization;
      if (request.method !== 'POST' || request.url !== '/v1/continuation'
          || authorization !== `Federated ${credential}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ reason: 'authentication_failed' }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          scenario: string; operation: 'continue' | 'reconcile'; input: ManagedContinuationCheckpointInput;
        };
        const fixture = HTTP_CASES.find(([scenario]) => scenario === body.scenario);
        if (!fixture) throw new Error('unknown fixture');
        calls.push({ scenario: body.scenario, operation: body.operation, authorization });
        const lane = new FederatedNormativeContinuationAdapter(fakeController(fixture[2]), runtime);
        const value = body.operation === 'continue' ? await lane.continue(body.input) : await lane.reconcile(body.input);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ value, transport: lane.transport, trust: lane.trust }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ reason: error instanceof Error ? error.message : 'fixture_failed' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/v1/continuation`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function invoke(scenario: string, operation: 'continue' | 'reconcile',
    input: ManagedContinuationCheckpointInput, suppliedCredential = credential) {
    const response = await fetch(endpoint, { method: 'POST', headers: {
      authorization: `Federated ${suppliedCredential}`, 'content-type': 'application/json',
      'x-rorca-transport-adapter': 'authenticated_https', 'x-rorca-trust-adapter': 'runtime_asserted',
    }, body: JSON.stringify({ scenario, operation, input }) });
    const body = await response.json() as { value?: ManagedContinuationOutcome; transport?: NormativeContinuationLane['transport'];
      trust?: NormativeContinuationLane['trust']; reason?: string };
    return { status: response.status, body };
  }

  test.each(HTTP_CASES)('matches managed normative outcome through real HTTP: %s',
    async (scenario, patch, expected) => {
      const input = { ...BASE_INPUT, ...patch };
      const managed = new ManagedNormativeContinuationAdapter(fakeController(expected));
      const managedOutcome = await managed.continue(input);
      const result = await invoke(scenario, 'continue', input);
      expect(result).toMatchObject({ status: 200, body: { value: managedOutcome,
        transport: { kind: 'authenticated_https', exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true,
          callerProjectionAuthority: 'none' },
        trust: { runtimeClaims: 'runtime_asserted', hostObservations: 'host_observed', canonicalCloseoutOnly: true,
          terminalLifecycleAuthority: 'none', activityLifecycleAuthority: 'none', candidateLifecycleAuthority: 'none' } } });
      expect(result.body.value).toMatchObject({ storyLifecycleMutation: false, closeoutDecision: false });
    });

  test('reconnect reconciles over HTTP without a second prompt and rejects a wrong credential', async () => {
    const input = { ...BASE_INPUT };
    await expect(invoke('crash_after_dispatch_cas', 'reconcile', input)).resolves.toMatchObject({
      status: 200, body: { value: { promptSent: false, closeoutDecision: false } },
    });
    await expect(invoke('crash_after_dispatch_cas', 'continue', input, `${credential}-wrong`)).resolves.toMatchObject({
      status: 401, body: { reason: 'authentication_failed' },
    });
    expect(calls.filter(({ scenario }) => scenario === 'crash_after_dispatch_cas')).toHaveLength(2);
  });
});

describe('production federated router continuation transport', () => {
  const credential = 'federated-router-fixture-credential-at-least-32-bytes';
  const runtime = { runtimeId: 'runtime:pilot', workspaceId: 'workspace:one', credentialVersion: 1, keyVersion: 1,
    status: 'active' as const, allowedContractVersions: ['1.0.0'] as const, mutationBoundsHash: h('1') };
  const binding = FederatedLeaseBindingSchema.parse({
    workspaceId: 'workspace:one', runtimeId: 'runtime:pilot', missionId: 'mission:one', missionRevision: 1,
    missionHash: h('1'), workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: h('2'),
    specId: 'spec:one', specVersion: 1, specHash: h('3'), storyId: 'story:one', storyVersion: 1, storyHash: h('4'),
    criteriaManifestHash: h('5'), attemptId: 'attempt:one', leaseId: 'lease:one', fencingToken: 1,
    expectedLeaseExpiresAt: '2026-08-05T13:00:00.000Z', policyDefinitionHash: h('f'),
    policyActivationId: 'activation:one', policyActivationRevision: 1, policyActivationHash: h('0'),
    checkpointId: 'checkpoint:one', checkpointHash: h('1'), retrievalReceiptId: 'receipt:one',
    retrievalReceiptHash: h('2'), bundleId: 'bundle:one', bundleHash: h('3'), dispatchId: 'dispatch:one',
    dispatchHash: h('4'), repositoryId: 'repository:one', remoteAuthorityHash: h('5'),
    baseSha: 'a'.repeat(40), currentSha: 'b'.repeat(40), expectedHeadSha: 'c'.repeat(40),
    worktreeId: 'worktree:one', allowedPathManifestHash: h('6'), requiredPathManifestHash: h('7'),
    changedPathManifestHash: h('8'), forbiddenPathManifestHash: h('9'), validationManifestHash: h('a'),
  });
  let server: Server;
  let endpoint: string;
  const authenticate = jest.fn(async (input: { credential: string }) => {
    if (input.credential !== credential) throw new AuthError('Federated runtime authentication failed');
    return runtime;
  });
  const recover = jest.fn(async (_runtime: typeof runtime, candidate: unknown) => {
    const request = FederatedRecoveryRequestSchema.parse(candidate);
    const scenario = request.idempotencyKey.replace(/^http:/, '');
    const fixture = HTTP_CASES.find(([name]) => name === scenario);
    if (!fixture) throw new Error('unknown continuation scenario');
    return { value: fixture[2],
      transport: { schemaVersion: 'rorca.continuation-transport-adapter.v1', kind: 'authenticated_https',
        exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true, callerProjectionAuthority: 'none' },
      trust: { schemaVersion: 'rorca.continuation-trust-adapter.v1', runtimeClaims: 'runtime_asserted',
        hostObservations: 'host_observed', canonicalCloseoutOnly: true, terminalLifecycleAuthority: 'none',
        activityLifecycleAuthority: 'none', candidateLifecycleAuthority: 'none' } };
  });

  beforeAll(async () => {
    const service = { authenticate, recover } as unknown as FederatedRuntimeService;
    const app = express();
    app.use('/api/mission-control/v1/federation', createFederatedRuntimeRouter(async () => service));
    app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof AppError) response.status(error.statusCode).json(error.toJSON());
      else response.status(500).json({ reason: error instanceof Error ? error.message : 'unknown' });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/api/mission-control/v1/federation/recover`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function invoke(scenario: string, suppliedCredential = credential) {
    const request = FederatedRecoveryRequestSchema.parse({
      schemaVersion: 'rorca.federated-recovery-request.v1', binding, generation: 1, sessionId: 'session:one',
      sessionFileHash: h('6'), turnId: 'turn:one', originatingGeneration: 1, cursor: 7, cursorHash: h('7'),
      bundleHash: binding.bundleHash, idempotencyKey: `http:${scenario}`,
    });
    const response = await fetch(endpoint, { method: 'POST', headers: {
      authorization: `Federated ${suppliedCredential}`, 'content-type': 'application/json',
      'x-rorca-workspace-id': runtime.workspaceId, 'x-rorca-runtime-id': runtime.runtimeId,
      'x-rorca-credential-version': '1', 'x-rorca-key-version': '1',
    }, body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() };
  }

  test.each(HTTP_CASES)('carries the normative lifecycle through the mounted federated router: %s',
    async (scenario, _patch, expected) => {
      await expect(invoke(scenario)).resolves.toMatchObject({
        status: 200, body: { value: expected,
          transport: { kind: 'authenticated_https', exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true,
            callerProjectionAuthority: 'none' },
          trust: { runtimeClaims: 'runtime_asserted', hostObservations: 'host_observed',
            canonicalCloseoutOnly: true, terminalLifecycleAuthority: 'none' } },
      });
    });

  test('rejects the wrong Federated credential at the actual router boundary', async () => {
    await expect(invoke('crash_after_dispatch_cas', `${credential}-wrong`)).resolves.toMatchObject({
      status: 401, body: { code: 'AUTH_ERROR' },
    });
  });
});
