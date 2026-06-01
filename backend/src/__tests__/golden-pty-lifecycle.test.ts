/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  getActivePtyCleanupTaskCount,
  registerPtyCleanupTask,
  resetPtyCleanupTasksForTests,
  runRegisteredPtyCleanupTasks,
  shutdownPtyProcess,
} from '../lib/pty-manager';

describe('golden PTY lifecycle regression coverage', () => {
  afterEach(() => {
    resetPtyCleanupTasksForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('clears the cleanup registry before running tasks so crashes do not leave zombie PTY entries behind', async () => {
    const calls: string[] = [];

    registerPtyCleanupTask('run-1', async () => {
      calls.push('run-1');
      expect(getActivePtyCleanupTaskCount()).toBe(0);
    });
    registerPtyCleanupTask('run-2', () => {
      calls.push('run-2');
      throw new Error('cleanup failure must not block the rest');
    });

    await expect(runRegisteredPtyCleanupTasks()).resolves.toBeUndefined();
    expect(calls.sort()).toEqual(['run-1', 'run-2']);
    expect(getActivePtyCleanupTaskCount()).toBe(0);
  });

  test('escalates from SIGTERM to SIGKILL when a PTY ignores the grace window', async () => {
    jest.useFakeTimers();
    const kill = jest.fn();
    const killProcessGroup = jest.fn();
    const waitForExit = new Promise<void>(() => undefined);

    const shutdown = shutdownPtyProcess(
      { pid: 90210, kill },
      { waitForExit, graceMs: 100, postKillSettleMs: 25, killProcessGroup },
    );

    await jest.advanceTimersByTimeAsync(150);
    await shutdown;

    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(killProcessGroup).toHaveBeenNthCalledWith(1, 90210, 'SIGTERM');
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, 90210, 'SIGKILL');
  });
});
