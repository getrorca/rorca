/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query } from '../db/index';
import { prepareRunReleaseIntent } from './release-authority';
import { persistHostRunCloseout } from './run-closeout-authority';
import { inspectRunHostAuthority } from './run-host-authority';

export interface WorkerCloseoutRecoveryResult {
  scanned: number;
  recovered: number;
  blocked: Array<{ runId: number; reason: string }>;
}

interface RecoverableRunRow {
  id: number | string;
}

/**
 * Recover successful branch-only runs whose engine and story closeout completed,
 * but whose worker died or failed before publishing the run-level closeout.
 *
 * The SQL fence deliberately excludes provider delivery, auto-merge, and every
 * failure summary other than the exact worker closeout transport failure. All
 * trusted writes still pass through the worker-only canonical closeout writer.
 */
export async function recoverBranchOnlyWorkerCloseouts(
  limit = 100,
): Promise<WorkerCloseoutRecoveryResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Worker closeout recovery limit must be between 1 and 1000');
  }

  const candidates = await query<RecoverableRunRow>(`
    SELECT pr.id
      FROM pipeline_runs pr
      LEFT JOIN pipeline_run_release_intents ri ON ri.run_id = pr.id
     WHERE pr.summary = 'worker_closeout_failed'
       AND pr.status IN ('failed', 'release_pending')
       AND pr.merge_strategy = 'branch-only'
       AND pr.auto_merge = FALSE
       AND pr.expected_story_ids IS NOT NULL
       AND cardinality(pr.expected_story_ids) > 0
       AND COALESCE(ri.status, 'missing') != 'completed'
     ORDER BY pr.finished_at ASC NULLS FIRST, pr.id ASC
     LIMIT $1
  `, [limit]);

  const result: WorkerCloseoutRecoveryResult = {
    scanned: candidates.length,
    recovered: 0,
    blocked: [],
  };

  for (const candidate of candidates) {
    const runId = Number(candidate.id);
    try {
      const authority = await inspectRunHostAuthority(runId);
      if (!authority?.complete || !authority.closeoutEligible
        || !authority.releaseEligible || !authority.finalCommitSha) {
        result.blocked.push({
          runId,
          reason: authority?.invalidReason ?? 'exact successful host authority is unavailable',
        });
        continue;
      }

      await persistHostRunCloseout({ runId, status: 'done', terminalizeRun: false });
      await prepareRunReleaseIntent({
        hostAuthority: authority,
        mergeStrategy: 'branch-only',
        autoMerge: false,
        externalSend: false,
      });
      result.recovered++;
    } catch (error) {
      result.blocked.push({
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
