/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createRequire } from 'module';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { logger } from './logger';

const runtimeRequire = createRequire(
  typeof __filename === 'string' ? __filename : path.resolve(process.argv[1] ?? process.cwd()),
);

export const PTY_UNAVAILABLE_HINT = 'Run: cd backend && npm rebuild node-pty';

export type PtyCleanupTask = () => Promise<void> | void;

export interface PtyCommittedChunk {
  sequence: number;
  chunk: Buffer;
}

export interface PtyCommittedRangeReference {
  generationId: string;
  firstSequence: number;
  lastSequence: number;
  byteCount: number;
  rangeHash: string;
  observedAt: string;
}

export type PtyCommittedRangeCallback = (range: PtyCommittedRangeReference) => Promise<void> | void;

/**
 * Build a content-addressed reference for one contiguous durable PTY range.
 * Raw bytes are used only as hash input and are never returned to projection
 * callbacks.
 */
export function createPtyCommittedRangeReference(
  generationId: string,
  chunks: readonly PtyCommittedChunk[],
  observedAt = new Date().toISOString(),
): PtyCommittedRangeReference | null {
  if (chunks.length === 0) return null;
  const digest = createHash('sha256');
  let byteCount = 0;
  let expectedSequence = chunks[0]!.sequence;
  for (const item of chunks) {
    if (item.sequence !== expectedSequence) {
      throw new Error('PTY committed range must be contiguous and ordered');
    }
    const sequence = Buffer.allocUnsafe(8);
    sequence.writeBigUInt64BE(BigInt(item.sequence));
    digest.update(sequence);
    digest.update(item.chunk);
    byteCount += item.chunk.length;
    expectedSequence += 1;
  }
  return {
    generationId,
    firstSequence: chunks[0]!.sequence,
    lastSequence: chunks[chunks.length - 1]!.sequence,
    byteCount,
    rangeHash: `sha256:${digest.digest('hex')}`,
    observedAt,
  };
}

export interface KillablePtyProcess {
  pid: number | null | undefined;
  kill(signal?: string): void;
}

export interface ShutdownPtyProcessOptions {
  signal?: NodeJS.Signals;
  graceMs?: number;
  postKillSettleMs?: number;
  waitForExit?: Promise<void>;
  killProcessGroup?: (pid: number | null | undefined, signal: NodeJS.Signals) => void;
}

const activePtyCleanupTasks = new Map<string, PtyCleanupTask>();

let ptyAvailable = false;

try {
  runtimeRequire('node-pty');
  ptyAvailable = true;
} catch (err) {
  logger.warn({ err }, `[pty-manager] node-pty unavailable — PTY mode disabled. ${PTY_UNAVAILABLE_HINT}`);
}

export const PTY_AVAILABLE = ptyAvailable;

function defaultKillProcessGroup(pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0) return;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal); } catch { /* fall through to direct PID signal */ }
  }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

export async function shutdownPtyProcess(
  pty: KillablePtyProcess | null,
  {
    signal = 'SIGTERM',
    graceMs = 10_000,
    postKillSettleMs = 250,
    waitForExit,
    killProcessGroup = defaultKillProcessGroup,
  }: ShutdownPtyProcessOptions = {},
): Promise<void> {
  if (!pty) return;

  try { pty.kill(signal); } catch { /* already gone */ }
  killProcessGroup(pty.pid, signal);

  if (signal === 'SIGTERM' && waitForExit) {
    let exited = false;
    const observedExit = waitForExit.then(() => {
      exited = true;
    });
    await Promise.race([observedExit, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
    if (!exited) {
      try { pty.kill('SIGKILL'); } catch { /* already gone */ }
      killProcessGroup(pty.pid, 'SIGKILL');
      await Promise.race([observedExit, new Promise<void>((resolve) => setTimeout(resolve, postKillSettleMs))]);
    }
  }
}

export function registerPtyCleanupTask(key: string, task: PtyCleanupTask): () => void {
  activePtyCleanupTasks.set(key, task);
  return () => {
    activePtyCleanupTasks.delete(key);
  };
}

export function getActivePtyCleanupTaskCount(): number {
  return activePtyCleanupTasks.size;
}

export async function runRegisteredPtyCleanupTasks(): Promise<void> {
  const entries = Array.from(activePtyCleanupTasks.entries());
  activePtyCleanupTasks.clear();

  await Promise.allSettled(entries.map(async ([key, task]) => {
    try {
      await task();
    } catch (err) {
      logger.warn({ err, key }, '[pty-manager] PTY cleanup task failed');
    }
  }));
}

export function resetPtyCleanupTasksForTests(): void {
  activePtyCleanupTasks.clear();
}
