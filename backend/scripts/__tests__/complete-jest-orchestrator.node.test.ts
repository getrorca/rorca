/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import * as path from 'node:path';
import test from 'node:test';
import {
  JEST_WRAPPER_CONTROL_MESSAGE,
  routeJestInvocation,
  runJestInvocation,
  runCompleteJestShards,
} from '../lib/complete-jest-orchestrator';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly relayedSignals: NodeJS.Signals[] = [];
  connected = true;
  readonly controlMessages: unknown[] = [];

  finish(code: number): void {
    this.exitCode = code;
    this.emit('close', code, null);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.relayedSignals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.controlMessages.push(message);
    queueMicrotask(() => {
      callback?.(null);
      this.finish(1);
    });
    return true;
  }
}

class RetainedWrapperIpc extends EventEmitter {
  connected = true;
  disconnectCalls = 0;

  constructor(private readonly events: string[]) {
    super();
  }

  disconnect(): void {
    this.events.push('disconnect');
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

const quietLogger = {
  error(_message: string): void {},
  log(_message: string): void {},
};

test('complete orchestration schedules every native Jest shard exactly once', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const shardCount = 8;
  const result = await runCompleteJestShards({
    shardCount,
    logger: quietLogger,
    spawnChild(command, args) {
      calls.push({ command, args: [...args] });
      const child = new FakeChild();
      queueMicrotask(() => child.finish(0));
      return child as unknown as ChildProcess;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.map(({ args }) => args.at(-1)),
    Array.from({ length: shardCount }, (_, offset) => `--shard=${offset + 1}/${shardCount}`),
  );
  assert.ok(calls.every(({ args }) => args.includes('--runInBand')));
  assert.ok(calls.every(({ args }) => !args.some((arg) => arg.startsWith('--workerIdleMemoryLimit'))));
  assert.ok(calls.every(({ command, args }) => (
    command === process.execPath
    && path.basename(args[0] ?? '') === 'cli.mjs'
    && path.basename(args[1] ?? '') === 'run-isolated-jest.ts'
  )));
});

test('a failed shard makes the aggregate fail without hiding later shard results', async () => {
  const exitCodes = [0, 23, 0];
  let launches = 0;
  const result = await runCompleteJestShards({
    shardCount: exitCodes.length,
    logger: quietLogger,
    spawnChild() {
      const child = new FakeChild();
      const code = exitCodes[launches];
      launches += 1;
      queueMicrotask(() => child.finish(code));
      return child as unknown as ChildProcess;
    },
  });

  assert.equal(launches, exitCodes.length);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.shards.map(({ code }) => code), exitCodes);
});

test('focused paths bypass complete-suite sharding', async () => {
  const focusedArguments = ['src/routes/__tests__/retry.test.ts', '--runInBand'];
  let completeCalls = 0;
  const focusedCalls: string[][] = [];

  const result = await routeJestInvocation(focusedArguments, {
    complete() {
      completeCalls += 1;
      return 'complete';
    },
    focused(args) {
      focusedCalls.push([...args]);
      return 'focused';
    },
  });

  assert.equal(result, 'focused');
  assert.equal(completeCalls, 0);
  assert.deepEqual(focusedCalls, [focusedArguments]);
});

test('the argument-free official invocation selects complete-suite orchestration', async () => {
  const result = await routeJestInvocation([], {
    complete: () => 'complete',
    focused: () => 'focused',
  });

  assert.equal(result, 'complete');
});

test('completed and failed wrappers disconnect IPC after cleanup despite a retained message listener', async () => {
  const completedEvents: string[] = [];
  const completedIpc = new RetainedWrapperIpc(completedEvents);
  completedIpc.on('message', () => {});
  const completedResult = await runJestInvocation(['--shard=1/8'], {
    complete() {
      throw new Error('unexpected complete route');
    },
    focused() {
      completedEvents.push('cleanup-complete');
      return 0;
    },
  }, completedIpc);

  assert.equal(completedResult, 0);
  assert.deepEqual(completedEvents, ['cleanup-complete', 'disconnect']);
  assert.equal(completedIpc.connected, false);
  assert.equal(completedIpc.disconnectCalls, 1);
  assert.equal(completedIpc.listenerCount('message'), 1);

  const failedEvents: string[] = [];
  const failedIpc = new RetainedWrapperIpc(failedEvents);
  failedIpc.on('message', () => {});
  await assert.rejects(runJestInvocation(['--shard=2/8'], {
    complete() {
      throw new Error('unexpected complete route');
    },
    focused() {
      failedEvents.push('cleanup-failed');
      throw new Error('wrapper failed');
    },
  }, failedIpc), /wrapper failed/);

  assert.deepEqual(failedEvents, ['cleanup-failed', 'disconnect']);
  assert.equal(failedIpc.connected, false);
  assert.equal(failedIpc.disconnectCalls, 1);
  assert.equal(failedIpc.listenerCount('message'), 1);
});

test('a completed real wrapper process is not retained solely by its IPC message listener', async () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const child = spawn(process.execPath, [
    require.resolve('tsx/cli'),
    path.join(__dirname, 'fixtures', 'completed-wrapper-ipc-child.ts'),
  ], {
    cwd: backendRoot,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];

  assert.equal(signal, null);
  assert.equal(code, 0, 'completed wrapper retained its IPC channel (sentinel exit 97)');
});

test('a termination signal reaches the active wrapper and stops later shards', async () => {
  const signalSource = new EventEmitter();
  const children: FakeChild[] = [];
  const resultPromise = runCompleteJestShards({
    shardCount: 4,
    logger: quietLogger,
    platform: 'darwin',
    signalSource,
    spawnChild() {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => signalSource.emit('SIGTERM'));
      return child as unknown as ChildProcess;
    },
  });

  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(result.interruptedBy, 'SIGTERM');
  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.relayedSignals, ['SIGTERM']);
  assert.equal(result.shards.length, 1);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

test('Windows termination uses owned IPC instead of abruptly killing the database wrapper', async () => {
  const signalSource = new EventEmitter();
  const child = new FakeChild();
  const resultPromise = runCompleteJestShards({
    shardCount: 2,
    logger: quietLogger,
    platform: 'win32',
    signalSource,
    spawnChild() {
      queueMicrotask(() => signalSource.emit('SIGINT'));
      return child as unknown as ChildProcess;
    },
  });

  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(result.interruptedBy, 'SIGINT');
  assert.deepEqual(child.relayedSignals, []);
  assert.deepEqual(child.controlMessages, [{
    type: JEST_WRAPPER_CONTROL_MESSAGE,
    signal: 'SIGINT',
  }]);
  assert.equal(result.shards.length, 1);
});
