/**
 * Tests for CI Autofix feedback loop (handleRunFinished):
 * - All stories passed → success commit status + completed row
 * - Some stories failed → failure commit status + failed row + error_summary
 * - No GitHub connection → warning logged, row still updated
 * - Non-autofix runs are ignored
 * - Missing ci_autofix_runs row is handled gracefully
 */

jest.mock('../../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
  execute: jest.fn(),
}));

jest.mock('../../sse-hub', () => ({
  broadcastAll: jest.fn(),
  subscribe: jest.fn(),
}));

jest.mock('../../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../lib/token-crypto', () => ({
  decryptToken: jest.fn(() => 'ghp_test_token_123'),
}));

jest.mock('../../github-rate-limiter', () => ({
  githubRateLimiter: {
    execute: jest.fn((fn: () => Promise<Response>) => fn()),
  },
}));

jest.mock('../../pg-boss', () => ({
  getBoss: jest.fn(),
}));

import { queryOne, query, execute } from '../../../db/index';
import { broadcastAll } from '../../sse-hub';
import { logger } from '../../logger';
import { decryptToken } from '../../../lib/token-crypto';
import { handleRunFinished } from '../fix-orchestrator';
import type { WalEvent } from '../../sse-hub';

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockExecute = execute as jest.MockedFunction<typeof execute>;
const mockBroadcastAll = broadcastAll as jest.MockedFunction<typeof broadcastAll>;
const mockDecryptToken = decryptToken as jest.MockedFunction<typeof decryptToken>;

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockDecryptToken.mockReturnValue('ghp_test_token_123');
});

function makeRunFinishedEvent(runId: number, status = 'done'): WalEvent {
  return {
    id: 100,
    ts: new Date().toISOString(),
    event_type: 'run_finished',
    workspace_id: 'ws-1',
    spec_id: null,
    story_id: null,
    actor: 'worker',
    payload: JSON.stringify({ run_id: runId, status, source: 'worker' }),
  };
}

// ─── Test: All stories passed → success commit status + completed row ─────

describe('handleRunFinished — success path', () => {
  test('all stories passed → posts success commit status and updates row to completed', async () => {
    // pipeline_runs lookup: trigger_type = 'ci-autofix'
    mockQueryOne
      .mockResolvedValueOnce({ id: 42, status: 'done', trigger_type: 'ci-autofix' })
      // ci_autofix_runs lookup
      .mockResolvedValueOnce({
        id: 7,
        workspace_id: 'ws-1',
        head_sha: 'abc123def456789012345678901234567890abcd',
        branch_name: 'feat/my-feature',
        check_run_name: 'build',
        run_id: 42,
        agent_type: 'claude',
      })
      // workspace_github_webhooks lookup
      .mockResolvedValueOnce({ repo_owner: 'myorg', repo_name: 'myrepo' })
      // github_connections lookup
      .mockResolvedValueOnce({ encrypted_token: 'encrypted_token_data' })
      // WAL event insert
      .mockResolvedValueOnce({
        id: 200,
        event_type: 'ci_autofix_completed',
        workspace_id: 'ws-1',
        ts: new Date().toISOString(),
      });

    // story_results: all passed
    mockQuery.mockResolvedValueOnce([
      { story_id: 'CAF-FIX-001', status: 'pass', reason: null },
    ]);

    // Mock GitHub API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
    });

    await handleRunFinished(makeRunFinishedEvent(42));

    // Verify pipeline_runs query
    expect(mockQueryOne.mock.calls[0][0]).toContain('pipeline_runs');
    expect(mockQueryOne.mock.calls[0][1]).toEqual([42]);

    // Verify ci_autofix_runs query
    expect(mockQueryOne.mock.calls[1][0]).toContain('ci_autofix_runs');
    expect(mockQueryOne.mock.calls[1][1]).toEqual([42]);

    // Verify story_results query
    expect(mockQuery.mock.calls[0][0]).toContain('story_results');
    expect(mockQuery.mock.calls[0][1]).toEqual([42]);

    // Verify GitHub commit status was posted
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('api.github.com/repos/myorg/myrepo/statuses/abc123def456789012345678901234567890abcd');

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.state).toBe('success');
    expect(fetchBody.context).toBe('Rorca CI Autofix');
    expect(fetchBody.description).toContain('all errors in build resolved');

    // Verify ci_autofix_runs updated to completed
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0]).toContain('UPDATE ci_autofix_runs');
    expect(mockExecute.mock.calls[0][1]).toEqual(['completed', null, 7]);

    // Verify WAL event emitted
    const walInsert = mockQueryOne.mock.calls[4];
    expect(walInsert[0]).toContain("'ci_autofix_completed'");
    const walPayload = JSON.parse(walInsert[1]![1] as string);
    expect(walPayload.runId).toBe(42);
    expect(walPayload.success).toBe(true);
    expect(walPayload.storiesPassed).toBe(1);
    expect(walPayload.storiesFailed).toBe(0);
    expect(walPayload.agentType).toBe('claude');

    // Verify broadcastAll was called
    expect(mockBroadcastAll).toHaveBeenCalledTimes(1);
  });
});

// ─── Test: Some stories failed → failure commit status + failed row ────────

describe('handleRunFinished — failure path', () => {
  test('some stories failed → posts failure commit status and updates row to failed with error_summary', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 43, status: 'done', trigger_type: 'ci-autofix' })
      .mockResolvedValueOnce({
        id: 8,
        workspace_id: 'ws-1',
        head_sha: 'def456789012345678901234567890abcd123456',
        branch_name: 'feat/broken',
        check_run_name: 'typecheck',
        run_id: 43,
        agent_type: 'opencode',
      })
      .mockResolvedValueOnce({ repo_owner: 'myorg', repo_name: 'myrepo' })
      .mockResolvedValueOnce({ encrypted_token: 'encrypted_token_data' })
      .mockResolvedValueOnce({
        id: 201,
        event_type: 'ci_autofix_completed',
        workspace_id: 'ws-1',
        ts: new Date().toISOString(),
      });

    // story_results: one failed
    mockQuery.mockResolvedValueOnce([
      { story_id: 'CAF-FIX-001', status: 'fail', reason: 'Type errors remain in src/app.ts' },
    ]);

    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    await handleRunFinished(makeRunFinishedEvent(43));

    // Verify failure commit status
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.state).toBe('failure');
    expect(fetchBody.description).toContain('could not resolve all errors in typecheck');

    // Verify ci_autofix_runs updated to failed with error_summary
    expect(mockExecute.mock.calls[0][1]![0]).toBe('failed');
    expect(mockExecute.mock.calls[0][1]![1]).toContain('CAF-FIX-001 (fail: Type errors remain');
    expect(mockExecute.mock.calls[0][1]![2]).toBe(8);

    // Verify WAL payload
    const walPayload = JSON.parse(mockQueryOne.mock.calls[4][1]![1] as string);
    expect(walPayload.success).toBe(false);
    expect(walPayload.storiesFailed).toBe(1);
    expect(walPayload.agentType).toBe('opencode');
  });

  test('error_summary is truncated to 500 chars', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 44, status: 'done', trigger_type: 'ci-autofix' })
      .mockResolvedValueOnce({
        id: 9,
        workspace_id: 'ws-1',
        head_sha: 'aaa456789012345678901234567890abcd123456',
        branch_name: 'feat/long-errors',
        check_run_name: 'lint',
        run_id: 44,
        agent_type: 'claude',
      })
      .mockResolvedValueOnce({ repo_owner: 'myorg', repo_name: 'myrepo' })
      .mockResolvedValueOnce({ encrypted_token: 'encrypted_token_data' })
      .mockResolvedValueOnce({ id: 202, event_type: 'ci_autofix_completed' });

    // Many failed stories with long reasons
    const failedStories = Array.from({ length: 20 }, (_, i) => ({
      story_id: `STORY-${i}`,
      status: 'fail',
      reason: 'A'.repeat(100),
    }));
    mockQuery.mockResolvedValueOnce(failedStories);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    await handleRunFinished(makeRunFinishedEvent(44));

    const errorSummary = mockExecute.mock.calls[0][1]![1] as string;
    expect(errorSummary.length).toBeLessThanOrEqual(500);
  });
});

// ─── Test: No GitHub connection → warning logged, row still updated ───────

describe('handleRunFinished — no GitHub connection', () => {
  test('missing workspace_github_webhooks → logs warning, still updates ci_autofix_runs', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 45, status: 'done', trigger_type: 'ci-autofix' })
      .mockResolvedValueOnce({
        id: 10,
        workspace_id: 'ws-1',
        head_sha: 'bbb456789012345678901234567890abcd123456',
        branch_name: 'feat/no-github',
        check_run_name: 'build',
        run_id: 45,
        agent_type: 'claude',
      })
      // No workspace_github_webhooks row
      .mockResolvedValueOnce(undefined)
      // WAL event insert
      .mockResolvedValueOnce({ id: 203, event_type: 'ci_autofix_completed' });

    mockQuery.mockResolvedValueOnce([
      { story_id: 'CAF-FIX-001', status: 'pass', reason: null },
    ]);

    await handleRunFinished(makeRunFinishedEvent(45));

    // No fetch call (no GitHub status posted)
    expect(mockFetch).not.toHaveBeenCalled();

    // Warning logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No GitHub connection'),
    );

    // ci_autofix_runs STILL updated
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1]).toEqual(['completed', null, 10]);

    // WAL event STILL emitted
    expect(mockQueryOne).toHaveBeenCalledTimes(4);
  });

  test('missing github_connections token → logs warning, still updates ci_autofix_runs', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 46, status: 'done', trigger_type: 'ci-autofix' })
      .mockResolvedValueOnce({
        id: 11,
        workspace_id: 'ws-1',
        head_sha: 'ccc456789012345678901234567890abcd123456',
        branch_name: 'feat/no-token',
        check_run_name: 'build',
        run_id: 46,
        agent_type: 'claude',
      })
      .mockResolvedValueOnce({ repo_owner: 'myorg', repo_name: 'myrepo' })
      // No github_connections row
      .mockResolvedValueOnce(undefined)
      // WAL event insert
      .mockResolvedValueOnce({ id: 204, event_type: 'ci_autofix_completed' });

    mockQuery.mockResolvedValueOnce([
      { story_id: 'CAF-FIX-001', status: 'pass', reason: null },
    ]);

    await handleRunFinished(makeRunFinishedEvent(46));

    // No fetch call
    expect(mockFetch).not.toHaveBeenCalled();

    // Warning logged about token
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No GitHub token'),
    );

    // ci_autofix_runs STILL updated
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1]).toEqual(['completed', null, 11]);
  });
});

// ─── Test: Non-autofix runs are ignored ───────────────────────────────────

describe('handleRunFinished — filtering', () => {
  test('non-autofix run (trigger_type !== ci-autofix) is ignored', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 50, status: 'done', trigger_type: 'manual' });

    await handleRunFinished(makeRunFinishedEvent(50));

    // Only one DB call (pipeline_runs lookup)
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('non-run_finished event type is ignored', async () => {
    const event: WalEvent = {
      id: 101,
      ts: new Date().toISOString(),
      event_type: 'story_passed',
      workspace_id: 'ws-1',
      spec_id: null,
      story_id: 'US-001',
      actor: 'worker',
      payload: JSON.stringify({ run_id: 42 }),
    };

    await handleRunFinished(event);

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('event with no payload is ignored', async () => {
    const event: WalEvent = {
      id: 102,
      ts: new Date().toISOString(),
      event_type: 'run_finished',
      workspace_id: 'ws-1',
      spec_id: null,
      story_id: null,
      actor: 'worker',
      payload: null,
    };

    await handleRunFinished(event);

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('missing ci_autofix_runs row → warning logged and returns', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 51, status: 'done', trigger_type: 'ci-autofix' })
      // No ci_autofix_runs row
      .mockResolvedValueOnce(undefined);

    await handleRunFinished(makeRunFinishedEvent(51));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No ci_autofix_runs row found'),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ─── Test: Timeout stories count as failures ──────────────────────────────

describe('handleRunFinished — timeout handling', () => {
  test('timed-out stories count as failures', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 47, status: 'done', trigger_type: 'ci-autofix' })
      .mockResolvedValueOnce({
        id: 12,
        workspace_id: 'ws-1',
        head_sha: 'ddd456789012345678901234567890abcd123456',
        branch_name: 'feat/timeout',
        check_run_name: 'build',
        run_id: 47,
        agent_type: 'claude',
      })
      .mockResolvedValueOnce({ repo_owner: 'myorg', repo_name: 'myrepo' })
      .mockResolvedValueOnce({ encrypted_token: 'encrypted_token_data' })
      .mockResolvedValueOnce({ id: 205, event_type: 'ci_autofix_completed' });

    mockQuery.mockResolvedValueOnce([
      { story_id: 'CAF-FIX-001', status: 'timeout', reason: 'exceeded 45min limit' },
    ]);

    mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

    await handleRunFinished(makeRunFinishedEvent(47));

    // Should be failure
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.state).toBe('failure');

    // ci_autofix_runs updated to failed
    expect(mockExecute.mock.calls[0][1]![0]).toBe('failed');
    expect(mockExecute.mock.calls[0][1]![1]).toContain('timeout');
  });
});
