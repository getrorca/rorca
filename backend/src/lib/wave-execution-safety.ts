/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { QualificationIdentity, QualificationQueryable } from './qualification-isolation';

export const WAVE_DURABLE_BOUNDARIES = [
  'queue_claim',
  'agent_start',
  'agent_commit',
  'host_validation',
  'integration_preparation',
  'integration_apply',
  'integrated_validation',
  'evidence_persistence',
  'run_closeout',
] as const;
export type WaveDurableBoundary = typeof WAVE_DURABLE_BOUNDARIES[number];

export interface WaveSafetyLimits {
  maxParallelism: number;
  maxPendingOutputBytes: number;
  maxStructuredTranscriptBytes: number;
  maxPtyCaptureBytes: number;
  maxRawCaptureBytes: number;
  maxMemoryBytes: number;
  maxQueueDepth: number;
  maxDiskBytes: number;
  maxOpenFiles: number;
  maxChildProcesses: number;
  maxWaveDurationMs: number;
  maxCleanupMs: number;
  leaseDurationMs: number;
}

const LIMITS: { [K in keyof WaveSafetyLimits]: { env: string; defaultValue: number; ceiling: number } } = {
  maxParallelism: { env: 'RORCA_WAVE_MAX_PARALLELISM', defaultValue: 4, ceiling: 32 },
  maxPendingOutputBytes: { env: 'RORCA_WAVE_MAX_PENDING_OUTPUT_BYTES', defaultValue: 1024 * 1024, ceiling: 64 * 1024 * 1024 },
  maxStructuredTranscriptBytes: { env: 'RORCA_WAVE_MAX_TRANSCRIPT_BYTES', defaultValue: 4 * 1024 * 1024, ceiling: 64 * 1024 * 1024 },
  maxPtyCaptureBytes: { env: 'RORCA_WAVE_MAX_PTY_BYTES', defaultValue: 8 * 1024 * 1024, ceiling: 128 * 1024 * 1024 },
  maxRawCaptureBytes: { env: 'RORCA_WAVE_MAX_RAW_CAPTURE_BYTES', defaultValue: 8 * 1024 * 1024, ceiling: 128 * 1024 * 1024 },
  maxMemoryBytes: { env: 'RORCA_WAVE_MAX_MEMORY_BYTES', defaultValue: 512 * 1024 * 1024, ceiling: 4 * 1024 * 1024 * 1024 },
  maxQueueDepth: { env: 'RORCA_WAVE_MAX_QUEUE_DEPTH', defaultValue: 100, ceiling: 10_000 },
  maxDiskBytes: { env: 'RORCA_WAVE_MAX_DISK_BYTES', defaultValue: 256 * 1024 * 1024, ceiling: 2 * 1024 * 1024 * 1024 },
  maxOpenFiles: { env: 'RORCA_WAVE_MAX_OPEN_FILES', defaultValue: 128, ceiling: 4_096 },
  maxChildProcesses: { env: 'RORCA_WAVE_MAX_CHILD_PROCESSES', defaultValue: 16, ceiling: 256 },
  maxWaveDurationMs: { env: 'RORCA_WAVE_MAX_DURATION_MS', defaultValue: 60 * 60 * 1000, ceiling: 24 * 60 * 60 * 1000 },
  maxCleanupMs: { env: 'RORCA_WAVE_MAX_CLEANUP_MS', defaultValue: 10_000, ceiling: 60_000 },
  leaseDurationMs: { env: 'RORCA_WAVE_LEASE_DURATION_MS', defaultValue: 30_000, ceiling: 5 * 60 * 1000 },
};

export function resolveWaveSafetyLimits(env: NodeJS.ProcessEnv = process.env): Readonly<WaveSafetyLimits> {
  const values = {} as WaveSafetyLimits;
  for (const key of Object.keys(LIMITS) as Array<keyof WaveSafetyLimits>) {
    const definition = LIMITS[key];
    const raw = env[definition.env];
    const value = raw === undefined ? definition.defaultValue : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > definition.ceiling) {
      throw new Error(`[wave-safety] ${definition.env} must be an integer between 1 and ${definition.ceiling}`);
    }
    values[key] = value;
  }
  return Object.freeze(values);
}

export type WaveResource =
  | 'parallelism'
  | 'pendingOutputBytes'
  | 'structuredTranscriptBytes'
  | 'ptyCaptureBytes'
  | 'rawCaptureBytes'
  | 'memoryBytes'
  | 'queueDepth'
  | 'diskBytes'
  | 'openFiles'
  | 'childProcesses';

const RESOURCE_LIMIT: Record<WaveResource, keyof WaveSafetyLimits> = {
  parallelism: 'maxParallelism',
  pendingOutputBytes: 'maxPendingOutputBytes',
  structuredTranscriptBytes: 'maxStructuredTranscriptBytes',
  ptyCaptureBytes: 'maxPtyCaptureBytes',
  rawCaptureBytes: 'maxRawCaptureBytes',
  memoryBytes: 'maxMemoryBytes',
  queueDepth: 'maxQueueDepth',
  diskBytes: 'maxDiskBytes',
  openFiles: 'maxOpenFiles',
  childProcesses: 'maxChildProcesses',
};

const RELEASABLE_RESOURCES = new Set<WaveResource>([
  'parallelism', 'pendingOutputBytes', 'memoryBytes', 'queueDepth', 'diskBytes', 'openFiles', 'childProcesses',
]);

export interface BackpressureDecision {
  accepted: boolean;
  action: 'accepted' | 'pause' | 'reject';
  diagnostic: string;
  used: number;
  requested: number;
  limit: number;
}

/**
 * Admission is mutation-free on pause/reject. Previously admitted counters are
 * retained, so backpressure can never discard accepted output or reorder work.
 */
export class WaveDeadline {
  private readonly deadlineMs: number;

  constructor(startedAtMs: number, private readonly limits: Readonly<WaveSafetyLimits>) {
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new Error('[wave-safety] wave start time is invalid');
    this.deadlineMs = startedAtMs + limits.maxWaveDurationMs;
  }

  remainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.deadlineMs - nowMs);
  }

  assertActive(nowMs = Date.now()): void {
    if (this.remainingMs(nowMs) === 0) {
      throw new Error(`[wave-safety] wave duration limit ${this.limits.maxWaveDurationMs}ms reached; scheduling and mutation are disabled`);
    }
  }
}

export class WaveResourceBudget {
  private readonly used = new Map<WaveResource, number>();
  private readonly pendingByStory = new Map<string, number>();

  constructor(readonly limits: Readonly<WaveSafetyLimits>) {}

  admit(resource: WaveResource, amount: number, storyId?: string): BackpressureDecision {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('[wave-safety] resource amount must be a positive integer');
    const used = this.used.get(resource) ?? 0;
    const limit = this.limits[RESOURCE_LIMIT[resource]];
    const noisyStoryLimit = resource === 'pendingOutputBytes'
      ? Math.max(1, Math.floor(limit / this.limits.maxParallelism))
      : limit;
    const storyUsed = storyId ? this.pendingByStory.get(storyId) ?? 0 : 0;
    const wouldExceedStoryShare = resource === 'pendingOutputBytes' && storyId && storyUsed + amount > noisyStoryLimit;
    const action = resource === 'pendingOutputBytes' ? 'pause' : 'reject';
    if (used + amount > limit || wouldExceedStoryShare) {
      const scope = wouldExceedStoryShare ? `story share ${noisyStoryLimit}` : `wave limit ${limit}`;
      return {
        accepted: false,
        action,
        diagnostic: `[wave-safety] ${resource} backpressure: used=${used} requested=${amount} ${scope}; accepted evidence retained`,
        used,
        requested: amount,
        limit,
      };
    }
    this.used.set(resource, used + amount);
    if (resource === 'pendingOutputBytes' && storyId) this.pendingByStory.set(storyId, storyUsed + amount);
    return { accepted: true, action: 'accepted', diagnostic: '[wave-safety] resource admitted', used: used + amount, requested: amount, limit };
  }

  release(resource: WaveResource, amount: number, storyId?: string): void {
    if (!RELEASABLE_RESOURCES.has(resource)) throw new Error(`[wave-safety] ${resource} is cumulative and cannot be released`);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('[wave-safety] release amount must be a positive integer');
    const used = this.used.get(resource) ?? 0;
    if (amount > used) throw new Error(`[wave-safety] ${resource} release exceeds admitted usage`);
    this.used.set(resource, used - amount);
    if (resource === 'pendingOutputBytes' && storyId) {
      const storyUsed = this.pendingByStory.get(storyId) ?? 0;
      if (amount > storyUsed) throw new Error('[wave-safety] story pending-output release exceeds admitted usage');
      this.pendingByStory.set(storyId, storyUsed - amount);
    }
  }

  snapshot(): Readonly<Record<WaveResource, number>> {
    return Object.freeze(Object.fromEntries(Object.keys(RESOURCE_LIMIT).map(resource => [resource, this.used.get(resource as WaveResource) ?? 0])) as Record<WaveResource, number>);
  }
}

export type WaveTerminalStatus = 'cancelled' | 'timed_out' | 'failed' | 'succeeded';

export interface WaveAttemptIdentity {
  qualificationNamespace: string;
  isolationMarker: string;
  storyId: string;
  attempt: number;
}

export interface WaveAttemptLease extends WaveAttemptIdentity {
  workerId: string;
  fencingToken: number;
  leaseExpiresAt: string;
  terminalStatus: 'active' | WaveTerminalStatus;
}

interface LeaseRow {
  qualification_namespace: string;
  isolation_marker: string;
  story_id: string;
  attempt: number;
  worker_id: string;
  fencing_token: string | number;
  lease_expires_at: string;
  terminal_status: WaveAttemptLease['terminalStatus'];
}

function leaseFromRow(row: LeaseRow | undefined): WaveAttemptLease | null {
  if (!row) return null;
  return {
    qualificationNamespace: row.qualification_namespace,
    isolationMarker: row.isolation_marker,
    storyId: row.story_id,
    attempt: row.attempt,
    workerId: row.worker_id,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    terminalStatus: row.terminal_status,
  };
}

function assertAttemptIdentity(identity: WaveAttemptIdentity): void {
  if (!/^qrun_[a-f0-9]{24}$/.test(identity.qualificationNamespace)) throw new Error('[wave-safety] qualification namespace is invalid');
  if (identity.isolationMarker !== `rorca-qualification-owned:${identity.qualificationNamespace}`) throw new Error('[wave-safety] isolation marker mismatch');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity.storyId)) throw new Error('[wave-safety] story identity is invalid');
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) throw new Error('[wave-safety] attempt is invalid');
}

function assertLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > LIMITS.leaseDurationMs.ceiling) {
    throw new Error(`[wave-safety] lease duration must be between 1 and ${LIMITS.leaseDurationMs.ceiling}ms`);
  }
}

/** PostgreSQL-backed renewable lease and idempotent boundary store. */
export class SqlWaveSafetyStore {
  constructor(private readonly client: QualificationQueryable) {}

  async claim(identity: WaveAttemptIdentity, workerId: string, leaseDurationMs: number): Promise<WaveAttemptLease> {
    assertAttemptIdentity(identity);
    assertLeaseDuration(leaseDurationMs);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId)) throw new Error('[wave-safety] worker identity is invalid');
    const result = await this.client.query<LeaseRow>(`
      INSERT INTO qualification_story_attempts
        (qualification_namespace, isolation_marker, story_id, attempt, worker_id, fencing_token, lease_expires_at)
      VALUES ($1, $2, $3, $4, $5, 1, NOW() + ($6 * INTERVAL '1 millisecond'))
      ON CONFLICT (qualification_namespace, story_id, attempt) DO UPDATE
        SET worker_id = EXCLUDED.worker_id,
            fencing_token = qualification_story_attempts.fencing_token + 1,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = NOW()
      WHERE qualification_story_attempts.terminal_status = 'active'
        AND (qualification_story_attempts.worker_id = EXCLUDED.worker_id
          OR qualification_story_attempts.lease_expires_at <= NOW())
      RETURNING *`, [identity.qualificationNamespace, identity.isolationMarker, identity.storyId, identity.attempt, workerId, leaseDurationMs]);
    const lease = leaseFromRow(result.rows[0]);
    if (!lease) throw new Error('[wave-safety] attempt lease is terminal or held by a live worker');
    return lease;
  }

  async renew(lease: WaveAttemptLease, leaseDurationMs: number): Promise<WaveAttemptLease> {
    assertLeaseDuration(leaseDurationMs);
    const result = await this.client.query<LeaseRow>(`
      UPDATE qualification_story_attempts
         SET lease_expires_at = NOW() + ($6 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE qualification_namespace = $1 AND story_id = $2 AND attempt = $3
         AND worker_id = $4 AND fencing_token = $5
         AND isolation_marker = $7 AND terminal_status = 'active' AND lease_expires_at > NOW()
       RETURNING *`, [lease.qualificationNamespace, lease.storyId, lease.attempt, lease.workerId, lease.fencingToken, leaseDurationMs, lease.isolationMarker]);
    const renewed = leaseFromRow(result.rows[0]);
    if (!renewed) throw new Error('[wave-safety] lease expired or was superseded');
    return renewed;
  }

  async current(identity: WaveAttemptIdentity): Promise<WaveAttemptLease | null> {
    assertAttemptIdentity(identity);
    const result = await this.client.query<LeaseRow>(`
      SELECT * FROM qualification_story_attempts
       WHERE qualification_namespace = $1 AND story_id = $2 AND attempt = $3 AND isolation_marker = $4`,
    [identity.qualificationNamespace, identity.storyId, identity.attempt, identity.isolationMarker]);
    return leaseFromRow(result.rows[0]);
  }

  async recordBoundary(lease: WaveAttemptLease, boundary: WaveDurableBoundary, evidence: unknown): Promise<boolean> {
    if (!WAVE_DURABLE_BOUNDARIES.includes(boundary)) throw new Error('[wave-safety] durable boundary is invalid');
    const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    const result = await this.client.query<{ evidence_hash: string }>(`
      WITH owned AS (
        SELECT 1 FROM qualification_story_attempts
         WHERE qualification_namespace = $1 AND story_id = $2 AND attempt = $3
           AND worker_id = $4 AND fencing_token = $5 AND isolation_marker = $6
           AND terminal_status = 'active' AND lease_expires_at > NOW()
         FOR UPDATE
      ), inserted AS (
        INSERT INTO qualification_durable_boundaries
          (qualification_namespace, story_id, attempt, boundary, fencing_token, evidence_hash)
        SELECT $1, $2, $3, $7, $5, $8 FROM owned
        ON CONFLICT (qualification_namespace, story_id, attempt, boundary) DO NOTHING
        RETURNING evidence_hash
      )
      SELECT evidence_hash FROM inserted
      UNION ALL
      SELECT boundary.evidence_hash
        FROM qualification_durable_boundaries boundary, owned
       WHERE boundary.qualification_namespace = $1 AND boundary.story_id = $2
         AND boundary.attempt = $3 AND boundary.boundary = $7 AND boundary.evidence_hash = $8
      LIMIT 1`, [lease.qualificationNamespace, lease.storyId, lease.attempt, lease.workerId, lease.fencingToken, lease.isolationMarker, boundary, evidenceHash]);
    const row = result.rows[0];
    if (!row) throw new Error('[wave-safety] stale fence or conflicting durable boundary replay');
    return row.evidence_hash === evidenceHash;
  }

  async markTerminal(lease: WaveAttemptLease, status: WaveTerminalStatus, reason: string): Promise<WaveAttemptLease> {
    if (!reason || reason.length > 512) throw new Error('[wave-safety] terminal reason must be present and bounded');
    const result = await this.client.query<LeaseRow>(`
      UPDATE qualification_story_attempts
         SET terminal_status = $6, terminal_reason = $7, terminal_at = NOW(), updated_at = NOW()
       WHERE qualification_namespace = $1 AND story_id = $2 AND attempt = $3
         AND worker_id = $4 AND fencing_token = $5 AND isolation_marker = $8
         AND terminal_status = 'active' AND lease_expires_at > NOW()
       RETURNING *`, [lease.qualificationNamespace, lease.storyId, lease.attempt, lease.workerId, lease.fencingToken, status, reason, lease.isolationMarker]);
    const terminal = leaseFromRow(result.rows[0]);
    if (terminal) return terminal;
    const current = await this.current(lease);
    if (current?.fencingToken === lease.fencingToken && current.workerId === lease.workerId && current.terminalStatus === status) return current;
    throw new Error('[wave-safety] stale fence or conflicting terminal transition');
  }
}

export interface QualificationOwnedResource extends WaveAttemptIdentity {
  kind: 'worktree' | 'recovery_ref' | 'integration' | 'process' | 'job' | 'database_row' | 'artifact';
  immutableId: string;
  fencingToken: number;
  terminal: boolean;
  lastDurableBoundary?: WaveDurableBoundary;
  integrationState?: 'none' | 'prepared' | 'integrating' | 'integrated' | 'finalized' | 'failed';
  immutableIdentityMatches: boolean;
}

export type RecoveryClassification = 'integrated' | 'recoverable' | 'safe-to-clean' | 'manual-review-required';

/** Classification never uses resource age; only immutable ownership and fence state. */
export function classifyQualificationOrphan(
  resource: QualificationOwnedResource,
  identity: QualificationIdentity,
  currentFencingToken: number,
): RecoveryClassification {
  const owned = resource.qualificationNamespace === identity.runId
    && resource.isolationMarker === identity.isolationMarker
    && resource.immutableId.startsWith(`${identity.runId}:`);
  if (!owned || !resource.immutableIdentityMatches || resource.fencingToken > currentFencingToken) return 'manual-review-required';
  if (resource.integrationState === 'integrated' || resource.integrationState === 'finalized') return 'integrated';
  if (resource.terminal || resource.integrationState === 'failed') return 'safe-to-clean';
  return 'recoverable';
}

export function reconcileQualificationStartup(
  resources: readonly QualificationOwnedResource[],
  identity: QualificationIdentity,
  currentFencingToken: number,
): ReadonlyArray<{ immutableId: string; kind: QualificationOwnedResource['kind']; classification: RecoveryClassification }> {
  const classified = new Map<string, { resource: QualificationOwnedResource; classification: RecoveryClassification }>();
  for (const resource of [...resources].sort((left, right) => left.immutableId.localeCompare(right.immutableId) || left.kind.localeCompare(right.kind))) {
    const prior = classified.get(resource.immutableId);
    if (!prior) {
      classified.set(resource.immutableId, { resource, classification: classifyQualificationOrphan(resource, identity, currentFencingToken) });
    } else if (JSON.stringify(prior.resource) !== JSON.stringify(resource)) {
      classified.set(resource.immutableId, { resource: prior.resource, classification: 'manual-review-required' });
    }
  }
  return [...classified.entries()].map(([immutableId, value]) => ({
    immutableId,
    kind: value.resource.kind,
    classification: value.classification,
  }));
}

export function assertQualificationCleanupOwnership(
  resource: QualificationOwnedResource,
  identity: QualificationIdentity,
  currentFencingToken: number,
): void {
  const classification = classifyQualificationOrphan(resource, identity, currentFencingToken);
  if (classification === 'manual-review-required' || resource.fencingToken !== currentFencingToken) {
    throw new Error('[wave-safety] cleanup refused for unowned or superseded resource');
  }
}

export interface OwnedProcessTree {
  resource: QualificationOwnedResource;
  rootPid: number;
  descendantPids: number[];
}

export interface ProcessTreeController {
  signal(tree: OwnedProcessTree, force: boolean): Promise<void>;
  reap(tree: OwnedProcessTree, deadlineMs: number): Promise<number[]>;
}

const execFileAsync = promisify(execFile);

export type ProcessTreeSignalPlan =
  | { mechanism: 'windows-taskkill'; command: 'taskkill'; args: string[] }
  | { mechanism: 'posix-process-group'; signal: 'SIGTERM' | 'SIGKILL'; groupPid: number; descendantPids: number[] };

export function processTreeSignalPlan(platform: NodeJS.Platform, tree: OwnedProcessTree, force: boolean): ProcessTreeSignalPlan {
  if (platform === 'win32') {
    return { mechanism: 'windows-taskkill', command: 'taskkill', args: ['/PID', String(tree.rootPid), '/T', ...(force ? ['/F'] : [])] };
  }
  return {
    mechanism: 'posix-process-group',
    signal: force ? 'SIGKILL' : 'SIGTERM',
    groupPid: -tree.rootPid,
    descendantPids: [...tree.descendantPids],
  };
}

/** Platform-aware process tree signalling; Windows deliberately uses taskkill rather than POSIX signals. */
export class NativeProcessTreeController implements ProcessTreeController {
  async signal(tree: OwnedProcessTree, force: boolean): Promise<void> {
    const plan = processTreeSignalPlan(process.platform, tree, force);
    if (plan.mechanism === 'windows-taskkill') {
      await execFileAsync(plan.command, plan.args, { windowsHide: true }).catch(() => undefined);
      return;
    }
    try { process.kill(plan.groupPid, plan.signal); } catch { /* already exited */ }
    for (const pid of plan.descendantPids) {
      try { process.kill(pid, plan.signal); } catch { /* already exited */ }
    }
  }

  async reap(tree: OwnedProcessTree, deadlineMs: number): Promise<number[]> {
    const pids = [tree.rootPid, ...tree.descendantPids];
    let remaining = pids.filter(processExists);
    while (remaining.length > 0 && Date.now() < deadlineMs) {
      await new Promise(resolve => setTimeout(resolve, 20));
      remaining = remaining.filter(processExists);
    }
    return remaining;
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class WaveCleanupCoordinator {
  private draining = false;
  private readonly processes = new Map<string, OwnedProcessTree>();
  private registeredProcessCount = 0;

  constructor(
    private readonly qualificationIdentity: QualificationIdentity,
    private readonly currentFencingToken: () => number,
    private readonly processController: ProcessTreeController,
    private readonly limits: Readonly<WaveSafetyLimits>,
  ) {}

  assertCanSchedule(): void {
    if (this.draining) throw new Error('[wave-safety] wave is draining; new story scheduling is disabled');
  }

  register(tree: OwnedProcessTree): void {
    this.assertCanSchedule();
    assertQualificationCleanupOwnership(tree.resource, this.qualificationIdentity, this.currentFencingToken());
    const processCount = 1 + tree.descendantPids.length;
    if (this.registeredProcessCount + processCount > this.limits.maxChildProcesses) {
      throw new Error(`[wave-safety] child-process limit ${this.limits.maxChildProcesses} reached`);
    }
    if (this.processes.has(tree.resource.immutableId)) throw new Error('[wave-safety] process immutable identity is already registered');
    this.processes.set(tree.resource.immutableId, tree);
    this.registeredProcessCount += processCount;
  }

  /** Persist terminal evidence first, then signal/reap. Terminal status cannot be promoted later. */
  async terminateAttempt(
    store: SqlWaveSafetyStore,
    lease: WaveAttemptLease,
    status: Exclude<WaveTerminalStatus, 'succeeded'>,
    reason: string,
  ): Promise<WaveAttemptLease> {
    this.draining = true;
    const terminal = await store.markTerminal(lease, status, reason);
    await this.drainAll();
    return terminal;
  }

  async drainAll(): Promise<void> {
    if (this.draining && this.processes.size === 0) return;
    this.draining = true;
    const trees = [...this.processes.values()];
    const deadline = Date.now() + this.limits.maxCleanupMs;
    for (const tree of trees) {
      assertQualificationCleanupOwnership(tree.resource, this.qualificationIdentity, this.currentFencingToken());
      await this.processController.signal(tree, false);
    }
    const graceDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor(this.limits.maxCleanupMs / 2)));
    for (const tree of trees) {
      let unreaped = await this.processController.reap(tree, graceDeadline);
      if (unreaped.length > 0) {
        await this.processController.signal(tree, true);
        unreaped = await this.processController.reap(tree, deadline);
      }
      if (unreaped.length > 0) throw new Error(`[wave-safety] cleanup deadline exceeded; unreaped owned process count=${unreaped.length}`);
      this.processes.delete(tree.resource.immutableId);
      this.registeredProcessCount -= 1 + tree.descendantPids.length;
    }
  }
}
