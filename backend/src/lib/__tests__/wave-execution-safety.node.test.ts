/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildQualificationIdentity, type QualificationQueryable } from '../qualification-isolation';
import {
  assertQualificationCleanupOwnership,
  classifyQualificationOrphan,
  processTreeSignalPlan,
  reconcileQualificationStartup,
  resolveWaveSafetyLimits,
  SqlWaveSafetyStore,
  WAVE_DURABLE_BOUNDARIES,
  WaveCleanupCoordinator,
  WaveDeadline,
  WaveResourceBudget,
  type OwnedProcessTree,
  type ProcessTreeController,
  type QualificationOwnedResource,
  type WaveResource,
  type WaveSafetyLimits,
} from '../wave-execution-safety';

const RUN_ID = 'qrun_0123456789abcdef01234567';
const TOKEN = RUN_ID.slice('qrun_'.length);
const DB_URL = `postgres://rorca_qrole_${TOKEN}:secret@localhost/rorca_qtest_${TOKEN}_test?application_name=${encodeURIComponent(`rorca-qualification:${RUN_ID}`)}`;
const IDENTITY = buildQualificationIdentity(RUN_ID, DB_URL);

const SMALL_LIMITS: WaveSafetyLimits = {
  maxParallelism: 2,
  maxPendingOutputBytes: 100,
  maxStructuredTranscriptBytes: 120,
  maxPtyCaptureBytes: 130,
  maxRawCaptureBytes: 140,
  maxMemoryBytes: 150,
  maxQueueDepth: 3,
  maxDiskBytes: 160,
  maxOpenFiles: 4,
  maxChildProcesses: 3,
  maxWaveDurationMs: 1_000,
  maxCleanupMs: 100,
  leaseDurationMs: 500,
};

interface FakeLeaseRow {
  qualification_namespace: string;
  isolation_marker: string;
  story_id: string;
  attempt: number;
  worker_id: string;
  fencing_token: number;
  lease_expires_at: string;
  terminal_status: 'active' | 'cancelled' | 'timed_out' | 'failed' | 'succeeded';
}

class FakeSafetyDb implements QualificationQueryable {
  row: FakeLeaseRow | undefined;
  expired = false;
  readonly boundaries = new Map<string, { fence: number; hash: string }>();

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT INTO qualification_story_attempts')) {
      const [namespace, marker, storyId, attempt, workerId] = values as [string, string, string, number, string];
      if (!this.row) {
        this.row = {
          qualification_namespace: namespace,
          isolation_marker: marker,
          story_id: storyId,
          attempt,
          worker_id: workerId,
          fencing_token: 1,
          lease_expires_at: new Date(Date.now() + 10_000).toISOString(),
          terminal_status: 'active',
        };
      } else if (this.row.terminal_status === 'active' && (this.row.worker_id === workerId || this.expired)) {
        this.row = { ...this.row, worker_id: workerId, fencing_token: this.row.fencing_token + 1, lease_expires_at: new Date(Date.now() + 10_000).toISOString() };
        this.expired = false;
      } else return { rows: [] };
      return { rows: [{ ...this.row } as T] };
    }
    if (normalized.startsWith('UPDATE qualification_story_attempts') && normalized.includes('lease_expires_at =')) {
      const fence = Number(values[4]);
      if (!this.row || this.expired || this.row.terminal_status !== 'active' || this.row.worker_id !== values[3] || this.row.fencing_token !== fence) return { rows: [] };
      this.row.lease_expires_at = new Date(Date.now() + 10_000).toISOString();
      return { rows: [{ ...this.row } as T] };
    }
    if (normalized.startsWith('UPDATE qualification_story_attempts') && normalized.includes('terminal_status =')) {
      const fence = Number(values[4]);
      if (!this.row || this.expired || this.row.terminal_status !== 'active' || this.row.worker_id !== values[3] || this.row.fencing_token !== fence) return { rows: [] };
      this.row = { ...this.row, terminal_status: values[5] as FakeLeaseRow['terminal_status'] };
      return { rows: [{ ...this.row } as T] };
    }
    if (normalized.startsWith('SELECT * FROM qualification_story_attempts')) {
      return { rows: this.row ? [{ ...this.row } as T] : [] };
    }
    if (normalized.startsWith('WITH owned AS')) {
      const fence = Number(values[4]);
      if (!this.row || this.expired || this.row.terminal_status !== 'active' || this.row.worker_id !== values[3] || this.row.fencing_token !== fence) return { rows: [] };
      const key = `${values[0]}:${values[1]}:${values[2]}:${values[6]}`;
      const candidate = { fence, hash: String(values[7]) };
      const existing = this.boundaries.get(key);
      if (existing && existing.hash !== candidate.hash) return { rows: [] };
      if (!existing) this.boundaries.set(key, candidate);
      return { rows: [{ evidence_hash: candidate.hash } as T] };
    }
    throw new Error(`unexpected fake SQL: ${normalized}`);
  }
}

function attemptIdentity(storyId = 'WPE-007') {
  return { qualificationNamespace: RUN_ID, isolationMarker: IDENTITY.isolationMarker, storyId, attempt: 1 };
}

function resource(overrides: Partial<QualificationOwnedResource> = {}): QualificationOwnedResource {
  return {
    ...attemptIdentity(),
    kind: 'process',
    immutableId: `${RUN_ID}:WPE-007:attempt-1:process-42`,
    fencingToken: 2,
    terminal: false,
    lastDurableBoundary: 'agent_start',
    integrationState: 'none',
    immutableIdentityMatches: true,
    ...overrides,
  };
}

test('every safety limit is explicit, configurable, bounded, and invalid configuration fails closed', () => {
  const configured = resolveWaveSafetyLimits({
    RORCA_WAVE_MAX_PARALLELISM: '3',
    RORCA_WAVE_MAX_PENDING_OUTPUT_BYTES: '1000',
    RORCA_WAVE_MAX_TRANSCRIPT_BYTES: '1001',
    RORCA_WAVE_MAX_PTY_BYTES: '1002',
    RORCA_WAVE_MAX_RAW_CAPTURE_BYTES: '1003',
    RORCA_WAVE_MAX_MEMORY_BYTES: '1004',
    RORCA_WAVE_MAX_QUEUE_DEPTH: '5',
    RORCA_WAVE_MAX_DISK_BYTES: '1005',
    RORCA_WAVE_MAX_OPEN_FILES: '6',
    RORCA_WAVE_MAX_CHILD_PROCESSES: '7',
    RORCA_WAVE_MAX_DURATION_MS: '1006',
    RORCA_WAVE_MAX_CLEANUP_MS: '1007',
    RORCA_WAVE_LEASE_DURATION_MS: '1008',
  });
  assert.deepEqual(Object.keys(configured).sort(), Object.keys(SMALL_LIMITS).sort());
  assert.equal(configured.maxParallelism, 3);
  assert.equal(configured.maxRawCaptureBytes, 1003);
  assert.equal(configured.leaseDurationMs, 1008);
  assert.throws(() => resolveWaveSafetyLimits({ RORCA_WAVE_MAX_PARALLELISM: '0' }), /between 1 and 32/);
  assert.throws(() => resolveWaveSafetyLimits({ RORCA_WAVE_MAX_DISK_BYTES: '999999999999' }), /RORCA_WAVE_MAX_DISK_BYTES/);
});

test('resource limits reject or pause without mutating accepted usage and noisy stories cannot starve siblings', () => {
  const pending = new WaveResourceBudget(SMALL_LIMITS);
  assert.equal(pending.admit('pendingOutputBytes', 40, 'noisy').accepted, true);
  const paused = pending.admit('pendingOutputBytes', 20, 'noisy');
  assert.equal(paused.action, 'pause');
  assert.match(paused.diagnostic, /accepted evidence retained/);
  assert.equal(pending.snapshot().pendingOutputBytes, 40);
  assert.equal(pending.admit('pendingOutputBytes', 40, 'sibling').accepted, true);
  pending.release('pendingOutputBytes', 40, 'noisy');
  assert.equal(pending.admit('pendingOutputBytes', 50, 'noisy').accepted, true);

  const resources: WaveResource[] = [
    'parallelism', 'structuredTranscriptBytes', 'ptyCaptureBytes', 'rawCaptureBytes', 'memoryBytes',
    'queueDepth', 'diskBytes', 'openFiles', 'childProcesses',
  ];
  for (const name of resources) {
    const budget = new WaveResourceBudget(SMALL_LIMITS);
    const limit = SMALL_LIMITS[({
      parallelism: 'maxParallelism', structuredTranscriptBytes: 'maxStructuredTranscriptBytes',
      ptyCaptureBytes: 'maxPtyCaptureBytes', rawCaptureBytes: 'maxRawCaptureBytes', memoryBytes: 'maxMemoryBytes',
      queueDepth: 'maxQueueDepth', diskBytes: 'maxDiskBytes', openFiles: 'maxOpenFiles', childProcesses: 'maxChildProcesses',
    } as const)[name]];
    assert.equal(budget.admit(name, limit).accepted, true);
    const rejected = budget.admit(name, 1);
    assert.equal(rejected.action, 'reject');
    assert.equal(budget.snapshot()[name], limit, `${name} mutated after rejection`);
  }
  assert.throws(() => pending.release('rawCaptureBytes', 1), /cumulative/);
});

test('wave duration has an explicit fail-closed deadline', () => {
  const deadline = new WaveDeadline(1_000, SMALL_LIMITS);
  deadline.assertActive(1_999);
  assert.throws(() => deadline.assertActive(2_000), /scheduling and mutation are disabled/);
});

test('renewable leases fence stale workers and all nine crash boundaries replay idempotently', async () => {
  const db = new FakeSafetyDb();
  const store = new SqlWaveSafetyStore(db);
  const first = await store.claim(attemptIdentity(), 'worker-a', SMALL_LIMITS.leaseDurationMs);
  assert.equal(first.fencingToken, 1);
  const renewed = await store.renew(first, SMALL_LIMITS.leaseDurationMs);
  assert.equal(renewed.fencingToken, 1);
  await assert.rejects(store.claim(attemptIdentity(), 'worker-b', SMALL_LIMITS.leaseDurationMs), /held by a live worker/);

  for (const boundary of WAVE_DURABLE_BOUNDARIES) {
    assert.equal(await store.recordBoundary(renewed, boundary, { boundary, immutable: true }), true);
    assert.equal(await store.recordBoundary(renewed, boundary, { boundary, immutable: true }), true);
  }
  assert.equal(db.boundaries.size, WAVE_DURABLE_BOUNDARIES.length);

  db.expired = true;
  const replacement = await store.claim(attemptIdentity(), 'worker-b', SMALL_LIMITS.leaseDurationMs);
  assert.equal(replacement.fencingToken, 2);
  assert.equal(await store.recordBoundary(replacement, 'agent_commit', { boundary: 'agent_commit', immutable: true }), true);
  await assert.rejects(store.recordBoundary(first, 'agent_commit', { stale: true }), /stale fence/);
  const terminal = await store.markTerminal(replacement, 'cancelled', 'operator cancellation');
  assert.equal(terminal.terminalStatus, 'cancelled');
  await assert.rejects(store.recordBoundary(replacement, 'run_closeout', { success: true }), /stale fence/);
  await assert.rejects(store.markTerminal(replacement, 'succeeded', 'late success'), /conflicting terminal transition/);
});

test('startup reconciliation uses immutable identities and fences, never age, at every crash boundary', () => {
  const crashInventory = WAVE_DURABLE_BOUNDARIES.map((boundary, index) => resource({
    kind: index % 3 === 0 ? 'worktree' : index % 3 === 1 ? 'job' : 'integration',
    immutableId: `${RUN_ID}:WPE-007:attempt-1:${boundary}`,
    lastDurableBoundary: boundary,
    integrationState: ['integrated_validation', 'evidence_persistence', 'run_closeout'].includes(boundary) ? 'integrated' : 'integrating',
  }));
  const first = reconcileQualificationStartup(crashInventory, IDENTITY, 2);
  const replay = reconcileQualificationStartup([...crashInventory].reverse(), IDENTITY, 2);
  assert.deepEqual(first, replay);
  assert.equal(first.length, WAVE_DURABLE_BOUNDARIES.length);
  assert.equal(first.filter(item => item.classification === 'integrated').length, 3);
  assert.equal(first.filter(item => item.classification === 'recoverable').length, 6);
  const identicalReplay = reconcileQualificationStartup([crashInventory[0], crashInventory[0]], IDENTITY, 2);
  assert.equal(identicalReplay.length, 1, 'repeated reconciliation duplicated a cleanup classification');
  const conflictingReplay = reconcileQualificationStartup([
    crashInventory[0],
    { ...crashInventory[0], immutableIdentityMatches: false },
  ], IDENTITY, 2);
  assert.deepEqual(conflictingReplay.map(item => item.classification), ['manual-review-required']);

  assert.equal(classifyQualificationOrphan(resource({ terminal: true }), IDENTITY, 2), 'safe-to-clean');
  assert.equal(classifyQualificationOrphan(resource({ fencingToken: 3 }), IDENTITY, 2), 'manual-review-required');
  assert.equal(classifyQualificationOrphan(resource({ immutableIdentityMatches: false }), IDENTITY, 2), 'manual-review-required');
  const outside = resource({ qualificationNamespace: 'qrun_aaaaaaaaaaaaaaaaaaaaaaaa', immutableId: 'qrun_aaaaaaaaaaaaaaaaaaaaaaaa:foreign' });
  assert.equal(classifyQualificationOrphan(outside, IDENTITY, 2), 'manual-review-required');
  assert.throws(() => assertQualificationCleanupOwnership(outside, IDENTITY, 2), /cleanup refused/);
  assert.throws(() => assertQualificationCleanupOwnership(resource({ fencingToken: 1 }), IDENTITY, 2), /superseded/);
});

test('SIGTERM graceful drain and SIGKILL abrupt fallback are platform-specific without POSIX assumptions on Windows', () => {
  const tree: OwnedProcessTree = { resource: resource(), rootPid: 101, descendantPids: [102] };
  assert.deepEqual(processTreeSignalPlan('linux', tree, false), {
    mechanism: 'posix-process-group', signal: 'SIGTERM', groupPid: -101, descendantPids: [102],
  });
  assert.deepEqual(processTreeSignalPlan('darwin', tree, true), {
    mechanism: 'posix-process-group', signal: 'SIGKILL', groupPid: -101, descendantPids: [102],
  });
  assert.deepEqual(processTreeSignalPlan('win32', tree, false), {
    mechanism: 'windows-taskkill', command: 'taskkill', args: ['/PID', '101', '/T'],
  });
  assert.deepEqual(processTreeSignalPlan('win32', tree, true), {
    mechanism: 'windows-taskkill', command: 'taskkill', args: ['/PID', '101', '/T', '/F'],
  });
});

test('terminal transition commits before graceful process-tree drain, force fallback, and idempotent closeout', async () => {
  const db = new FakeSafetyDb();
  const store = new SqlWaveSafetyStore(db);
  const lease = await store.claim(attemptIdentity(), 'worker-a', SMALL_LIMITS.leaseDurationMs);
  db.expired = true;
  const current = await store.claim(attemptIdentity(), 'worker-a', SMALL_LIMITS.leaseDurationMs);
  assert.equal(current.fencingToken, 2);

  const calls: string[] = [];
  let reapCount = 0;
  const controller: ProcessTreeController = {
    async signal(_tree, force) {
      assert.equal(db.row?.terminal_status, 'timed_out', 'process signalled before terminal evidence committed');
      calls.push(force ? 'force' : 'graceful');
    },
    async reap(_tree, _deadline) {
      reapCount += 1;
      return reapCount === 1 ? [101, 102] : [];
    },
  };
  const coordinator = new WaveCleanupCoordinator(IDENTITY, () => current.fencingToken, controller, SMALL_LIMITS);
  const tree: OwnedProcessTree = { resource: resource(), rootPid: 101, descendantPids: [102] };
  coordinator.register(tree);
  const terminal = await coordinator.terminateAttempt(store, current, 'timed_out', 'wave deadline reached');
  assert.equal(terminal.terminalStatus, 'timed_out');
  assert.deepEqual(calls, ['graceful', 'force']);
  assert.throws(() => coordinator.assertCanSchedule(), /scheduling is disabled/);
  await coordinator.drainAll();

  const tooMany = new WaveCleanupCoordinator(IDENTITY, () => 2, controller, { ...SMALL_LIMITS, maxChildProcesses: 1 });
  assert.throws(() => tooMany.register(tree), /child-process limit/);
  await assert.rejects(store.recordBoundary(lease, 'agent_commit', {}), /stale fence/);
});

test('migration creates only qualification-owned Rorca tables and enforces terminal/fence idempotency', () => {
  const sourceRoot = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
    ? path.resolve(process.cwd(), 'backend', 'src')
    : path.resolve(process.cwd(), 'src');
  const migrationPath = path.join(sourceRoot, 'db', 'pg-migrations', '20260719092000_wave_execution_safety.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS qualification_story_attempts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS qualification_durable_boundaries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS qualification_cleanup_actions/);
  assert.match(sql, /terminal status is immutable/);
  assert.match(sql, /fencing token cannot decrease/);
  assert.match(sql, /stale qualification fence cannot classify or clean a resource/);
  assert.match(sql, /manual-review-required resource cannot be cleaned automatically/);
  assert.doesNotMatch(sql, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
});
