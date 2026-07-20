/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commitGuardedMerge, integrationGitEnvironment } from './story-worktree-lifecycle';

export const WAVE_INTEGRATION_STATES = [
  'prepared',
  'integrating',
  'conflicted',
  'resolution_pending',
  'aborted',
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

export type WaveConflictKind = 'content' | 'add_add' | 'rename_delete' | 'binary' | 'generated' | 'unsupported';

export interface WaveConflictingFileIdentity {
  /** UTF-8 path prefix, bounded to avoid turning Git output into unbounded evidence. */
  path: string;
  pathHash: string;
  kind: WaveConflictKind;
  stages: number[];
  modes: string[];
}

export interface WaveConflictEvidence {
  schemaVersion: 1;
  conflictingFiles: WaveConflictingFileIdentity[];
  conflictingFilesTruncated: boolean;
  sourceCommit: string;
  expectedParentHead: string;
  actualParentHead: string;
  preMergeHead: string;
  postAbortHead: string | null;
  resolver: {
    policy: 'disabled';
    identity: null;
    resolutionDiffHash: null;
  };
}

export interface WaveIntegrationRecord extends WaveContributionIdentity {
  protocolVersion: 'rorca.wave-integration.v1';
  ledgerKey: string;
  state: WaveIntegrationState;
  resultingHead: string | null;
  validationIdentity: WaveValidationIdentity | null;
  finalizationIdentity: WaveFinalizationIdentity | null;
  conflictEvidence: WaveConflictEvidence | null;
  failureReason: string | null;
  transitions: WaveIntegrationTransition[];
}

export interface PrepareWaveContributionInput extends WaveContributionIdentity {}

const OID = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SAFE_STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CONFLICT_FILES = 32;
const MAX_CONFLICT_PATH_BYTES = 512;
const ACTIVE_GIT_OPERATIONS = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG',
];
const GENERATED_PATH = /(?:^|\/)(?:dist|build|generated|coverage)(?:\/|$)|(?:\.generated\.|-lock\.(?:json|yaml|yml)$)/i;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function rollbackRejectedWaveTarget(cwd: string, expectedParentHead: string, integratedHead: string): void {
  if (git(cwd, ['rev-parse', 'HEAD']) !== integratedHead) {
    throw new Error('[wave-integration] rejected contribution cannot be rolled back because target HEAD advanced');
  }
  execFileSync('git', ['reset', '--hard', expectedParentHead], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8').split('\0').filter(Boolean);
  const root = path.resolve(cwd);
  for (const relativePath of untracked) {
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('[wave-integration] rejected contribution produced an unsafe untracked path');
    }
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  if (git(cwd, ['rev-parse', 'HEAD']) !== expectedParentHead
    || git(cwd, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new Error('[wave-integration] rejected contribution rollback did not restore the clean parent target');
  }
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

function boundedUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

interface UnmergedStage {
  path: string;
  mode: string;
  oid: string;
  stage: number;
}

function readUnmergedStages(cwd: string): UnmergedStage[] {
  const output = execFileSync('git', ['ls-files', '-u', '-z'], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('[wave-integration] malformed unmerged index entry');
    return { mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] };
  });
}

function blobLooksBinary(cwd: string, oid: string): boolean {
  const size = Number(git(cwd, ['cat-file', '-s', oid]));
  if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) return true;
  const blob = execFileSync('git', ['cat-file', 'blob', oid], {
    cwd,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  return blob.includes(0);
}

function conflictFileIdentities(cwd: string, stages: readonly UnmergedStage[]): {
  files: WaveConflictingFileIdentity[];
  truncated: boolean;
} {
  const paths = [...new Set(stages.map(item => item.path))].sort((left, right) => left.localeCompare(right));
  const files = paths.slice(0, MAX_CONFLICT_FILES).map(filePath => {
    const entries = stages.filter(item => item.path === filePath);
    const stageNumbers = entries.map(item => item.stage).sort();
    const modes = [...new Set(entries.map(item => item.mode))].sort();
    let kind: WaveConflictKind = 'content';
    if (modes.some(mode => mode === '160000' || !['100644', '100755', '120000'].includes(mode))) kind = 'unsupported';
    else if (entries.some(entry => blobLooksBinary(cwd, entry.oid))) kind = 'binary';
    else if (GENERATED_PATH.test(filePath)) kind = 'generated';
    else if (!stageNumbers.includes(1) && stageNumbers.includes(2) && stageNumbers.includes(3)) kind = 'add_add';
    else if (stageNumbers.includes(1) && (!stageNumbers.includes(2) || !stageNumbers.includes(3))) kind = 'rename_delete';
    return {
      path: boundedUtf8(filePath, MAX_CONFLICT_PATH_BYTES),
      pathHash: sha256(filePath),
      kind,
      stages: stageNumbers,
      modes,
    };
  });
  return { files, truncated: paths.length > files.length };
}

class WaveConflictAbort extends Error {
  constructor(readonly ledgerKey: string) {
    super('merge conflict was durably attributed and aborted');
  }
}

function assertConflictEvidence(record: WaveIntegrationRecord): void {
  const conflictState = ['conflicted', 'resolution_pending', 'aborted'].includes(record.state);
  const evidence = record.conflictEvidence;
  if (!evidence) {
    if (conflictState) throw new Error('[wave-integration] conflict record is missing evidence');
    return;
  }
  if (
    evidence.schemaVersion !== 1
    || evidence.sourceCommit !== record.sourceCommit
    || evidence.expectedParentHead !== record.expectedParentHead
    || !OID.test(evidence.actualParentHead)
    || !OID.test(evidence.preMergeHead)
    || (evidence.postAbortHead !== null && !OID.test(evidence.postAbortHead))
    || (record.state === 'aborted' && evidence.postAbortHead === null)
    || evidence.resolver?.policy !== 'disabled'
    || evidence.resolver.identity !== null
    || evidence.resolver.resolutionDiffHash !== null
    || !Array.isArray(evidence.conflictingFiles)
    || evidence.conflictingFiles.length === 0
    || evidence.conflictingFiles.length > MAX_CONFLICT_FILES
  ) throw new Error('[wave-integration] conflict evidence is malformed');
  for (const file of evidence.conflictingFiles) {
    if (
      !file.path
      || Buffer.byteLength(file.path, 'utf8') > MAX_CONFLICT_PATH_BYTES
      || !HASH.test(file.pathHash)
      || !['content', 'add_add', 'rename_delete', 'binary', 'generated', 'unsupported'].includes(file.kind)
      || !Array.isArray(file.stages)
      || file.stages.some(stage => ![1, 2, 3].includes(stage))
      || !Array.isArray(file.modes)
      || file.modes.some(mode => !/^\d{6}$/.test(mode))
    ) throw new Error('[wave-integration] conflicting file identity is malformed');
  }
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

export type WaveStoryReconciliationState =
  | 'never_attempted'
  | 'integrating'
  | 'integrated'
  | 'conflicted'
  | 'resolution_pending'
  | 'aborted'
  | 'failed';

/** Stable restart projection; transitions retain conflict attribution after abort. */
export function waveStoryReconciliationState(record: WaveIntegrationRecord | null): WaveStoryReconciliationState {
  if (!record || record.state === 'prepared') return 'never_attempted';
  if (record.state === 'integrating') return 'integrating';
  if (record.state === 'conflicted') return 'conflicted';
  if (record.state === 'resolution_pending') return 'resolution_pending';
  if (record.state === 'aborted') return 'aborted';
  if (record.state === 'failed') return 'failed';
  return 'integrated';
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
      conflictEvidence: null,
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

  markFailed(identity: WaveContributionIdentity, reason: string): WaveIntegrationRecord {
    return this.withMutationLock(identity, () => {
      const record = this.requireRecord(identity);
      if (record.state === 'failed' || ['conflicted', 'resolution_pending', 'aborted'].includes(record.state)) return record;
      if (record.state === 'finalized') throw new Error('[wave-integration] finalized contribution cannot be rejected');
      if (!['prepared', 'integrating', 'integrated', 'integrated_validated'].includes(record.state)) {
        throw new Error(`[wave-integration] contribution cannot fail from ${record.state}`);
      }
      if (git(this.repositoryPath, ['rev-parse', 'HEAD']) !== record.expectedParentHead
        || git(this.repositoryPath, ['status', '--porcelain', '--untracked-files=all']) !== '') {
        throw new Error('[wave-integration] failed contribution did not leave its clean parent target');
      }
      return this.transition({ ...record, failureReason: boundedUtf8(reason, 512) }, 'failed', record.expectedParentHead);
    });
  }

  /** Persist the apply intent before the Git linearization point. */
  beginIntegration(identity: WaveContributionIdentity): WaveIntegrationRecord {
    let record = this.requireRecord(identity);
    this.assertFrozenManifest(record);
    record = this.reconcile(record);
    if (['integrating', 'integrated', 'integrated_validated', 'finalized'].includes(record.state)) return record;
    if (['conflicted', 'resolution_pending', 'aborted', 'failed'].includes(record.state)) {
      throw new Error(`[wave-integration] contribution cannot integrate from ${record.state}: ${record.failureReason ?? 'unspecified'}`);
    }
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
      const preMergeHead = git(this.repositoryPath, ['rev-parse', 'HEAD']);
      try {
        execFileSync('git', ['merge', '--no-ff', '--no-commit', record.sourceCommit], {
          cwd: this.repositoryPath,
          env: integrationGitEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (mergeError) {
        const unmerged = readUnmergedStages(this.repositoryPath);
        if (unmerged.length === 0) throw mergeError;
        const identities = conflictFileIdentities(this.repositoryPath, unmerged);
        const evidence: WaveConflictEvidence = {
          schemaVersion: 1,
          conflictingFiles: identities.files,
          conflictingFilesTruncated: identities.truncated,
          sourceCommit: record.sourceCommit,
          expectedParentHead: record.expectedParentHead,
          actualParentHead: preMergeHead,
          preMergeHead,
          postAbortHead: null,
          resolver: { policy: 'disabled', identity: null, resolutionDiffHash: null },
        };
        record = this.transition({
          ...record,
          conflictEvidence: evidence,
          failureReason: `merge conflict in ${identities.files.length}${identities.truncated ? '+' : ''} bounded file identities; automatic resolution disabled`,
        }, 'conflicted', preMergeHead);
        this.abortPartialMerge(preMergeHead);
        const postAbortHead = git(this.repositoryPath, ['rev-parse', 'HEAD']);
        record = this.transition({
          ...record,
          conflictEvidence: { ...evidence, postAbortHead },
        }, 'aborted', postAbortHead);
        throw new WaveConflictAbort(record.ledgerKey);
      }
      const resultingHead = commitGuardedMerge(
        this.repositoryPath,
        `merge(wave-${record.waveIndex}): ${record.storyId} attempt ${record.attempt}`,
        record.expectedParentHead,
      );
      record = { ...record, resultingHead };
      return this.transition(record, 'integrated', resultingHead);
    } catch (error) {
      if (error instanceof WaveConflictAbort) {
        throw new Error(`[wave-integration] merge conflict aborted and failed closed (${error.ledgerKey.slice(0, 12)})`);
      }
      try { this.abortPartialMerge(git(this.repositoryPath, ['rev-parse', 'HEAD'])); } catch { /* failure remains durable below */ }
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
    if (record.state === 'conflicted' || record.state === 'resolution_pending') {
      const preMergeHead = record.conflictEvidence?.preMergeHead ?? record.expectedParentHead;
      this.abortPartialMerge(preMergeHead);
      const postAbortHead = git(this.repositoryPath, ['rev-parse', 'HEAD']);
      return this.transition({
        ...record,
        conflictEvidence: record.conflictEvidence ? { ...record.conflictEvidence, postAbortHead } : null,
        failureReason: record.failureReason ?? 'incomplete conflict recovery was aborted during restart reconciliation',
      }, 'aborted', postAbortHead);
    }
    if (record.state !== 'integrating') return record;
    const currentHead = git(this.repositoryPath, ['rev-parse', 'HEAD']);
    if (currentHead === record.expectedParentHead) {
      const unmerged = readUnmergedStages(this.repositoryPath);
      if (unmerged.length > 0) {
        const identities = conflictFileIdentities(this.repositoryPath, unmerged);
        const conflicted = this.transition({
          ...record,
          conflictEvidence: {
            schemaVersion: 1,
            conflictingFiles: identities.files,
            conflictingFilesTruncated: identities.truncated,
            sourceCommit: record.sourceCommit,
            expectedParentHead: record.expectedParentHead,
            actualParentHead: currentHead,
            preMergeHead: currentHead,
            postAbortHead: null,
            resolver: { policy: 'disabled', identity: null, resolutionDiffHash: null },
          },
          failureReason: `merge conflict in ${identities.files.length}${identities.truncated ? '+' : ''} bounded file identities; recovered after interrupted apply`,
        }, 'conflicted', currentHead);
        return this.reconcile(conflicted);
      }
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

  private abortPartialMerge(expectedHead: string): void {
    const mergeHead = path.resolve(this.repositoryPath, git(this.repositoryPath, ['rev-parse', '--git-path', 'MERGE_HEAD']));
    if (fs.existsSync(mergeHead)) {
      execFileSync('git', ['merge', '--abort'], { cwd: this.repositoryPath, env: process.env, stdio: 'ignore' });
    }
    const currentHead = git(this.repositoryPath, ['rev-parse', 'HEAD']);
    if (currentHead !== expectedHead) throw new Error('[wave-integration] abort changed or failed to restore the target head');
    this.assertCleanAndIdle();
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
    // v1 records written before conflict recovery had no conflictEvidence key.
    if (parsed.conflictEvidence === undefined) parsed.conflictEvidence = null;
    if (
      parsed.protocolVersion !== 'rorca.wave-integration.v1'
      || parsed.ledgerKey !== ledgerKey
      || !WAVE_INTEGRATION_STATES.includes(parsed.state)
      || !Array.isArray(parsed.transitions)
      || parsed.transitions.some((item, index) => (
        item.sequence !== index + 1
        || !WAVE_INTEGRATION_STATES.includes(item.state)
        || !OID.test(item.revision)
      ))
    ) throw new Error('[wave-integration] ledger record is malformed');
    assertIdentity(parsed);
    assertConflictEvidence(parsed);
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
