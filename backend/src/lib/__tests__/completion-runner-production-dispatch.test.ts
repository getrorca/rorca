/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../completion-runner-production-context', () => ({
  loadProductionCompletionContext: jest.fn(),
  observeProductionCompletionControl: jest.fn(),
}));

jest.mock('../completion-runner', () => ({
  runCompletionRunner: jest.fn(),
}));

import { runCompletionRunner } from '../completion-runner';
import {
  loadProductionCompletionContext,
  observeProductionCompletionControl,
} from '../completion-runner-production-context';
import {
  runProductionCompletionStory,
  type ProductionCompletionStoryInput,
} from '../completion-runner-host-adapter';

const loadContext = jest.mocked(loadProductionCompletionContext);
const observeControl = jest.mocked(observeProductionCompletionControl);
const runRunner = jest.mocked(runCompletionRunner);

function input(submitCloseout: ProductionCompletionStoryInput['submitCloseout']): ProductionCompletionStoryInput {
  return {
    identity: {
      workspaceId: 'workspace:dispatch',
      specId: 'spec:dispatch',
      runId: 17,
      storyId: 'story:dispatch',
      manifestHash: `sha256:${'a'.repeat(64)}`,
    },
    stateRoot: '/tmp/rorca-dispatch-state',
    checkoutRoot: '/tmp/rorca-dispatch-checkout',
    result: {
      baseSha: 'b'.repeat(40),
      resultSha: 'c'.repeat(40),
      treeHash: 'd'.repeat(40),
      diffHash: `sha256:${'e'.repeat(64)}`,
      changedPaths: ['src/dispatch.ts'],
      sourceVectorHash: `sha256:${'f'.repeat(64)}`,
      settledAt: '2026-08-04T12:00:00.000Z',
    },
    requiredCommandHashes: [],
    validations: [],
    selfAuditIssueCodes: [],
    submitCloseout,
  };
}

const READY_CONTEXT = {
  kind: 'ready',
  scope: {
    workspaceId: 'workspace:dispatch',
    attemptId: 'attempt:dispatch',
    leaseId: 'lease:dispatch',
    fencingToken: 9,
  },
  workPackage: { workPackageId: 'package:dispatch' },
  obligations: { obligationSetId: 'obligations:dispatch' },
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  observeControl.mockResolvedValue({
    observedAt: '2026-08-04T12:00:00.000Z',
    cancellation: 'none',
    cancellationId: null,
  });
});

test('governed incomplete context fails closed before runner or host closeout', async () => {
  loadContext.mockResolvedValue({ kind: 'governed_incomplete', reasonCode: 'COMPLETION_ATTEMPT_MISSING' });
  const submitCloseout = jest.fn();

  await expect(runProductionCompletionStory(input(submitCloseout))).resolves.toEqual({
    kind: 'blocked',
    reasonCode: 'COMPLETION_ATTEMPT_MISSING',
    runner: null,
  });
  expect(runRunner).not.toHaveBeenCalled();
  expect(submitCloseout).not.toHaveBeenCalled();
});

test('governed production dispatch reaches host closeout only through the durable runner closeout port', async () => {
  loadContext.mockResolvedValue(READY_CONTEXT);
  const decision = { status: 'accepted', decisionId: 'decision:accepted' } as never;
  const submitCloseout = jest.fn().mockResolvedValue(decision);
  runRunner.mockImplementation(async (_runnerInput, ports) => {
    const observed = await ports.closeout.submit({} as never);
    expect(observed).toBe(decision);
    return {
      status: 'closeout_accepted',
      reasonCode: 'accepted_story_closeout',
      executedBatchId: 'batch:dispatch',
      gateStage: 'host_semantic',
      proposalId: 'proposal:dispatch',
      closeoutDecisionId: 'decision:accepted',
      finalReportEligible: true,
      ledgerHighWaterHash: `sha256:${'1'.repeat(64)}`,
    };
  });

  const result = await runProductionCompletionStory(input(submitCloseout));

  expect(runRunner).toHaveBeenCalledTimes(1);
  expect(submitCloseout).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    kind: 'runner',
    runner: { status: 'closeout_accepted', finalReportEligible: true },
  });
});

test('a non-accepted runner result cannot invoke or bypass host closeout', async () => {
  loadContext.mockResolvedValue(READY_CONTEXT);
  const submitCloseout = jest.fn();
  runRunner.mockResolvedValue({
    status: 'blocked',
    reasonCode: 'gate_blocked',
    executedBatchId: 'batch:dispatch',
    gateStage: 'host_semantic',
    proposalId: 'proposal:dispatch',
    closeoutDecisionId: null,
    finalReportEligible: false,
    ledgerHighWaterHash: `sha256:${'2'.repeat(64)}`,
  });

  await expect(runProductionCompletionStory(input(submitCloseout))).resolves.toMatchObject({
    kind: 'runner',
    runner: { status: 'blocked', finalReportEligible: false },
  });
  expect(runRunner).toHaveBeenCalledTimes(1);
  expect(submitCloseout).not.toHaveBeenCalled();
});
