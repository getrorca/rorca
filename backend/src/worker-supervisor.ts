/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const WORKER_SCRIPT = path.resolve(__dirname, 'worker.ts');
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_THRESHOLD_MS = 60_000;

let child: ChildProcess | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let startTime = 0;
let shuttingDown = false;

function spawnWorker(): void {
  startTime = Date.now();

  child = spawn('npx', ['tsx', WORKER_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (shuttingDown) return;

    if (code === 0) {
      console.log('[supervisor] Worker exited cleanly (code 0). Supervisor stopping.');
      process.exit(0);
    }

    const uptime = Date.now() - startTime;
    if (uptime >= STABLE_THRESHOLD_MS) {
      backoffMs = INITIAL_BACKOFF_MS;
    }

    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[supervisor] Worker exited with ${exitReason}, restarting in ${backoffMs}ms`);

    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);

    setTimeout(() => {
      if (!shuttingDown) spawnWorker();
    }, delay);
  });
}

function forwardSignal(sig: NodeJS.Signals): void {
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(sig);
  }
}

process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));

spawnWorker();
