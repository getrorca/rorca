/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Cross-process PID-reuse-safe liveness observations for private runtime state. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

export type ExactProcessInstanceObservation = 'exact' | 'dead' | 'mismatched' | 'unknown';

function processExists(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function linuxStartIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    // The suffix begins at field 3 (state); process start time is field 22.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    return `linux-proc-start:${startTicks}`;
  } catch {
    return null;
  }
}

// /bin/ps is setuid root on Darwin and can never exec inside a seatbelt, so
// cross-process observation is unavailable there. A process can still attest
// its OWN identity stably: pid + monotonic start-time derived from uptime.
// (This is used by test fixtures for self-referential leases; cross-process
// liveness inside the sandbox uses the owner-signed heartbeat instead.)
let cachedDarwinSelfIdentity: string | null = null;

function darwinSelfIdentity(): string | null {
  if (!cachedDarwinSelfIdentity) {
    const startMs = Date.now() - Math.round(process.uptime() * 1000);
    cachedDarwinSelfIdentity = `darwin-self:${process.pid}:${startMs}`;
  }
  return cachedDarwinSelfIdentity;
}

function darwinStartIdentity(pid: number): string | null {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
  if (!result.error && result.signal === null && result.status === 0) {
    const started = result.stdout.trim().replace(/\s+/g, ' ');
    if (started) return `darwin-ps-lstart:${started}`;
  }
  // The seatbelt refuses to exec setuid /bin/ps (EPERM); fall back to the
  // process's own stable self-identity when probing itself.
  if (pid === process.pid) return darwinSelfIdentity();
  return null;
}

export function readProcessStartIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') return linuxStartIdentity(pid);
  if (platform === 'darwin') return darwinStartIdentity(pid);
  return null;
}

/**
 * Never reports dead solely because an identity probe was unavailable. Cleanup
 * callers may mutate another process's state only for a proved ESRCH or a live
 * PID whose platform start identity differs from the persisted identity.
 */
export function observeExactProcessInstance(
  pid: number,
  expectedStartIdentity: string,
  platform: NodeJS.Platform = process.platform,
): ExactProcessInstanceObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !expectedStartIdentity) return 'unknown';
  const observed = readProcessStartIdentity(pid, platform);
  if (observed) return observed === expectedStartIdentity ? 'exact' : 'mismatched';
  const existence = processExists(pid);
  if (existence === 'dead') return 'dead';
  return 'unknown';
}

export function requireCurrentProcessStartIdentity(): string {
  const identity = readProcessStartIdentity(process.pid);
  if (!identity) throw new Error(`Platform cannot prove process-start identity for PID ${process.pid}`);
  return identity;
}
