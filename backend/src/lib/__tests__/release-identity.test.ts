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

const queryOne = jest.fn();
const getAuthority = jest.fn();
const resolveToken = jest.fn();

jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => queryOne(...args) }));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: (...args: unknown[]) => getAuthority(...args),
}));
jest.mock('../github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: (...args: unknown[]) => resolveToken(...args),
}));

import {
  withGithubReleaseActuation,
  type RunReleaseIdentity,
} from '../release-identity';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let workspace: string;
let worktree: string;
let release: RunReleaseIdentity;

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-release-identity-'));
  workspace = path.join(root, 'workspace');
  worktree = path.join(root, 'worktree');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'test@rorca.invalid');
  git(workspace, 'config', 'user.name', 'Rorca Test');
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'base\n');
  git(workspace, 'add', 'file.txt');
  git(workspace, 'commit', '-q', '-m', 'base');
  git(workspace, 'branch', '-M', 'main');
  git(workspace, 'worktree', 'add', '-q', '-b', 'run/release', worktree);
  fs.writeFileSync(path.join(worktree, 'file.txt'), 'authorized\n');
  git(worktree, 'add', 'file.txt');
  git(worktree, 'commit', '-q', '-m', 'authorized');
  const sha = git(worktree, 'rev-parse', 'HEAD');
  release = {
    runId: 71,
    workspaceId: 'ws-release',
    specId: 'release-spec',
    authorizedSha: sha,
    branchName: 'run/release',
    workspaceRealpath: fs.realpathSync(workspace),
    worktreeRealpath: fs.realpathSync(worktree),
    repository: {
      owner: 'getrorca', name: 'rorca', source: 'github-app-installation',
      bindingId: '00000000-0000-4000-8000-000000000071',
      installationId: 71, repositoryId: 72,
    },
  };
  queryOne.mockResolvedValue({
    workspace_id: release.workspaceId,
    spec_path: `forge/specs/approved/${release.specId}.json`,
    branch_name: release.branchName,
    worktree_path: release.worktreeRealpath,
    execution_workspace_path: release.workspaceRealpath,
    execution_worktree_path: release.worktreeRealpath,
    terminal_checkout_sha: release.authorizedSha,
  });
  getAuthority.mockResolvedValue({
    workspaceId: release.workspaceId,
    owner: 'getrorca', name: 'rorca', source: 'github-app-installation', status: 'active',
    bindingId: release.repository!.bindingId, installationId: 71, repositoryId: 72,
  });
  resolveToken.mockResolvedValue({ token: 'memory-only', source: 'github-app-installation' });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('reacquires App authority, resolves the purpose credential last, and actuates exact HEAD', async () => {
  const actuator = jest.fn().mockResolvedValue('ok');
  await expect(withGithubReleaseActuation(release, 'pulls-write', actuator)).resolves.toBe('ok');
  expect(getAuthority.mock.invocationCallOrder[0]).toBeLessThan(resolveToken.mock.invocationCallOrder[0]);
  expect(actuator).toHaveBeenCalledTimes(1);
});

test.each(['merge', 'pulls-write', 'workflow-dispatch', 'checks-write'] as const)(
  'HEAD advance during %s credential resolution blocks the actuator',
  async (purpose) => {
    resolveToken.mockImplementationOnce(async () => {
      fs.writeFileSync(path.join(worktree, 'race.txt'), purpose);
      git(worktree, 'add', 'race.txt');
      git(worktree, 'commit', '-q', '-m', `race ${purpose}`);
      return { token: 'memory-only', source: 'github-app-installation' };
    });
    const actuator = jest.fn();
    await expect(withGithubReleaseActuation(release, purpose, actuator)).rejects.toThrow(/HEAD differs|HEAD advanced/);
    expect(actuator).not.toHaveBeenCalled();
  },
);

test('App credential failure fails closed without invoking an alternate actuator', async () => {
  resolveToken.mockRejectedValueOnce(new Error('installation token unavailable'));
  const actuator = jest.fn();
  await expect(withGithubReleaseActuation(release, 'pulls-write', actuator)).rejects.toThrow('installation token unavailable');
  expect(actuator).not.toHaveBeenCalled();
});

test('App authority cannot downgrade to a workspace PAT', async () => {
  resolveToken.mockResolvedValueOnce({ token: 'legacy', source: 'workspace-pat' });
  const actuator = jest.fn();
  await expect(withGithubReleaseActuation(release, 'merge', actuator)).rejects.toThrow(/cannot downgrade/);
  expect(actuator).not.toHaveBeenCalled();
});
