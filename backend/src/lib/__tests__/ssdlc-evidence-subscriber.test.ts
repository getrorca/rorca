/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { WalEvent } from '../sse-hub';

const mockExecute = jest.fn();
const mockUnsubscribe = jest.fn();
const mockSubscribe = jest.fn((callback: (event: WalEvent) => Promise<void>) => {
  subscriber = callback;
  return mockUnsubscribe;
});
const mockInitBoss = jest.fn();
const mockGetBoss = jest.fn();
const mockRegisterLifecycleAssuranceWorker = jest.fn();
const mockRecoverRecentLifecycleAssurancePublications = jest.fn();
const mockEnqueueLifecycleAssuranceForRun = jest.fn();
const mockBoss = { name: 'test-boss' };
let subscriber: ((event: WalEvent) => Promise<void>) | null = null;

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));

jest.mock('../sse-hub', () => ({
  subscribe: (callback: (event: WalEvent) => Promise<void>) => mockSubscribe(callback),
}));

jest.mock('../pg-boss', () => ({
  initBoss: () => mockInitBoss(),
  getBoss: () => mockGetBoss(),
}));

jest.mock('../ssdlc-lifecycle-orchestrator', () => ({
  enqueueLifecycleAssuranceForRun: (...args: unknown[]) => mockEnqueueLifecycleAssuranceForRun(...args),
  recoverRecentLifecycleAssurancePublications: (...args: unknown[]) =>
    mockRecoverRecentLifecycleAssurancePublications(...args),
  registerLifecycleAssuranceWorker: (...args: unknown[]) => mockRegisterLifecycleAssuranceWorker(...args),
}));

import { startSsdlcEvidenceNormalizer } from '../ssdlc-evidence-subscriber';

beforeEach(() => {
  jest.clearAllMocks();
  subscriber = null;
  mockInitBoss.mockResolvedValue(undefined);
  mockGetBoss.mockReturnValue(mockBoss);
  mockRegisterLifecycleAssuranceWorker.mockResolvedValue(undefined);
  mockRecoverRecentLifecycleAssurancePublications.mockResolvedValue(undefined);
  mockEnqueueLifecycleAssuranceForRun.mockResolvedValue({
    status: 'queued',
    jobId: 'lifecycle-assurance-947',
    reason: 'trusted_run_completion',
  });
  mockExecute.mockResolvedValue(undefined);
});

test('starts one recovery and subscriber, projects terminal events asynchronously, and unsubscribes', async () => {
  let signalRecoveryStarted: (() => void) | undefined;
  const recoveryStarted = new Promise<void>((resolve) => {
    signalRecoveryStarted = resolve;
  });
  mockRecoverRecentLifecycleAssurancePublications.mockImplementationOnce(async () => {
    signalRecoveryStarted?.();
  });

  const stop = startSsdlcEvidenceNormalizer();
  const duplicateStop = startSsdlcEvidenceNormalizer();

  expect(duplicateStop).toBe(stop);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
  expect(subscriber).not.toBeNull();
  expect(mockRecoverRecentLifecycleAssurancePublications).not.toHaveBeenCalled();

  await recoveryStarted;

  expect(mockInitBoss).toHaveBeenCalledTimes(1);
  expect(mockRegisterLifecycleAssuranceWorker).toHaveBeenCalledTimes(1);
  expect(mockRegisterLifecycleAssuranceWorker).toHaveBeenCalledWith(mockBoss);
  expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledTimes(1);
  expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledWith(100, mockBoss);

  const terminalEvent: WalEvent = {
    id: 77,
    ts: '2026-07-15T12:00:00.000Z',
    event_type: 'run_finished',
    workspace_id: 'workspace-evaluator',
    spec_id: 'fixture-phase-evaluator',
    story_id: null,
    actor: 'worker',
    payload: JSON.stringify({ run_id: 947, status: 'done' }),
    trust_provenance: 'host',
    trusted_source: 'worker',
    canonical_run_id: 947,
  };
  await subscriber!(terminalEvent);

  expect(mockEnqueueLifecycleAssuranceForRun).toHaveBeenCalledWith({
    workspaceId: 'workspace-evaluator',
    runId: 947,
  });

  mockEnqueueLifecycleAssuranceForRun.mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(subscriber!({ ...terminalEvent, id: 78 })).resolves.toBeUndefined();
  expect(mockExecute).toHaveBeenCalledWith(
    expect.stringContaining("'ssdlc_evidence_adapter_error'"),
    expect.arrayContaining(['workspace-evaluator']),
  );

  stop();
  duplicateStop();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});

test('periodic recovery is single-flight, survives failed/empty due scans, and stops with the subscriber', async () => {
  jest.useFakeTimers();
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  mockRecoverRecentLifecycleAssurancePublications
    .mockImplementationOnce(() => first)
    .mockRejectedValueOnce(new Error('recovery transport unavailable'))
    .mockResolvedValue(undefined);
  try {
    const stop = startSsdlcEvidenceNormalizer();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await first;
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledTimes(3);

    stop();
    await jest.advanceTimersByTimeAsync(300_000);
    expect(mockRecoverRecentLifecycleAssurancePublications).toHaveBeenCalledTimes(3);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
