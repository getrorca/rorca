/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * @module ci-autofix/webhook-handler
 * @description
 * GitHub `check_run` webhook handler for CI autofix. Language-agnostic — works with
 * ANY CI pipeline because GitHub normalizes all CI tool output into the same
 * `check_run.output.annotations[]` structure.
 *
 * Registered via `onGithubEvent('check_run', ...)` in the legacy handler registry.
 */
import micromatch from 'micromatch';
import { queryOne } from '../../db/index';
import { broadcastAll, type WalEvent } from '../sse-hub';
import { parseErrorsFromText } from './error-parser';
import { onGithubEvent } from '../../routes/webhooks';
import { logger } from '../logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CiAnnotation {
  path: string;
  line: number;
  message: string;
  level: 'failure' | 'warning';
  parser?: string;
}

export interface CiCheckFailure {
  checkRunId: number;
  checkRunName: string;
  headSha: string;
  branchName: string;
  repoOwner: string;
  repoName: string;
  workspaceId: string;
  annotations: CiAnnotation[];
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handleCheckRun(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): Promise<void> {
  // Only fire on completed + failed check runs
  if (payload.action !== 'completed') return;
  if (payload.check_run?.conclusion !== 'failure') return;

  const checkRun = payload.check_run;
  const checkRunName: string = checkRun.name ?? '';
  const repoFullName: string = payload.repository?.full_name ?? '';
  const [repoOwner, repoName] = repoFullName.split('/');

  if (!repoOwner || !repoName) {
    logger.warn('[CI-Autofix] Missing repository info in check_run payload');
    return;
  }

  // Check ci_autofix_enabled flag — CAF-003 adds this column, may not exist yet
  let autofixEnabled = false;
  let checkPatterns: string[] = ['*'];

  try {
    const row = await queryOne<{ ci_autofix_enabled: boolean; ci_autofix_check_patterns: string | null }>(
      'SELECT ci_autofix_enabled, ci_autofix_check_patterns FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (row) {
      autofixEnabled = row.ci_autofix_enabled ?? false;
      if (row.ci_autofix_check_patterns) {
        const parsed = typeof row.ci_autofix_check_patterns === 'string'
          ? JSON.parse(row.ci_autofix_check_patterns)
          : row.ci_autofix_check_patterns;
        if (Array.isArray(parsed) && parsed.length > 0) {
          checkPatterns = parsed;
        }
      }
    }
  } catch {
    // CAF-003 columns may not exist yet — default to disabled
    logger.debug('[CI-Autofix] ci_autofix columns not available, defaulting to disabled');
    return;
  }

  if (!autofixEnabled) {
    logger.debug(`[CI-Autofix] Autofix disabled for workspace ${workspaceId}, skipping check_run`);
    return;
  }

  // Check name filtering via micromatch
  if (!micromatch.isMatch(checkRunName, checkPatterns)) {
    logger.debug(`[CI-Autofix] Check "${checkRunName}" did not match patterns ${JSON.stringify(checkPatterns)}, skipping`);
    return;
  }

  const matchedPattern = checkPatterns.find((p) => micromatch.isMatch(checkRunName, [p]));
  logger.debug(`[CI-Autofix] Check "${checkRunName}" matched pattern "${matchedPattern}"`);

  // Extract annotations
  const annotations: CiAnnotation[] = [];

  // Primary path: structured annotations from check_run output
  const rawAnnotations: any[] = checkRun.output?.annotations ?? [];
  for (const ann of rawAnnotations) {
    if (ann.annotation_level === 'failure') {
      annotations.push({
        path: ann.path ?? '',
        line: ann.start_line ?? 0,
        message: ann.message ?? '',
        level: 'failure',
      });
    }
  }

  // Fallback path: parse raw log text if no structured annotations
  if (annotations.length === 0 && checkRun.output?.text) {
    const parsed = parseErrorsFromText(checkRun.output.text);
    for (const p of parsed) {
      annotations.push({
        path: p.path,
        line: p.line,
        message: p.message,
        level: 'failure',
        parser: p.parser,
      });
    }
  }

  const result: CiCheckFailure = {
    checkRunId: checkRun.id,
    checkRunName,
    headSha: checkRun.head_sha ?? '',
    branchName: checkRun.check_suite?.head_branch ?? '',
    repoOwner,
    repoName,
    workspaceId,
    annotations,
  };

  // Emit WAL event
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ('ci_check_failed', $1, 'github', $2) RETURNING *`,
    [workspaceId, JSON.stringify(result)],
  );

  if (walEvent) {
    broadcastAll(walEvent);
  }

  logger.info(
    `[CI-Autofix] check_run "${checkRunName}" failed on ${repoFullName} — ${annotations.length} annotation(s) extracted`,
  );
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerCiAutofixHandler(): void {
  onGithubEvent('check_run', handleCheckRun);
  logger.info('[CI-Autofix] Registered check_run handler');
}
