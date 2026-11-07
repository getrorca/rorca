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
const execute = jest.fn();
const relay = jest.fn();
const transaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: jest.fn(), queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  transaction: (...args: unknown[]) => transaction(...args),
}));
jest.mock('../release-identity', () => ({
  revalidateRunReleaseIdentity: jest.fn().mockResolvedValue(undefined),
  withRunReleaseLock: async (_identity: unknown, fn: () => Promise<unknown>) => fn(),
  withGithubReleaseActuation: jest.fn(),
}));
jest.mock('../merge-handler', () => ({ performMerge: jest.fn() }));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(), githubRepoApiUrl: jest.fn(), assertGithubRef: jest.fn(),
}));
jest.mock('../github-token-resolver', () => ({ resolveWorkspaceGitHubToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({ fetchGithubWithTimeout: jest.fn() }));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: jest.fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: jest.fn() }));
jest.mock('../trusted-wal', () => ({
  persistTrustedWalEvent: jest.fn(),
  relayTrustedWalEvent: (...args: unknown[]) => relay(...args),
  trustedWalReference: () => ({
    id: 501, ingestKey: 'terminal', identityHash: 'f'.repeat(64), eventType: 'run_finished',
    workspaceId: 'ws-state', runId: 121, specId: 'state', storyId: null,
    source: 'worker', storyResultId: null, payload: { status: 'done' },
  }),
}));

import { reconcileRunReleaseIntent } from '../release-authority';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let root: string;
let workspace: string;
let source: string;
let intent: Record<string, any>;
let cleanupPendingWrites: number;
let failCleanupCompletionOnce: boolean;
let canonicalRunStatus: string;

beforeEach(() => {
  jest.clearAllMocks();
  cleanupPendingWrites = 0;
  failCleanupCompletionOnce = false;
  canonicalRunStatus = 'release_pending';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-reconcile-state-'));
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
  git(workspace, 'worktree', 'add', '-q', '-b', 'run/state', source);
  fs.writeFileSync(path.join(source, 'story.txt'), 'story\n');
  git(source, 'add', 'story.txt');
  git(source, 'commit', '-q', '-m', 'story');
  const sha = git(source, 'rev-parse', 'HEAD');
  intent = {
    run_id: 121, workspace_id: 'ws-state', spec_id: 'state', authorized_sha: sha,
    branch_name: 'run/state', execution_workspace_path: fs.realpathSync(workspace), execution_worktree_path: fs.realpathSync(source),
    repository_owner: null, repository_name: null, repository_authority_source: null,
    repository_binding_id: null, repository_installation_id: null, repository_id: null,
    merge_strategy: 'direct', auto_merge: true, external_send: false, identity_hash: 'e'.repeat(64),
    status: 'processing',
    step_state: {
      merge: 'completed', push: 'not_required', local_base: 'completed', pr: 'not_required',
      workflow: 'not_required', integration_cleanup: 'completed', release_closeout: 'completed',
      terminal_intent: 'completed',
    },
    base_branch: 'main', base_sha: base, provider_release_ref: null,
    integration_checkout_path: path.join(fs.realpathSync(root), 'integration'), merge_commit_sha: sha,
    terminal_event_id: 501,
    host_closeout_event_id: 502,
    host_closeout_identity_hash: 'c'.repeat(64),
    dispatch_fence: 'dispatch-state-121',
  };
  queryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('pipeline_run_release_intents')) return intent;
    if (sql.includes('wal_events')) return { id: 501 };
    if (sql.includes('worktree_cleanup_status')) return { worktree_cleanup_status: 'completed' };
    return undefined;
  });
  execute.mockImplementation(async (sqlValue: unknown, values: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes('jsonb_set(step_state')) {
      intent.step_state[String(values[1])] = String(values[2]);
    }
    if (sql.includes("worktree_cleanup_status = 'pending'")) cleanupPendingWrites++;
    if (sql.includes("worktree_cleanup_status = 'completed'") && failCleanupCompletionOnce) {
      failCleanupCompletionOnce = false;
      throw new Error('crash after authorized removal');
    }
    if (sql.includes("SET status = 'completed'")) intent.status = 'completed';
    if (sql.includes("SET status = 'pending'")) intent.status = 'pending';
    return { rowCount: 1, rows: [{ id: 121 }] };
  });
  transaction.mockImplementation(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) => fn({
    query: jest.fn().mockImplementation(async (sqlValue: unknown, values: unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT run.status')) {
        return {
          rowCount: 1,
          rows: [{
            status: canonicalRunStatus,
            dispatch_fence: intent.dispatch_fence,
            intent_fence: intent.dispatch_fence,
            cancellation_requested: false,
          }],
        };
      }
      if (sql.includes('jsonb_set(step_state')) {
        intent.step_state[String(values[1])] = String(values[2]);
      }
      if (sql.includes("SET status = 'done'")) canonicalRunStatus = 'done';
      if (sql.includes("SET status = 'processing'")) intent.status = 'processing';
      if (sql.includes("SET status = 'completed'")) intent.status = 'completed';
      return {
        rowCount: sql.includes('UPDATE wal_events') ? 2 : 1,
        rows: sql.includes('UPDATE wal_events') ? [{ id: 501 }, { id: 502 }] : [{ id: 121 }],
      };
    }),
  }));
  relay.mockResolvedValue(undefined);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('cleanup success followed by relay failure never reruns or downgrades completed cleanup', async () => {
  relay.mockRejectedValueOnce(new Error('relay unavailable')).mockResolvedValueOnce(undefined);
  await expect(reconcileRunReleaseIntent(121)).resolves.toMatchObject({ status: 'blocked' });
  expect(fs.existsSync(source)).toBe(false);
  expect(intent.step_state.cleanup).toBe('completed');
  expect(cleanupPendingWrites).toBe(1);
  await expect(reconcileRunReleaseIntent(121)).resolves.toEqual({ runId: 121, status: 'completed' });
  expect(cleanupPendingWrites).toBe(1);
  expect(intent.step_state.cleanup).toBe('completed');
});

test.each(['pr', 'draft-pr', 'branch-only'] as const)(
  'retry %s release survives crash after public done and converges through one terminal relay',
  async (strategy) => {
    intent.merge_strategy = strategy;
    intent.auto_merge = false;
    intent.external_send = true;
    intent.repository_owner = 'getrorca';
    intent.repository_name = 'rorca';
    intent.repository_authority_source = 'github-app-installation';
    intent.repository_binding_id = 'binding';
    intent.repository_installation_id = 1;
    intent.repository_id = 2;
    intent.provider_release_ref = `rorca/release/run-121-${String(intent.authorized_sha).slice(0, 12)}`;
    intent.step_state.push = 'completed';
    intent.step_state.pr = strategy === 'branch-only' ? 'not_required' : 'completed';
    intent.step_state.cleanup = 'not_required';
    relay.mockRejectedValueOnce(new Error('crash after public done')).mockResolvedValueOnce(undefined);
    await expect(reconcileRunReleaseIntent(121)).resolves.toMatchObject({ status: 'blocked' });
    expect(intent.step_state.public_done).toBe('completed');
    await expect(reconcileRunReleaseIntent(121)).resolves.toEqual({ runId: 121, status: 'completed' });
    expect(relay).toHaveBeenCalledTimes(2);
  },
);

test('crash after worktree removal treats exact absent/unregistered target as idempotent completion', async () => {
  failCleanupCompletionOnce = true;
  await expect(reconcileRunReleaseIntent(121)).resolves.toMatchObject({ status: 'blocked' });
  expect(fs.existsSync(source)).toBe(false);
  expect(intent.step_state.cleanup).toBe('failed');
  await expect(reconcileRunReleaseIntent(121)).resolves.toEqual({ runId: 121, status: 'completed' });
  expect(intent.step_state.cleanup).toBe('completed');
  expect(cleanupPendingWrites).toBe(2);
});
