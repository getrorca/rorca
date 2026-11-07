/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();
const mockPrepareCloseout = jest.fn();
const mockTerminalizeCloseout = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../run-closeout-authority', () => ({
  prepareHostRunCloseout: (...args: unknown[]) => mockPrepareCloseout(...args),
  terminalizePreparedHostRunCloseout: (...args: unknown[]) => mockTerminalizeCloseout(...args),
}));

import { terminalizeGovernedRetryRun } from '../governed-retry-publication';

const PREVIEW = 'sha256:' + 'a'.repeat(64);
const DISPATCH = 'sha256:' + 'b'.repeat(64);

function sqlText(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

describe('common governed retry terminalizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryOne.mockImplementation((sql: unknown) => {
      const text = sqlText(sql);
      // The terminalizer probes for an existing host closeout before preparing
      // a new one. Return none so the existing tests exercise closeout prep.
      if (text.includes("event_type = 'run_closeout'")) return Promise.resolve(undefined);
      return Promise.resolve({
        preview_hash: PREVIEW,
        identity_hash: DISPATCH,
        state: 'executing',
        cancellation_requested_at: null,
      });
    });
    mockPrepareCloseout.mockResolvedValue({
      runId: 42,
      workspaceId: 'workspace-1',
      specId: 'spec-1',
      status: 'cancelled',
      payload: {},
    });
    mockTerminalizeCloseout.mockResolvedValue({ id: 99, identityHash: 'sha256:' + 'c'.repeat(64) });
  });

  test('atomically converges a winning pre-Git cancellation in preview-dispatch-run lock order', async () => {
    mockQueryOne.mockImplementation((sql: unknown) => {
      if (sqlText(sql).includes("event_type = 'run_closeout'")) return Promise.resolve(undefined);
      return Promise.resolve({
        preview_hash: PREVIEW,
        identity_hash: DISPATCH,
        state: 'executing',
        cancellation_requested_at: '2026-07-21T00:00:00.000Z',
      });
    });
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: unknown) => {
        const text = sqlText(sql);
        calls.push(text);
        if (text.includes('FROM pipeline_retry_previews') && text.includes('FOR UPDATE')) {
          return { rows: [{ preview_hash: PREVIEW, status: 'dispatched', preparation_state: 'published' }], rowCount: 1 };
        }
        if (text.includes('FROM governed_retry_dispatches') && text.includes('FOR UPDATE')) {
          return { rows: [{ identity_hash: DISPATCH, state: 'executing', boss_job_id: 'boss-1', cancellation_requested_at: 'now' }], rowCount: 1 };
        }
        if (text.includes('FROM pipeline_runs') && text.includes('FOR UPDATE')) {
          return { rows: [{ status: 'running', host_closeout_event_id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    mockTransaction.mockImplementation(async (fn: (client: any) => unknown) => fn(client));

    const result = await terminalizeGovernedRetryRun({
      runId: 42,
      workspaceId: 'workspace-1',
      requestedTerminal: 'auto',
      reason: 'worker_crash_recovery',
      source: 'test',
    });

    expect(result).toMatchObject({ outcome: 'terminalized', terminal: 'cancelled', bossJobId: 'boss-1' });
    const authorityLocks = calls.filter((sql) => sql.includes('FOR UPDATE'));
    expect(authorityLocks.slice(0, 3).map((sql) =>
      sql.includes('pipeline_retry_previews') ? 'preview'
        : sql.includes('governed_retry_dispatches') ? 'dispatch' : 'run',
    )).toEqual(['preview', 'dispatch', 'run']);
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE governed_retry_story_attempts'), expect.any(Array));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE run_pty_sessions'), [42]);
    expect(mockTerminalizeCloseout).toHaveBeenCalledWith(client, expect.objectContaining({ status: 'cancelled' }));
  });

  test('retry snapshot disappearance terminalizes attempts/dispatch, clears lease, closes out, and emits canonical evidence', async () => {
    mockQueryOne.mockImplementation((sql: unknown) => {
      if (sqlText(sql).includes("event_type = 'run_closeout'")) return Promise.resolve(undefined);
      return Promise.resolve({
        preview_hash: PREVIEW,
        identity_hash: DISPATCH,
        state: 'executing',
        cancellation_requested_at: null,
      });
    });
    mockPrepareCloseout.mockResolvedValue({
      runId: 42,
      workspaceId: 'workspace-1',
      specId: 'spec-1',
      status: 'failed',
      payload: {},
    });
    const client = {
      query: jest.fn(async (sql: unknown) => {
        const text = sqlText(sql);
        if (text.includes('FROM pipeline_retry_previews') && text.includes('FOR UPDATE')) {
          return { rows: [{ preview_hash: PREVIEW, status: 'dispatched', preparation_state: 'published' }], rowCount: 1 };
        }
        if (text.includes('FROM governed_retry_dispatches') && text.includes('FOR UPDATE')) {
          return { rows: [{ identity_hash: DISPATCH, state: 'executing', boss_job_id: 'boss-missing', cancellation_requested_at: null }], rowCount: 1 };
        }
        if (text.includes('FROM pipeline_runs') && text.includes('FOR UPDATE')) {
          return { rows: [{ status: 'starting', host_closeout_event_id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    mockTransaction.mockImplementation(async (fn: (client: any) => unknown) => fn(client));

    const result = await terminalizeGovernedRetryRun({
      runId: 42,
      workspaceId: 'workspace-1',
      requestedTerminal: 'auto',
      reason: 'retry_spec_missing:retry_spec_missing',
      source: 'worker_retry_exact_owner_catch',
    });

    expect(result).toMatchObject({ outcome: 'terminalized', terminal: 'failed', bossJobId: 'boss-missing' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE governed_retry_story_attempts'),
      expect.arrayContaining([DISPATCH, 'failed', expect.stringContaining('retry_spec_missing')]),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('lease_owner = NULL, lease_expires_at = NULL'),
      expect.arrayContaining([DISPATCH, 'failed']),
    );
    expect(mockTerminalizeCloseout).toHaveBeenCalledWith(client, expect.objectContaining({ status: 'failed' }));
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO wal_events'),
      [
        'governed_retry_failed',
        'workspace-1',
        expect.stringContaining('"runId":42'),
        `governed-retry-terminal:${DISPATCH}:failed`,
      ],
    );
  });

  test('finishes closeout when failed dispatch authority outlives stale preview and run projections', async () => {
    mockQueryOne.mockImplementation((sql: unknown) => {
      if (sqlText(sql).includes("event_type = 'run_closeout'")) return Promise.resolve(undefined);
      return Promise.resolve({
        preview_hash: PREVIEW,
        identity_hash: DISPATCH,
        state: 'failed',
        cancellation_requested_at: null,
      });
    });
    mockPrepareCloseout.mockResolvedValue({
      runId: 42,
      workspaceId: 'workspace-1',
      specId: 'spec-1',
      status: 'failed',
      payload: {},
    });
    const client = {
      query: jest.fn(async (sql: unknown) => {
        const text = sqlText(sql);
        if (text.includes('FROM pipeline_retry_previews') && text.includes('FOR UPDATE')) {
          return { rows: [{ preview_hash: PREVIEW, status: 'dispatched', preparation_state: 'published' }], rowCount: 1 };
        }
        if (text.includes('FROM governed_retry_dispatches') && text.includes('FOR UPDATE')) {
          return { rows: [{ identity_hash: DISPATCH, state: 'failed', boss_job_id: 'boss-failed', cancellation_requested_at: null }], rowCount: 1 };
        }
        if (text.includes('FROM pipeline_runs') && text.includes('FOR UPDATE')) {
          return { rows: [{ status: 'running', host_closeout_event_id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    mockTransaction.mockImplementation(async (fn: (client: any) => unknown) => fn(client));

    const result = await terminalizeGovernedRetryRun({
      runId: 42,
      workspaceId: 'workspace-1',
      requestedTerminal: 'auto',
      reason: 'stale_pre_git_worker_exit',
      source: 'worker_stale_reconciliation',
    });

    expect(result).toMatchObject({ outcome: 'terminalized', terminal: 'failed', bossJobId: 'boss-failed' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pipeline_retry_previews'),
      expect.arrayContaining([PREVIEW, 'refused']),
    );
    expect(mockTerminalizeCloseout).toHaveBeenCalledWith(client, expect.objectContaining({ status: 'failed' }));
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pipeline_runs'),
      expect.arrayContaining([42, 'stale_pre_git_worker_exit']),
    );
  });

  test('routes post-Git ambiguity to manual review and never creates failure closeout', async () => {
    mockQueryOne.mockResolvedValue({
      preview_hash: PREVIEW,
      identity_hash: DISPATCH,
      state: 'committed',
      cancellation_requested_at: '2026-07-21T00:00:00.000Z',
    });
    const client = {
      query: jest.fn(async (sql: unknown) => {
        const text = sqlText(sql);
        if (text.includes('pipeline_retry_previews')) return { rows: [{ preview_hash: PREVIEW }], rowCount: 1 };
        if (text.includes('governed_retry_dispatches') && text.includes('SELECT')) {
          return { rows: [{ identity_hash: DISPATCH, state: 'committed', boss_job_id: 'boss-2' }], rowCount: 1 };
        }
        return { rows: [{ id: 42 }], rowCount: 1 };
      }),
    };
    mockTransaction.mockImplementation(async (fn: (client: any) => unknown) => fn(client));

    const result = await terminalizeGovernedRetryRun({
      runId: 42,
      workspaceId: 'workspace-1',
      requestedTerminal: 'auto',
      reason: 'stale_post_git_authority_incomplete',
      source: 'test',
    });

    expect(result).toMatchObject({ outcome: 'manual_review_required', bossJobId: 'boss-2' });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("state = 'manual_review_required'"),
      expect.any(Array),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'partial_failure'"),
      expect.any(Array),
    );
    expect(mockPrepareCloseout).not.toHaveBeenCalled();
    expect(mockTerminalizeCloseout).not.toHaveBeenCalled();
  });

  test('fails closed when cancellation lacks a durable winning request', async () => {
    mockQueryOne.mockResolvedValue({
      preview_hash: PREVIEW,
      identity_hash: DISPATCH,
      state: 'executing',
      cancellation_requested_at: null,
    });

    await expect(terminalizeGovernedRetryRun({
      runId: 42,
      workspaceId: 'workspace-1',
      requestedTerminal: 'cancelled',
      reason: 'synthetic_cancel',
      source: 'test',
    })).rejects.toThrow('no durable winning request');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockTerminalizeCloseout).not.toHaveBeenCalled();
  });

  test('reuses an existing host closeout when converging a stale dispatched preview', async () => {
    mockQueryOne.mockImplementation((sql: unknown) => {
      if (sqlText(sql).includes("event_type = 'run_closeout'")) {
        return Promise.resolve({ id: 77, identity_hash: 'sha256:' + 'd'.repeat(64) });
      }
      return Promise.resolve({
        preview_hash: PREVIEW,
        identity_hash: DISPATCH,
        state: 'failed',
        cancellation_requested_at: null,
      });
    });
    const client = {
      query: jest.fn(async (sql: unknown) => {
        const text = sqlText(sql);
        if (text.includes('FROM pipeline_retry_previews') && text.includes('FOR UPDATE')) {
          return { rows: [{ preview_hash: PREVIEW, status: 'dispatched', preparation_state: 'published' }], rowCount: 1 };
        }
        if (text.includes('FROM governed_retry_dispatches') && text.includes('FOR UPDATE')) {
          return { rows: [{ identity_hash: DISPATCH, state: 'failed', boss_job_id: 'boss-stale', cancellation_requested_at: null }], rowCount: 1 };
        }
        if (text.includes('FROM pipeline_runs') && text.includes('FOR UPDATE')) {
          return { rows: [{ status: 'partial_failure', host_closeout_event_id: 77 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    mockTransaction.mockImplementation(async (fn: (client: any) => unknown) => fn(client));

    const result = await terminalizeGovernedRetryRun({
      runId: 42,
      workspaceId: 'workspace-1',
      requestedTerminal: 'auto',
      reason: 'stale_pre_git_worker_exit',
      source: 'worker_stale_reconciliation',
    });

    expect(result).toMatchObject({ outcome: 'terminalized', terminal: 'failed', bossJobId: 'boss-stale' });
    // The already-durable closeout is reused; no second closeout is prepared.
    expect(mockPrepareCloseout).not.toHaveBeenCalled();
    expect(mockTerminalizeCloseout).not.toHaveBeenCalled();
    // The stale dispatched preview converges to refused, freeing the partial
    // unique index for a new dispatch of the original run.
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pipeline_retry_previews'),
      expect.arrayContaining([PREVIEW, 'refused']),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO wal_events'),
      expect.arrayContaining(['governed_retry_failed', expect.stringContaining('"hostCloseoutEventId":77')]),
    );
  });
});
