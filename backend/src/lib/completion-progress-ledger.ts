/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  completionProgressEntryHash,
  ProgressLedgerEntryV1Schema,
  type ProgressLedgerEntryV1,
} from './governed-contracts/completion-protocol';
import { governedHash, type ContinuationScope } from './governed-contracts';

export const COMPLETION_PROGRESS_LEDGER_MAX_ENTRY_BYTES = 64 * 1024;
export const COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const COMPLETION_PROGRESS_LEDGER_MAX_ENTRIES = 100_000;

const SNAPSHOT_MAX_BYTES = 32 * 1024;
const LOCK_MAX_BYTES = 8 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

type LedgerOperation =
  | 'lock_write' | 'lock_fsync' | 'ledger_write' | 'ledger_fsync'
  | 'snapshot_write' | 'snapshot_fsync' | 'quarantine_write' | 'quarantine_fsync'
  | 'directory_fsync' | 'rename';

export interface CompletionProgressLedgerFaultHooks {
  /** Test/host injection point. Throwing is treated exactly like the named I/O failure. */
  beforeOperation?(operation: LedgerOperation): void;
}

export interface CompletionProgressLedgerOptions {
  /** Explicit service-owned state root. It must already exist and be outside checkoutRoot. */
  stateRoot: string;
  /** Explicit checkout root used only to enforce the outside-checkout boundary. */
  checkoutRoot: string;
  scope: ContinuationScope;
  writerFence: number;
  clock?: () => Date;
  faultHooks?: CompletionProgressLedgerFaultHooks;
}

export type CompletionProgressAppendInput = Omit<
  ProgressLedgerEntryV1,
  'sequence' | 'priorEntryHash' | 'entryHash' | 'contentHash' | 'writerFence'
>;

export interface CompletionProgressLedgerPaths {
  stateRoot: string;
  attemptDirectory: string;
  ledgerFile: string;
  snapshotFile: string;
  quarantineDirectory: string;
  writerLockFile: string;
}

export type CompletionProgressRecoveryState =
  | 'unreconciled'
  | 'reloaded'
  | 'suffix_quarantined'
  | 'exact'
  | 'database_ahead'
  | 'ledger_ahead_replayed'
  | 'rebuilt';

export interface CompletionProgressLedgerSnapshot {
  schemaVersion: 'rorca.completion-progress-snapshot.v1';
  ledgerIdentityHash: string;
  entryCount: number;
  headSequence: number | null;
  headHash: string | null;
  activeWriterFence: number;
  ledgerBytes: number;
  recoveryState: CompletionProgressRecoveryState;
  canonicalDatabaseHeadHash: string | null;
  updatedAt: string;
  snapshotHash: string;
}

export interface CompletionProgressVerification {
  entries: readonly ProgressLedgerEntryV1[];
  snapshot: CompletionProgressLedgerSnapshot;
  suffixQuarantinePath: string | null;
}

export interface CompletionProgressReplayCallbacks {
  /** Returns the complete, sequence-zero-based canonical journal for this exact attempt. */
  loadCanonicalReceipts(): Promise<readonly ProgressLedgerEntryV1[]>;
  /** Persists/reloads one exact entry. The returned entry must be byte-semantically identical. */
  replayLedgerEntry(entry: ProgressLedgerEntryV1): Promise<ProgressLedgerEntryV1>;
  /** Host-authored marker used only when canonical DB state was ahead of the file journal. */
  createDatabaseAheadMarker(input: {
    localHead: ProgressLedgerEntryV1 | null;
    canonicalHead: ProgressLedgerEntryV1;
    recoveredEntries: readonly ProgressLedgerEntryV1[];
  }): Promise<CompletionProgressAppendInput> | CompletionProgressAppendInput;
}

export interface CompletionProgressReconciliationResult {
  state: 'exact' | 'database_ahead' | 'ledger_ahead_replayed';
  ledgerHead: ProgressLedgerEntryV1 | null;
  canonicalDatabaseHead: ProgressLedgerEntryV1 | null;
  replayedEntries: number;
  recoveredEntries: number;
  recoveryMarker: ProgressLedgerEntryV1 | null;
}

export type CompletionProgressLedgerErrorCode =
  | 'COMPLETION_LEDGER_INVALID_PATH'
  | 'COMPLETION_LEDGER_ALREADY_EXISTS'
  | 'COMPLETION_LEDGER_MISSING'
  | 'COMPLETION_LEDGER_WRITER_FENCED'
  | 'COMPLETION_LEDGER_CORRUPT_SUFFIX'
  | 'COMPLETION_LEDGER_ATTEMPT_QUARANTINED'
  | 'COMPLETION_LEDGER_BOUNDS_EXCEEDED'
  | 'COMPLETION_LEDGER_IO_FAILED'
  | 'COMPLETION_LEDGER_REPLAY_CONFLICT'
  | 'COMPLETION_LEDGER_CLOSED';

export class CompletionProgressLedgerError extends Error {
  constructor(
    public readonly code: CompletionProgressLedgerErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CompletionProgressLedgerPathError extends CompletionProgressLedgerError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super('COMPLETION_LEDGER_INVALID_PATH', message, details, options);
  }
}

export class CompletionProgressLedgerFenceError extends CompletionProgressLedgerError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('COMPLETION_LEDGER_WRITER_FENCED', message, details);
  }
}

export class CompletionProgressLedgerCorruptionError extends CompletionProgressLedgerError {
  constructor(
    code: 'COMPLETION_LEDGER_CORRUPT_SUFFIX' | 'COMPLETION_LEDGER_ATTEMPT_QUARANTINED',
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(code, message, details, options);
  }
}

export class CompletionProgressLedgerIOError extends CompletionProgressLedgerError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super('COMPLETION_LEDGER_IO_FAILED', message, details, options);
  }
}

export class CompletionProgressLedgerReplayError extends CompletionProgressLedgerError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super('COMPLETION_LEDGER_REPLAY_CONFLICT', message, details, options);
  }
}

const SnapshotSchema = z.object({
  schemaVersion: z.literal('rorca.completion-progress-snapshot.v1'),
  ledgerIdentityHash: z.string().regex(HASH),
  entryCount: z.number().int().nonnegative().max(COMPLETION_PROGRESS_LEDGER_MAX_ENTRIES),
  headSequence: z.number().int().nonnegative().nullable(),
  headHash: z.string().regex(HASH).nullable(),
  activeWriterFence: z.number().int().positive(),
  ledgerBytes: z.number().int().nonnegative().max(COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES),
  recoveryState: z.enum(['unreconciled', 'reloaded', 'suffix_quarantined', 'exact', 'database_ahead', 'ledger_ahead_replayed', 'rebuilt']),
  canonicalDatabaseHeadHash: z.string().regex(HASH).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  snapshotHash: z.string().regex(HASH),
}).strict();

const LockSchema = z.object({
  schemaVersion: z.literal('rorca.completion-progress-writer-lock.v1'),
  scopeHash: z.string().regex(HASH),
  writerFence: z.number().int().positive(),
  ownerNonce: z.string().uuid(),
  pid: z.number().int().positive(),
  openedAt: z.iso.datetime({ offset: true }),
}).strict();
type WriterLock = z.infer<typeof LockSchema>;

interface ResolvedOptions extends CompletionProgressLedgerOptions {
  stateRoot: string;
  checkoutRoot: string;
  scopeHash: string;
  ledgerIdentityHash: string;
  clock: () => Date;
}

interface LockOwnership {
  fd: number;
  stat: fs.Stats;
  value: WriterLock;
}

interface ParsedLine {
  start: number;
  end: number;
  hasNewline: boolean;
  parsed: unknown;
  entry: ProgressLedgerEntryV1 | null;
  independentValid: boolean;
  scopeConflict: boolean;
}

interface ReloadResult {
  entries: ProgressLedgerEntryV1[];
  ledgerBytes: number;
  suffixQuarantinePath: string | null;
  recoveryState: CompletionProgressRecoveryState;
}

function causeOptions(error: unknown): ErrorOptions | undefined {
  return error instanceof Error ? { cause: error } : undefined;
}

function operation(hooks: CompletionProgressLedgerFaultHooks | undefined, value: LedgerOperation): void {
  hooks?.beforeOperation?.(value);
}

function currentTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CompletionProgressLedgerError('COMPLETION_LEDGER_IO_FAILED', 'Ledger clock returned an invalid date');
  }
  return value.toISOString();
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertSafeComponent(value: string, label: string): string {
  if (!SAFE_COMPONENT.test(value) || value === '.' || value === '..' || /%2f|%5c|\0/i.test(value)) {
    throw new CompletionProgressLedgerPathError(`Unsafe ${label} path component`, { label });
  }
  return value;
}

function assertOwnedMode(stat: fs.Stats, expectedKind: 'file' | 'directory', target: string): void {
  const kindMatches = expectedKind === 'file' ? stat.isFile() : stat.isDirectory();
  if (!kindMatches || stat.isSymbolicLink()) {
    throw new CompletionProgressLedgerPathError(`Ledger ${expectedKind} is not a no-follow ${expectedKind}`, { target });
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new CompletionProgressLedgerPathError(`Ledger ${expectedKind} is not owner-only`, { target });
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new CompletionProgressLedgerPathError(`Ledger ${expectedKind} is not owned by this service user`, { target });
  }
}

function completionLedgerIdentityHash(scope: ContinuationScope): string {
  const repository = scope.repository;
  return governedHash('rorca.completion-progress-ledger-identity.v1', {
    workspaceId: scope.workspaceId,
    missionId: scope.missionId,
    missionRevision: scope.missionRevision,
    missionHash: scope.missionHash,
    workPackageId: scope.workPackageId,
    workPackageRevision: scope.workPackageRevision,
    workPackageHash: scope.workPackageHash,
    spec: scope.spec,
    runId: scope.runId,
    attemptId: scope.attemptId,
    repository: {
      repositoryId: repository.repositoryId,
      remoteAuthorityHash: repository.remoteAuthorityHash,
      gitObjectFormat: repository.gitObjectFormat,
      baseSha: repository.baseSha,
      worktreeId: repository.worktreeId,
      allowedPathManifestHash: repository.allowedPathManifestHash,
      requiredPathManifestHash: repository.requiredPathManifestHash,
      forbiddenPathManifestHash: repository.forbiddenPathManifestHash,
    },
  } as never);
}

function verifiedProgressEntryHash(entry: ProgressLedgerEntryV1): string {
  const { contentHash: _contentHash, entryHash: _entryHash, ...material } = entry;
  return completionProgressEntryHash(material);
}

function resolveOptions(options: CompletionProgressLedgerOptions): ResolvedOptions {
  if (!options.stateRoot || !path.isAbsolute(options.stateRoot)) {
    throw new CompletionProgressLedgerPathError('stateRoot must be an explicit absolute path');
  }
  if (!options.checkoutRoot || !path.isAbsolute(options.checkoutRoot)) {
    throw new CompletionProgressLedgerPathError('checkoutRoot must be an explicit absolute path');
  }
  if (!Number.isSafeInteger(options.writerFence) || options.writerFence <= 0) {
    throw new CompletionProgressLedgerFenceError('Writer fence must be a positive safe integer');
  }
  if (options.scope.fencingToken !== options.writerFence) {
    throw new CompletionProgressLedgerFenceError('Writer fence does not match the exact continuation scope', {
      scopeFence: options.scope.fencingToken,
      writerFence: options.writerFence,
    });
  }

  let stateRoot: string;
  let checkoutRoot: string;
  try {
    const stateStat = fs.lstatSync(options.stateRoot);
    const checkoutStat = fs.lstatSync(options.checkoutRoot);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) throw new Error('state root is not a real directory');
    if (checkoutStat.isSymbolicLink() || !checkoutStat.isDirectory()) throw new Error('checkout root is not a real directory');
    stateRoot = fs.realpathSync(options.stateRoot);
    checkoutRoot = fs.realpathSync(options.checkoutRoot);
  } catch (error) {
    throw new CompletionProgressLedgerPathError('Ledger roots must be existing no-follow directories', {}, causeOptions(error));
  }
  if (isContained(checkoutRoot, stateRoot) || isContained(stateRoot, checkoutRoot)) {
    throw new CompletionProgressLedgerPathError('Ledger state root and checkout root must be disjoint');
  }

  const workspace = assertSafeComponent(options.scope.workspaceId, 'workspace');
  const run = assertSafeComponent(String(options.scope.runId), 'run');
  const attempt = assertSafeComponent(options.scope.attemptId, 'attempt');
  const attemptDirectory = path.resolve(stateRoot, 'completion-protocol', 'v1', workspace, run, attempt);
  if (!isContained(stateRoot, attemptDirectory) || isContained(checkoutRoot, attemptDirectory)) {
    throw new CompletionProgressLedgerPathError('Ledger attempt path escaped its external state root');
  }

  return {
    ...options,
    stateRoot,
    checkoutRoot,
    scopeHash: governedHash('rorca.continuation-scope.v1', options.scope as never),
    ledgerIdentityHash: completionLedgerIdentityHash(options.scope),
    clock: options.clock ?? (() => new Date()),
  };
}

function pathsFor(options: ResolvedOptions): CompletionProgressLedgerPaths {
  const attemptDirectory = path.join(
    options.stateRoot,
    'completion-protocol',
    'v1',
    assertSafeComponent(options.scope.workspaceId, 'workspace'),
    assertSafeComponent(String(options.scope.runId), 'run'),
    assertSafeComponent(options.scope.attemptId, 'attempt'),
  );
  return {
    stateRoot: options.stateRoot,
    attemptDirectory,
    ledgerFile: path.join(attemptDirectory, 'ledger.ndjson'),
    snapshotFile: path.join(attemptDirectory, 'snapshot.json'),
    quarantineDirectory: path.join(attemptDirectory, 'quarantine'),
    writerLockFile: path.join(attemptDirectory, 'writer.lock'),
  };
}

function fsyncDirectory(directory: string, hooks?: CompletionProgressLedgerFaultHooks): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) throw new Error('not a directory');
    operation(hooks, 'directory_fsync');
    fs.fsyncSync(fd);
  } catch (error) {
    throw new CompletionProgressLedgerIOError('Directory fsync failed', { directory }, causeOptions(error));
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the primary failure is more useful */ }
    }
  }
}

function ensurePrivateDirectory(directory: string, parent: string, hooks?: CompletionProgressLedgerFaultHooks): boolean {
  try {
    const stat = fs.lstatSync(directory);
    assertOwnedMode(stat, 'directory', directory);
    const realParent = fs.realpathSync(parent);
    const realDirectory = fs.realpathSync(directory);
    if (!isContained(realParent, realDirectory)) throw new Error('directory escaped parent');
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof CompletionProgressLedgerError) throw error;
      throw new CompletionProgressLedgerPathError('Ledger directory is unsafe', { directory }, causeOptions(error));
    }
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fsyncDirectory(directory, hooks);
    fsyncDirectory(parent, hooks);
    return true;
  } catch (error) {
    throw new CompletionProgressLedgerIOError('Could not durably create ledger directory', { directory }, causeOptions(error));
  }
}

function ensureHierarchy(options: ResolvedOptions, createAttempt: boolean): { paths: CompletionProgressLedgerPaths; attemptCreated: boolean } {
  const paths = pathsFor(options);
  const components = [
    'completion-protocol',
    'v1',
    assertSafeComponent(options.scope.workspaceId, 'workspace'),
    assertSafeComponent(String(options.scope.runId), 'run'),
  ];
  let parent = options.stateRoot;
  for (const component of components) {
    const next = path.join(parent, component);
    ensurePrivateDirectory(next, parent, options.faultHooks);
    parent = next;
  }
  let attemptCreated = false;
  if (createAttempt) {
    attemptCreated = ensurePrivateDirectory(paths.attemptDirectory, parent, options.faultHooks);
  } else {
    try {
      const stat = fs.lstatSync(paths.attemptDirectory);
      assertOwnedMode(stat, 'directory', paths.attemptDirectory);
      if (!isContained(fs.realpathSync(parent), fs.realpathSync(paths.attemptDirectory))) throw new Error('attempt escaped run root');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CompletionProgressLedgerError('COMPLETION_LEDGER_MISSING', 'Completion ledger attempt directory is missing', {
          attemptDirectory: paths.attemptDirectory,
        });
      }
      if (error instanceof CompletionProgressLedgerError) throw error;
      throw new CompletionProgressLedgerPathError('Ledger attempt directory is unsafe', {}, causeOptions(error));
    }
  }
  return { paths, attemptCreated };
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('zero-byte write');
    offset += written;
  }
}

function atomicWrite(
  target: string,
  bytes: Buffer,
  kind: 'snapshot' | 'ledger',
  hooks?: CompletionProgressLedgerFaultHooks,
): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    try {
      const targetStat = fs.lstatSync(target);
      assertOwnedMode(targetStat, 'file', target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    operation(hooks, kind === 'snapshot' ? 'snapshot_write' : 'ledger_write');
    writeAll(fd, bytes);
    operation(hooks, kind === 'snapshot' ? 'snapshot_fsync' : 'ledger_fsync');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    operation(hooks, 'rename');
    fs.renameSync(temporary, target);
    fsyncDirectory(directory, hooks);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* unpublished temp cleanup */ }
    if (error instanceof CompletionProgressLedgerError) throw error;
    throw new CompletionProgressLedgerIOError(`Atomic ${kind} write failed`, { target }, causeOptions(error));
  }
}

function snapshotMaterial(snapshot: CompletionProgressLedgerSnapshot): Omit<CompletionProgressLedgerSnapshot, 'snapshotHash'> {
  const { snapshotHash: _snapshotHash, ...material } = snapshot;
  return material;
}

function snapshotHash(material: Omit<CompletionProgressLedgerSnapshot, 'snapshotHash'>): string {
  return governedHash('rorca.completion-progress-snapshot.v1', material as never);
}

function createSnapshot(input: {
  options: ResolvedOptions;
  entries: readonly ProgressLedgerEntryV1[];
  ledgerBytes: number;
  recoveryState: CompletionProgressRecoveryState;
  canonicalDatabaseHeadHash?: string | null;
}): CompletionProgressLedgerSnapshot {
  const head = input.entries.at(-1) ?? null;
  const material: Omit<CompletionProgressLedgerSnapshot, 'snapshotHash'> = {
    schemaVersion: 'rorca.completion-progress-snapshot.v1',
    ledgerIdentityHash: input.options.ledgerIdentityHash,
    entryCount: input.entries.length,
    headSequence: head?.sequence ?? null,
    headHash: head?.entryHash ?? null,
    activeWriterFence: input.options.writerFence,
    ledgerBytes: input.ledgerBytes,
    recoveryState: input.recoveryState,
    canonicalDatabaseHeadHash: input.canonicalDatabaseHeadHash ?? null,
    updatedAt: currentTimestamp(input.options.clock),
  };
  return { ...material, snapshotHash: snapshotHash(material) };
}

function readRegularFile(target: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(target);
    assertOwnedMode(before, 'file', target);
    if (before.size > maxBytes) {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_BOUNDS_EXCEEDED', 'Ledger file exceeds its frozen byte bound', {
        target,
        size: before.size,
        maxBytes,
      });
    }
    fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new CompletionProgressLedgerPathError('No-follow ledger file identity changed while opening', { target });
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('incomplete bounded read');
      offset += count;
    }
    return bytes;
  } catch (error) {
    if (error instanceof CompletionProgressLedgerError || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new CompletionProgressLedgerIOError('No-follow ledger read failed', { target }, causeOptions(error));
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* primary result remains authoritative */ }
    }
  }
}

function readSnapshot(paths: CompletionProgressLedgerPaths, options: ResolvedOptions): CompletionProgressLedgerSnapshot | null {
  let bytes: Buffer;
  try {
    bytes = readRegularFile(paths.snapshotFile, SNAPSHOT_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof CompletionProgressLedgerIOError && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')) return null;
    throw error;
  }
  let unknown: unknown;
  try { unknown = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch (error) { throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Snapshot is invalid JSON', {}, causeOptions(error)); }
  const parsed = SnapshotSchema.safeParse(unknown);
  if (!parsed.success) {
    throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Snapshot violates its strict schema');
  }
  const snapshot = parsed.data as CompletionProgressLedgerSnapshot;
  if (snapshot.ledgerIdentityHash !== options.ledgerIdentityHash
    || snapshot.snapshotHash !== snapshotHash(snapshotMaterial(snapshot))) {
    throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Snapshot identity or integrity hash conflicts with this attempt');
  }
  if ((snapshot.entryCount === 0) !== (snapshot.headSequence === null && snapshot.headHash === null)
    || (snapshot.entryCount > 0 && snapshot.headSequence !== snapshot.entryCount - 1)) {
    throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Snapshot high-water fields are inconsistent');
  }
  return snapshot;
}

function parseLines(bytes: Buffer, options: ResolvedOptions): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let start = 0;
  for (let cursor = 0; cursor < bytes.length; cursor += 1) {
    if (bytes[cursor] !== 0x0a) continue;
    lines.push(parseLine(bytes, start, cursor, true, options));
    start = cursor + 1;
  }
  if (start < bytes.length) lines.push(parseLine(bytes, start, bytes.length, false, options));
  return lines;
}

function parseLine(bytes: Buffer, start: number, end: number, hasNewline: boolean, options: ResolvedOptions): ParsedLine {
  const lineBytes = bytes.subarray(start, end);
  let parsed: unknown = null;
  let entry: ProgressLedgerEntryV1 | null = null;
  let independentValid = false;
  let scopeConflict = false;
  try {
    const text = lineBytes.toString('utf8');
    if (!lineBytes.equals(Buffer.from(text, 'utf8')) || text.length === 0) throw new Error('invalid UTF-8 or empty line');
    parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      const rawScope = raw.scope as { fencingToken?: unknown; repository?: { currentSha?: unknown } } | undefined;
      if (rawScope && (raw.writerFence !== rawScope.fencingToken || raw.repositorySha !== rawScope.repository?.currentSha)) {
        scopeConflict = true;
      }
    }
    const result = ProgressLedgerEntryV1Schema.safeParse(parsed);
    if (result.success) {
      entry = result.data;
      scopeConflict ||= completionLedgerIdentityHash(entry.scope) !== options.ledgerIdentityHash;
      independentValid = lineBytes.length + (hasNewline ? 1 : 0) <= COMPLETION_PROGRESS_LEDGER_MAX_ENTRY_BYTES
        && verifiedProgressEntryHash(entry) === entry.entryHash
        && entry.contentHash === entry.entryHash;
    }
  } catch {
    // Classification below decides whether an invalid line is a recoverable suffix.
  }
  return { start, end: hasNewline ? end + 1 : end, hasNewline, parsed, entry, independentValid, scopeConflict };
}

function validPrefix(lines: readonly ParsedLine[]): { entries: ProgressLedgerEntryV1[]; firstBad: number | null } {
  const entries: ProgressLedgerEntryV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const previous = entries[index - 1];
    const expectedPrior = index === 0 ? 'not_applicable' : previous!.entryHash;
    if (!line.hasNewline || !line.entry || !line.independentValid
      || line.entry.sequence !== index || line.entry.priorEntryHash !== expectedPrior
      || (previous !== undefined && line.entry.writerFence < previous.writerFence)) {
      return { entries, firstBad: index };
    }
    entries.push(line.entry);
  }
  return { entries, firstBad: null };
}

function writeQuarantinedSuffix(
  paths: CompletionProgressLedgerPaths,
  options: ResolvedOptions,
  suffix: Buffer,
  firstBad: number,
): string {
  ensurePrivateDirectory(paths.quarantineDirectory, paths.attemptDirectory, options.faultHooks);
  const name = `suffix-${String(firstBad).padStart(8, '0')}-${Date.parse(currentTimestamp(options.clock))}-${randomUUID()}.ndjson`;
  const target = path.join(paths.quarantineDirectory, name);
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    operation(options.faultHooks, 'quarantine_write');
    writeAll(fd, suffix);
    operation(options.faultHooks, 'quarantine_fsync');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(paths.quarantineDirectory, options.faultHooks);
    return target;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(target); } catch { /* unpublished quarantine cleanup */ }
    if (error instanceof CompletionProgressLedgerError) throw error;
    throw new CompletionProgressLedgerIOError('Could not durably retain corrupt ledger suffix', {}, causeOptions(error));
  }
}

function reloadLedger(
  paths: CompletionProgressLedgerPaths,
  options: ResolvedOptions,
  snapshot: CompletionProgressLedgerSnapshot | null,
  repairSuffix: boolean,
): ReloadResult {
  let bytes: Buffer;
  try {
    bytes = readRegularFile(paths.ledgerFile, COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof CompletionProgressLedgerIOError
        && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT');
    if (missing) {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_MISSING', 'Completion ledger file is missing; canonical DB rebuild is required', {
        ledgerFile: paths.ledgerFile,
      });
    }
    throw error;
  }
  const lines = parseLines(bytes, options);
  if (lines.length > COMPLETION_PROGRESS_LEDGER_MAX_ENTRIES) {
    throw new CompletionProgressLedgerError('COMPLETION_LEDGER_BOUNDS_EXCEEDED', 'Completion ledger exceeds its frozen entry bound');
  }
  if (lines.some(line => line.scopeConflict)) {
    throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Completion ledger contains an exact-scope, fence, or repository conflict');
  }
  const prefix = validPrefix(lines);
  if (snapshot) {
    const snapshotPrefixExists = prefix.entries.length >= snapshot.entryCount;
    const snapshotHeadMatches = snapshot.entryCount === 0
      || prefix.entries[snapshot.entryCount - 1]?.entryHash === snapshot.headHash;
    if (!snapshotPrefixExists || !snapshotHeadMatches || snapshot.ledgerBytes > bytes.length) {
      throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Ledger corruption intersects the acknowledged snapshot high-water mark');
    }
  }
  const durableHeadFence = prefix.entries.at(-1)?.writerFence;
  if (durableHeadFence !== undefined && durableHeadFence > options.writerFence) {
    throw new CompletionProgressLedgerFenceError('Ledger contains a durable entry from a newer writer fence', {
      requestedFence: options.writerFence,
      durableHeadFence,
    });
  }
  if (prefix.firstBad === null) {
    return {
      entries: prefix.entries,
      ledgerBytes: bytes.length,
      suffixQuarantinePath: null,
      recoveryState: snapshot && snapshot.entryCount === prefix.entries.length && snapshot.ledgerBytes === bytes.length
        ? snapshot.recoveryState
        : 'reloaded',
    };
  }

  const laterValid = lines.slice(prefix.firstBad + 1).some(line => line.independentValid || line.scopeConflict);
  if (laterValid) {
    throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', 'Completion ledger has middle corruption followed by a valid entry');
  }
  if (!repairSuffix) {
    throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_CORRUPT_SUFFIX', 'Completion ledger has a recoverable corrupt suffix', {
      firstBadSequence: prefix.firstBad,
    });
  }
  const suffixStart = lines[prefix.firstBad]!.start;
  const quarantinePath = writeQuarantinedSuffix(paths, options, bytes.subarray(suffixStart), prefix.firstBad);
  const retained = bytes.subarray(0, suffixStart);
  atomicWrite(paths.ledgerFile, retained, 'ledger', options.faultHooks);
  return {
    entries: prefix.entries,
    ledgerBytes: retained.length,
    suffixQuarantinePath: quarantinePath,
    recoveryState: 'suffix_quarantined',
  };
}

function writeSnapshotFile(paths: CompletionProgressLedgerPaths, snapshot: CompletionProgressLedgerSnapshot, hooks?: CompletionProgressLedgerFaultHooks): void {
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
  if (bytes.length > SNAPSHOT_MAX_BYTES) {
    throw new CompletionProgressLedgerError('COMPLETION_LEDGER_BOUNDS_EXCEEDED', 'Completion ledger snapshot exceeds its frozen byte bound');
  }
  atomicWrite(paths.snapshotFile, bytes, 'snapshot', hooks);
}

function createEmptyLedger(paths: CompletionProgressLedgerPaths, hooks?: CompletionProgressLedgerFaultHooks): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(paths.ledgerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    operation(hooks, 'ledger_fsync');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(paths.attemptDirectory, hooks);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* primary error retained */ }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_ALREADY_EXISTS', 'Completion ledger already exists');
    }
    if (error instanceof CompletionProgressLedgerError) throw error;
    throw new CompletionProgressLedgerIOError('Could not create completion ledger', {}, causeOptions(error));
  }
}

function readWriterLock(lockFile: string): { value: WriterLock; stat: fs.Stats } {
  const bytes = readRegularFile(lockFile, LOCK_MAX_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new CompletionProgressLedgerFenceError('Existing writer lock is invalid', { lockFile }); }
  const result = LockSchema.safeParse(parsed);
  if (!result.success) throw new CompletionProgressLedgerFenceError('Existing writer lock violates its strict schema', { lockFile });
  return { value: result.data, stat: fs.lstatSync(lockFile) };
}

function acquireWriterLock(paths: CompletionProgressLedgerPaths, options: ResolvedOptions, snapshot: CompletionProgressLedgerSnapshot | null): LockOwnership {
  if (snapshot && options.writerFence < snapshot.activeWriterFence) {
    throw new CompletionProgressLedgerFenceError('Writer fence is older than the durable active fence', {
      requestedFence: options.writerFence,
      activeFence: snapshot.activeWriterFence,
    });
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value: WriterLock = {
      schemaVersion: 'rorca.completion-progress-writer-lock.v1',
      scopeHash: options.scopeHash,
      writerFence: options.writerFence,
      ownerNonce: randomUUID(),
      pid: process.pid,
      openedAt: currentTimestamp(options.clock),
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(paths.writerLockFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      operation(options.faultHooks, 'lock_write');
      writeAll(fd, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
      operation(options.faultHooks, 'lock_fsync');
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      fsyncDirectory(paths.attemptDirectory, options.faultHooks);
      return { fd, stat, value };
    } catch (error) {
      if (fd !== undefined) {
        let owned: fs.Stats | null = null;
        try { owned = fs.fstatSync(fd); } catch { /* descriptor creation may itself have failed */ }
        try { fs.closeSync(fd); } catch { /* best effort */ }
        if (owned) {
          try {
            const current = fs.lstatSync(paths.writerLockFile);
            if (sameFile(current, owned)) fs.unlinkSync(paths.writerLockFile);
          } catch { /* a replacement writer owns any changed path */ }
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (error instanceof CompletionProgressLedgerError) throw error;
        throw new CompletionProgressLedgerIOError('Could not acquire completion ledger writer lock', {}, causeOptions(error));
      }
    }

    const existing = readWriterLock(paths.writerLockFile);
    if (existing.value.writerFence >= options.writerFence) {
      throw new CompletionProgressLedgerFenceError('Completion ledger already has an equal or newer active writer', {
        requestedFence: options.writerFence,
        activeFence: existing.value.writerFence,
      });
    }
    ensurePrivateDirectory(paths.quarantineDirectory, paths.attemptDirectory, options.faultHooks);
    const staleTarget = path.join(paths.quarantineDirectory, `writer-${existing.value.writerFence}-${existing.value.ownerNonce}.lock`);
    try {
      const current = fs.lstatSync(paths.writerLockFile);
      if (current.dev !== existing.stat.dev || current.ino !== existing.stat.ino) continue;
      operation(options.faultHooks, 'rename');
      fs.renameSync(paths.writerLockFile, staleTarget);
      fsyncDirectory(paths.attemptDirectory, options.faultHooks);
      fsyncDirectory(paths.quarantineDirectory, options.faultHooks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof CompletionProgressLedgerError) throw error;
      throw new CompletionProgressLedgerIOError('Could not roll over the stale ledger writer fence', {}, causeOptions(error));
    }
  }
  throw new CompletionProgressLedgerFenceError('Writer fence acquisition did not converge');
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactEntry(left: ProgressLedgerEntryV1, right: ProgressLedgerEntryV1): boolean {
  return governedHash('rorca.completion-progress-entry-replay-exact.v1', left as never)
    === governedHash('rorca.completion-progress-entry-replay-exact.v1', right as never);
}

function verifyEntryArray(entries: readonly ProgressLedgerEntryV1[], options: ResolvedOptions): ProgressLedgerEntryV1[] {
  if (entries.length > COMPLETION_PROGRESS_LEDGER_MAX_ENTRIES) {
    throw new CompletionProgressLedgerReplayError('Canonical receipt journal exceeds the frozen entry bound');
  }
  const verified: ProgressLedgerEntryV1[] = [];
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = ProgressLedgerEntryV1Schema.safeParse(entries[index]);
    if (!parsed.success) throw new CompletionProgressLedgerReplayError('Canonical DB receipt violates the progress-entry schema', { sequence: index });
    const entry = parsed.data;
    const entryIdentityHash = completionLedgerIdentityHash(entry.scope);
    const previous = verified[index - 1];
    const expectedPrior = index === 0 ? 'not_applicable' : previous!.entryHash;
    if (entryIdentityHash !== options.ledgerIdentityHash || entry.sequence !== index || entry.priorEntryHash !== expectedPrior
      || (previous !== undefined && entry.writerFence < previous.writerFence)
      || entry.entryHash !== verifiedProgressEntryHash(entry) || entry.contentHash !== entry.entryHash) {
      throw new CompletionProgressLedgerReplayError('Canonical DB receipt journal has an identity, sequence, fence, chain, or hash conflict', { sequence: index });
    }
    const bytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`, 'utf8');
    if (bytes > COMPLETION_PROGRESS_LEDGER_MAX_ENTRY_BYTES) {
      throw new CompletionProgressLedgerReplayError('Canonical DB receipt entry exceeds the frozen byte bound', { sequence: index });
    }
    totalBytes += bytes;
    if (totalBytes > COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES) {
      throw new CompletionProgressLedgerReplayError('Canonical DB receipt journal exceeds the frozen file bound');
    }
    verified.push(entry);
  }
  const canonicalHeadFence = verified.at(-1)?.writerFence;
  if (canonicalHeadFence !== undefined && canonicalHeadFence > options.writerFence) {
    throw new CompletionProgressLedgerFenceError('Canonical DB journal is owned by a newer writer fence', {
      requestedFence: options.writerFence,
      canonicalHeadFence,
    });
  }
  return verified;
}

function wholeAttemptQuarantine(paths: CompletionProgressLedgerPaths, options: ResolvedOptions): string {
  const runDirectory = path.dirname(paths.attemptDirectory);
  const quarantineRoot = path.join(runDirectory, '.attempt-quarantine');
  ensurePrivateDirectory(quarantineRoot, runDirectory, options.faultHooks);
  const target = path.join(quarantineRoot, `${path.basename(paths.attemptDirectory)}-${Date.parse(currentTimestamp(options.clock))}-${randomUUID()}`);
  try {
    operation(options.faultHooks, 'rename');
    fs.renameSync(paths.attemptDirectory, target);
    fsyncDirectory(runDirectory, options.faultHooks);
    fsyncDirectory(quarantineRoot, options.faultHooks);
    return target;
  } catch (error) {
    if (error instanceof CompletionProgressLedgerError) throw error;
    throw new CompletionProgressLedgerIOError('Could not quarantine corrupt completion attempt', {}, causeOptions(error));
  }
}

export class CompletionProgressLedgerWriter {
  readonly paths: CompletionProgressLedgerPaths;
  private entriesValue: ProgressLedgerEntryV1[];
  private ledgerBytes: number;
  private lock: LockOwnership;
  private closed = false;
  private poisoned = false;
  private busy = false;
  private recoveryState: CompletionProgressRecoveryState;
  private canonicalDatabaseHeadHash: string | null = null;

  private constructor(
    private readonly options: ResolvedOptions,
    paths: CompletionProgressLedgerPaths,
    lock: LockOwnership,
    reloaded: ReloadResult,
  ) {
    this.paths = paths;
    this.lock = lock;
    this.entriesValue = reloaded.entries;
    this.ledgerBytes = reloaded.ledgerBytes;
    this.recoveryState = reloaded.recoveryState;
  }

  static initialize(optionsInput: CompletionProgressLedgerOptions): CompletionProgressLedgerWriter {
    const options = resolveOptions(optionsInput);
    const { paths, attemptCreated } = ensureHierarchy(options, true);
    if (!attemptCreated) {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_ALREADY_EXISTS', 'Completion ledger attempt directory already exists');
    }
    createEmptyLedger(paths, options.faultHooks);
    const lock = acquireWriterLock(paths, options, null);
    const reloaded: ReloadResult = { entries: [], ledgerBytes: 0, suffixQuarantinePath: null, recoveryState: 'unreconciled' };
    const writer = new CompletionProgressLedgerWriter(options, paths, lock, reloaded);
    try { writer.writeSnapshot(); }
    catch (error) { writer.releaseLock(); throw error; }
    return writer;
  }

  static open(optionsInput: CompletionProgressLedgerOptions): CompletionProgressLedgerWriter {
    const options = resolveOptions(optionsInput);
    const { paths } = ensureHierarchy(options, false);
    let snapshot: CompletionProgressLedgerSnapshot | null;
    try { snapshot = readSnapshot(paths, options); }
    catch (error) {
      if (error instanceof CompletionProgressLedgerCorruptionError) {
        const quarantinePath = wholeAttemptQuarantine(paths, options);
        throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', error.message, { quarantinePath }, causeOptions(error));
      }
      throw error;
    }
    const lock = acquireWriterLock(paths, options, snapshot);
    try {
      const reloaded = reloadLedger(paths, options, snapshot, true);
      // Publish a fresh ledger inode while owning the new lock. A superseded
      // process that passed a pre-rollover check can then only write its
      // unlinked old inode; it cannot mutate the active higher-fence journal.
      const verifiedBytes = Buffer.from(reloaded.entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
      atomicWrite(paths.ledgerFile, verifiedBytes, 'ledger', options.faultHooks);
      reloaded.ledgerBytes = verifiedBytes.length;
      const writer = new CompletionProgressLedgerWriter(options, paths, lock, reloaded);
      writer.writeSnapshot();
      return writer;
    } catch (error) {
      try { fs.closeSync(lock.fd); } catch { /* best effort before quarantine */ }
      if (error instanceof CompletionProgressLedgerCorruptionError
        && error.code === 'COMPLETION_LEDGER_ATTEMPT_QUARANTINED') {
        const quarantinePath = wholeAttemptQuarantine(paths, options);
        throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', error.message, { quarantinePath }, causeOptions(error));
      }
      try {
        const current = fs.lstatSync(paths.writerLockFile);
        if (sameFile(current, lock.stat)) fs.unlinkSync(paths.writerLockFile);
      } catch { /* primary error retained */ }
      throw error;
    }
  }

  static async rebuild(
    optionsInput: CompletionProgressLedgerOptions,
    loadCanonicalReceipts: () => Promise<readonly ProgressLedgerEntryV1[]>,
  ): Promise<CompletionProgressLedgerWriter> {
    const options = resolveOptions(optionsInput);
    const { paths } = ensureHierarchy(options, true);
    let canonical: ProgressLedgerEntryV1[];
    try { canonical = verifyEntryArray(await loadCanonicalReceipts(), options); }
    catch (error) {
      if (error instanceof CompletionProgressLedgerError) throw error;
      throw new CompletionProgressLedgerIOError('Canonical DB receipts could not be loaded for ledger rebuild', {}, causeOptions(error));
    }
    try {
      fs.lstatSync(paths.ledgerFile);
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_ALREADY_EXISTS', 'Rebuild refuses to replace an existing completion ledger');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const bytes = Buffer.from(canonical.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
    atomicWrite(paths.ledgerFile, bytes, 'ledger', options.faultHooks);
    const lock = acquireWriterLock(paths, options, null);
    const writer = new CompletionProgressLedgerWriter(options, paths, lock, {
      entries: canonical,
      ledgerBytes: bytes.length,
      suffixQuarantinePath: null,
      recoveryState: 'rebuilt',
    });
    try { writer.writeSnapshot(); }
    catch (error) { writer.close(); throw error; }
    return writer;
  }

  get entries(): readonly ProgressLedgerEntryV1[] { return this.entriesValue; }
  get head(): ProgressLedgerEntryV1 | null { return this.entriesValue.at(-1) ?? null; }
  get isClosed(): boolean { return this.closed; }

  append(input: CompletionProgressAppendInput): ProgressLedgerEntryV1 {
    this.assertUsable();
    if (this.busy) throw new CompletionProgressLedgerError('COMPLETION_LEDGER_IO_FAILED', 'Completion ledger append ownership is already active');
    this.busy = true;
    try { return this.appendInternal(input, true); }
    finally { this.busy = false; }
  }

  private appendInternal(input: CompletionProgressAppendInput, snapshotAfter: boolean): ProgressLedgerEntryV1 {
    this.assertActiveFence();
    const sequence = this.entriesValue.length;
    const priorEntryHash = sequence === 0 ? 'not_applicable' as const : this.entriesValue[sequence - 1]!.entryHash;
    const material = {
      ...input,
      sequence,
      priorEntryHash,
      writerFence: this.options.writerFence,
    } as Omit<ProgressLedgerEntryV1, 'contentHash' | 'entryHash'>;
    const entryHash = completionProgressEntryHash(material as never);
    const candidate = { ...material, contentHash: entryHash, entryHash };
    const parsed = ProgressLedgerEntryV1Schema.safeParse(candidate);
    if (!parsed.success) {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_REPLAY_CONFLICT', 'Progress entry violates its strict frozen contract', {
        issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
      });
    }
    const entry = parsed.data;
    if (governedHash('rorca.continuation-scope.v1', entry.scope as never) !== this.options.scopeHash) {
      throw new CompletionProgressLedgerReplayError('Progress entry does not bind the active writer exact scope');
    }
    if (this.head && entry.writerFence < this.head.writerFence) {
      throw new CompletionProgressLedgerFenceError('Progress entry regresses the durable writer fence');
    }
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    if (line.length > COMPLETION_PROGRESS_LEDGER_MAX_ENTRY_BYTES
      || this.ledgerBytes + line.length > COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES
      || sequence >= COMPLETION_PROGRESS_LEDGER_MAX_ENTRIES) {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_BOUNDS_EXCEEDED', 'Progress ledger append exceeds a frozen bound', { sequence });
    }
    this.appendBytes(line);
    this.entriesValue.push(entry);
    this.ledgerBytes += line.length;
    if (snapshotAfter) this.writeSnapshot();
    return entry;
  }

  private appendBytes(bytes: Buffer): void {
    let fd: number | undefined;
    try {
      const before = fs.lstatSync(this.paths.ledgerFile);
      assertOwnedMode(before, 'file', this.paths.ledgerFile);
      fd = fs.openSync(this.paths.ledgerFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameFile(before, opened) || opened.size !== this.ledgerBytes) {
        throw new CompletionProgressLedgerFenceError('Ledger identity or size changed outside the serial writer');
      }
      this.assertActiveFence();
      operation(this.options.faultHooks, 'ledger_write');
      writeAll(fd, bytes);
      operation(this.options.faultHooks, 'ledger_fsync');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(this.paths.attemptDirectory, this.options.faultHooks);
    } catch (error) {
      this.poisoned = true;
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* primary write failure retained */ }
      }
      if (error instanceof CompletionProgressLedgerError) throw error;
      throw new CompletionProgressLedgerIOError('Progress ledger append failed before durable acknowledgement', {}, causeOptions(error));
    }
  }

  private appendCanonicalSuffix(entries: readonly ProgressLedgerEntryV1[]): void {
    if (entries.length === 0) return;
    this.assertActiveFence();
    const bytes = Buffer.from(entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
    if (bytes.length + this.ledgerBytes > COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES) {
      throw new CompletionProgressLedgerError('COMPLETION_LEDGER_BOUNDS_EXCEEDED', 'Canonical recovery suffix exceeds the ledger file bound');
    }
    this.appendBytes(bytes);
    this.entriesValue.push(...entries);
    this.ledgerBytes += bytes.length;
  }

  writeSnapshot(): CompletionProgressLedgerSnapshot {
    this.assertUsable();
    this.assertActiveFence();
    const snapshot = createSnapshot({
      options: this.options,
      entries: this.entriesValue,
      ledgerBytes: this.ledgerBytes,
      recoveryState: this.recoveryState,
      canonicalDatabaseHeadHash: this.canonicalDatabaseHeadHash,
    });
    try { writeSnapshotFile(this.paths, snapshot, this.options.faultHooks); }
    catch (error) { this.poisoned = true; throw error; }
    return snapshot;
  }

  reload(): CompletionProgressVerification {
    this.assertUsable();
    this.assertActiveFence();
    const snapshot = readSnapshot(this.paths, this.options);
    const reloaded = reloadLedger(this.paths, this.options, snapshot, true);
    this.entriesValue = reloaded.entries;
    this.ledgerBytes = reloaded.ledgerBytes;
    this.recoveryState = reloaded.recoveryState;
    const written = this.writeSnapshot();
    return { entries: this.entriesValue, snapshot: written, suffixQuarantinePath: reloaded.suffixQuarantinePath };
  }

  async reconcile(callbacks: CompletionProgressReplayCallbacks): Promise<CompletionProgressReconciliationResult> {
    this.assertUsable();
    if (this.busy) throw new CompletionProgressLedgerError('COMPLETION_LEDGER_IO_FAILED', 'Completion ledger serial ownership is already active');
    this.busy = true;
    try {
      this.assertActiveFence();
      let canonical: ProgressLedgerEntryV1[];
      try { canonical = verifyEntryArray(await callbacks.loadCanonicalReceipts(), this.options); }
      catch (error) {
        if (error instanceof CompletionProgressLedgerReplayError) return this.quarantineReplayConflict(error.message, error);
        if (error instanceof CompletionProgressLedgerFenceError) throw error;
        throw new CompletionProgressLedgerIOError('Canonical DB receipt reload failed', {}, causeOptions(error));
      }
      const shared = Math.min(this.entriesValue.length, canonical.length);
      for (let index = 0; index < shared; index += 1) {
        if (!exactEntry(this.entriesValue[index]!, canonical[index]!)) {
          return this.quarantineReplayConflict('Ledger and canonical DB receipts diverge', undefined, index);
        }
      }

      if (canonical.length === this.entriesValue.length) {
        this.recoveryState = 'exact';
        this.canonicalDatabaseHeadHash = canonical.at(-1)?.entryHash ?? null;
        this.writeSnapshot();
        return {
          state: 'exact',
          ledgerHead: this.head,
          canonicalDatabaseHead: canonical.at(-1) ?? null,
          replayedEntries: 0,
          recoveredEntries: 0,
          recoveryMarker: null,
        };
      }

      if (canonical.length > this.entriesValue.length) {
        const localHead = this.head;
        const suffix = canonical.slice(this.entriesValue.length);
        this.appendCanonicalSuffix(suffix);
        const markerInput = await callbacks.createDatabaseAheadMarker({
          localHead,
          canonicalHead: canonical.at(-1)!,
          recoveredEntries: suffix,
        });
        if (markerInput.entryType !== 'recovery_recorded') {
          return this.quarantineReplayConflict('DB-ahead recovery callback did not produce a recovery_recorded marker');
        }
        const marker = this.appendInternal(markerInput, false);
        let mirrored: ProgressLedgerEntryV1;
        try { mirrored = ProgressLedgerEntryV1Schema.parse(await callbacks.replayLedgerEntry(marker)); }
        catch (error) {
          this.poisoned = true;
          throw new CompletionProgressLedgerIOError('DB-ahead recovery marker replay failed', {}, causeOptions(error));
        }
        if (!exactEntry(marker, mirrored)) {
          return this.quarantineReplayConflict('DB-ahead recovery marker changed during canonical replay');
        }
        this.recoveryState = 'database_ahead';
        this.canonicalDatabaseHeadHash = marker.entryHash;
        this.writeSnapshot();
        return {
          state: 'database_ahead',
          ledgerHead: marker,
          canonicalDatabaseHead: mirrored,
          replayedEntries: 1,
          recoveredEntries: suffix.length,
          recoveryMarker: marker,
        };
      }

      const suffix = this.entriesValue.slice(canonical.length);
      for (const entry of suffix) {
        let mirrored: ProgressLedgerEntryV1;
        try { mirrored = ProgressLedgerEntryV1Schema.parse(await callbacks.replayLedgerEntry(entry)); }
        catch (error) {
          this.poisoned = true;
          throw new CompletionProgressLedgerIOError('Ledger-ahead canonical replay failed', { sequence: entry.sequence }, causeOptions(error));
        }
        if (!exactEntry(entry, mirrored)) {
          return this.quarantineReplayConflict('Ledger entry changed during canonical DB replay', undefined, entry.sequence);
        }
      }
      this.recoveryState = 'ledger_ahead_replayed';
      this.canonicalDatabaseHeadHash = this.head?.entryHash ?? null;
      this.writeSnapshot();
      return {
        state: 'ledger_ahead_replayed',
        ledgerHead: this.head,
        canonicalDatabaseHead: this.head,
        replayedEntries: suffix.length,
        recoveredEntries: 0,
        recoveryMarker: null,
      };
    } finally {
      this.busy = false;
    }
  }

  private quarantineReplayConflict(message: string, cause?: unknown, sequence?: number): never {
    this.releaseLock();
    const quarantinePath = wholeAttemptQuarantine(this.paths, this.options);
    this.closed = true;
    throw new CompletionProgressLedgerReplayError(message, { quarantinePath, sequence }, causeOptions(cause));
  }

  private assertUsable(): void {
    if (this.closed) throw new CompletionProgressLedgerError('COMPLETION_LEDGER_CLOSED', 'Completion ledger writer is closed');
    if (this.poisoned) throw new CompletionProgressLedgerIOError('Completion ledger writer is poisoned after an uncertain I/O result; reopen and reconcile');
  }

  private assertActiveFence(): void {
    let current: fs.Stats;
    try { current = fs.lstatSync(this.paths.writerLockFile); }
    catch { throw new CompletionProgressLedgerFenceError('Completion ledger writer lock is no longer active'); }
    if (!sameFile(current, this.lock.stat)) {
      throw new CompletionProgressLedgerFenceError('Completion ledger writer was replaced by a newer fence');
    }
    const opened = fs.fstatSync(this.lock.fd);
    if (!sameFile(opened, this.lock.stat)) {
      throw new CompletionProgressLedgerFenceError('Completion ledger writer descriptor identity changed');
    }
  }

  private releaseLock(): void {
    if (this.closed) return;
    try {
      const current = fs.lstatSync(this.paths.writerLockFile);
      if (sameFile(current, this.lock.stat)) {
        fs.unlinkSync(this.paths.writerLockFile);
        fsyncDirectory(this.paths.attemptDirectory, this.options.faultHooks);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof CompletionProgressLedgerError)) {
        throw new CompletionProgressLedgerIOError('Could not release completion ledger writer lock', {}, causeOptions(error));
      }
      if (error instanceof CompletionProgressLedgerError) throw error;
    } finally {
      try { fs.closeSync(this.lock.fd); } catch { /* close is idempotent at the API boundary */ }
    }
  }

  close(): void {
    if (this.closed) return;
    this.releaseLock();
    this.closed = true;
  }
}

export function initializeCompletionProgressLedger(options: CompletionProgressLedgerOptions): CompletionProgressLedgerWriter {
  return CompletionProgressLedgerWriter.initialize(options);
}

export function openCompletionProgressLedger(options: CompletionProgressLedgerOptions): CompletionProgressLedgerWriter {
  return CompletionProgressLedgerWriter.open(options);
}

export function verifyCompletionLedger(optionsInput: CompletionProgressLedgerOptions): CompletionProgressVerification {
  const options = resolveOptions(optionsInput);
  const { paths } = ensureHierarchy(options, false);
  try {
    try {
      fs.lstatSync(paths.writerLockFile);
      throw new CompletionProgressLedgerFenceError('Cannot verify/repair a completion ledger with an active writer');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const snapshot = readSnapshot(paths, options);
    const reloaded = reloadLedger(paths, options, snapshot, true);
    const written = createSnapshot({
      options,
      entries: reloaded.entries,
      ledgerBytes: reloaded.ledgerBytes,
      recoveryState: reloaded.recoveryState,
    });
    writeSnapshotFile(paths, written, options.faultHooks);
    return { entries: reloaded.entries, snapshot: written, suffixQuarantinePath: reloaded.suffixQuarantinePath };
  } catch (error) {
    if (error instanceof CompletionProgressLedgerCorruptionError
      && error.code === 'COMPLETION_LEDGER_ATTEMPT_QUARANTINED') {
      const quarantinePath = wholeAttemptQuarantine(paths, options);
      throw new CompletionProgressLedgerCorruptionError('COMPLETION_LEDGER_ATTEMPT_QUARANTINED', error.message, { quarantinePath }, causeOptions(error));
    }
    throw error;
  }
}

export async function reconcileCompletionLedger(
  writer: CompletionProgressLedgerWriter,
  callbacks: CompletionProgressReplayCallbacks,
): Promise<CompletionProgressReconciliationResult> {
  return writer.reconcile(callbacks);
}

export async function rebuildCompletionLedger(
  optionsInput: CompletionProgressLedgerOptions,
  loadCanonicalReceipts: () => Promise<readonly ProgressLedgerEntryV1[]>,
): Promise<CompletionProgressLedgerWriter> {
  return CompletionProgressLedgerWriter.rebuild(optionsInput, loadCanonicalReceipts);
}
