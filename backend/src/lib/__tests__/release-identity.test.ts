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

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  withPgAdvisoryLock: async (_key: string, operation: () => Promise<unknown>) => operation(),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: (...args: unknown[]) => getAuthority(...args),
}));
jest.mock('../github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: (...args: unknown[]) => resolveToken(...args),
}));

import {
  withGithubReleaseActuation,
  withRunReleaseLock,
  type RunReleaseIdentity,
} from '../release-identity';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let workspace: string;
let worktree: string;
let release: RunReleaseIdentity;

function exactAppToken() {
  return {
    token: 'memory-only', source: 'github-app-installation',
    metadata: {
      source: 'github-app-installation', bindingId: release.repository!.bindingId,
      appId: 1, appSlug: 'rorca', installationId: release.repository!.installationId,
      repositoryId: release.repository!.repositoryId,
      repository: { owner: release.repository!.owner, name: release.repository!.name },
      permissions: {}, expiresAt: '2026-07-20T07:00:00.000Z',
    },
  };
}

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
    baseBranch: 'main',
    baseSha: git(workspace, 'rev-parse', 'main'),
    providerReleaseRef: `rorca/release/run-71-${sha.slice(0, 12)}`,
    integrationCheckoutPath: path.join(root, 'integration'),
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
  resolveToken.mockImplementation(async () => exactAppToken());
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('reacquires App authority, resolves the purpose credential last, and actuates exact HEAD', async () => {
  const actuator = jest.fn().mockResolvedValue('ok');
  await expect(withGithubReleaseActuation(release, 'pulls-write', actuator)).resolves.toBe('ok');
  expect(getAuthority.mock.invocationCallOrder[0]).toBeLessThan(resolveToken.mock.invocationCallOrder[0]);
  expect(actuator).toHaveBeenCalledTimes(1);
});

test.each(['merge', 'pulls-write', 'repository-read', 'checks-write'] as const)(
  'HEAD advance during %s credential resolution blocks the actuator',
  async (purpose) => {
    resolveToken.mockImplementationOnce(async () => {
      fs.writeFileSync(path.join(worktree, 'race.txt'), purpose);
      git(worktree, 'add', 'race.txt');
      git(worktree, 'commit', '-q', '-m', `race ${purpose}`);
      return exactAppToken();
    });
    const actuator = jest.fn();
    await expect(withGithubReleaseActuation(release, purpose, actuator)).rejects.toThrow(/HEAD differs|HEAD advanced/);
    expect(actuator).not.toHaveBeenCalled();
  },
);

test('same-repository binding replacement during token resolution blocks actuation', async () => {
  const replacement = {
    workspaceId: release.workspaceId,
    owner: 'getrorca', name: 'rorca', source: 'github-app-installation', status: 'active',
    bindingId: '00000000-0000-4000-8000-000000000099', installationId: 99, repositoryId: 72,
  };
  getAuthority
    .mockResolvedValueOnce({ ...replacement, bindingId: release.repository!.bindingId, installationId: 71 })
    .mockResolvedValueOnce(replacement);
  resolveToken.mockResolvedValueOnce({
    ...exactAppToken(),
    metadata: { ...exactAppToken().metadata, bindingId: replacement.bindingId, installationId: 99 },
  });
  const actuator = jest.fn();
  await expect(withGithubReleaseActuation(release, 'merge', actuator)).rejects.toThrow(/authority changed|metadata/i);
  expect(actuator).not.toHaveBeenCalled();
});

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

test('different runs for one repository serialize under one repository-wide lock', async () => {
  const events: string[] = [];
  const second = { ...release, runId: 72 };
  await Promise.all([
    withRunReleaseLock(release, async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push('first:end');
    }),
    withRunReleaseLock(second, async () => {
      events.push('second:start');
      events.push('second:end');
    }),
  ]);
  expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
});
