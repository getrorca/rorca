/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Run-private Git control state for model processes and the trusted host reconciliation seam. */

import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  observeExactProcessInstance,
  requireCurrentProcessStartIdentity,
} from './process-instance-identity';

export const AUTONOMOUS_GIT_STATE_ROOT_ENV = 'RORCA_AUTONOMOUS_GIT_STATE_ROOT';
export const AUTONOMOUS_GIT_VIEW_ENV = 'RORCA_AUTONOMOUS_GIT_VIEW';
const STATE_PREFIX = 'rorca-autonomous-git-state-';
const STATE_SCHEMA_VERSION = 3 as const;
const PRIVATE_REF = 'refs/heads/rorca-run-private';
const MAX_GIT_ALIAS_INVENTORY_ENTRIES = 500_000;
const MAX_GIT_ALTERNATE_OBJECT_DIRECTORIES = 256;
const MAX_GIT_ALTERNATES_FILE_BYTES = 1024 * 1024;
const PROCESS_START_IDENTITY = requireCurrentProcessStartIdentity();
const PROCESS_INSTANCE_NONCE = crypto.randomBytes(32).toString('hex');
const activeRoots = new Map<string, string>();
let exitCleanupRegistered = false;

export interface AutonomousGitStateManifest {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  runId: number;
  ownerPid: number;
  ownerProcessStartIdentity: string;
  ownerInstanceNonce: string;
  worktreePath: string;
  branchName: string;
  objectFormat: 'sha1' | 'sha256';
  initialHead: string;
  sharedGitDir: string;
  sharedCommonDir: string;
  /** Primary object database retained for the private view's first alternate. */
  sharedObjectsDir: string;
  /** Primary plus every resolved local objects/info/alternates chain root. */
  sharedObjectDirs: string[];
}

export interface AutonomousGitView {
  stateRoot: string;
  gitDir: string;
  worktreePath: string;
  sharedGitDir: string;
  sharedCommonDir: string;
  sharedObjectsDir: string;
  sharedObjectDirs: string[];
  baseHead: string;
}

function realTemporaryRoot(): string {
  return fs.realpathSync(os.tmpdir());
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  }).trim();
}

function repositoryPath(cwd: string, flag: '--absolute-git-dir' | '--git-common-dir'): string {
  const value = runGit(cwd, ['rev-parse', flag]);
  return fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function readBoundedAlternatesFile(alternatesPath: string): string | null {
  let fd: number;
  try {
    const pathStat = fs.lstatSync(alternatesPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('Autonomous Git alternates list must be a non-symbolic regular file');
    }
    fd = fs.openSync(alternatesPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_GIT_ALTERNATES_FILE_BYTES) {
      throw new Error('Autonomous Git alternates list is not a bounded regular file');
    }
    const buffer = Buffer.alloc(MAX_GIT_ALTERNATES_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_GIT_ALTERNATES_FILE_BYTES) {
      throw new Error('Autonomous Git alternates list exceeded its bounded byte budget');
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(alternatesPath);
    if (current.isSymbolicLink() || !current.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== current.dev || after.ino !== current.ino
      || before.size !== after.size || after.size !== bytesRead
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Autonomous Git alternates list changed during preflight');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function discoverReachableObjectDirectories(primaryObjectsDir: string): string[] {
  const primary = fs.realpathSync(primaryObjectsDir);
  if (!fs.statSync(primary).isDirectory()) throw new Error('Autonomous Git primary object database is not a directory');
  const discovered: string[] = [];
  const seen = new Set<string>();
  const pending = [primary];

  while (pending.length > 0) {
    const objectDir = pending.shift()!;
    if (seen.has(objectDir)) continue;
    seen.add(objectDir);
    discovered.push(objectDir);
    if (discovered.length > MAX_GIT_ALTERNATE_OBJECT_DIRECTORIES) {
      throw new Error('Autonomous Git alternate object chain exceeded its bounded directory budget');
    }

    const alternatesPath = path.join(objectDir, 'info', 'alternates');
    const content = readBoundedAlternatesFile(alternatesPath);
    if (content === null) continue;
    if (content.includes('\0')) throw new Error('Autonomous Git alternates list contains a NUL byte');
    for (const rawLine of content.split('\n')) {
      const alternate = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!alternate) continue;
      const candidate = path.isAbsolute(alternate)
        ? path.resolve(alternate)
        : path.resolve(objectDir, alternate);
      let resolved: string;
      try {
        resolved = fs.realpathSync(candidate);
      } catch (error) {
        throw new Error(`Autonomous Git alternate object database is unavailable: ${candidate}`, { cause: error });
      }
      if (candidate !== resolved) {
        throw new Error(`Autonomous Git alternate object database must not traverse symbolic paths: ${candidate}`);
      }
      if (!fs.statSync(resolved).isDirectory()) {
        throw new Error(`Autonomous Git alternate object database is not a directory: ${resolved}`);
      }
      if (!seen.has(resolved) && !pending.includes(resolved)) {
        if (seen.size + pending.length >= MAX_GIT_ALTERNATE_OBJECT_DIRECTORIES) {
          throw new Error('Autonomous Git alternate object chain exceeded its bounded directory budget');
        }
        pending.push(resolved);
      }
    }
  }
  return discovered;
}

/** Resolve the complete local object graph Git can reach from this repository. */
export function resolveReachableLocalGitObjectDirectories(cwd: string): string[] {
  const worktree = fs.realpathSync(cwd);
  const commonDir = repositoryPath(worktree, '--git-common-dir');
  return discoverReachableObjectDirectories(path.join(commonDir, 'objects'));
}

/** Fail if an alternates graph changed while a sandbox policy was assembled. */
export function assertReachableLocalGitObjectDirectoriesUnchanged(
  cwd: string,
  expected: readonly string[],
): void {
  const current = resolveReachableLocalGitObjectDirectories(cwd);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('Autonomous Git shared object topology changed during sandbox preflight');
  }
}

function assertPrivateDirectory(directory: string, parent: string, label: string): string {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== parent) throw new Error(`${label} escaped its worker-owned parent`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symbolic directory`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must remain private`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} has an unexpected owner`);
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error(`${label} changed identity`);
  return real;
}

function assertStateRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('Autonomous Git state root must be absolute');
  const temporaryRoot = realTemporaryRoot();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(STATE_PREFIX)) {
    throw new Error('Autonomous Git state root is outside the trusted temporary namespace');
  }
  return assertPrivateDirectory(resolved, temporaryRoot, 'Autonomous Git state root');
}

function readPrivateManifestRecord(root: string): Record<string, unknown> {
  const stateRoot = assertStateRoot(root);
  const manifestPath = path.join(stateRoot, 'manifest.json');
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error('Autonomous Git state manifest is not a private regular file');
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Autonomous Git state manifest is invalid');
  }
  return parsed as Record<string, unknown>;
}

function readManifest(root: string): AutonomousGitStateManifest {
  const manifest = readPrivateManifestRecord(root) as Partial<AutonomousGitStateManifest>;
  if (
    manifest.schemaVersion !== STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(manifest.runId) || Number(manifest.runId) <= 0
    || !Number.isSafeInteger(manifest.ownerPid) || Number(manifest.ownerPid) <= 0
    || typeof manifest.ownerProcessStartIdentity !== 'string'
    || !/^(?:linux-proc-start:\d+|darwin-ps-lstart:.+)$/.test(manifest.ownerProcessStartIdentity)
    || typeof manifest.ownerInstanceNonce !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.ownerInstanceNonce)
    || typeof manifest.worktreePath !== 'string'
    || typeof manifest.branchName !== 'string' || !manifest.branchName
    || !['sha1', 'sha256'].includes(manifest.objectFormat ?? '')
    || typeof manifest.initialHead !== 'string'
    || !new RegExp(`^[a-f0-9]{${manifest.objectFormat === 'sha256' ? 64 : 40}}$`).test(manifest.initialHead)
    || typeof manifest.sharedGitDir !== 'string'
    || typeof manifest.sharedCommonDir !== 'string'
    || typeof manifest.sharedObjectsDir !== 'string'
    || !Array.isArray(manifest.sharedObjectDirs)
    || manifest.sharedObjectDirs.length < 1
    || manifest.sharedObjectDirs.length > MAX_GIT_ALTERNATE_OBJECT_DIRECTORIES
    || manifest.sharedObjectDirs.some(value => typeof value !== 'string'
      || !path.isAbsolute(value) || path.resolve(value) !== value)
    || new Set(manifest.sharedObjectDirs).size !== manifest.sharedObjectDirs.length
    || manifest.sharedObjectDirs[0] !== manifest.sharedObjectsDir
  ) throw new Error('Autonomous Git state manifest is invalid');
  return manifest as AutonomousGitStateManifest;
}

/** Preserve exact stale-root recovery across the schema-2 -> schema-3 upgrade. */
function readManifestOwnerForSweep(root: string): {
  ownerPid: number;
  ownerProcessStartIdentity: string;
} {
  const record = readPrivateManifestRecord(root);
  if (record.schemaVersion === STATE_SCHEMA_VERSION) {
    const manifest = readManifest(root);
    return {
      ownerPid: manifest.ownerPid,
      ownerProcessStartIdentity: manifest.ownerProcessStartIdentity,
    };
  }
  const objectFormat = record.objectFormat;
  if (record.schemaVersion !== 2
    || !Number.isSafeInteger(record.runId) || Number(record.runId) <= 0
    || !Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0
    || typeof record.ownerProcessStartIdentity !== 'string'
    || !/^(?:linux-proc-start:\d+|darwin-ps-lstart:.+)$/.test(record.ownerProcessStartIdentity)
    || typeof record.ownerInstanceNonce !== 'string' || !/^[a-f0-9]{64}$/.test(record.ownerInstanceNonce)
    || typeof record.worktreePath !== 'string'
    || typeof record.branchName !== 'string' || !record.branchName
    || (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    || typeof record.initialHead !== 'string'
    || !new RegExp(`^[a-f0-9]{${objectFormat === 'sha256' ? 64 : 40}}$`).test(record.initialHead)
    || typeof record.sharedGitDir !== 'string'
    || typeof record.sharedCommonDir !== 'string'
    || typeof record.sharedObjectsDir !== 'string') {
    throw new Error('Legacy autonomous Git state manifest is invalid');
  }
  return {
    ownerPid: Number(record.ownerPid),
    ownerProcessStartIdentity: record.ownerProcessStartIdentity,
  };
}

function assertManifestRepositoryIdentity(manifest: AutonomousGitStateManifest, cwd: string): string {
  const worktree = fs.realpathSync(cwd);
  if (worktree !== manifest.worktreePath) throw new Error('Autonomous Git state worktree changed identity');
  if (repositoryPath(worktree, '--absolute-git-dir') !== manifest.sharedGitDir
    || repositoryPath(worktree, '--git-common-dir') !== manifest.sharedCommonDir) {
    throw new Error('Autonomous Git shared control-plane identity changed');
  }
  const objectDirs = discoverReachableObjectDirectories(path.join(manifest.sharedCommonDir, 'objects'));
  if (objectDirs[0] !== manifest.sharedObjectsDir
    || JSON.stringify(objectDirs) !== JSON.stringify(manifest.sharedObjectDirs)) {
    throw new Error('Autonomous Git shared object topology changed');
  }
  const branch = runGit(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== manifest.branchName) throw new Error('Autonomous Git host branch changed identity');
  return worktree;
}

interface InodeInventory {
  entries: number;
  regularFiles: Map<string, string>;
  directories: Set<string>;
}

function inodeKey(stat: fs.BigIntStats): string {
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

function inventoryRegularFiles(
  roots: readonly string[],
  excludedRoots: readonly string[],
  inventory: InodeInventory,
  onRegularFile?: (filePath: string, key: string) => void,
): void {
  const stack = [...roots.map(value => path.resolve(value))];
  while (stack.length > 0) {
    const candidate = stack.pop()!;
    if (excludedRoots.some(root => isWithin(candidate, root))) continue;
    inventory.entries += 1;
    if (inventory.entries > MAX_GIT_ALIAS_INVENTORY_ENTRIES) {
      throw new Error('Autonomous Git hardlink inventory exceeded its bounded filesystem budget');
    }
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const key = inodeKey(stat);
      if (inventory.directories.has(key)) continue;
      inventory.directories.add(key);
      for (const name of fs.readdirSync(candidate)) stack.push(path.join(candidate, name));
      continue;
    }
    if (!stat.isFile()) continue;
    const key = inodeKey(stat);
    inventory.regularFiles.set(key, candidate);
    onRegularFile?.(candidate, key);
  }
}

/**
 * A read-only Git pathname does not protect a shared inode that is also linked
 * beneath the writable worktree. Inventory both namespaces before issuing any
 * Darwin Seatbelt profile or Linux mount plan and fail closed on every alias,
 * including config, refs, hooks, and objects.
 */
export function assertNoSharedGitHardlinkAliases(cwd: string): string[] {
  const worktree = fs.realpathSync(cwd);
  const sharedGitDir = repositoryPath(worktree, '--absolute-git-dir');
  const sharedCommonDir = repositoryPath(worktree, '--git-common-dir');
  const sharedObjectDirs = discoverReachableObjectDirectories(path.join(sharedCommonDir, 'objects'));
  const canonicalGitPointer = path.resolve(worktree, '.git');
  // Every object database may itself be a symlink or live outside the common
  // directory. Resolve the complete alternates graph before plan issuance and
  // inventory each namespace explicitly rather than trusting path traversal.
  const sharedRoots = [...new Set([sharedGitDir, sharedCommonDir, ...sharedObjectDirs])];
  const inventory: InodeInventory = {
    entries: 0,
    regularFiles: new Map(),
    directories: new Set(),
  };
  inventoryRegularFiles(sharedRoots, [], inventory);
  const sharedFiles = new Map(inventory.regularFiles);
  inventory.regularFiles.clear();
  // Directory de-duplication is namespace-local. Reusing shared-directory
  // inode keys while walking the writable namespace could hide a bind-mounted
  // alias subtree even though regular-file hardlinks are the final comparison.
  inventory.directories.clear();
  const excluded = [
    canonicalGitPointer,
    ...sharedRoots.filter(root => isWithin(root, worktree)),
  ];
  inventoryRegularFiles([worktree], excluded, inventory, (filePath, key) => {
    const sharedPath = sharedFiles.get(key);
    if (sharedPath) {
      throw new Error(
        `Autonomous sandbox refused writable worktree hardlink alias ${filePath} -> shared Git state ${sharedPath}`,
      );
    }
  });
  assertReachableLocalGitObjectDirectoriesUnchanged(worktree, sharedObjectDirs);
  return sharedObjectDirs;
}

/** Allocate one worker-owned root. Model processes receive only per-launch child views. */
export function createAutonomousGitState(runId: number, cwd: string, branchName: string): string {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Autonomous Git state requires a valid run id');
  const worktree = fs.realpathSync(cwd);
  const sharedGitDir = repositoryPath(worktree, '--absolute-git-dir');
  const sharedCommonDir = repositoryPath(worktree, '--git-common-dir');
  const sharedObjectDirs = discoverReachableObjectDirectories(path.join(sharedCommonDir, 'objects'));
  const sharedObjectsDir = sharedObjectDirs[0];
  const actualBranch = runGit(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branchName || actualBranch !== branchName) throw new Error('Autonomous Git state requires the exact host-owned branch');
  const objectFormat = runGit(worktree, ['rev-parse', '--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error(`Autonomous Git state does not support object format ${objectFormat || '(unknown)'}`);
  }
  const initialHead = runGit(worktree, ['rev-parse', '--verify', 'HEAD']);
  if (!new RegExp(`^[a-f0-9]{${objectFormat === 'sha256' ? 64 : 40}}$`).test(initialHead)) {
    throw new Error('Autonomous Git state requires an exact format-preserving initial commit');
  }

  const root = fs.mkdtempSync(path.join(realTemporaryRoot(), `${STATE_PREFIX}${runId}-`));
  fs.chmodSync(root, 0o700);
  try {
    fs.mkdirSync(path.join(root, 'views'), { mode: 0o700 });
    const manifest: AutonomousGitStateManifest = {
      schemaVersion: STATE_SCHEMA_VERSION,
      runId,
      ownerPid: process.pid,
      ownerProcessStartIdentity: PROCESS_START_IDENTITY,
      ownerInstanceNonce: PROCESS_INSTANCE_NONCE,
      worktreePath: worktree,
      branchName,
      objectFormat,
      initialHead,
      sharedGitDir,
      sharedCommonDir,
      sharedObjectsDir,
      sharedObjectDirs,
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    const trustedRoot = assertStateRoot(root);
    activeRoots.set(trustedRoot, PROCESS_INSTANCE_NONCE);
    if (!exitCleanupRegistered) {
      exitCleanupRegistered = true;
      process.once('exit', () => {
        for (const active of [...activeRoots.keys()]) {
          try { removeAutonomousGitState(active); } catch { /* process exit is best-effort */ }
        }
      });
    }
    return trustedRoot;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Create a per-model private ref/index/object view at the current trusted host HEAD.
 * Shared objects are borrowed through a read-only alternates path. Private refs,
 * index, config, logs, hooks, and newly-created objects never enter shared Git.
 */
export function createAutonomousGitView(stateRoot: string, cwd: string): AutonomousGitView {
  const root = assertStateRoot(stateRoot);
  const manifest = readManifest(root);
  const worktree = assertManifestRepositoryIdentity(manifest, cwd);
  const baseHead = runGit(worktree, ['rev-parse', '--verify', 'HEAD']);
  const views = assertPrivateDirectory(path.join(root, 'views'), root, 'Autonomous Git views directory');
  const gitDir = fs.mkdtempSync(path.join(views, 'view-'));
  fs.chmodSync(gitDir, 0o700);
  try {
    runGit(worktree, ['init', '--bare', '--quiet', `--object-format=${manifest.objectFormat}`, gitDir]);
    const privateEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: worktree };
    runGit(worktree, ['config', 'core.bare', 'false'], privateEnv);
    runGit(worktree, ['config', 'core.worktree', worktree], privateEnv);
    runGit(worktree, ['config', 'gc.auto', '0'], privateEnv);
    const alternates = path.join(gitDir, 'objects', 'info', 'alternates');
    fs.writeFileSync(alternates, `${manifest.sharedObjectsDir}\n`, { mode: 0o600 });
    runGit(worktree, ['update-ref', PRIVATE_REF, baseHead], privateEnv);
    runGit(worktree, ['symbolic-ref', 'HEAD', PRIVATE_REF], privateEnv);
    runGit(worktree, ['read-tree', baseHead], privateEnv);
    return {
      stateRoot: root,
      gitDir: fs.realpathSync(gitDir),
      worktreePath: worktree,
      sharedGitDir: manifest.sharedGitDir,
      sharedCommonDir: manifest.sharedCommonDir,
      sharedObjectsDir: manifest.sharedObjectsDir,
      sharedObjectDirs: [...manifest.sharedObjectDirs],
      baseHead,
    };
  } catch (error) {
    fs.rmSync(gitDir, { recursive: true, force: true });
    throw error;
  }
}

export function createAutonomousGitViewFromEnv(
  cwd: string,
  env: Record<string, string>,
): AutonomousGitView | null {
  const stateRoot = env[AUTONOMOUS_GIT_STATE_ROOT_ENV];
  if (!stateRoot) return null;
  return createAutonomousGitView(stateRoot, cwd);
}

/**
 * Trusted engine seam immediately before host staging/commit. This does not
 * import model-created refs or objects: only physical worktree changes proceed
 * through the engine's existing validation, allowlisting, staging, and commit.
 */
export function assertAutonomousGitHostReconciliation(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const stateRoot = env[AUTONOMOUS_GIT_STATE_ROOT_ENV];
  if (!stateRoot) return;
  if (env.GIT_DIR || env.GIT_WORK_TREE || env[AUTONOMOUS_GIT_VIEW_ENV]) {
    throw new Error('Trusted Git reconciliation cannot inherit model-private Git control state');
  }
  const root = assertStateRoot(stateRoot);
  const manifest = readManifest(root);
  assertManifestRepositoryIdentity(manifest, cwd);
}

export function removeAutonomousGitState(stateRoot: string): void {
  let trustedRoot: string;
  try { trustedRoot = assertStateRoot(stateRoot); } catch { return; }
  const activeNonce = activeRoots.get(trustedRoot);
  if (activeNonce !== PROCESS_INSTANCE_NONCE) return;
  let manifest: AutonomousGitStateManifest;
  try { manifest = readManifest(trustedRoot); } catch { return; }
  if (manifest.ownerPid !== process.pid
    || manifest.ownerProcessStartIdentity !== PROCESS_START_IDENTITY
    || manifest.ownerInstanceNonce !== activeNonce) return;
  fs.rmSync(trustedRoot, { recursive: true, force: true });
  activeRoots.delete(trustedRoot);
}

/** Remove only roots whose exact persisted owner instance is proved gone. */
export function sweepStaleAutonomousGitState(candidates?: readonly string[]): number {
  const temporaryRoot = realTemporaryRoot();
  const roots = candidates ?? fs.readdirSync(temporaryRoot)
    .filter(name => name.startsWith(STATE_PREFIX))
    .map(name => path.join(temporaryRoot, name));
  let removed = 0;
  for (const candidate of roots) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(STATE_PREFIX)) continue;
    if (activeRoots.has(resolved)) continue;
    try {
      const root = assertStateRoot(resolved);
      const manifestOwner = readManifestOwnerForSweep(root);
      const owner = observeExactProcessInstance(
        manifestOwner.ownerPid,
        manifestOwner.ownerProcessStartIdentity,
      );
      if (owner !== 'dead' && owner !== 'mismatched') continue;
      fs.rmSync(root, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Never follow or recursively remove an attacker-substituted entry.
    }
  }
  return removed;
}

export function autonomousGitStateManifestForTests(stateRoot: string): AutonomousGitStateManifest {
  return readManifest(stateRoot);
}

export function autonomousGitPathIsInsideStateForTests(candidate: string, stateRoot: string): boolean {
  return isWithin(path.resolve(candidate), assertStateRoot(stateRoot));
}
