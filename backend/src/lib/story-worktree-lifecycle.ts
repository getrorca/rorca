/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OWNERSHIP_VERSION = 'rorca.story-worktree-ownership.v1' as const;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const ZERO_OID = '0000000000000000000000000000000000000000';
const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?|secrets?)(?:$|\/)|\.(?:pem|p12|pfx|key)$/i;
const SECRET_CONTENT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]{8,})/i;

export interface StoryWorktreeOwnershipInput {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  runId: number;
  waveIndex: number;
  storyId: string;
  attempt: number;
  baseRevision: string;
  qualificationNamespace: string;
}

export interface StoryWorktreeOwnership {
  version: typeof OWNERSHIP_VERSION;
  ownershipId: string;
  runId: number;
  waveIndex: number;
  storyId: string;
  attempt: number;
  baseRevision: string;
  repositoryCommonDirectory: string;
  qualificationNamespace: string;
  worktreeRealpath: string;
  branchName: string;
  metadataPath: string;
  createdAt: string;
}

export interface CleanupOwnedWorktreeInput {
  repositoryPath: string;
  ownership: StoryWorktreeOwnership;
  currentWaveAllowlist: ReadonlySet<string>;
  expectedBaseRevision: string;
  preserve: boolean;
  outcome: 'integrated' | 'rejected';
}

export interface OwnedWorktreeCleanupResult {
  ok: boolean;
  removed: boolean;
  preserved: boolean;
  alreadyCleaned: boolean;
  recoveryRef?: string;
  snapshotPath?: string;
  diagnostics: string[];
}

interface RecoverySnapshotEntry {
  path: string;
  status: string;
  mode: number | null;
  indexBase64: string | null;
  workingTreeBase64: string | null;
}

function git(cwd: string, args: string[], encoding: BufferEncoding | null = 'utf8'): string | Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: encoding ?? undefined,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
}

function gitText(cwd: string, args: string[]): string {
  return (git(cwd, args, 'utf8') as string).trim();
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

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function safeToken(value: string, label: string): string {
  const token = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!token) throw new Error(`${label} has no safe identifier characters`);
  return token;
}

function commonDirectory(repositoryPath: string): string {
  const raw = gitText(repositoryPath, ['rev-parse', '--git-common-dir']);
  return fs.realpathSync(path.resolve(repositoryPath, raw));
}

function metadataDirectory(commonDir: string): string {
  return path.join(commonDir, 'rorca', 'story-worktree-ownership');
}

function boundedDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:[A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s]+/g, '[redacted-url]')
    .replace(/(?:token|password|secret|key)=\S+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 512);
}

function writeExclusive(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readOwnership(ownership: StoryWorktreeOwnership): StoryWorktreeOwnership {
  const parsed = JSON.parse(fs.readFileSync(ownership.metadataPath, 'utf8')) as StoryWorktreeOwnership;
  if (canonicalJson(parsed) !== canonicalJson(ownership)) throw new Error('ownership metadata does not match the allowlisted record');
  return parsed;
}

function worktreeRegistration(repositoryPath: string, expectedPath: string): { branch: string; head: string } | null {
  const records = gitText(repositoryPath, ['worktree', 'list', '--porcelain']).split(/\n\n+/);
  for (const record of records) {
    const fields = record.split('\n');
    const worktree = fields.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!worktree) continue;
    let real: string;
    try { real = fs.realpathSync(worktree); } catch { continue; }
    if (real !== expectedPath) continue;
    return {
      branch: (fields.find(line => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? ''),
      head: fields.find(line => line.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
    };
  }
  return null;
}

export function createOwnedStoryWorktree(input: StoryWorktreeOwnershipInput): StoryWorktreeOwnership {
  const repositoryPath = fs.realpathSync(input.repositoryPath);
  const repositoryCommonDirectory = commonDirectory(repositoryPath);
  const baseRevision = gitText(repositoryPath, ['rev-parse', '--verify', `${input.baseRevision}^{commit}`]);
  const worktreePath = path.resolve(input.worktreePath);
  const branchRef = `refs/heads/${input.branchName}`;
  gitText(repositoryPath, ['check-ref-format', branchRef]);
  if (fs.existsSync(worktreePath)) throw new Error('owned worktree path already exists');
  try {
    gitText(repositoryPath, ['show-ref', '--verify', branchRef]);
    throw new Error('owned temporary branch already exists');
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'owned temporary branch already exists') throw error;
  }

  const identity = {
    version: OWNERSHIP_VERSION,
    runId: input.runId,
    waveIndex: input.waveIndex,
    storyId: input.storyId,
    attempt: input.attempt,
    baseRevision,
    repositoryCommonDirectory,
    qualificationNamespace: input.qualificationNamespace,
    worktreePath,
    branchName: input.branchName,
  };
  const ownershipId = digest(identity);
  const metadataPath = path.join(metadataDirectory(repositoryCommonDirectory), `${ownershipId}.json`);

  try {
    git(repositoryPath, ['worktree', 'add', '-b', input.branchName, worktreePath, baseRevision]);
    const worktreeRealpath = fs.realpathSync(worktreePath);
    const registration = worktreeRegistration(repositoryPath, worktreeRealpath);
    if (!registration || registration.branch !== input.branchName || registration.head !== baseRevision) {
      throw new Error('created worktree registration does not match requested branch and base');
    }
    if (commonDirectory(worktreeRealpath) !== repositoryCommonDirectory) {
      throw new Error('created worktree belongs to another repository common directory');
    }

    const ownership: StoryWorktreeOwnership = {
      version: OWNERSHIP_VERSION,
      ownershipId,
      runId: input.runId,
      waveIndex: input.waveIndex,
      storyId: input.storyId,
      attempt: input.attempt,
      baseRevision,
      repositoryCommonDirectory,
      qualificationNamespace: input.qualificationNamespace,
      worktreeRealpath,
      branchName: input.branchName,
      metadataPath,
      createdAt: new Date().toISOString(),
    };
    writeExclusive(metadataPath, `${canonicalJson(ownership)}\n`);
    verifyOwnedStoryWorktree(repositoryPath, ownership, new Set([ownershipId]), baseRevision);
    return ownership;
  } catch (error) {
    try { git(repositoryPath, ['worktree', 'remove', '--force', worktreePath]); } catch { /* best effort for this just-created path */ }
    try { git(repositoryPath, ['update-ref', '-d', branchRef]); } catch { /* best effort for this just-created ref */ }
    throw error;
  }
}

export function verifyOwnedStoryWorktree(
  repositoryPath: string,
  ownership: StoryWorktreeOwnership,
  currentWaveAllowlist: ReadonlySet<string>,
  expectedBaseRevision: string,
): void {
  if (!currentWaveAllowlist.has(ownership.ownershipId)) throw new Error('worktree is not allowlisted for the current wave');
  readOwnership(ownership);
  const repositoryCommonDirectory = commonDirectory(repositoryPath);
  if (repositoryCommonDirectory !== ownership.repositoryCommonDirectory) throw new Error('repository common directory mismatch');
  const expectedBase = gitText(repositoryPath, ['rev-parse', '--verify', `${expectedBaseRevision}^{commit}`]);
  if (expectedBase !== ownership.baseRevision) throw new Error('expected base revision mismatch');
  const realpath = fs.realpathSync(ownership.worktreeRealpath);
  if (realpath !== ownership.worktreeRealpath) throw new Error('worktree realpath mismatch');
  if (commonDirectory(realpath) !== ownership.repositoryCommonDirectory) throw new Error('worktree repository identity mismatch');
  const registration = worktreeRegistration(repositoryPath, realpath);
  if (!registration || registration.branch !== ownership.branchName) throw new Error('worktree branch registration mismatch');
  git(repositoryPath, ['merge-base', '--is-ancestor', ownership.baseRevision, registration.head]);
}

function statusEntries(worktreePath: string): Array<{ status: string; relativePath: string }> {
  const output = git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'utf8') as string;
  const chunks = output.split('\0').filter(Boolean);
  const entries: Array<{ status: string; relativePath: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const status = chunk.slice(0, 2);
    if (/[RC]/.test(status)) throw new Error('rename/copy state cannot be captured losslessly');
    const relativePath = chunk.slice(3);
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
      throw new Error('unsafe status path');
    }
    entries.push({ status, relativePath });
  }
  return entries;
}

function readIndex(worktreePath: string, relativePath: string): Buffer | null {
  try { return git(worktreePath, ['show', `:${relativePath}`], null) as Buffer; } catch { return null; }
}

function createSafeSnapshot(ownership: StoryWorktreeOwnership): { path: string; digest: string } | null {
  const entries = statusEntries(ownership.worktreeRealpath);
  if (entries.length === 0) return null;
  let totalBytes = 0;
  const snapshotEntries: RecoverySnapshotEntry[] = [];
  for (const entry of entries) {
    if (SECRET_PATH.test(entry.relativePath)) throw new Error('secret-bearing path requires worktree preservation');
    const absolutePath = path.join(ownership.worktreeRealpath, entry.relativePath);
    let working: Buffer | null = null;
    let mode: number | null = null;
    if (fs.existsSync(absolutePath)) {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile()) throw new Error('non-regular worktree entry requires preservation');
      mode = stat.mode & 0o777;
      working = fs.readFileSync(absolutePath);
    }
    const index = readIndex(ownership.worktreeRealpath, entry.relativePath);
    for (const content of [working, index]) {
      if (!content) continue;
      totalBytes += content.length;
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error('recovery snapshot exceeds safe size bound');
      if (SECRET_CONTENT.test(content.toString('utf8'))) throw new Error('secret-bearing content requires worktree preservation');
    }
    snapshotEntries.push({
      path: entry.relativePath,
      status: entry.status,
      mode,
      indexBase64: index?.toString('base64') ?? null,
      workingTreeBase64: working?.toString('base64') ?? null,
    });
  }
  const body = canonicalJson({
    version: 'rorca.safe-recovery-snapshot.v1',
    ownershipId: ownership.ownershipId,
    baseRevision: ownership.baseRevision,
    entries: snapshotEntries,
  });
  const snapshotDigest = createHash('sha256').update(body).digest('hex');
  const snapshotPath = path.join(ownership.repositoryCommonDirectory, 'rorca', 'recovery-snapshots', `${snapshotDigest}.json`);
  try { writeExclusive(snapshotPath, `${body}\n`); } catch (error: unknown) {
    if (!fs.existsSync(snapshotPath) || fs.readFileSync(snapshotPath, 'utf8') !== `${body}\n`) throw error;
  }
  return { path: snapshotPath, digest: snapshotDigest };
}

function createRecoveryRef(
  repositoryPath: string,
  ownership: StoryWorktreeOwnership,
  head: string,
  snapshotDigest: string | null,
): string {
  const artifactDigest = digest({ ownershipId: ownership.ownershipId, head, snapshotDigest }).slice(0, 20);
  const ref = `refs/heads/rorca/recovery/run-${ownership.runId}/wave-${ownership.waveIndex}/${safeToken(ownership.storyId, 'storyId')}/attempt-${ownership.attempt}/${artifactDigest}`;
  try {
    git(repositoryPath, ['update-ref', ref, head, ZERO_OID]);
  } catch (error) {
    let existing = '';
    try { existing = gitText(repositoryPath, ['rev-parse', '--verify', ref]); } catch { /* absent */ }
    if (existing !== head) throw error;
  }
  return ref;
}

export function cleanupOwnedStoryWorktree(input: CleanupOwnedWorktreeInput): OwnedWorktreeCleanupResult {
  const diagnostics: string[] = [];
  const receiptPath = `${input.ownership.metadataPath}.cleanup.json`;
  if (input.preserve) {
    return { ok: true, removed: false, preserved: true, alreadyCleaned: false, diagnostics: ['preserve decision overrides cleanup'] };
  }
  if (fs.existsSync(receiptPath) && !fs.existsSync(input.ownership.worktreeRealpath)) {
    return { ok: true, removed: false, preserved: false, alreadyCleaned: true, diagnostics: ['owned worktree was already cleaned'] };
  }

  let recoveryRef: string | undefined;
  let snapshotPath: string | undefined;
  try {
    verifyOwnedStoryWorktree(input.repositoryPath, input.ownership, input.currentWaveAllowlist, input.expectedBaseRevision);
    const branchRef = `refs/heads/${input.ownership.branchName}`;
    const branchHead = gitText(input.repositoryPath, ['rev-parse', '--verify', branchRef]);
    let snapshotDigest: string | null = null;

    if (input.outcome === 'rejected') {
      try {
        const snapshot = createSafeSnapshot(input.ownership);
        snapshotPath = snapshot?.path;
        snapshotDigest = snapshot?.digest ?? null;
      } catch (error) {
        diagnostics.push(boundedDiagnostic(error));
        return { ok: false, removed: false, preserved: true, alreadyCleaned: false, diagnostics };
      }
      if (branchHead !== input.ownership.baseRevision || snapshotDigest) {
        recoveryRef = createRecoveryRef(input.repositoryPath, input.ownership, branchHead, snapshotDigest);
      }
    } else {
      const dirty = statusEntries(input.ownership.worktreeRealpath);
      if (dirty.length > 0) throw new Error('integrated worktree became dirty before cleanup');
    }

    git(input.repositoryPath, ['worktree', 'remove', '--force', input.ownership.worktreeRealpath]);
    try {
      git(input.repositoryPath, ['update-ref', '-d', branchRef, branchHead]);
    } catch (error) {
      // Never delete a branch that changed after verification/removal.
      throw new Error(`temporary branch changed during cleanup: ${boundedDiagnostic(error)}`);
    }
    const receipt = canonicalJson({
      version: 'rorca.story-worktree-cleanup.v1',
      ownershipId: input.ownership.ownershipId,
      branchHead,
      outcome: input.outcome,
      recoveryRef: recoveryRef ?? null,
      snapshotPath: snapshotPath ?? null,
    });
    try { writeExclusive(receiptPath, `${receipt}\n`); } catch (error: unknown) {
      if (!fs.existsSync(receiptPath) || fs.readFileSync(receiptPath, 'utf8') !== `${receipt}\n`) throw error;
    }
    return { ok: true, removed: true, preserved: false, alreadyCleaned: false, recoveryRef, snapshotPath, diagnostics };
  } catch (error) {
    diagnostics.push(boundedDiagnostic(error));
    return { ok: false, removed: false, preserved: true, alreadyCleaned: false, recoveryRef, snapshotPath, diagnostics };
  }
}

export function assertSingletonRunWorktree(
  runWorktreePath: string,
  requirement: { enabled: boolean; path: string | null; guardedWorkingDirectory: string },
): void {
  const runRealpath = fs.realpathSync(runWorktreePath);
  const canonicalPath = (candidate: string): string => {
    const resolved = path.resolve(candidate);
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  };
  const guardedPath = canonicalPath(requirement.guardedWorkingDirectory);
  if (guardedPath !== runRealpath) throw new Error('singleton wave manifest requires another guarded working directory');
  if (requirement.enabled && (!requirement.path || canonicalPath(requirement.path) !== runRealpath)) {
    throw new Error('singleton wave manifest requires another worktree');
  }
}

export function assertExpectedParentHead(repositoryPath: string, expectedParentHead: string): void {
  const expected = gitText(repositoryPath, ['rev-parse', '--verify', `${expectedParentHead}^{commit}`]);
  const actual = gitText(repositoryPath, ['rev-parse', '--verify', 'HEAD']);
  if (actual !== expected) throw new Error(`run branch advanced concurrently (expected ${expected.slice(0, 12)}, observed ${actual.slice(0, 12)})`);
}

/**
 * Materialize the already-validated merge index and advance the checked-out run
 * branch with an explicit old-OID compare-and-swap. A concurrent ref advance
 * leaves only an unreachable candidate commit; it never receives this story.
 */
export function commitGuardedMerge(
  repositoryPath: string,
  message: string,
  expectedParentHead: string,
): string {
  assertExpectedParentHead(repositoryPath, expectedParentHead);
  const branchRef = gitText(repositoryPath, ['symbolic-ref', '-q', 'HEAD']);
  if (!branchRef.startsWith('refs/heads/')) throw new Error('guarded integration requires a checked-out branch');
  const mergeHeads = gitText(repositoryPath, ['rev-parse', '--verify', 'MERGE_HEAD']).split('\n').filter(Boolean);
  if (mergeHeads.length === 0) throw new Error('guarded integration requires an active merge');
  const tree = gitText(repositoryPath, ['write-tree']);
  const args = ['commit-tree', tree, '-p', expectedParentHead];
  for (const mergeHead of mergeHeads) args.push('-p', mergeHead);
  const commit = execFileSync('git', args, {
    cwd: repositoryPath,
    env: process.env,
    input: `${message}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  // This is the integration linearization point. Never retry with a new old OID.
  git(repositoryPath, ['update-ref', branchRef, commit, expectedParentHead]);
  git(repositoryPath, ['read-tree', '--reset', '-u', commit]);
  for (const stateName of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE']) {
    try {
      const statePath = gitText(repositoryPath, ['rev-parse', '--git-path', stateName]);
      fs.rmSync(path.resolve(repositoryPath, statePath), { force: true });
    } catch { /* absent state file */ }
  }
  const observed = gitText(repositoryPath, ['rev-parse', '--verify', branchRef]);
  if (observed !== commit) throw new Error('run branch advanced again immediately after guarded integration');
  return commit;
}
