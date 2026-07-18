/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const queryOne = jest.fn();
const query = jest.fn();
const execute = jest.fn().mockResolvedValue({ rowCount: 1 });
const resolveToken = jest.fn();
const getAuthority = jest.fn();
const providerFetch = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  query: (...args: unknown[]) => query(...args),
  execute: (...args: unknown[]) => execute(...args),
  transaction: jest.fn(),
}));
jest.mock('child_process', () => ({
  execSync: jest.fn(() => `${'b'.repeat(40)}\n`),
}));
jest.mock('../github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: (...args: unknown[]) => resolveToken(...args),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: (...args: unknown[]) => getAuthority(...args),
  githubRepoApiUrl: (owner: string, repo: string, suffix: string) => `https://api.github.test/repos/${owner}/${repo}${suffix}`,
  isFullGitObjectId: (value: unknown) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value),
}));
jest.mock('../github-app-credential-provider', () => ({
  fetchGithubWithTimeout: (_fetch: unknown, url: string, init: RequestInit) => providerFetch(url, init),
}));
jest.mock('../github-rate-limiter', () => ({
  githubRateLimiter: { execute: (operation: () => unknown) => operation() },
}));

import { handleCommitStatusWalEvent } from '../commit-status-poster';
import {
  handleCheckRunWalEvent,
  resetCheckRunPosterForTests,
} from '../check-run-poster';
import { trustedWalIdentityHash, type TrustedWalSource } from '../trusted-wal';
import type { WalEvent } from '../sse-hub';

const PASS_SHA = 'a'.repeat(40);
const FINAL_SHA = 'c'.repeat(40);
let eventId = 1;
let currentRun: {
  id: number;
  workspace_id: string;
  spec_path: string;
  status: string;
  lifecycle_status: string;
  expected_story_ids: string[] | null;
  finished_at: string | null;
};
let storyAuthority: Record<string, unknown> | undefined;
let latestTerminalStatus: string | undefined;
let terminalRows: Array<Record<string, unknown>> = [];

function response(body: unknown = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

function trustedEvent(input: {
  eventType: string;
  workspaceId?: string;
  runId?: number;
  specId?: string;
  storyId?: string | null;
  source: TrustedWalSource;
  payload?: Record<string, unknown>;
}): WalEvent {
  const workspaceId = input.workspaceId ?? 'ws-a';
  const runId = input.runId ?? 41;
  const specId = input.specId ?? 'spec-a';
  const storyId = input.storyId ?? null;
  const payload: Record<string, unknown> = {
    ...(input.payload ?? {}), run_id: runId, ...(storyId ? { story_id: storyId } : {}),
  };
  const storyResultId = input.source === 'story-result' ? Number(payload.story_result_id) : null;
  const hash = trustedWalIdentityHash({
    eventType: input.eventType,
    workspaceId,
    runId,
    specId,
    storyId,
    source: input.source,
    storyResultId,
    payload,
  });
  return {
    id: eventId++,
    ts: '2026-07-18T10:00:00.000Z',
    event_type: input.eventType,
    workspace_id: workspaceId,
    spec_id: specId,
    story_id: storyId,
    actor: 'rorca-host',
    payload: JSON.stringify(payload),
    ingest_key: `trusted-wal:v1:${hash}`,
    trust_provenance: 'host',
    trusted_source: input.source,
    canonical_run_id: runId,
    story_result_id: storyResultId,
    event_identity_hash: hash,
    outbox_ready_at: '2026-07-18T10:00:00.000Z',
    outbox_relayed_at: null,
  };
}

function acceptedRow(storyId: string, resultId: number, commitSha: string, pushedAt: string) {
  return {
    id: resultId,
    story_id: storyId,
    status: 'pass',
    spec_id: 'spec-a',
    reason: null,
    finished_at: '2026-07-18T10:01:00.000Z',
    closeout_decision_id: `CLO-${storyId}`,
    closeout_status: 'accepted',
    commit_sha: commitSha,
    observed_source: 'worktree_branch',
    author: 'rorca-execution-engine',
    pushed_at: pushedAt,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetCheckRunPosterForTests();
  eventId = 1;
  currentRun = {
    id: 41,
    workspace_id: 'ws-a',
    spec_path: 'forge/specs/approved/spec-a.json',
    status: 'running',
    lifecycle_status: 'running',
    expected_story_ids: ['US-001', 'US-002'],
    finished_at: null,
  };
  storyAuthority = undefined;
  latestTerminalStatus = undefined;
  terminalRows = [];
  resolveToken.mockResolvedValue({ token: 'host-token' });
  getAuthority.mockResolvedValue({ owner: 'acme', name: 'widgets' });
  providerFetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/check-runs') && init.method === 'POST') return response({ id: 101 }, 201);
    return response({}, 200);
  });
  queryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('SELECT id, workspace_id, spec_path, status, lifecycle_status')) return currentRun;
    if (sql.includes('SELECT worktree_path, workspace_id FROM pipeline_runs')) {
      return { worktree_path: '/tmp/canonical-run', workspace_id: currentRun.workspace_id };
    }
    if (sql.includes('FROM story_results sr')) return storyAuthority;
    if (sql.includes('SELECT status FROM story_results')) {
      return latestTerminalStatus ? { status: latestTerminalStatus } : undefined;
    }
    if (sql.includes('INSERT INTO wal_events')) return undefined;
    return undefined;
  });
  query.mockImplementation(async (sqlValue: unknown) => String(sqlValue).includes('DISTINCT ON (sr.story_id)')
    ? terminalRows
    : []);
});

afterEach(() => resetCheckRunPosterForTests());

describe('commit status trusted authority', () => {
  test('forged caller WAL and cross-workspace run events never resolve authority or a token', async () => {
    const forged: WalEvent = {
      id: 1,
      ts: '2026-07-18T10:00:00.000Z',
      event_type: 'story_passed',
      workspace_id: 'ws-a',
      spec_id: 'spec-a',
      story_id: 'US-001',
      actor: 'caller',
      payload: JSON.stringify({ run_id: 41, commit_sha: PASS_SHA }),
      trust_provenance: 'untrusted',
    };
    await handleCommitStatusWalEvent(forged);

    const crossWorkspace = trustedEvent({
      eventType: 'story_passed',
      workspaceId: 'ws-other',
      storyId: 'US-001',
      source: 'story-result',
      payload: { story_result_id: 1, closeout_decision_id: 'CLO-US-001', commit_sha: PASS_SHA },
    });
    await handleCommitStatusWalEvent(crossWorkspace);

    expect(resolveToken).not.toHaveBeenCalled();
    expect(getAuthority).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  test('missing accepted closeout does nothing, while exact trusted pass posts only its canonical SHA', async () => {
    const event = trustedEvent({
      eventType: 'story_passed',
      storyId: 'US-001',
      source: 'story-result',
      payload: { story_result_id: 7, closeout_decision_id: 'CLO-US-001', commit_sha: PASS_SHA },
    });
    storyAuthority = { ...acceptedRow('US-001', 7, PASS_SHA, '2026-07-18T10:01:00.000Z'), closeout_status: null };
    await handleCommitStatusWalEvent(event);
    expect(resolveToken).not.toHaveBeenCalled();

    storyAuthority = acceptedRow('US-001', 7, PASS_SHA, '2026-07-18T10:01:00.000Z');
    await handleCommitStatusWalEvent(event);

    expect(resolveToken).toHaveBeenCalledWith('ws-a', expect.objectContaining({ purpose: 'statuses-write' }));
    const [, init] = providerFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(providerFetch.mock.calls.at(-1)?.[0]).toContain(`/statuses/${PASS_SHA}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ state: 'success' });
  });
});

describe('check run terminal completeness authority', () => {
  async function startWorkspaceA(): Promise<void> {
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_started',
      source: 'worker',
      payload: { spec_path: currentRun.spec_path },
    }));
  }

  test('early run_finished and incomplete latest story sets perform no provider mutation', async () => {
    await startWorkspaceA();
    const callsAfterStart = providerFetch.mock.calls.length;
    const finish = trustedEvent({ eventType: 'run_finished', source: 'worker', payload: { status: 'done' } });

    await handleCheckRunWalEvent(finish);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterStart);

    currentRun = {
      ...currentRun,
      status: 'done',
      lifecycle_status: 'finished',
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, PASS_SHA, '2026-07-18T10:01:00.000Z')];
    await handleCheckRunWalEvent(finish);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterStart);
  });

  test('wrong in-memory workspace state cannot complete a check run', async () => {
    await startWorkspaceA();
    const callsAfterStart = providerFetch.mock.calls.length;
    currentRun = {
      ...currentRun,
      workspace_id: 'ws-b',
      spec_path: 'forge/specs/approved/spec-b.json',
      status: 'done',
      lifecycle_status: 'finished',
      expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [{
      ...acceptedRow('US-001', 1, PASS_SHA, '2026-07-18T10:01:00.000Z'),
      spec_id: 'spec-b',
    }];
    const finishB = trustedEvent({
      eventType: 'run_finished',
      workspaceId: 'ws-b',
      specId: 'spec-b',
      source: 'worker',
      payload: { status: 'done' },
    });
    await handleCheckRunWalEvent(finishB);
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterStart);
  });

  test('publishes success on the exact final SHA only for a trusted complete terminal run', async () => {
    await startWorkspaceA();
    providerFetch.mockClear();
    resolveToken.mockClear();
    currentRun = {
      ...currentRun,
      status: 'done',
      lifecycle_status: 'finished',
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [
      acceptedRow('US-001', 1, PASS_SHA, '2026-07-18T10:01:00.000Z'),
      acceptedRow('US-002', 2, FINAL_SHA, '2026-07-18T10:02:00.000Z'),
    ];
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished',
      source: 'worker',
      payload: { status: 'done' },
    }));

    const parsedCalls = providerFetch.mock.calls.map(([url, init]: [string, RequestInit]) => ({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      method: init.method,
    }));
    expect(parsedCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/check-runs'), body: expect.objectContaining({ head_sha: FINAL_SHA }) }),
      expect.objectContaining({ url: expect.stringContaining('/check-runs/101'), body: expect.objectContaining({ conclusion: 'success' }) }),
    ]));
    expect(resolveToken).toHaveBeenCalled();
  });
});
