/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  MIN_PIPELINE_EXECUTION_TIMEOUT_SECONDS,
  pipelineExecutionJobSendOptions,
} from '../pipeline-job-lifecycle';
import {
  WorkerRunResourceOwner,
  includesWorkerChildQuiescenceError,
} from '../worker-run-resource-owner';

class FakeChild extends EventEmitter {
  readonly kills: NodeJS.Signals[] = [];
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    this.killed = true;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

class EscalatingChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    this.killed = true;
    if (signal === 'SIGKILL') {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
      });
    }
    return true;
  }
}

class NoCloseChild extends FakeChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    this.killed = true;
    return true;
  }
}

function childProcess(fake = new FakeChild()): ChildProcess {
  return fake as unknown as ChildProcess;
}

test.each([
  ['after Git root', 1],
  ['after Pi runtime', 2],
  ['after broker', 3],
] as const)('throw %s cleans every acquired identity once in LIFO order', async (_label, acquired) => {
  const owner = new WorkerRunResourceOwner();
  const cleanups = [jest.fn(), jest.fn(), jest.fn()];
  const order: number[] = [];
  for (let index = 0; index < acquired; index += 1) {
    owner.own(`resource-${index}`, () => { cleanups[index](); order.push(index); });
  }
  await owner.dispose();
  await owner.dispose();
  expect(order).toEqual(Array.from({ length: acquired }, (_, index) => acquired - index - 1));
  for (let index = 0; index < cleanups.length; index += 1) {
    expect(cleanups[index]).toHaveBeenCalledTimes(index < acquired ? 1 : 0);
  }
});

test('spawn error is observed synchronously and all child/broker/runtime ownership is released once', async () => {
  const active = jest.fn();
  const inactive = jest.fn();
  const closeBroker = jest.fn(async () => undefined);
  const removeRuntime = jest.fn();
  const owner = new WorkerRunResourceOwner({ runId: 51, onChildActive: active, onChildInactive: inactive });
  owner.own('runtime', removeRuntime);
  owner.own('broker', closeBroker);
  const child = new FakeChild();
  const terminalPromise = owner.ownChild(childProcess(child));

  const spawnError = new Error('synthetic spawn failure');
  child.emit('error', spawnError);
  child.emit('close', null, null);
  await expect(terminalPromise).resolves.toMatchObject({ kind: 'error', error: spawnError });
  await owner.dispose();
  await owner.dispose();

  expect(active).toHaveBeenCalledTimes(1);
  expect(inactive).toHaveBeenCalledTimes(1);
  expect(closeBroker).toHaveBeenCalledTimes(1);
  expect(removeRuntime).toHaveBeenCalledTimes(1);
  expect(child.kills).toEqual([]);
});

test('early cancellation after partial start waits for bounded child quiescence before releasing later resources', async () => {
  const events: string[] = [];
  const child = new FakeChild();
  const owner = new WorkerRunResourceOwner({
    runId: 52,
    termTimeoutMs: 50,
    killTimeoutMs: 50,
    onChildActive: () => events.push('active'),
    onChildInactive: () => events.push('inactive'),
  });
  owner.own('git', () => { events.push('git-clean'); });
  owner.own('broker', () => { events.push('broker-close'); });
  owner.ownChild(childProcess(child));

  await owner.dispose();
  expect(child.kills).toEqual(['SIGTERM']);
  expect(events).toEqual(['active', 'inactive', 'broker-close', 'git-clean']);
});

test('spawn error with a live PID still escalates to close before releasing later resources', async () => {
  const events: string[] = [];
  const child = new EscalatingChild();
  const owner = new WorkerRunResourceOwner({
    runId: 521,
    termTimeoutMs: 10,
    killTimeoutMs: 50,
    onChildInactive: () => events.push('inactive'),
  });
  owner.own('broker', () => { events.push('broker-close'); });
  const terminal = owner.ownChild(childProcess(child));
  child.emit('error', new Error('synthetic IPC error'));

  await expect(terminal).resolves.toMatchObject({ kind: 'error' });
  await owner.dispose();

  expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  expect(events).toEqual(['inactive', 'broker-close']);
});

test('normal close/error/duplicate-dispose race terminalizes and clears timer exactly once', async () => {
  const child = new FakeChild();
  const inactive = jest.fn();
  const owner = new WorkerRunResourceOwner({ runId: 53, onChildInactive: inactive });
  const timer = setInterval(() => undefined, 60_000);
  const clearSpy = jest.spyOn(global, 'clearInterval');
  owner.ownTimer(timer);
  const terminalPromise = owner.ownChild(childProcess(child));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  child.emit('error', new Error('late duplicate error'));

  await expect(terminalPromise).resolves.toEqual({ kind: 'close', code: 0, signal: null });
  await Promise.all([owner.dispose(), owner.dispose(), owner.dispose()]);
  expect(inactive).toHaveBeenCalledTimes(1);
  expect(clearSpy).toHaveBeenCalledTimes(1);
  expect(child.kills).toEqual([]);
  clearSpy.mockRestore();
});

test('a callback remains owned beyond 300 seconds and completes only after child close, semantic closeout, and disposal', async () => {
  jest.useFakeTimers();
  try {
    const child = new FakeChild();
    const semanticCloseout = jest.fn(async () => undefined);
    const owner = new WorkerRunResourceOwner({ runId: 54, termTimeoutMs: 10, killTimeoutMs: 10 });
    const terminal = owner.ownChild(childProcess(child));
    owner.ownChildDeadline(10 * 60_000);
    let callbackCompleted = false;
    const callback = (async () => {
      await terminal;
      await semanticCloseout();
      await owner.dispose();
      callbackCompleted = true;
    })();

    await jest.advanceTimersByTimeAsync(301_000);
    expect(callbackCompleted).toBe(false);
    expect(semanticCloseout).not.toHaveBeenCalled();
    expect(child.kills).toEqual([]);

    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await callback;
    expect(callbackCompleted).toBe(true);
    expect(semanticCloseout).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('whole-run deadline permits canonical closeout after TERM produces close proof', async () => {
  jest.useFakeTimers();
  try {
    const child = new FakeChild();
    const owner = new WorkerRunResourceOwner({ runId: 541, termTimeoutMs: 25, killTimeoutMs: 25 });
    owner.ownChild(childProcess(child));
    const terminal = owner.ownChildDeadline(1_000);
    const semanticCloseout = jest.fn(async () => undefined);
    const callback = (async () => {
      const observed = await terminal;
      await semanticCloseout();
      await owner.dispose();
      return observed;
    })();

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(callback).resolves.toMatchObject({ kind: 'close', signal: 'SIGTERM' });
    expect(child.kills).toEqual(['SIGTERM']);
    expect(semanticCloseout).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('no-close deadline rejects and settles the callback before configured pg-boss expiration', async () => {
  jest.useFakeTimers();
  try {
    const executionTimeoutSeconds = MIN_PIPELINE_EXECUTION_TIMEOUT_SECONDS;
    const expireInSeconds = pipelineExecutionJobSendOptions({ executionTimeoutSeconds }).expireInSeconds;
    const deadlineMs = executionTimeoutSeconds * 1_000;
    const startedAt = Date.now();
    const child = new NoCloseChild();
    const inactive = jest.fn();
    const owner = new WorkerRunResourceOwner({ runId: 542, onChildInactive: inactive });
    const semanticCloseout = jest.fn(async () => undefined);
    owner.ownChild(childProcess(child));
    const terminal = owner.ownChildDeadline(deadlineMs);
    const callback = (async () => {
      try {
        await terminal;
        await semanticCloseout();
      } finally {
        await owner.dispose();
      }
    })();
    let callbackSettled = false;
    let callbackError: unknown;
    void callback.then(
      () => { callbackSettled = true; },
      reason => { callbackSettled = true; callbackError = reason; },
    );

    await jest.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(callbackSettled).toBe(false);
    expect(child.kills).toEqual([]);

    await jest.advanceTimersByTimeAsync(4_002);
    expect(callbackSettled).toBe(true);
    expect(includesWorkerChildQuiescenceError(callbackError)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(expireInSeconds * 1_000);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(semanticCloseout).not.toHaveBeenCalled();
    expect(inactive).not.toHaveBeenCalled();

    child.emit('close', null, 'SIGKILL');
    await Promise.resolve();
    expect(inactive).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('cleanup continues after one release fails and reports the exact resource label', async () => {
  const later = jest.fn();
  const owner = new WorkerRunResourceOwner();
  owner.own('later', later);
  owner.own('broken-broker', () => { throw new Error('close failed'); });
  await expect(owner.dispose()).rejects.toMatchObject({
    errors: [expect.objectContaining({ resourceLabel: 'broken-broker' })],
  });
  expect(later).toHaveBeenCalledTimes(1);
  await expect(owner.dispose()).rejects.toThrow(/exact-once resource cleanup failed/);
  expect(later).toHaveBeenCalledTimes(1);
});
