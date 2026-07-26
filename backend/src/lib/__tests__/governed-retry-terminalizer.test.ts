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
    mockQueryOne.mockResolvedValue({
      preview_hash: PREVIEW,
      identity_hash: DISPATCH,
      state: 'executing',
      cancellation_requested_at: '2026-07-21T00:00:00.000Z',
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
    expect(calls.slice(0, 3).map((sql) =>
      sql.includes('pipeline_retry_previews') ? 'preview'
        : sql.includes('governed_retry_dispatches') ? 'dispatch' : 'run',
    )).toEqual(['preview', 'dispatch', 'run']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE governed_retry_story_attempts'), expect.any(Array));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE run_pty_sessions'), [42]);
    expect(mockTerminalizeCloseout).toHaveBeenCalledWith(client, expect.objectContaining({ status: 'cancelled' }));
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
});
