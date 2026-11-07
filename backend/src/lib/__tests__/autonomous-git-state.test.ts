/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTONOMOUS_GIT_STATE_ROOT_ENV,
  assertAutonomousGitHostReconciliation,
  autonomousGitPathIsInsideStateForTests,
  autonomousGitStateManifestForTests,
  createAutonomousGitState,
  createAutonomousGitView,
  removeAutonomousGitState,
  sweepStaleAutonomousGitState,
} from '../autonomous-git-state';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1'): { root: string; primary: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-private-git-fixture-'));
  const primary = path.join(root, 'primary');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`);
  git(primary, 'config', 'user.email', 'private-git@rorca.invalid');
  git(primary, 'config', 'user.name', 'Private Git Test');
  fs.writeFileSync(path.join(primary, 'file.txt'), 'base\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-qm', 'base');
  git(primary, 'worktree', 'add', '-qb', 'feature/private-view', worktree);
  return { root, primary, worktree };
}

test('per-launch refs, index, config, logs, hooks, and objects stay in private views', () => {
  const { root, primary, worktree } = fixture();
  const stateRoot = createAutonomousGitState(401, worktree, 'feature/private-view');
  try {
    const manifest = autonomousGitStateManifestForTests(stateRoot);
    const primaryHead = git(primary, 'rev-parse', 'main');
    const featureHead = git(worktree, 'rev-parse', 'HEAD');
    const first = createAutonomousGitView(stateRoot, worktree);
    const second = createAutonomousGitView(stateRoot, worktree);
    expect(first.gitDir).not.toBe(second.gitDir);
    expect(autonomousGitPathIsInsideStateForTests(first.gitDir, stateRoot)).toBe(true);
    expect(fs.readFileSync(path.join(first.gitDir, 'objects', 'info', 'alternates'), 'utf8').trim())
      .toBe(manifest.sharedObjectsDir);

    const privateEnv = {
      GIT_DIR: first.gitDir,
      GIT_WORK_TREE: worktree,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
    };
    execFileSync('git', ['update-ref', 'refs/heads/main', featureHead], { cwd: worktree, env: privateEnv });
    expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: worktree, env: privateEnv, encoding: 'utf8' }).trim())
      .toBe(featureHead);
    expect(git(primary, 'rev-parse', 'main')).toBe(primaryHead);
    expect(fs.existsSync(path.join(manifest.sharedCommonDir, 'refs', 'heads', 'private-proof'))).toBe(false);
  } finally {
    removeAutonomousGitState(stateRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trusted reconciliation rejects branch/control-plane drift and model Git env inheritance', () => {
  const { root, worktree } = fixture();
  const stateRoot = createAutonomousGitState(402, worktree, 'feature/private-view');
  try {
    expect(() => assertAutonomousGitHostReconciliation(worktree, {
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot,
    })).not.toThrow();
    expect(() => assertAutonomousGitHostReconciliation(worktree, {
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot,
      GIT_DIR: '/attacker/private',
    })).toThrow(/cannot inherit model-private Git control state/);
    git(worktree, 'branch', '-m', 'feature/drifted');
    expect(() => assertAutonomousGitHostReconciliation(worktree, {
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot,
    })).toThrow(/branch changed identity/);
  } finally {
    removeAutonomousGitState(stateRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exact cleanup and startup sweep never follow a substituted root symlink or remove an exact live owner', () => {
  const { root, worktree } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-private-git-outside-'));
  const sentinel = path.join(outside, 'must-survive');
  fs.writeFileSync(sentinel, 'survive');
  const stateRoot = createAutonomousGitState(403, worktree, 'feature/private-view');
  try {
    removeAutonomousGitState(stateRoot);
    expect(fs.existsSync(stateRoot)).toBe(false);

    const substituted = createAutonomousGitState(404, worktree, 'feature/private-view');
    fs.rmSync(substituted, { recursive: true });
    fs.symlinkSync(outside, substituted);
    removeAutonomousGitState(substituted);
    expect(fs.lstatSync(substituted).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('survive');
    fs.unlinkSync(substituted);

    const stale = createAutonomousGitState(405, worktree, 'feature/private-view');
    // Simulate a root absent from this module's in-memory map while retaining
    // an exact live persisted owner. Absence from the map is never stale proof.
    const staleManifest = autonomousGitStateManifestForTests(stale);
    removeAutonomousGitState(stale);
    fs.mkdirSync(stale, { mode: 0o700 });
    fs.mkdirSync(path.join(stale, 'views'), { mode: 0o700 });
    fs.writeFileSync(path.join(stale, 'manifest.json'), `${JSON.stringify(staleManifest)}\n`, { mode: 0o600 });
    expect(sweepStaleAutonomousGitState([stale])).toBe(0);
    expect(fs.existsSync(stale)).toBe(true);

    // A live reused PID with a different process-start identity proves the
    // persisted owner instance is gone and makes exact-root cleanup safe.
    const reusedPidManifest: Record<string, unknown> = {
      ...staleManifest,
      schemaVersion: 2,
      ownerProcessStartIdentity: staleManifest.ownerProcessStartIdentity.replace(/.$/, value => value === '0' ? '1' : '0'),
    };
    delete reusedPidManifest.sharedObjectDirs;
    fs.writeFileSync(path.join(stale, 'manifest.json'), `${JSON.stringify(reusedPidManifest)}\n`, { mode: 0o600 });
    expect(sweepStaleAutonomousGitState([stale])).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  } finally {
    removeAutonomousGitState(stateRoot);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

function readFirstJsonLine(child: ChildProcess): Promise<{ root: string; pid: number }> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try { resolve(JSON.parse(output.slice(0, newline)) as { root: string; pid: number }); }
      catch (error) { reject(error); }
    });
  });
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('close', () => resolve()));
}

test('a second live process preserves the exact first process Git-state root, then sweeps it after owner death', async () => {
  const { root, worktree } = fixture();
  const ownerFixture = path.join(__dirname, 'fixtures', 'autonomous-git-state-owner.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', ownerFixture, '406', worktree, 'feature/private-view'], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stateRoot: string | undefined;
  try {
    const owned = await readFirstJsonLine(child);
    stateRoot = owned.root;
    expect(owned.pid).toBe(child.pid);
    expect(sweepStaleAutonomousGitState([owned.root])).toBe(0);
    expect(fs.existsSync(owned.root)).toBe(true);
    child.kill('SIGKILL');
    await waitForClose(child);
    expect(sweepStaleAutonomousGitState([owned.root])).toBe(1);
    expect(fs.existsSync(owned.root)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForClose(child);
    }
    if (stateRoot) fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const supportsSha256 = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-git-sha256-probe-'));
  try {
    execFileSync('git', ['init', '-q', '--object-format=sha256', root]);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(supportsSha256 ? test : test.skip)('SHA-1 and SHA-256 private views preserve object format, alternates, and host reconciliation', () => {
  for (const objectFormat of ['sha1', 'sha256'] as const) {
    const { root, worktree } = fixture(objectFormat);
    const stateRoot = createAutonomousGitState(objectFormat === 'sha1' ? 407 : 408, worktree, 'feature/private-view');
    try {
      const manifest = autonomousGitStateManifestForTests(stateRoot);
      const view = createAutonomousGitView(stateRoot, worktree);
      expect(manifest.objectFormat).toBe(objectFormat);
      expect(execFileSync('git', ['--git-dir', view.gitDir, 'rev-parse', '--show-object-format'], { encoding: 'utf8' }).trim())
        .toBe(objectFormat);
      expect(fs.readFileSync(path.join(view.gitDir, 'objects', 'info', 'alternates'), 'utf8').trim())
        .toBe(manifest.sharedObjectsDir);
      expect(() => assertAutonomousGitHostReconciliation(worktree, {
        [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot,
      })).not.toThrow();
    } finally {
      removeAutonomousGitState(stateRoot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
