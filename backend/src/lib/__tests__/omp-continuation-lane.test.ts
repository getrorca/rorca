/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
// W5-008: the continuation controller + normative lane are wired through the
// production module (no test-only wiring). The existing controller contract
// suite imports the controller from here; this suite covers the lane adapter
// shape and fail-closed omp probing.
import {
  OmpNormativeContinuationAdapter,
  PiManagedContinuationController,
  createOmpManagedContinuationStack,
  type ManagedContinuationCheckpointInput,
  type ManagedContinuationOutcome,
  type NormativeContinuationLane,
} from '../omp-continuation-lane';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

function outcome(kind: ManagedContinuationOutcome['kind']): ManagedContinuationOutcome {
  return Object.freeze({
    kind, continuationKey: hash('1'), dispatchId: kind === 'settled' ? 'dispatch:lane' : null,
    promptSent: kind === 'dispatched' || kind === 'settled', resultProposalRequired: false,
    restartProposal: null, storyLifecycleMutation: false, closeoutDecision: false,
  });
}

describe('omp continuation lane (production wiring)', () => {
  test('the controller is exported from the production module and constructs', () => {
    const controller = new PiManagedContinuationController(
      { persistBeforeTrigger: async () => ({ duplicate: false }), loadDispatch: async () => null,
        consumeDispatchCas: async () => ({ consumed: true, duplicate: false, authorizationExpiresAt: '2026-08-05T12:00:00.000Z' }),
        markDispatched: async () => undefined, settle: async () => ({ duplicate: false }), fence: async () => undefined },
      { retrieve: async () => ({ receipt: {}, bundle: {}, renderedPayloadRef: { referenceId: 'r', kind: 'context', hash: hash('1'), sensitivity: 'internal', retentionClass: 'r', accessTier: 'auth', rawPayloadIncluded: false }, renderedPayloadHash: hash('1') }),
        createDispatch: async () => ({ dispatch: {}, renderedPayload: 'payload' }) },
      { verifyActive: async () => undefined },
      { verifyExact: async () => undefined },
      { authorize: async () => undefined },
      { sendSameSession: async () => ({ sendReceiptHash: hash('2') }), observeSettled: async () => ({ settled: true, turnId: 'turn', generation: 0, entryId: 'entry', entryHash: hash('3'), cursor: 2 }),
        abortProcessGroup: async () => ({ dead: true, deathReceiptHash: hash('4') }) },
      { emit: async () => undefined },
      { claim: async () => ({ claimed: true, fence: 1, state: 'in_flight' }), settle: async () => ({ state: 'closed', retryable: false }) },
      { now: () => '2026-08-05T11:00:00.000Z', sleep: async () => undefined },
    );
    expect(controller).toBeInstanceOf(PiManagedContinuationController);
  });

  test('OmpNormativeContinuationAdapter is a local-process managed lane', async () => {
    const fakeController = {
      continue: jest.fn(async () => outcome('settled')),
      reconcile: jest.fn(async () => outcome('settled')),
    } as unknown as PiManagedContinuationController;
    const lane: NormativeContinuationLane = new OmpNormativeContinuationAdapter(fakeController);
    expect(lane.laneId).toBe('managed');
    expect(lane.transport).toMatchObject({ kind: 'local_process', exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true, callerProjectionAuthority: 'none' });
    expect(lane.trust.canonicalCloseoutOnly).toBe(true);
    const input = { scope: {}, checkpoint: {}, policyActivation: {}, retryCycleId: 'not_applicable', retryPhase: 'none',
      completionCandidateState: 'none', priorProcessGroupDead: true } as unknown as ManagedContinuationCheckpointInput;
    await expect(lane.continue(input)).resolves.toMatchObject({ kind: 'settled' });
    await expect(lane.reconcile(input)).resolves.toMatchObject({ kind: 'settled' });
    expect(fakeController.continue).toHaveBeenCalledTimes(1);
    expect(fakeController.reconcile).toHaveBeenCalledTimes(1);
  });

  test('stack construction fails closed when the omp binary is unavailable', async () => {
    const originalOmpBin = process.env.OMP_BIN;
    process.env.OMP_BIN = '/nonexistent/omp-binary';
    try {
      await expect(createOmpManagedContinuationStack({
        workspaceId: 'workspace:lane-test',
        runtimeId: 'runtime:lane-test',
        store: {
          prepare: async () => { throw new Error('unused'); },
        } as never,
        implementationGate: {
          schemaVersion: 'rorca.wave3a-implementation-gate.v1', accepted: true, packetHash: hash('1'),
          executionAuthority: 'none', approvalAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none', productionActivationAuthority: 'none',
        },
      })).rejects.toThrow(/omp binary not found|OMP_BIN/);
    } finally {
      if (originalOmpBin === undefined) delete process.env.OMP_BIN;
      else process.env.OMP_BIN = originalOmpBin;
    }
  });
});
