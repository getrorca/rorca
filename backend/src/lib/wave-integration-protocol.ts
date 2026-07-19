/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commitGuardedMerge } from './story-worktree-lifecycle';

export const WAVE_INTEGRATION_STATES = [
  'prepared',
  'integrating',
  'integrated',
  'integrated_validated',
  'finalized',
  'failed',
] as const;

export type WaveIntegrationState = typeof WAVE_INTEGRATION_STATES[number];

export interface WaveContributionIdentity {
  runId: number;
  waveIndex: number;
  storyId: string;
  attempt: number;
  sourceRef: string;
  sourceCommit: string;
  sourceBaseCommit: string;
  expectedParentHead: string;
  frozenManifestPath: string;
  frozenManifestHash: string;
}

export interface WaveValidationIdentity {
  validator: string;
  revision: string;
  treeHash: string;
  contractHash: string;
}

export interface WaveFinalizationIdentity {
  idempotencyKey: string;
  revision: string;
  receiptHash: string;
}

export interface WaveIntegrationTransition {
  sequence: number;
  state: WaveIntegrationState;
  revision: string;
}

export interface WaveIntegrationRecord extends WaveContributionIdentity {
  protocolVersion: 'rorca.wave-integration.v1';
  ledgerKey: string;
  state: WaveIntegrationState;
  resultingHead: string | null;
  validationIdentity: WaveValidationIdentity | null;
  finalizationIdentity: WaveFinalizationIdentity | null;
  failureReason: string | null;
  transitions: WaveIntegrationTransition[];
}

export interface PrepareWaveContributionInput extends WaveContributionIdentity {}

const OID = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SAFE_STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIVE_GIT_OPERATIONS = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG',
];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertRegularFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`[wave-integration] ${label} must be a regular non-symlink file`);
}

function assertIdentity(input: WaveContributionIdentity): void {
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) throw new Error('[wave-integration] runId is invalid');
  if (!Number.isSafeInteger(input.waveIndex) || input.waveIndex < 0) throw new Error('[wave-integration] waveIndex is invalid');
  if (!SAFE_STORY_ID.test(input.storyId)) throw new Error('[wave-integration] storyId is invalid');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error('[wave-integration] attempt is invalid');
  for (const [label, oid] of [
    ['sourceCommit', input.sourceCommit],
    ['sourceBaseCommit', input.sourceBaseCommit],
    ['expectedParentHead', input.expectedParentHead],
  ] as const) {
    if (!OID.test(oid)) throw new Error(`[wave-integration] ${label} is invalid`);
  }
  if (!HASH.test(input.frozenManifestHash)) throw new Error('[wave-integration] frozenManifestHash is invalid');
}

function identityProjection(input: WaveContributionIdentity): WaveContributionIdentity {
  return {
    runId: input.runId,
    waveIndex: input.waveIndex,
    storyId: input.storyId,
    attempt: input.attempt,
    sourceRef: input.sourceRef,
    sourceCommit: input.sourceCommit,
    sourceBaseCommit: input.sourceBaseCommit,
    expectedParentHead: input.expectedParentHead,
    frozenManifestPath: input.frozenManifestPath,
    frozenManifestHash: input.frozenManifestHash,
  };
}

export function waveIntegrationLedgerKey(identity: Pick<WaveContributionIdentity, 'runId' | 'storyId' | 'attempt'>): string {
  return sha256(canonicalJson({ runId: identity.runId, storyId: identity.storyId, attempt: identity.attempt }));
}

export function deterministicWaveIntegrationOrder<T extends Pick<WaveContributionIdentity, 'waveIndex' | 'storyId'>>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.waveIndex - right.waveIndex || left.storyId.localeCompare(right.storyId));
}

/**
 * Atomic, restart-readable Git integration protocol. The PostgreSQL
 * `story_integration_ledger` table mirrors this record and provides the
 * production transaction boundary for result projection; this file protocol is
 * also usable before database connectivity is available during recovery.
 */
export class WaveIntegrationLedger {
  private readonly repositoryPath: string;
  private readonly commonDirectory: string;
  private readonly ledgerDirectory: string;

  constructor(repositoryPath: string, ledgerDirectory?: string) {
    this.repositoryPath = fs.realpathSync(repositoryPath);
    const common = path.resolve(this.repositoryPath, git(this.repositoryPath, ['rev-parse', '--git-common-dir']));
    this.commonDirectory = fs.realpathSync(common);
    this.ledgerDirectory = ledgerDirectory
      ? path.resolve(ledgerDirectory)
      : path.join(this.commonDirectory, 'rorca', 'wave-integration-ledger');
    fs.mkdirSync(this.ledgerDirectory, { recursive: true, mode: 0o700 });
    const ledgerStat = fs.lstatSync(this.ledgerDirectory);
    if (!ledgerStat.isDirectory() || ledgerStat.isSymbolicLink()) throw new Error('[wave-integration] ledger directory is unsafe');
  }

  prepare(input: PrepareWaveContributionInput): WaveIntegrationRecord {
    assertIdentity(input);
    const ledgerKey = waveIntegrationLedgerKey(input);
    const existing = this.readByKey(ledgerKey);
    if (existing) {
      this.assertSameIdentity(existing, input);
      return existing;
    }

    this.assertFrozenManifest(input);
    this.assertIntegrationPreconditions(input);
    const record: WaveIntegrationRecord = {
      protocolVersion: 'rorca.wave-integration.v1',
      ledgerKey,
      ...identityProjection(input),
      state: 'prepared',
      resultingHead: null,
      validationIdentity: null,
      finalizationIdentity: null,
      failureReason: null,
      transitions: [{ sequence: 1, state: 'prepared', revision: input.expectedParentHead }],
    };
    try {
      this.writeExclusive(record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const concurrentlyPrepared = this.readByKey(ledgerKey);
      if (!concurrentlyPrepared) throw error;
      this.assertSameIdentity(concurrentlyPrepared, input);
      return concurrentlyPrepared;
    }
  }

  /** Persist the apply intent before the Git linearization point. */
  beginIntegration(identity: WaveContributionIdentity): WaveIntegrationRecord {
    let record = this.requireRecord(identity);
    this.assertFrozenManifest(record);
    record = this.reconcile(record);
    if (['integrating', 'integrated', 'integrated_validated', 'finalized'].includes(record.state)) return record;
    if (record.state === 'failed') throw new Error(`[wave-integration] contribution is failed: ${record.failureReason ?? 'unspecified'}`);
    if (record.state !== 'prepared') throw new Error('[wave-integration] contribution is not prepared');
    this.assertIntegrationPreconditions(record);
    return this.transition(record, 'integrating', record.expectedParentHead);
  }

  integrate(identity: WaveContributionIdentity): WaveIntegrationRecord {
    return this.withMutationLock(identity, () => this.integrateUnderLock(identity));
  }

  private integrateUnderLock(identity: WaveContributionIdentity): WaveIntegrationRecord {
    let record: WaveIntegrationRecord;
    try {
      record = this.beginIntegration(identity);
    } catch (error) {
      const current = this.requireRecord(identity);
      if (current.state !== 'integrating') throw error;
      const failed = this.transition({
        ...current,
        failureReason: error instanceof Error ? error.message.slice(0, 512) : 'integration reconciliation failed',
      }, 'failed', git(this.repositoryPath, ['rev-parse', 'HEAD']));
      throw new Error(`[wave-integration] integration failed closed (${failed.ledgerKey.slice(0, 12)})`);
    }
    if (['integrated', 'integrated_validated', 'finalized'].includes(record.state)) return record;

    try {
      // A restart after the durable `integrating` transition repeats all guards.
      // If application had already advanced HEAD, reconcile() above recognized
      // only the exact two-parent merge for this source commit.
      this.assertIntegrationPreconditions(record);
      execFileSync('git', ['merge', '--no-ff', '--no-commit', record.sourceCommit], {
        cwd: this.repositoryPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const resultingHead = commitGuardedMerge(
        this.repositoryPath,
        `merge(wave-${record.waveIndex}): ${record.storyId} attempt ${record.attempt}`,
        record.expectedParentHead,
      );
      record = { ...record, resultingHead };
      return this.transition(record, 'integrated', resultingHead);
    } catch (error) {
      try { execFileSync('git', ['merge', '--abort'], { cwd: this.repositoryPath, stdio: 'ignore' }); } catch { /* no merge remains */ }
      const failed = this.transition({
        ...record,
        failureReason: error instanceof Error ? error.message.slice(0, 512) : 'integration failed',
      }, 'failed', git(this.repositoryPath, ['rev-parse', 'HEAD']));
      throw new Error(`[wave-integration] integration failed closed (${failed.ledgerKey.slice(0, 12)})`);
    }
  }

  markIntegratedValidated(identity: WaveContributionIdentity, validation: WaveValidationIdentity): WaveIntegrationRecord {
    let record = this.reconcile(this.requireRecord(identity));
    if (record.state === 'integrated_validated' || record.state === 'finalized') {
      if (canonicalJson(record.validationIdentity) !== canonicalJson(validation)) throw new Error('[wave-integration] validation identity changed on replay');
      return record;
    }
    if (record.state !== 'integrated' || !record.resultingHead) throw new Error('[wave-integration] validation requires an integrated contribution');
    this.assertFrozenManifest(record);
    this.assertCleanAndIdle();
    const head = git(this.repositoryPath, ['rev-parse', 'HEAD']);
    const treeHash = git(this.repositoryPath, ['rev-parse', 'HEAD^{tree}']);
    if (validation.revision !== record.resultingHead || validation.revision !== head || validation.treeHash !== treeHash) {
      throw new Error('[wave-integration] validation does not identify the integrated run revision and tree');
    }
    if (!validation.validator || !HASH.test(validation.contractHash)) throw new Error('[wave-integration] validation identity is incomplete');
    const resultingHead = record.resultingHead;
    record = { ...record, validationIdentity: { ...validation } };
    return this.transition(record, 'integrated_validated', resultingHead);
  }

  finalize(
    identity: WaveContributionIdentity,
    finalizeDurably: (idempotencyKey: string, revision: string) => WaveFinalizationIdentity,
  ): WaveIntegrationRecord {
    return this.withMutationLock(identity, () => this.finalizeUnderLock(identity, finalizeDurably));
  }

  private finalizeUnderLock(
    identity: WaveContributionIdentity,
    finalizeDurably: (idempotencyKey: string, revision: string) => WaveFinalizationIdentity,
  ): WaveIntegrationRecord {
    let record = this.reconcile(this.requireRecord(identity));
    if (record.state === 'finalized') return record;
    if (record.state !== 'integrated_validated' || !record.resultingHead || !record.validationIdentity) {
      throw new Error('[wave-integration] finalization requires integrated validation');
    }
    this.assertFrozenManifest(record);
    this.assertCleanAndIdle();
    if (git(this.repositoryPath, ['rev-parse', 'HEAD']) !== record.resultingHead) {
      throw new Error('[wave-integration] run revision changed before finalization');
    }
    const resultingHead = record.resultingHead;
    const idempotencyKey = `${record.ledgerKey}:finalize`;
    const finalization = finalizeDurably(idempotencyKey, resultingHead);
    if (
      finalization.idempotencyKey !== idempotencyKey
      || finalization.revision !== resultingHead
      || !HASH.test(finalization.receiptHash)
    ) throw new Error('[wave-integration] durable finalization returned a mismatched identity');
    record = { ...record, finalizationIdentity: { ...finalization } };
    return this.transition(record, 'finalized', resultingHead);
  }

  get(identity: Pick<WaveContributionIdentity, 'runId' | 'storyId' | 'attempt'>): WaveIntegrationRecord | null {
    return this.readByKey(waveIntegrationLedgerKey(identity));
  }

  private reconcile(record: WaveIntegrationRecord): WaveIntegrationRecord {
    if (record.state !== 'integrating') return record;
    const currentHead = git(this.repositoryPath, ['rev-parse', 'HEAD']);
    if (currentHead === record.expectedParentHead) {
      this.assertCleanAndIdle();
      return record;
    }
    this.assertFrozenManifest(record);
    this.assertCleanAndIdle();
    const parents = git(this.repositoryPath, ['show', '-s', '--format=%P', currentHead]).split(/\s+/).filter(Boolean);
    if (parents.length !== 2 || parents[0] !== record.expectedParentHead || parents[1] !== record.sourceCommit) {
      throw new Error('[wave-integration] integrating restart found an unrecognized target revision');
    }
    const reconciled = { ...record, resultingHead: currentHead };
    return this.transition(reconciled, 'integrated', currentHead);
  }

  private assertIntegrationPreconditions(identity: WaveContributionIdentity): void {
    this.assertCleanAndIdle();
    if (git(this.repositoryPath, ['rev-parse', 'HEAD']) !== identity.expectedParentHead) {
      throw new Error('[wave-integration] expected target head changed');
    }
    if (git(this.repositoryPath, ['rev-parse', `${identity.sourceRef}^{commit}`]) !== identity.sourceCommit) {
      throw new Error('[wave-integration] source ref no longer identifies the prepared commit');
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', identity.sourceBaseCommit, identity.sourceCommit], {
        cwd: this.repositoryPath,
        stdio: 'ignore',
      });
    } catch {
      throw new Error('[wave-integration] source commit is not descended from its frozen base');
    }
    if (identity.sourceBaseCommit !== identity.expectedParentHead) {
      // Later contributions in a wave are still based on the wave's frozen base;
      // the base must remain an ancestor of the serial integration parent.
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', identity.sourceBaseCommit, identity.expectedParentHead], {
          cwd: this.repositoryPath,
          stdio: 'ignore',
        });
      } catch {
        throw new Error('[wave-integration] expected target is not descended from the frozen wave base');
      }
    }
  }

  private assertCleanAndIdle(): void {
    if (git(this.repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all'])) {
      throw new Error('[wave-integration] run worktree is not clean');
    }
    const active = ACTIVE_GIT_OPERATIONS.filter(name => {
      const gitPath = git(this.repositoryPath, ['rev-parse', '--git-path', name]);
      return fs.existsSync(path.resolve(this.repositoryPath, gitPath));
    });
    if (active.length > 0) throw new Error(`[wave-integration] Git operation is already in progress: ${active.join(',')}`);
  }

  private assertFrozenManifest(identity: WaveContributionIdentity): void {
    const manifestPath = path.resolve(identity.frozenManifestPath);
    assertRegularFile(manifestPath, 'frozen execution manifest');
    if (sha256(fs.readFileSync(manifestPath)) !== identity.frozenManifestHash) {
      throw new Error('[wave-integration] frozen execution manifest changed');
    }
  }

  private requireRecord(identity: WaveContributionIdentity): WaveIntegrationRecord {
    assertIdentity(identity);
    const record = this.readByKey(waveIntegrationLedgerKey(identity));
    if (!record) throw new Error('[wave-integration] prepared contribution is missing');
    this.assertSameIdentity(record, identity);
    return record;
  }

  private assertSameIdentity(record: WaveIntegrationRecord, identity: WaveContributionIdentity): void {
    if (canonicalJson(identityProjection(record)) !== canonicalJson(identityProjection(identity))) {
      throw new Error('[wave-integration] story attempt identity changed on replay');
    }
  }

  private transition(record: WaveIntegrationRecord, state: WaveIntegrationState, revision: string): WaveIntegrationRecord {
    const next: WaveIntegrationRecord = {
      ...record,
      state,
      transitions: [...record.transitions, { sequence: record.transitions.length + 1, state, revision }],
    };
    this.replace(next);
    return next;
  }

  private recordPath(ledgerKey: string): string {
    if (!HASH.test(ledgerKey)) throw new Error('[wave-integration] ledger key is invalid');
    return path.join(this.ledgerDirectory, `${ledgerKey}.json`);
  }

  private withMutationLock<T>(
    identity: Pick<WaveContributionIdentity, 'runId' | 'storyId' | 'attempt'>,
    mutate: () => T,
  ): T {
    const ledgerKey = waveIntegrationLedgerKey(identity);
    const lockPath = `${this.recordPath(ledgerKey)}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, ledgerKey })}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertRegularFile(lockPath, 'integration mutation lock');
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown; ledgerKey?: unknown };
        if (!Number.isSafeInteger(lock.pid) || lock.ledgerKey !== ledgerKey) {
          throw new Error('[wave-integration] mutation lock identity is malformed');
        }
        let ownerAlive = true;
        try { process.kill(Number(lock.pid), 0); } catch { ownerAlive = false; }
        if (ownerAlive) throw new Error('[wave-integration] story attempt integration is already active');
        fs.unlinkSync(lockPath);
      }
    }
    if (!acquired) throw new Error('[wave-integration] could not acquire story attempt integration lock');
    try {
      return mutate();
    } finally {
      fs.rmSync(lockPath, { force: false });
    }
  }

  private readByKey(ledgerKey: string): WaveIntegrationRecord | null {
    const recordPath = this.recordPath(ledgerKey);
    if (!fs.existsSync(recordPath)) return null;
    assertRegularFile(recordPath, 'ledger record');
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as WaveIntegrationRecord;
    if (
      parsed.protocolVersion !== 'rorca.wave-integration.v1'
      || parsed.ledgerKey !== ledgerKey
      || !WAVE_INTEGRATION_STATES.includes(parsed.state)
      || !Array.isArray(parsed.transitions)
      || parsed.transitions.some((item, index) => item.sequence !== index + 1)
    ) throw new Error('[wave-integration] ledger record is malformed');
    assertIdentity(parsed);
    return parsed;
  }

  private writeExclusive(record: WaveIntegrationRecord): void {
    const recordPath = this.recordPath(record.ledgerKey);
    const fd = fs.openSync(recordPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${canonicalJson(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private replace(record: WaveIntegrationRecord): void {
    const recordPath = this.recordPath(record.ledgerKey);
    const temporaryPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${canonicalJson(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, recordPath);
  }
}
