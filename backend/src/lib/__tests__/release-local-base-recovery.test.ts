/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

jest.mock('../../db/index', () => ({ execute: jest.fn(), query: jest.fn(), queryOne: jest.fn(), transaction: jest.fn() }));
jest.mock('../merge-handler', () => ({ performMerge: jest.fn() }));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(), githubRepoApiUrl: jest.fn(), assertGithubRef: jest.fn(),
}));
jest.mock('../github-token-resolver', () => ({ resolveWorkspaceGitHubToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({ fetchGithubWithTimeout: jest.fn() }));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: jest.fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: jest.fn() }));
jest.mock('../trusted-wal', () => ({ persistTrustedWalEvent: jest.fn(), relayTrustedWalEvent: jest.fn(), trustedWalReference: jest.fn() }));

import { updateLocalBaseExactForTests } from '../release-authority';
import type { RunReleaseIdentity } from '../release-identity';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let workspace: string;
let base: string;
let merged: string;
let identity: RunReleaseIdentity;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-local-base-recovery-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'test@rorca.invalid');
  git(workspace, 'config', 'user.name', 'Rorca Test');
  fs.writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-q', '-m', 'base');
  git(workspace, 'branch', '-M', 'main');
  base = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'checkout', '-q', '-b', 'integration');
  fs.writeFileSync(path.join(workspace, 'merged.txt'), 'merged\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-q', '-m', 'merged');
  merged = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'checkout', '-q', 'main');
  identity = {
    runId: 131, workspaceId: 'ws-local-base', specId: 'local-base', authorizedSha: merged,
    branchName: 'run/local-base', workspaceRealpath: fs.realpathSync(workspace), worktreeRealpath: fs.realpathSync(workspace),
    baseBranch: 'main', baseSha: base, providerReleaseRef: null,
    integrationCheckoutPath: path.join(fs.realpathSync(root), 'integration-checkout'), repository: null,
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function simulateCrashAfterRefCas(): void {
  git(workspace, 'update-ref', 'refs/heads/main', merged, base);
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(merged);
  expect(fs.existsSync(path.join(workspace, 'merged.txt'))).toBe(false);
}

test('crash after local ref CAS repairs an untouched base index/worktree exactly', async () => {
  simulateCrashAfterRefCas();
  await expect(updateLocalBaseExactForTests(identity, merged)).resolves.toBeUndefined();
  expect(fs.readFileSync(path.join(workspace, 'merged.txt'), 'utf8')).toBe('merged\n');
  expect(git(workspace, 'status', '--porcelain')).toBe('');
});

test('local CAS recovery preserves and fails closed on operator changes', async () => {
  simulateCrashAfterRefCas();
  fs.writeFileSync(path.join(workspace, 'operator.txt'), 'do not delete\n');
  await expect(updateLocalBaseExactForTests(identity, merged)).rejects.toThrow(/operator worktree changes/);
  expect(fs.readFileSync(path.join(workspace, 'operator.txt'), 'utf8')).toBe('do not delete\n');
});
