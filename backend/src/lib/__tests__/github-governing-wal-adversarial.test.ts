/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const queryOne = jest.fn();
const query = jest.fn();
const execute = jest.fn().mockResolvedValue({ rowCount: 1 });
const transaction = jest.fn();
const resolveToken = jest.fn();
const getAuthority = jest.fn();
const providerFetch = jest.fn();
const inspectRunHostAuthority = jest.fn();
const assertCanonicalRunCheckout = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  query: (...args: unknown[]) => query(...args),
  execute: (...args: unknown[]) => execute(...args),
  transaction: (...args: unknown[]) => transaction(...args),
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
jest.mock('../run-host-authority', () => ({
  inspectRunHostAuthority: (...args: unknown[]) => inspectRunHostAuthority(...args),
}));
jest.mock('../run-git-authority', () => ({
  assertCanonicalRunCheckout: (...args: unknown[]) => assertCanonicalRunCheckout(...args),
}));

import { handleCommitStatusWalEvent } from '../commit-status-poster';
import {
  handleCheckRunWalEvent,
  reconcileCheckRunProjection,
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
let projection: Record<string, unknown> | undefined;
let includePassOutboxes = true;

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
    closeout_manifest_hash: `sha256:${storyId.padEnd(64, '1').slice(0, 64)}`,
    manifest_hash: `sha256:${storyId.padEnd(64, '1').slice(0, 64)}`,
    integrated: true,
    result_commit_sha: commitSha,
    result_commit_message: `integrated ${storyId}`,
    result_commit_author: 'rorca-execution-engine',
    result_commit_branch: 'run/spec-a',
    result_commit_source: 'worktree_branch',
    result_provenance: 'host',
    result_source: 'execution-engine',
    commit_sha: commitSha,
    commit_message: `integrated ${storyId}`,
    observed_source: 'worktree_branch',
    author: 'rorca-execution-engine',
    branch_name: 'run/spec-a',
    pushed_at: pushedAt,
    commit_count: 1,
  };
}

const projectionClient = {
  query: jest.fn(async (sqlValue: unknown, params: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (sql.includes('SELECT * FROM github_check_run_projections')) {
      return { rows: projection ? [projection] : [] };
    }
    if (sql.includes('INSERT INTO github_check_run_projections')) {
      projection = {
        run_id: Number(params[0]), workspace_id: params[1], spec_id: params[2],
        desired_event_id: params[3], desired_event_identity_hash: params[4],
        desired_state: params[5], head_sha: params[6], conclusion: params[7],
        desired_payload: JSON.parse(String(params[8])), desired_payload_hash: params[9],
        external_id: params[10], projection_status: 'pending', check_run_id: null,
        provider_head_sha: null, claim_token: null, claimed_at: null, attempts: 0,
        next_attempt_at: null,
      };
      return { rows: [] };
    }
    if (sql.includes('SET desired_event_id')) {
      projection = {
        ...projection,
        desired_event_id: params[1], desired_event_identity_hash: params[2],
        desired_state: params[3], head_sha: params[4], conclusion: params[5],
        desired_payload: JSON.parse(String(params[6])), desired_payload_hash: params[7],
        projection_status: 'pending', claim_token: null, claimed_at: null,
      };
      return { rows: [] };
    }
    if (sql.includes("SET projection_status = 'processing'")) {
      projection = { ...projection, projection_status: 'processing', claim_token: params[1], claimed_at: new Date().toISOString(), attempts: Number(projection?.attempts ?? 0) + 1 };
      return { rows: [projection] };
    }
    return { rows: [] };
  }),
};

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
  projection = undefined;
  includePassOutboxes = true;
  transaction.mockImplementation(async (fn: (client: typeof projectionClient) => Promise<unknown>) => fn(projectionClient));
  execute.mockImplementation(async (sqlValue: unknown, params: unknown[] = []) => {
    if (String(sqlValue).includes('UPDATE github_check_run_projections') && projection) {
      projection = {
        ...projection,
        projection_status: params[3],
        check_run_id: params[4] ?? projection.check_run_id,
        provider_head_sha: params[5] ?? projection.provider_head_sha,
        claim_token: null,
        claimed_at: null,
      };
    }
    return { rowCount: 1 };
  });
  resolveToken.mockResolvedValue({ token: 'host-token' });
  getAuthority.mockResolvedValue({ owner: 'acme', name: 'widgets' });
  assertCanonicalRunCheckout.mockImplementation(() => ({
    headSha: terminalRows.filter(row => row.status === 'pass').at(-1)?.commit_sha ?? 'b'.repeat(40),
    branchName: 'run/spec-a', cwd: '/tmp/canonical-run', repositoryTopLevel: '/tmp/canonical-run',
  }));
  inspectRunHostAuthority.mockImplementation(async () => {
    if (!currentRun.spec_path.endsWith('/spec-a.json')) return null;
    const expected = currentRun.expected_story_ids ?? [];
    const governing = terminalRows.filter(row => row.result_provenance === 'host'
      && ['execution-engine', 'worker'].includes(String(row.result_source)));
    if (governing.length !== expected.length || !includePassOutboxes) return null;
    const final = governing.filter(row => row.status === 'pass').at(-1)?.commit_sha as string | undefined;
    return {
      runId: currentRun.id, workspaceId: currentRun.workspace_id, specId: 'spec-a',
      status: currentRun.status, lifecycleStatus: currentRun.lifecycle_status,
      finishedAt: currentRun.finished_at, branchName: 'run/spec-a',
      checkoutPath: '/tmp/canonical-run', repositoryTopLevel: '/tmp/canonical-run',
      expectedStoryIds: expected, excludedStoryIds: [],
      stories: governing.map(row => ({ storyId: row.story_id, status: row.status, reason: row.reason,
        finishedAt: row.finished_at, resultId: Number(row.id), commitSha: row.commit_sha })),
      authoritativePassedStoryIds: governing.filter(row => row.status === 'pass').map(row => row.story_id),
      finalCommitSha: final ?? null, complete: true,
      releaseEligible: governing.length > 0 && governing.every(row => row.status === 'pass'), invalidReason: null,
    };
  });
  providerFetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.includes('/commits/') && init.method === 'GET') return response({ total_count: 0, check_runs: [] });
    if (url.endsWith('/check-runs') && init.method === 'POST') return response({ id: 101 }, 201);
    return response({}, 200);
  });
  queryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('SELECT id, workspace_id, spec_path, status, lifecycle_status')) return currentRun;
    if (sql.includes('SELECT pr.worktree_path')) {
      return { worktree_path: '/tmp/canonical-run', workspace_id: currentRun.workspace_id,
        branch_name: 'run/spec-a', workspace_path: '/tmp/canonical-run' };
    }
    if (sql.includes('FROM story_results sr')) return storyAuthority;
    if (sql.includes('SELECT status, result_provenance, result_source FROM story_results')) {
      return latestTerminalStatus ? {
        status: latestTerminalStatus,
        result_provenance: 'host',
        result_source: 'execution-engine',
      } : undefined;
    }
    if (sql.includes('INSERT INTO wal_events')) return undefined;
    return undefined;
  });
  query.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('DISTINCT ON (sr.story_id)')) return terminalRows;
    if (sql.includes("FROM wal_events") && sql.includes("trusted_source = 'story-result'")) {
      if (!includePassOutboxes) return [];
      return terminalRows.filter(row => row.status === 'pass').map(row => trustedEvent({
        eventType: 'story_passed',
        storyId: String(row.story_id),
        source: 'story-result',
        payload: {
          story_result_id: Number(row.id),
          closeout_decision_id: String(row.closeout_decision_id),
          commit_sha: String(row.result_commit_sha),
        },
      }));
    }
    return [];
  });
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

  test('story commit statuses are explicitly inert even for an exact trusted pass', async () => {
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

    expect(resolveToken).not.toHaveBeenCalled();
    expect(getAuthority).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
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

  test('forged journal pass replayed after closeout never reaches repository or token resolution', async () => {
    currentRun = {
      ...currentRun,
      status: 'done',
      lifecycle_status: 'finished',
      expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [{
      ...acceptedRow('US-001', 77, PASS_SHA, '2026-07-18T10:01:00.000Z'),
      result_provenance: 'recovery_proposal',
      result_source: 'fallback-journal',
    }];
    includePassOutboxes = false;
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(getAuthority).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  test.each([
    ['skip', 'recovery_proposal', 'fallback-journal'],
    ['excluded', 'recovery_proposal', 'fallback-journal'],
    ['skip', 'compatibility', 'compatibility-http'],
    ['excluded', 'compatibility', 'compatibility-http'],
  ])('a forged %s after a valid pass is inert and never reaches repository/token authority', async (status, provenance, source) => {
    currentRun = {
      ...currentRun,
      status: 'done', lifecycle_status: 'finished',
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [
      acceptedRow('US-001', 1, PASS_SHA, '2026-07-18T10:01:00.000Z'),
      { ...acceptedRow('US-002', 3, FINAL_SHA, '2026-07-18T10:02:00.000Z'),
        status, result_provenance: provenance, result_source: source,
        integrated: false, commit_sha: null, result_commit_sha: null },
    ];
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(getAuthority).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  test('a host-looking pass without its one released immutable outbox never resolves a token', async () => {
    currentRun = {
      ...currentRun,
      status: 'done',
      lifecycle_status: 'finished',
      expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 78, PASS_SHA, '2026-07-18T10:01:00.000Z')];
    includePassOutboxes = false;
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(getAuthority).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
  });

  test('wrong canonical workspace state cannot complete a check run', async () => {
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

  test('terminal-before-start ordering creates one exact completed provider check', async () => {
    currentRun = {
      ...currentRun,
      status: 'done', lifecycle_status: 'finished', expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, FINAL_SHA, '2026-07-18T10:02:00.000Z')];
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    const providerCalls = providerFetch.mock.calls.length;
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_started', source: 'worker', payload: { spec_path: currentRun.spec_path },
    }));
    expect(providerFetch).toHaveBeenCalledTimes(providerCalls);
    expect(providerFetch.mock.calls.filter(([url, init]: [string, RequestInit]) =>
      url.endsWith('/check-runs') && init.method === 'POST')).toHaveLength(1);
  });

  test('provider-uncertain create is reconciled by external identity after restart without a second create', async () => {
    currentRun = {
      ...currentRun,
      status: 'done', lifecycle_status: 'finished', expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, FINAL_SHA, '2026-07-18T10:02:00.000Z')];
    let createAttempts = 0;
    providerFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/commits/') && init.method === 'GET') {
        return response(createAttempts === 0 ? { total_count: 0, check_runs: [] } : {
          total_count: 1,
          check_runs: [{ id: 909, external_id: 'rorca:pipeline-run:41:v1', head_sha: FINAL_SHA }],
        });
      }
      if (url.endsWith('/check-runs') && init.method === 'POST') {
        createAttempts++;
        throw Object.assign(new Error('connection reset after provider accepted request'), { code: 'ECONNRESET' });
      }
      if (url.endsWith('/check-runs/909') && init.method === 'PATCH') return response({}, 200);
      return response({}, 200);
    });
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(projection?.projection_status).toBe('uncertain');
    resetCheckRunPosterForTests(); // process-memory loss; durable projection remains
    await reconcileCheckRunProjection(41);
    expect(createAttempts).toBe(1);
    expect(providerFetch.mock.calls.some(([url, init]: [string, RequestInit]) =>
      url.endsWith('/check-runs/909') && init.method === 'PATCH')).toBe(true);
    expect(projection?.projection_status).toBe('completed');
  });

  test('provider-uncertain discovery deterministically paginates beyond the first 100', async () => {
    currentRun = {
      ...currentRun,
      status: 'done', lifecycle_status: 'finished', expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, FINAL_SHA, '2026-07-18T10:02:00.000Z')];
    providerFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/commits/') && init.method === 'GET') {
        if (url.includes('page=2')) return response({ total_count: 101, check_runs: [
          { id: 910, external_id: 'rorca:pipeline-run:41:v1', head_sha: FINAL_SHA },
        ] });
        return response({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, id) => ({
          id: id + 1, external_id: `other:${id}`, head_sha: FINAL_SHA,
        })) });
      }
      if (url.endsWith('/check-runs/910') && init.method === 'PATCH') return response({}, 200);
      return response({ id: 999 }, 201);
    });
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(providerFetch.mock.calls.some(([url]: [string]) => url.includes('page=2'))).toBe(true);
    expect(providerFetch.mock.calls.filter(([url, init]: [string, RequestInit]) =>
      url.endsWith('/check-runs') && init.method === 'POST')).toHaveLength(0);
    expect(projection?.check_run_id).toBe(910);
  });

  test.each([
    ['missing check_runs', { total_count: 0 }],
    ['missing total_count', { check_runs: [] }],
    ['negative total_count', { total_count: -1, check_runs: [] }],
    ['unsafe total_count', { total_count: Number.MAX_SAFE_INTEGER + 1, check_runs: [] }],
    ['under-reported total_count', { total_count: 1, check_runs: [] }],
  ])('malformed discovery shape (%s) remains uncertain and never creates', async (_label, malformed) => {
    currentRun = {
      ...currentRun,
      status: 'done', lifecycle_status: 'finished', expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, FINAL_SHA, '2026-07-18T10:02:00.000Z')];
    providerFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/commits/') && init.method === 'GET') return response(malformed);
      if (url.endsWith('/check-runs') && init.method === 'POST') return response({ id: 999 }, 201);
      return response({}, 200);
    });
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(projection?.projection_status).toBe('uncertain');
    expect(providerFetch.mock.calls.filter(([url, init]: [string, RequestInit]) =>
      url.endsWith('/check-runs') && init.method === 'POST')).toHaveLength(0);
  });

  test('a failed terminal run cannot publish neutral or success merely because its last story passed', async () => {
    currentRun = {
      ...currentRun,
      status: 'failed', lifecycle_status: 'failed', expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, FINAL_SHA, '2026-07-18T10:02:00.000Z')];
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'failed' },
    }));
    const terminalWrite = providerFetch.mock.calls.find(([url, init]: [string, RequestInit]) =>
      url.endsWith('/check-runs') && init.method === 'POST');
    expect(terminalWrite).toBeDefined();
    expect(JSON.parse(String(terminalWrite?.[1].body))).toMatchObject({
      head_sha: FINAL_SHA, status: 'completed', conclusion: 'failure',
    });
  });

  test('branch/HEAD drift after durable acceptance blocks repository and token resolution', async () => {
    currentRun = {
      ...currentRun,
      status: 'done', lifecycle_status: 'finished', expected_story_ids: ['US-001'],
      finished_at: '2026-07-18T10:02:00.000Z',
    };
    terminalRows = [acceptedRow('US-001', 1, FINAL_SHA, '2026-07-18T10:02:00.000Z')];
    assertCanonicalRunCheckout.mockReturnValue({
      headSha: PASS_SHA, branchName: 'run/spec-a', cwd: '/tmp/canonical-run', repositoryTopLevel: '/tmp/canonical-run',
    });
    await handleCheckRunWalEvent(trustedEvent({
      eventType: 'run_finished', source: 'worker', payload: { status: 'done' },
    }));
    expect(getAuthority).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
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
      expect.objectContaining({
        url: expect.stringMatching(/\/check-runs$/),
        method: 'POST',
        body: expect.objectContaining({
          head_sha: FINAL_SHA,
          external_id: 'rorca:pipeline-run:41:v1',
          status: 'completed',
          conclusion: 'success',
        }),
      }),
    ]));
    expect(resolveToken).toHaveBeenCalled();
  });
});
