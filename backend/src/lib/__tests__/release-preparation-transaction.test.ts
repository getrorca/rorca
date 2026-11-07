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

const execute = jest.fn();
const queryOne = jest.fn();
const transaction = jest.fn();
const clientQuery = jest.fn();

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => execute(...args),
  query: jest.fn(),
  queryOne: (...args: unknown[]) => queryOne(...args),
  transaction: (...args: unknown[]) => transaction(...args),
  withPgAdvisoryLock: async (_key: string, operation: () => Promise<unknown>) => operation(),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(),
  githubRepoApiUrl: jest.fn(),
  assertGithubRef: jest.fn(),
}));
jest.mock('../github-token-resolver', () => ({ resolveWorkspaceGitHubToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({ fetchGithubWithTimeout: jest.fn() }));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: jest.fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: jest.fn() }));
jest.mock('../trusted-wal', () => ({ persistTrustedWalEvent: jest.fn(), relayTrustedWalEvent: jest.fn(), trustedWalReference: jest.fn() }));
jest.mock('../run-closeout-authority', () => ({
  loadHostRunCloseoutReference: jest.fn(async () => ({
    reference: { id: 9001, identityHash: `sha256:${'9'.repeat(64)}` },
    payload: { status: 'done', integrated_revision: currentCloseoutSha, accepted_story_ids: [] },
    ready: true,
  })),
}));

let currentCloseoutSha = '';

import { prepareRunReleaseIntent } from '../release-authority';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let workspace: string;
let worktree: string;
let sha: string;

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-release-prepare-'));
  workspace = path.join(root, 'workspace');
  worktree = path.join(root, 'worktree');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'test@rorca.invalid');
  git(workspace, 'config', 'user.name', 'Rorca Test');
  fs.writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git(workspace, 'add', 'base.txt');
  git(workspace, 'commit', '-q', '-m', 'base');
  git(workspace, 'branch', '-M', 'main');
  git(workspace, 'worktree', 'add', '-q', '-b', 'run/prepare', worktree);
  fs.writeFileSync(path.join(worktree, 'story.txt'), 'story\n');
  git(worktree, 'add', 'story.txt');
  git(worktree, 'commit', '-q', '-m', 'story');
  sha = git(worktree, 'rev-parse', 'HEAD');
  currentCloseoutSha = sha;
  queryOne.mockResolvedValue({
    workspace_id: 'ws-prepare', spec_path: 'forge/specs/approved/prepare.json', branch_name: 'run/prepare',
    worktree_path: fs.realpathSync(worktree), execution_workspace_path: fs.realpathSync(workspace), execution_worktree_path: fs.realpathSync(worktree),
    terminal_checkout_sha: null, base_branch: null, base_sha: null, provider_release_ref: null,
    integration_checkout_path: null,
  });
  let digest = '';
  clientQuery.mockImplementation(async (sqlValue: unknown, values: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs run') && sql.includes('FOR UPDATE OF run')) {
      return {
        rowCount: 1,
        rows: [{
          status: 'done',
          dispatch_fence: 'dispatch-fence-prepare',
          intent_fence: null,
          cancellation_requested: false,
        }],
      };
    }
    if (sql.includes('INSERT INTO pipeline_run_release_intents')) {
      digest = String(values[16]);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT identity_hash')) return { rowCount: 1, rows: [{ identity_hash: digest }] };
    if (sql.includes('UPDATE pipeline_runs')) return { rowCount: 1, rows: [{ id: 101 }] };
    return { rowCount: 0, rows: [] };
  });
  transaction.mockImplementation(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) => fn({ query: clientQuery }));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function input() {
  return {
    hostAuthority: {
      runId: 101, workspaceId: 'ws-prepare', specId: 'prepare', releaseEligible: true,
      finalCommitSha: sha, branchName: 'run/prepare', repositoryTopLevel: workspace,
      checkoutPath: worktree,
      expectedStoryIds: [],
    },
    mergeStrategy: 'branch-only' as const, autoMerge: false, externalSend: false,
  };
}

test('intent, immutable terminal checkout attestation, and release_pending transition share one transaction', async () => {
  await expect(prepareRunReleaseIntent(input() as never)).resolves.toMatchObject({ authorizedSha: sha });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  const sql = clientQuery.mock.calls.map(([value]) => String(value));
  expect(sql.findIndex((value) => value.includes('INSERT INTO pipeline_run_release_intents')))
    .toBeLessThan(sql.findIndex((value) => value.includes('UPDATE pipeline_runs')));
  expect(sql.join('\n')).toContain("status = CASE WHEN status = 'done' THEN status ELSE 'release_pending' END");
});

test('zero-row terminal attestation update aborts preparation transaction', async () => {
  let digest = '';
  clientQuery.mockImplementation(async (sqlValue: unknown, values: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs run') && sql.includes('FOR UPDATE OF run')) {
      return {
        rowCount: 1,
        rows: [{
          status: 'done',
          dispatch_fence: 'dispatch-fence-prepare',
          intent_fence: null,
          cancellation_requested: false,
        }],
      };
    }
    if (sql.includes('INSERT INTO pipeline_run_release_intents')) {
      digest = String(values[16]);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT identity_hash')) return { rowCount: 1, rows: [{ identity_hash: digest }] };
    if (sql.includes('UPDATE pipeline_runs')) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  });
  await expect(prepareRunReleaseIntent(input() as never)).rejects.toThrow(/attestation.*did not bind/);
});
