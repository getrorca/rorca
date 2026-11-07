/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  createPtyCommittedRangeReference,
  getActivePtyCleanupTaskCount,
  registerPtyCleanupTask,
  resetPtyCleanupTasksForTests,
  runRegisteredPtyCleanupTasks,
  shutdownPtyProcess,
} from '../pty-manager';

describe('pty-manager cleanup registry', () => {
  afterEach(() => {
    resetPtyCleanupTasksForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('registers and unregisters cleanup tasks', () => {
    const unregister = registerPtyCleanupTask('run-1', jest.fn());
    expect(getActivePtyCleanupTaskCount()).toBe(1);

    unregister();
    expect(getActivePtyCleanupTaskCount()).toBe(0);
  });

  it('runs all registered cleanup tasks and clears the registry first', async () => {
    const calls: string[] = [];
    registerPtyCleanupTask('run-1', async () => {
      calls.push('run-1');
      expect(getActivePtyCleanupTaskCount()).toBe(0);
    });
    registerPtyCleanupTask('run-2', () => {
      calls.push('run-2');
    });

    await runRegisteredPtyCleanupTasks();

    expect(calls.sort()).toEqual(['run-1', 'run-2']);
    expect(getActivePtyCleanupTaskCount()).toBe(0);
  });

  it('continues running cleanup tasks when one throws', async () => {
    const calls: string[] = [];
    registerPtyCleanupTask('run-1', () => {
      calls.push('run-1');
      throw new Error('boom');
    });
    registerPtyCleanupTask('run-2', () => {
      calls.push('run-2');
    });

    await expect(runRegisteredPtyCleanupTasks()).resolves.toBeUndefined();
    expect(calls.sort()).toEqual(['run-1', 'run-2']);
    expect(getActivePtyCleanupTaskCount()).toBe(0);
  });

  it('projects only a hash-bound reference for contiguous committed PTY bytes', () => {
    const reference = createPtyCommittedRangeReference('generation:one', [
      { sequence: 7, chunk: Buffer.from('raw-secret-one') },
      { sequence: 8, chunk: Buffer.from('raw-secret-two') },
    ], '2026-08-05T12:00:00.000Z');

    expect(reference).toMatchObject({
      generationId: 'generation:one',
      firstSequence: 7,
      lastSequence: 8,
      byteCount: 28,
      observedAt: '2026-08-05T12:00:00.000Z',
    });
    expect(reference?.rangeHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(reference)).not.toContain('raw-secret');
    expect(() => createPtyCommittedRangeReference('generation:one', [
      { sequence: 7, chunk: Buffer.from('one') },
      { sequence: 9, chunk: Buffer.from('gap') },
    ])).toThrow('contiguous');
  });

  it('stops after SIGTERM when the PTY exits during the grace window', async () => {
    jest.useFakeTimers();
    const kill = jest.fn();
    const killProcessGroup = jest.fn();
    let resolveExit!: () => void;
    const waitForExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const shutdown = shutdownPtyProcess(
      { pid: 321, kill },
      { waitForExit, graceMs: 10_000, killProcessGroup },
    );

    resolveExit();
    await Promise.resolve();
    await shutdown;

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(killProcessGroup).toHaveBeenCalledWith(321, 'SIGTERM');
    expect(killProcessGroup).not.toHaveBeenCalledWith(321, 'SIGKILL');
  });

  it('escalates from SIGTERM to SIGKILL when the PTY does not exit', async () => {
    jest.useFakeTimers();
    const kill = jest.fn();
    const killProcessGroup = jest.fn();
    const waitForExit = new Promise<void>(() => undefined);

    const shutdown = shutdownPtyProcess(
      { pid: 654, kill },
      { waitForExit, graceMs: 100, postKillSettleMs: 25, killProcessGroup },
    );

    await jest.advanceTimersByTimeAsync(150);
    await shutdown;

    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(killProcessGroup).toHaveBeenNthCalledWith(1, 654, 'SIGTERM');
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, 654, 'SIGKILL');
  });
});
