/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PoolClient, QueryResult } from 'pg';
import {
  recomputeFalseZeroStoryAccounting,
  storyAccountingBackfillLockIdentity,
} from '../story-accounting-backfill';

function result(rows: unknown[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] } as QueryResult;
}

describe('owner-operated story accounting backfill', () => {
  let workspace: string;
  let logPath: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-accounting-backfill-'));
    logPath = path.join(workspace, 'CANARY-001_20260818T003800.log');
    fs.writeFileSync(logPath, [
      '[Token] launch=primary provider=openai-codex model=gpt-5.6-sol input=40000 output=70 cost=0.2 cumulative_input=40000 cumulative_output=70 cumulative_cost=0.2 turn=1',
      '[Token] launch=retry provider=openai-codex model=gpt-5.6-sol input=2673 output=2 cost=0.0155253 cumulative_input=2673 cumulative_output=2 cumulative_cost=0.0155253 turn=1',
    ].join('\n'));
  });

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  function client(options: {
    receipt?: string | (() => string | undefined);
    missingUsage?: boolean;
    nonzero?: boolean;
    lock?: () => Promise<void>;
    unlock?: () => Promise<void>;
    inserted?: (receiptHash: string) => void;
  } = {}): PoolClient {
    const currentReceipt = () => typeof options.receipt === 'function' ? options.receipt() : options.receipt;
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_lock')) { await options.lock?.(); return result([]); }
      if (sql.includes('pg_advisory_unlock')) { await options.unlock?.(); return result([]); }
      if (sql.includes('pg_get_userbyid')) return result([{ current_user: 'owner', table_owner: 'owner' }]);
      if (sql.includes('FROM rorca.story_results sr')) {
        return result([{
          story_result_id: '91', run_id: '20260316000009', story_id: 'CANARY-001',
          agent_type: 'omp', agent_model: null, log_path: logPath, workspace_path: workspace,
          input_tokens: options.nonzero ? 1 : 0, output_tokens: 0, cost_usd: 0,
          accounting_input_tokens: 0, accounting_output_tokens: 0, accounting_cost_usd: 0,
          receipt_hash: currentReceipt() ?? null,
        }]);
      }
      if (sql.includes('FROM rorca.story_accounting_backfill_receipts')) {
        return result([{
          receipt_hash: currentReceipt(), provider: 'openai-codex', model: 'openai-codex/gpt-5.6-sol',
          input_tokens: '42673', output_tokens: '72', cost_usd: '0.215525300', log_sha256: 'a'.repeat(64),
        }]);
      }
      if (sql.includes('FROM rorca.token_usage')) {
        return result(options.missingUsage ? [] : [{ id: '71', input_tokens: 0, output_tokens: 0, cost_usd: 0 }]);
      }
      if (sql.startsWith('INSERT INTO rorca.story_accounting_backfill_receipts')) {
        options.inserted?.(String(params?.[0]));
        return result([], 1);
      }
      if (sql.startsWith('UPDATE rorca.story_results') || sql.startsWith('UPDATE rorca.token_usage')) return result([], 1);
      return result([]);
    });
    return { query } as unknown as PoolClient;
  }

  test('serializes run-wide and story-specific apply scopes on the same run lock', () => {
    const runWide = storyAccountingBackfillLockIdentity('20260316000009');
    const storySpecific = storyAccountingBackfillLockIdentity('20260316000009');
    expect(runWide).toBe(storySpecific);
    expect(runWide).not.toBe(storyAccountingBackfillLockIdentity('20260316000010'));
  });

  test('previews exact appended-launch totals without mutating the database', async () => {
    const db = client();
    const rows = await recomputeFalseZeroStoryAccounting(db, { runId: '20260316000009', apply: false });
    expect(rows).toEqual([expect.objectContaining({
      storyId: 'CANARY-001', provider: 'openai-codex', model: 'openai-codex/gpt-5.6-sol',
      inputTokens: 42673, outputTokens: 72, costUsd: 0.2155253, applied: false,
    })]);
    expect((db.query as jest.Mock).mock.calls.flat().join(' ')).not.toContain('UPDATE rorca');
  });

  test('concurrent run-wide and story-specific applies converge on the winning receipt', async () => {
    let held = false;
    const waiters: Array<() => void> = [];
    let receipt: string | undefined;
    const lock = async () => {
      if (held) await new Promise<void>((resolve) => waiters.push(resolve));
      held = true;
    };
    const unlock = async () => {
      held = false;
      waiters.shift()?.();
    };
    const options = {
      receipt: () => receipt,
      lock,
      unlock,
      inserted: (hash: string) => { receipt = hash; },
    };
    const [runWide, storySpecific] = await Promise.all([
      recomputeFalseZeroStoryAccounting(client(options), { runId: '20260316000009', apply: true }),
      recomputeFalseZeroStoryAccounting(client(options), {
        runId: '20260316000009', storyId: 'CANARY-001', apply: true,
      }),
    ]);
    expect(runWide[0].receiptHash).toBe(storySpecific[0].receiptHash);
    expect([runWide[0].applied, storySpecific[0].applied].sort()).toEqual([false, true]);
  });


  test('applies one receipt-bound correction to both canonical accounting projections', async () => {
    const db = client();
    const rows = await recomputeFalseZeroStoryAccounting(db, {
      runId: '20260316000009', apply: true,
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      applied: true,
    }));
    const statements = (db.query as jest.Mock).mock.calls.map(([sql]) => sql as string);
    expect(statements.some((sql) => sql.startsWith('UPDATE rorca.story_results'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('UPDATE rorca.token_usage'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('INSERT INTO rorca.story_accounting_backfill_receipts'))).toBe(true);
  });

  test('refuses an oversized log before allocating or writing a receipt', async () => {
    fs.truncateSync(logPath, 64 * 1024 * 1024 + 1);
    await expect(recomputeFalseZeroStoryAccounting(client(), {
      runId: '20260316000009', apply: false,
    })).rejects.toThrow('Story log exceeds');
  });
  test('returns the immutable prior receipt on replay', async () => {
    const rows = await recomputeFalseZeroStoryAccounting(client({ receipt: 'b'.repeat(64) }), {
      runId: '20260316000009', apply: true,
    });

    expect(rows[0]).toEqual(expect.objectContaining({ receiptHash: 'b'.repeat(64), applied: false }));
  });

  test.each([
    [{ missingUsage: true }, 'exactly one is required'],
    [{ nonzero: true }, 'Refusing to overwrite nonzero accounting'],
  ])('refuses ambiguous or nonzero candidates without overwrite', async (options, message) => {
    await expect(recomputeFalseZeroStoryAccounting(client(options), {
      runId: '20260316000009', apply: true,
    })).rejects.toThrow(message);
  });
});
