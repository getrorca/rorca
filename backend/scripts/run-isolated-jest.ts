#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Parent-owned Jest invocation lease and fail-safe PostgreSQL cleanup. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  JEST_WRAPPER_CONTROL_MESSAGE,
  RELAYED_SIGNALS,
  isRelayedSignal,
  runJestInvocation,
  runCompleteJestShards,
  type RelayedSignal,
} from './lib/complete-jest-orchestrator';
import {
  cleanupIsolatedTestDatabase,
  recoverStaleIsolatedTestDatabases,
} from '../src/lib/test-db-harness';
import { requireCurrentProcessStartIdentity } from '../src/lib/process-instance-identity';
import { WorkerRunResourceOwner } from '../src/lib/worker-run-resource-owner';
import {
  JEST_INVOCATION_PREFIX,
  OWNER_HEARTBEAT_FILENAME,
  TEST_DB_STATE_SCHEMA_VERSION,
  type IsolatedTestDatabaseState,
} from '../src/lib/test-db-safety';

async function runIsolatedJest(jestArguments: readonly string[]): Promise<number> {
  const invocationId = crypto.randomBytes(12).toString('hex');
  const ownerProcessStartIdentity = requireCurrentProcessStartIdentity();
  const ownerInstanceNonce = crypto.randomBytes(32).toString('hex');
  const root = path.join(fs.realpathSync(os.tmpdir()), `${JEST_INVOCATION_PREFIX}${invocationId}`);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const leaseFile = path.join(root, 'owner.lease');
  const stateFile = path.join(root, 'database-state.json');
  const token = crypto.randomBytes(32).toString('hex');
  const leaseTokenHash = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
  const leaseFd = fs.openSync(leaseFile, 'wx', 0o600);
  fs.writeFileSync(leaseFd, `${JSON.stringify({
    invocationId,
    ownerPid: process.pid,
    ownerProcessStartIdentity,
    ownerInstanceNonce,
    token,
  })}\n`);
  fs.fsyncSync(leaseFd);
  const state: IsolatedTestDatabaseState = {
    schemaVersion: TEST_DB_STATE_SCHEMA_VERSION,
    invocationId,
    ownerPid: process.pid,
    ownerProcessStartIdentity,
    ownerInstanceNonce,
    root,
    leaseFile,
    leaseTokenHash,
    stateFile,
    status: 'allocated',
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  const heartbeatPath = path.join(root, OWNER_HEARTBEAT_FILENAME);
  const writeOwnerHeartbeat = (): void => {
    const timestamp = Date.now();
    const hash = `sha256:${crypto.createHash('sha256').update(`${token}:${timestamp}`).digest('hex')}`;
    fs.writeFileSync(heartbeatPath, `${JSON.stringify({ ts: timestamp, hash })}\n`, { mode: 0o600 });
  };
  writeOwnerHeartbeat();
  const ownerHeartbeatTimer = setInterval(writeOwnerHeartbeat, 15_000);
  ownerHeartbeatTimer.unref();


  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'DATABASE_URL', 'DATABASE_URL_TEST', 'TEST_DATABASE_URL', 'RORCA_TEST_DATABASE_URL', 'RORCA_TEST_DB_ENV_FILE',
    'RORCA_MIGRATION_DATABASE_URL', 'WAVE2_TEST_MIGRATION_DATABASE_URL', 'RORCA_RUNTIME_DATABASE_USER',
    'RORCA_CANONICAL_WRITER_DATABASE_URL', 'RORCA_CANONICAL_WRITER_DATABASE_USER',
    'RORCA_TEST_DATABASE_WORKSPACE_SCOPE', 'RORCA_MIGRATIONS_PREAPPLIED', 'RORCA_PGBOSS_PREAPPLIED',
    'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE',
    'PGSSLMODE', 'PGSSLROOTCERT', 'PGOPTIONS',
  ]) delete childEnv[key];
  Object.assign(childEnv, {
    NODE_ENV: 'test',
    RORCA_JEST_INVOCATION_ID: invocationId,
    RORCA_JEST_OWNER_PID: String(process.pid),
    RORCA_JEST_STATE_FILE: stateFile,
  });

  let child: ChildProcess | null = null;
  let relayedSignal: NodeJS.Signals | null = null;
  const childOwner = new WorkerRunResourceOwner({ runId: 1, termTimeoutMs: 5_000, killTimeoutMs: 5_000 });
  const {
    promise: signalShutdown,
    resolve: resolveSignalShutdown,
    reject: rejectSignalShutdown,
  } = Promise.withResolvers<void>();
  const relaySignal = (signal: RelayedSignal): void => {
    if (relayedSignal) return;
    relayedSignal = signal;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolveSignalShutdown();
      return;
    }
    // Bounded exact child ownership: TERM, close wait, KILL, close proof. The
    // database is never stopped beneath a child that did not become quiescent.
    void childOwner.dispose().then(resolveSignalShutdown, rejectSignalShutdown);
  };
  for (const signal of RELAYED_SIGNALS) process.on(signal, () => relaySignal(signal));
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const control = message as { type?: unknown; signal?: unknown };
    if (control.type === JEST_WRAPPER_CONTROL_MESSAGE && isRelayedSignal(control.signal)) {
      relaySignal(control.signal);
    }
  });

  async function run(): Promise<number> {
    const jestBin = path.resolve('node_modules', 'jest', 'bin', 'jest.js');
    if (!fs.existsSync(jestBin)) throw new Error(`Jest binary is unavailable: ${jestBin}`);
    child = spawn(process.execPath, ['--max-old-space-size=8192', jestBin, ...jestArguments], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
    });
    const terminal = childOwner.ownChild(child, 1);
    return Promise.race([
      terminal.then((outcome) => {
        if (outcome.kind === 'error') throw outcome.error ?? new Error('Jest child spawn failed');
        return outcome.code ?? (outcome.signal ? 1 : 0);
      }),
      signalShutdown.then(() => 1),
    ]);
  }

  let exitCode = 1;
  try {
    const recovered = await recoverStaleIsolatedTestDatabases(process.env);
    if (recovered > 0) console.warn(`[jest-owner] recovered ${recovered} exact stale invocation database(s)`);
    if (relayedSignal) throw new Error(`Jest invocation interrupted by ${relayedSignal} before child launch`);
    exitCode = await run();
  } catch (error) {
    console.error('[jest-owner] invocation failed:', error);
    exitCode = 1;
  } finally {
    clearInterval(ownerHeartbeatTimer);
    let childQuiescent = true;
    try {
      await childOwner.dispose();
    } catch (error) {
      childQuiescent = false;
      console.error('[jest-owner] bounded child TERM/KILL did not prove quiescence; preserving database recovery state:', error);
      exitCode = 1;
    }
    if (childQuiescent) {
      try {
        await cleanupIsolatedTestDatabase(childEnv);
      } catch (error) {
        console.error('[jest-owner] exact invocation cleanup failed; state preserved for exact recovery:', error);
        exitCode = 1;
      }
    }
    try { fs.closeSync(leaseFd); } catch { /* root may already be removed */ }
    // The cleanup helper normally removes the root. A parent fallback is
    // allowed only for a still-unprovisioned exact allocated root; any local
    // cluster/container identity or cleanup failure must remain recoverable.
    if (fs.existsSync(root) && path.dirname(root) === fs.realpathSync(os.tmpdir())
      && path.basename(root) === `${JEST_INVOCATION_PREFIX}${invocationId}`) {
      try {
        const current = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<IsolatedTestDatabaseState>;
        if (current.status === 'allocated' && !current.mode && !current.containerName
          && !current.containerId && !current.dataDirectory) {
          fs.rmSync(root, { recursive: true, force: false });
        }
      } catch {
        // Invalid or provisioned state is deliberately preserved, never guessed.
      }
    }
  }

  if (relayedSignal && exitCode === 0) exitCode = 1;
  return exitCode;
}

function clearJestTransformCache(): void {
  // Intermittent isolation-passing failures ("Expected 400/403, Received
  // 404/401" on unconditionally-mounted routers) were traced to the shared
  // Jest transform cache serving stale module transforms under heavy worker
  // churn. Start every invocation from a clean cache so the gate is
  // deterministic; a cold first shard is the only cost. A failed clear must
  // fail the invocation: running with the stale-cache path active would
  // re-enable the exact flake class this guard removes.
  const jestBin = path.resolve('node_modules', 'jest', 'bin', 'jest.js');
  if (!fs.existsSync(jestBin)) {
    throw new Error('Jest binary is unavailable for cache clearing');
  }
  const result = spawnSync(process.execPath, [jestBin, '--clearCache'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Jest transform cache clear failed: ${(result.error?.message ?? result.stderr) || result.stdout}`);
  }
}

async function main(): Promise<void> {
  const jestArguments = process.argv.slice(2);
  clearJestTransformCache();
  process.exitCode = await runJestInvocation(jestArguments, {
    complete: async () => (await runCompleteJestShards()).exitCode,
    focused: (args) => runIsolatedJest(args),
  });
}

void main().catch((error) => {
  console.error('[jest-owner] fatal wrapper failure:', error);
  process.exitCode = 1;
});
