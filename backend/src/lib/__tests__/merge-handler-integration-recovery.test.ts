/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const execute = jest.fn().mockResolvedValue({ rowCount: 1 });
jest.mock('../../db/index', () => ({ execute: (...args: unknown[]) => execute(...args) }));
jest.mock('../release-identity', () => ({
  revalidateRunReleaseIdentity: jest.fn().mockResolvedValue(undefined),
  withRunReleaseLock: async (_identity: unknown, fn: () => Promise<unknown>) => fn(),
}));
jest.mock('../merge-conflict-resolver', () => ({ resolveMergeConflict: jest.fn() }));

import { performMerge } from '../merge-handler';
import type { RunReleaseIdentity } from '../release-identity';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let workspace: string;
let source: string;
let identity: RunReleaseIdentity;

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rowCount: 1 });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-isolated-merge-'));
  workspace = path.join(root, 'workspace');
  source = path.join(root, 'source');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'test@rorca.invalid');
  git(workspace, 'config', 'user.name', 'Rorca Test');
  fs.writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git(workspace, 'add', 'base.txt');
  git(workspace, 'commit', '-q', '-m', 'base');
  git(workspace, 'branch', '-M', 'main');
  const base = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'worktree', 'add', '-q', '-b', 'run/merge', source);
  fs.writeFileSync(path.join(source, 'story.txt'), 'story\n');
  git(source, 'add', 'story.txt');
  git(source, 'commit', '-q', '-m', 'story');
  const authorized = git(source, 'rev-parse', 'HEAD');
  identity = {
    runId: 111, workspaceId: 'ws-merge', specId: 'merge', authorizedSha: authorized,
    branchName: 'run/merge', workspaceRealpath: fs.realpathSync(workspace), worktreeRealpath: fs.realpathSync(source),
    baseBranch: 'main', baseSha: base, providerReleaseRef: null,
    integrationCheckoutPath: path.join(fs.realpathSync(root), 'integration'), repository: null,
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('isolated exact merge replays to the same commit without mutating canonical base', async () => {
  const first = await performMerge(111, 'run/merge', workspace, undefined, {}, identity);
  expect(first.success).toBe(true);
  expect(git(workspace, 'rev-parse', 'main')).toBe(identity.baseSha);
  const second = await performMerge(111, 'run/merge', workspace, undefined, {}, identity);
  expect(second).toMatchObject({ success: true, mergeCommitSha: first.mergeCommitSha });
});

test('crash-left MERGE_HEAD/index is aborted and deterministically rebuilt from frozen base', async () => {
  git(workspace, 'worktree', 'add', '--detach', identity.integrationCheckoutPath, identity.baseSha);
  const started = spawnSync('git', ['merge', '--no-ff', '--no-commit', identity.authorizedSha], {
    cwd: identity.integrationCheckoutPath, encoding: 'utf8',
  });
  expect(started.status).toBe(0);
  expect(() => git(identity.integrationCheckoutPath, 'rev-parse', '--verify', 'MERGE_HEAD')).not.toThrow();
  const recovered = await performMerge(111, 'run/merge', workspace, undefined, {}, identity);
  expect(recovered.success).toBe(true);
  expect(() => git(identity.integrationCheckoutPath, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
});

test('base advancement by a concurrent run fails closed', async () => {
  fs.writeFileSync(path.join(workspace, 'other.txt'), 'concurrent\n');
  git(workspace, 'add', 'other.txt');
  git(workspace, 'commit', '-q', '-m', 'concurrent base');
  const result = await performMerge(111, 'run/merge', workspace, undefined, {}, identity);
  expect(result).toMatchObject({ success: false });
  expect(result.error).toMatch(/Frozen local base advanced/);
});

test('base branch switch fails closed before integration', async () => {
  git(workspace, 'checkout', '-q', '-b', 'other-base');
  const result = await performMerge(111, 'run/merge', workspace, undefined, {}, identity);
  expect(result).toMatchObject({ success: false });
  expect(result.error).toMatch(/base branch switched/);
});
