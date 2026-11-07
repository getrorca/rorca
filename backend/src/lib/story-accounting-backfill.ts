/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { extractTokenUsage } from './execution-engine';

interface BackfillCandidateRow {
  story_result_id: string;
  run_id: string;
  story_id: string;
  agent_type: 'pi' | 'omp';
  agent_model: string | null;
  log_path: string | null;
  workspace_path: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | number | null;
  accounting_input_tokens: number | null;
  accounting_output_tokens: number | null;
  accounting_cost_usd: string | number | null;
  receipt_hash: string | null;
}

interface TokenUsageRow {
  id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | number;
}

export interface StoryAccountingBackfillInput {
  runId: string;
  storyId?: string;
  apply: boolean;
}

export interface StoryAccountingBackfillResult {
  receiptHash: string;
  storyResultId: string;
  runId: string;
  storyId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  logSha256: string;
  applied: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const MAX_ACCOUNTING_LOG_BYTES = 64 * 1024 * 1024;

function readBoundedLogSnapshot(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_ACCOUNTING_LOG_BYTES) throw new Error(`Story log exceeds ${MAX_ACCOUNTING_LOG_BYTES} bytes`);
    const snapshot = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, snapshot, offset, size - offset, offset);
      if (read === 0) throw new Error('Story log changed while creating the accounting snapshot');
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, size) !== 0) {
      throw new Error('Story log changed while creating the accounting snapshot');
    }
    return snapshot;
  } finally {
    fs.closeSync(fd);
  }
}

export function storyAccountingBackfillLockIdentity(runId: string): string {
  return `story-accounting-backfill:${runId}`;
}

/**
 * Owner-only historical repair. Every candidate must be an accounting-required
 * Pi/OMP row whose result and unique token_usage projection are still false-zero.
 * The exact DB-bound story log is parsed before one atomic receipt + projection
 * update. Any ambiguity aborts the complete batch.
 */
export async function recomputeFalseZeroStoryAccounting(
  client: PoolClient,
  input: StoryAccountingBackfillInput,
): Promise<StoryAccountingBackfillResult[]> {
  const authority = await client.query<{ current_user: string; table_owner: string }>(
    `SELECT current_user, pg_get_userbyid(c.relowner) AS table_owner
       FROM pg_catalog.pg_class c
      WHERE c.oid = 'rorca.story_results'::regclass`,
  );
  if (!authority.rows[0] || authority.rows[0].current_user !== authority.rows[0].table_owner) {
    throw new Error('Story accounting backfill requires the migration owner principal');
  }
  const lockIdentity = storyAccountingBackfillLockIdentity(input.runId);
  if (input.apply) {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockIdentity]);
  }

  const params: string[] = [input.runId];
  const storyPredicate = input.storyId ? 'AND sr.story_id = $2' : '';
  if (input.storyId) params.push(input.storyId);
  let candidates: { rows: BackfillCandidateRow[] };
  try {
    candidates = await client.query<BackfillCandidateRow>(
    `SELECT sr.id::text AS story_result_id, sr.run_id::text AS run_id, sr.story_id,
            COALESCE(pr.agent_type, pr.agent)::text AS agent_type, pr.agent_model,
            sr.log_path, w.path AS workspace_path,
            sr.input_tokens, sr.output_tokens, sr.cost_usd,
            sr.accounting_input_tokens, sr.accounting_output_tokens, sr.accounting_cost_usd,
            receipt.receipt_hash
       FROM rorca.story_results sr
       JOIN rorca.pipeline_runs pr ON pr.id = sr.run_id
       JOIN rorca.workspaces w ON w.id = pr.workspace_id
       LEFT JOIN rorca.story_accounting_backfill_receipts receipt ON receipt.story_result_id = sr.id
      WHERE sr.run_id = $1::bigint
        AND sr.accounting_required = TRUE
        AND COALESCE(pr.agent_type, pr.agent) IN ('pi', 'omp')
        ${storyPredicate}
      ORDER BY sr.id`,
    params,
    );
  } catch (error) {
    if (input.apply) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
    throw error;
  }
  if (candidates.rows.length === 0) {
    if (input.apply) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
    throw new Error('No accounting-required Pi/OMP story results matched the requested identity');
  }

  const results: StoryAccountingBackfillResult[] = [];
  try {
    if (input.apply) await client.query('BEGIN');
    for (const candidate of candidates.rows) {
      if (candidate.receipt_hash) {
        const receipt = await client.query<{
          receipt_hash: string; provider: string; model: string; input_tokens: string;
          output_tokens: string; cost_usd: string; log_sha256: string;
        }>(
          `SELECT receipt_hash, provider, model, input_tokens::text, output_tokens::text,
                  cost_usd::text, log_sha256
             FROM rorca.story_accounting_backfill_receipts
            WHERE story_result_id = $1::bigint`,
          [candidate.story_result_id],
        );
        const row = receipt.rows[0];
        if (!row) throw new Error(`Backfill receipt disappeared for story result ${candidate.story_result_id}`);
        results.push({
          receiptHash: row.receipt_hash,
          storyResultId: candidate.story_result_id,
          runId: candidate.run_id,
          storyId: candidate.story_id,
          provider: row.provider,
          model: row.model,
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          costUsd: Number(row.cost_usd),
          logSha256: row.log_sha256,
          applied: false,
        });
        continue;
      }

      const resultIsZero = Number(candidate.input_tokens ?? 0) === 0
        && Number(candidate.output_tokens ?? 0) === 0
        && Number(candidate.cost_usd ?? 0) === 0
        && Number(candidate.accounting_input_tokens ?? 0) === 0
        && Number(candidate.accounting_output_tokens ?? 0) === 0
        && Number(candidate.accounting_cost_usd ?? 0) === 0;
      if (!resultIsZero) {
        throw new Error(`Refusing to overwrite nonzero accounting for story result ${candidate.story_result_id}`);
      }

      const usageRows = await client.query<TokenUsageRow>(
        `SELECT id::text, input_tokens, output_tokens, cost_usd
           FROM rorca.token_usage
          WHERE story_result_id = $1::bigint
          ORDER BY id`,
        [candidate.story_result_id],
      );
      if (usageRows.rows.length !== 1) {
        throw new Error(`Story result ${candidate.story_result_id} has ${usageRows.rows.length} token usage projections; exactly one is required`);
      }
      const usageRow = usageRows.rows[0];
      if (Number(usageRow.input_tokens) !== 0 || Number(usageRow.output_tokens) !== 0 || Number(usageRow.cost_usd) !== 0) {
        throw new Error(`Refusing to overwrite nonzero token usage ${usageRow.id}`);
      }
      if (!candidate.log_path || !fs.existsSync(candidate.log_path)) {
        throw new Error(`Exact story log is missing for ${candidate.run_id}/${candidate.story_id}`);
      }
      const workspaceRoot = fs.realpathSync(candidate.workspace_path);
      const exactLogPath = fs.realpathSync(candidate.log_path);
      const expectedPrefix = `${candidate.story_id}_`;
      if (!exactLogPath.startsWith(`${workspaceRoot}${path.sep}`)
        || !path.basename(exactLogPath).startsWith(expectedPrefix)
        || path.extname(exactLogPath) !== '.log') {
        throw new Error(`Story log identity is ambiguous for ${candidate.run_id}/${candidate.story_id}`);
      }
      const logBytes = readBoundedLogSnapshot(exactLogPath);
      const logSha256 = sha256(logBytes);
      const usage = extractTokenUsage(
        exactLogPath, candidate.agent_type, candidate.agent_model, '', workspaceRoot, logBytes.toString('utf8'),
      );
      if (!usage.provider || !usage.model || usage.model === 'unknown'
        || (usage.inputTokens === 0 && usage.outputTokens === 0)) {
        throw new Error(`Story log lacks exact nonzero provider/model accounting for ${candidate.run_id}/${candidate.story_id}`);
      }
      const receiptPayload = [
        candidate.story_result_id, usageRow.id, candidate.run_id, candidate.story_id,
        candidate.agent_type, usage.provider, usage.model, String(usage.inputTokens),
        String(usage.outputTokens), usage.costUsd.toFixed(9), exactLogPath, logSha256,
      ].join('\u0000');
      const receiptHash = sha256(receiptPayload);

      if (input.apply) {
        await client.query(
          `INSERT INTO rorca.story_accounting_backfill_receipts
             (receipt_hash,story_result_id,token_usage_id,run_id,story_id,agent_type,
              provider,model,input_tokens,output_tokens,cost_usd,log_path,log_sha256)
           VALUES($1,$2::bigint,$3::bigint,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [receiptHash, candidate.story_result_id, usageRow.id, candidate.run_id, candidate.story_id,
            candidate.agent_type, usage.provider, usage.model, usage.inputTokens, usage.outputTokens,
            usage.costUsd, exactLogPath, logSha256],
        );
        const resultUpdate = await client.query(
          `UPDATE rorca.story_results
              SET input_tokens=$2, output_tokens=$3, model_used=$4, cost_usd=$5,
                  accounting_model=$4, accounting_input_tokens=$2,
                  accounting_output_tokens=$3, accounting_reasoning_tokens=COALESCE(accounting_reasoning_tokens,0),
                  accounting_cost_usd=$5, accounting_cost_source='explicit'
            WHERE id=$1::bigint
              AND accounting_required=TRUE
              AND COALESCE(input_tokens,0)=0 AND COALESCE(output_tokens,0)=0 AND COALESCE(cost_usd,0)=0
              AND COALESCE(accounting_input_tokens,0)=0 AND COALESCE(accounting_output_tokens,0)=0
              AND COALESCE(accounting_cost_usd,0)=0`,
          [candidate.story_result_id, usage.inputTokens, usage.outputTokens, usage.model, usage.costUsd],
        );
        const usageUpdate = await client.query(
          `UPDATE rorca.token_usage
              SET input_tokens=$2, output_tokens=$3, reasoning_tokens=COALESCE(reasoning_tokens,0),
                  model=$4, cost_usd=$5, cost_source='explicit'
            WHERE id=$1::bigint AND input_tokens=0 AND output_tokens=0 AND cost_usd=0`,
          [usageRow.id, usage.inputTokens, usage.outputTokens, usage.model, usage.costUsd],
        );
        if (resultUpdate.rowCount !== 1 || usageUpdate.rowCount !== 1) {
          throw new Error(`False-zero accounting changed concurrently for story result ${candidate.story_result_id}`);
        }
      }
      results.push({
        receiptHash,
        storyResultId: candidate.story_result_id,
        runId: candidate.run_id,
        storyId: candidate.story_id,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        logSha256,
        applied: input.apply,
      });
    }
    if (input.apply) await client.query('COMMIT');
    return results;
  } catch (error) {
    if (input.apply) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (input.apply) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
    }
  }
}
