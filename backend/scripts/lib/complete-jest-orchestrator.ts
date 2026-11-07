/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

// The exact 497-suite diagnostic completed in eight fresh processes after the
// unsharded process exhausted its 8 GiB heap. Keep this fixed and reproducible.
export const COMPLETE_JEST_SHARD_COUNT = 8;
export const RELAYED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export const JEST_WRAPPER_CONTROL_MESSAGE = 'rorca-jest-wrapper-signal';

export type RelayedSignal = (typeof RELAYED_SIGNALS)[number];

type SpawnChild = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'];
  },
) => ChildProcess;

interface SignalSource {
  on(signal: RelayedSignal, listener: () => void): unknown;
  off(signal: RelayedSignal, listener: () => void): unknown;
}

interface Logger {
  error(message: string): void;
  log(message: string): void;
}

export interface JestShardResult {
  index: number;
  code: number;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface CompleteJestResult {
  exitCode: number;
  interruptedBy: RelayedSignal | null;
  shards: JestShardResult[];
}

export interface CompleteJestOptions {
  shardCount?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  commandArgsPrefix?: readonly string[];
  spawnChild?: SpawnChild;
  signalSource?: SignalSource;
  logger?: Logger;
  platform?: NodeJS.Platform;
}

export interface JestInvocationRoutes<T> {
  complete(): Promise<T> | T;
  focused(args: readonly string[]): Promise<T> | T;
}

export interface JestWrapperIpc {
  readonly connected?: boolean;
  disconnect?(): void;
}

/** Only the argument-free official command is the complete suite. */
export function isCompleteJestInvocation(args: readonly string[]): boolean {
  return args.length === 0;
}

export function isRelayedSignal(value: unknown): value is RelayedSignal {
  return typeof value === 'string' && (RELAYED_SIGNALS as readonly string[]).includes(value);
}

/** Keep all focused/configured Jest commands as one isolated invocation. */
export function routeJestInvocation<T>(
  args: readonly string[],
  routes: JestInvocationRoutes<T>,
): Promise<T> | T {
  return isCompleteJestInvocation(args) ? routes.complete() : routes.focused(args);
}

/**
 * Route one wrapper command and release its parent-owned IPC channel only after
 * the selected invocation has finished all database cleanup.
 */
export async function runJestInvocation<T>(
  args: readonly string[],
  routes: JestInvocationRoutes<T>,
  wrapperIpc: JestWrapperIpc = process,
): Promise<T> {
  try {
    return await routeJestInvocation(args, routes);
  } finally {
    if (wrapperIpc.connected) {
      if (!wrapperIpc.disconnect) throw new Error('Connected Jest wrapper IPC has no disconnect operation');
      wrapperIpc.disconnect();
    }
  }
}

export function createJestShardArguments(index: number, shardCount: number): string[] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new RangeError(`Jest shard count must be a positive integer: ${shardCount}`);
  }
  if (!Number.isSafeInteger(index) || index < 1 || index > shardCount) {
    throw new RangeError(`Jest shard index ${index} is outside 1/${shardCount}`);
  }
  // A shard is already the memory-bounding unit. Forcing maxWorkers=1 through
  // a child worker with workerIdleMemoryLimit made hosted macOS suites lose
  // their initialized beforeAll fixtures while the same shard passed in-band.
  // Keep global setup state, test files, and teardown under one shard process.
  return ['--runInBand', `--shard=${index}/${shardCount}`];
}

function childTerminal(child: ChildProcess): Promise<Omit<JestShardResult, 'index'>> {
  const { promise, resolve } = Promise.withResolvers<Omit<JestShardResult, 'index'>>();
  let childError: Error | undefined;
  const onError = (error: Error): void => {
    childError = error;
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    child.removeListener('error', onError);
    resolve({
      code: childError ? 1 : (code ?? (signal ? 1 : 0)),
      signal,
      error: childError,
    });
  };
  // Node guarantees close after either exit or a spawn error. Waiting for
  // close is essential: an error must never let the orchestrator advance or
  // exit before the exact wrapper process has become quiescent.
  child.once('error', onError);
  child.once('close', onClose);
  return promise;
}

/**
 * Run native Jest shards sequentially. Each child is the nonce-owning wrapper,
 * so every shard owns a fresh database and proves cleanup before the next starts.
 */
export async function runCompleteJestShards(options: CompleteJestOptions = {}): Promise<CompleteJestResult> {
  const shardCount = options.shardCount ?? COMPLETE_JEST_SHARD_COUNT;
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new RangeError(`Jest shard count must be a positive integer: ${shardCount}`);
  }

  const cwd = options.cwd ?? process.cwd();
  const command = options.command ?? process.execPath;
  const commandArgsPrefix = options.commandArgsPrefix ?? [
    require.resolve('tsx/cli'),
    path.resolve(__dirname, '..', 'run-isolated-jest.ts'),
  ];
  const spawnChild = options.spawnChild ?? ((childCommand, args, spawnOptions) => (
    spawn(childCommand, [...args], spawnOptions)
  ));
  const signalSource = options.signalSource ?? process;
  const logger = options.logger ?? console;
  const platform = options.platform ?? process.platform;
  const results: JestShardResult[] = [];
  let activeChild: ChildProcess | null = null;
  let interruptedBy: RelayedSignal | null = null;

  const signalHandlers = {} as Record<RelayedSignal, () => void>;
  for (const signal of RELAYED_SIGNALS) {
    const handler = (): void => {
      if (interruptedBy) return;
      interruptedBy = signal;
      logger.error(`[jest-complete] interrupted by ${signal}; stopping after the active shard cleans up`);
      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
        // Windows kill() is abrupt even for SIGTERM/SIGINT/SIGHUP, which could
        // orphan the wrapper's database. Use the owned IPC channel there; on
        // POSIX the wrapper receives the native signal. In both cases wait for
        // wrapper close proof instead of exiting underneath it.
        try {
          if (platform === 'win32') {
            if (activeChild.connected) {
              activeChild.send(
                { type: JEST_WRAPPER_CONTROL_MESSAGE, signal },
                (error) => {
                  if (error) logger.error(`[jest-complete] IPC relay failed; waiting for the active wrapper: ${error.message}`);
                },
              );
            } else {
              logger.error('[jest-complete] wrapper IPC is closed; waiting for wrapper close proof');
            }
          } else {
            activeChild.kill(signal);
          }
        } catch (error) {
          logger.error(`[jest-complete] could not relay ${signal}; waiting for the active wrapper: ${String(error)}`);
        }
      }
    };
    signalHandlers[signal] = handler;
    signalSource.on(signal, handler);
  }

  try {
    for (let index = 1; index <= shardCount; index += 1) {
      if (interruptedBy) break;
      const shardArgs = createJestShardArguments(index, shardCount);
      logger.log(`[jest-complete] starting shard ${index}/${shardCount}`);
      try {
        activeChild = spawnChild(command, [...commandArgsPrefix, ...shardArgs], {
          cwd,
          env: options.env ?? process.env,
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
        const terminal = await childTerminal(activeChild);
        const result = { index, ...terminal };
        results.push(result);
        if (result.error) {
          logger.error(`[jest-complete] shard ${index}/${shardCount} failed to start: ${result.error.message}`);
        } else if (result.code !== 0) {
          logger.error(`[jest-complete] shard ${index}/${shardCount} failed with exit ${result.code}`);
        } else {
          logger.log(`[jest-complete] shard ${index}/${shardCount} passed`);
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        results.push({ index, code: 1, signal: null, error: normalized });
        logger.error(`[jest-complete] shard ${index}/${shardCount} failed to launch: ${normalized.message}`);
      } finally {
        activeChild = null;
      }
    }
  } finally {
    for (const signal of RELAYED_SIGNALS) signalSource.off(signal, signalHandlers[signal]);
  }

  const failed = results.filter(({ code }) => code !== 0).length;
  const exitCode = interruptedBy || failed > 0 || results.length !== shardCount ? 1 : 0;
  logger.log(
    `[jest-complete] ${results.length}/${shardCount} shard(s) finished; ${failed} failed`
      + (interruptedBy ? `; interrupted by ${interruptedBy}` : ''),
  );
  return { exitCode, interruptedBy, shards: results };
}
