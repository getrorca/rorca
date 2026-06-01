/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { logger } from './logger';

export const PTY_UNAVAILABLE_HINT = 'Run: cd backend && npm rebuild node-pty';

export type PtyCleanupTask = () => Promise<void> | void;

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
  require('node-pty');
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
