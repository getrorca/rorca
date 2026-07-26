/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * @module ci-autofix/fix-orchestrator
 * @description
 * Subscribes to WAL `ci_check_failed` events and orchestrates autofix pipeline runs.
 * Language-agnostic — the generated fix spec does NOT hardcode any verification commands.
 * Instead, the agent reads CLAUDE.md and the direction stack to determine the correct
 * build/test/lint commands for the workspace's stack.
 *
 * Flow:
 * 1. Check infinite loop guard (ci_autofix_runs count per SHA)
 * 2. Generate single-story fix spec from annotations
 * 3. Insert pipeline_runs row, enqueue pg-boss job
 * 4. Track in ci_autofix_runs, emit WAL event
 */

import * as fs from 'fs';
import * as path from 'path';
import { subscribe, broadcastAll, type WalEvent } from '../sse-hub';
import { queryOne, query, execute } from '../../db/index';
import { getBoss } from '../pg-boss';
import { logger } from '../logger';
import type { CiCheckFailure, CiAnnotation } from './webhook-handler';
import type { AgentType } from '../config';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  path: string;
  pipeline_config: string | null;
  ci_autofix_config: string | null;
}

interface CiAutofixConfig {
  max_retries?: number;
}

interface CiAutofixRunRow {
  id: number;
  workspace_id: string;
  head_sha: string;
  branch_name: string;
  check_run_name: string;
  run_id: number;
  agent_type: string;
}

interface StoryResultRow {
  story_id: string;
  status: string;
  reason: string | null;
}

interface PipelineRunRow {
  id: number;
  status: string;
  trigger_type: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function buildFixDescription(
  checkRunName: string,
  branchName: string,
  sha7: string,
  annotations: CiAnnotation[],
): string {
  const annotationLines = annotations.map(
    (a) => `- **${a.path}:${a.line}** — ${a.message}`,
  );

  const prefix =
    annotations.length > 50
      ? `(${annotations.length} total errors from ${checkRunName} — fix all of them)\n\n`
      : '';

  return (
    `Fix the following CI failures reported by check '${checkRunName}' on branch \`${branchName}\` (commit ${sha7}):\n\n` +
    prefix +
    annotationLines.join('\n') +
    '\n\nRead the project\'s CLAUDE.md and direction stack for the correct build, test, and lint commands. ' +
    'Fix the root cause of each error listed above. After fixing, re-run the failing CI check locally to verify all errors are resolved. ' +
    'Do not suppress errors, skip lint rules, disable checks, or modify CI configuration — fix the source code.'
  );
}

function buildAcceptanceCriteria(
  checkRunName: string,
  annotations: CiAnnotation[],
): string[] {
  const criteria = annotations.map((a) => {
    const msg = truncate(a.message, 80);
    return `${a.path}:${a.line} — ${msg}`;
  });
  criteria.push(
    `The CI check "${checkRunName}" passes locally after all fixes are applied`,
  );
  return criteria;
}

function resolveAgent(pipelineConfig: Record<string, unknown>): AgentType {
  const wsAgent = pipelineConfig.agentType as string | undefined;
  if (wsAgent && ['claude', 'opencode', 'codex', 'pi'].includes(wsAgent)) {
    return wsAgent as AgentType;
  }
  const envAgent = process.env.RORCA_AGENT?.toLowerCase().trim();
  if (envAgent && ['claude', 'opencode', 'codex', 'pi'].includes(envAgent)) {
    return envAgent as AgentType;
  }
  return 'claude';
}

function resolveModel(pipelineConfig: Record<string, unknown>): string {
  const wsModel = pipelineConfig.model as string | undefined;
  if (wsModel?.trim()) return wsModel.trim();
  if (process.env.RORCA_MODEL?.trim()) return process.env.RORCA_MODEL.trim();
  return DEFAULT_MODEL;
}

// ─── Core Handler ───────────────────────────────────────────────────────────

async function handleCiCheckFailed(event: WalEvent): Promise<void> {
  if (event.event_type !== 'ci_check_failed') return;
  if (!event.payload) return;

  const failure: CiCheckFailure = JSON.parse(event.payload);
  const {
    checkRunId,
    checkRunName,
    headSha,
    branchName,
    workspaceId,
    annotations,
  } = failure;

  if (!annotations || annotations.length === 0) {
    logger.info(
      `[CI Autofix] No annotations in ci_check_failed for ${checkRunName}, skipping`,
    );
    return;
  }

  const sha7 = headSha.slice(0, 7);

  // 1. Load workspace
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, path, pipeline_config, ci_autofix_config FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    logger.warn(`[CI Autofix] Workspace ${workspaceId} not found, skipping`);
    return;
  }

  // 2. Infinite loop guard
  const autofixConfig: CiAutofixConfig = workspace.ci_autofix_config
    ? JSON.parse(workspace.ci_autofix_config)
    : {};
  const maxRetries = autofixConfig.max_retries ?? DEFAULT_MAX_RETRIES;

  const countRow = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM ci_autofix_runs WHERE head_sha = $1 AND workspace_id = $2',
    [headSha, workspaceId],
  );
  const existingCount = parseInt(countRow?.count ?? '0', 10);

  if (existingCount >= maxRetries) {
    logger.info(
      `[CI Autofix] Max retries (${maxRetries}) reached for ${sha7}, skipping`,
    );
    return;
  }

  // 3. Resolve agent and model
  const pipelineConfig: Record<string, unknown> = workspace.pipeline_config
    ? JSON.parse(workspace.pipeline_config)
    : {};
  const resolvedAgent = resolveAgent(pipelineConfig);
  const resolvedModel = resolveModel(pipelineConfig);

  // 4. Build spec JSON
  const specSlug = `ci-autofix-${sha7}`;
  const description = buildFixDescription(
    checkRunName,
    branchName,
    sha7,
    annotations,
  );
  const acceptanceCriteria = buildAcceptanceCriteria(checkRunName, annotations);

  const hasExplicitAgent = !!(pipelineConfig.agentType as string | undefined);

  const specJson: Record<string, unknown> = {
    title: specSlug,
    userStories: [
      {
        id: 'CAF-FIX-001',
        title: `Fix CI failures from ${checkRunName}`,
        description,
        acceptanceCriteria,
        dependsOn: [],
        passes: false,
      },
    ],
    model: resolvedModel,
    generatedAt: new Date().toISOString(),
  };

  if (hasExplicitAgent) {
    specJson.agentOverride = resolvedAgent;
  }

  // 5. Write spec file
  const specRelPath = `forge/specs/approved/${specSlug}.json`;
  const specAbsPath = path.join(workspace.path, specRelPath);

  // Ensure directory exists
  const specDir = path.dirname(specAbsPath);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(specAbsPath, JSON.stringify(specJson, null, 2), 'utf-8');

  logger.info(
    `[CI Autofix] Spec written to ${specRelPath} (${annotations.length} annotations)`,
  );

  // 6. Insert pipeline_runs row
  const runResult = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs
       (spec_path, workspace_id, status, trigger_type, triggered_via, agent_type, agent_model, queued_at)
     VALUES ($1, $2, 'queued', 'ci-autofix', 'run_now', $3, $4, NOW())
     RETURNING id`,
    [specRelPath, workspaceId, resolvedAgent, resolvedModel],
  );
  if (!runResult) {
    logger.error('[CI Autofix] Failed to insert pipeline_runs row');
    return;
  }
  const runId = runResult.id;

  // 7. Enqueue pg-boss job
  const boss = getBoss();
  const jobId = await boss.send('pipeline:run', {
    runId,
    specPath: specRelPath,
    workspacePath: workspace.path,
    agent: resolvedAgent,
    model: resolvedModel,
    worktreePath: null,
    branchName: null,
    triggeredVia: 'run_now',
  });

  if (!jobId) {
    logger.error(
      `[CI Autofix] boss.send returned null for run ${runId} — queue may not exist`,
    );
  }

  // 8. Insert ci_autofix_runs row
  await execute(
    `INSERT INTO ci_autofix_runs
       (workspace_id, head_sha, branch_name, check_run_id, check_run_name, spec_path, run_id, annotation_count, agent_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      workspaceId,
      headSha,
      branchName,
      checkRunId,
      checkRunName,
      specRelPath,
      runId,
      annotations.length,
      resolvedAgent,
    ],
  );

  // 9. Emit WAL event
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
     VALUES ('ci_autofix_triggered', $1, $2, 'ci-autofix', $3)
     RETURNING *`,
    [
      workspaceId,
      specSlug,
      JSON.stringify({
        runId,
        specPath: specRelPath,
        headSha,
        branchName,
        checkRunName,
        annotationCount: annotations.length,
        agentType: resolvedAgent,
      }),
    ],
  );

  if (walEvent) {
    broadcastAll(walEvent);
  }

  logger.info(
    `[CI Autofix] Triggered run #${runId} for ${checkRunName} on ${sha7} (${annotations.length} errors, agent=${resolvedAgent}, model=${resolvedModel})`,
  );
}

// ─── Feedback Loop Handler ──────────────────────────────────────────────────

/**
 * When a pipeline run triggered by CI autofix completes, close the feedback loop:
 * 1. Look up ci_autofix_runs row by run_id
 * 2. Determine outcome from pipeline_runs.status and story_results
 * 3. Record local/WAL completion only (automatic provider status is disabled)
 * 4. Update ci_autofix_runs row with final status
 * 5. Emit ci_autofix_completed WAL event
 */
async function handleRunFinished(event: WalEvent): Promise<void> {
  if (event.event_type !== 'run_finished') return;
  if (!event.payload) return;

  const payload = JSON.parse(event.payload);
  const runId: number | undefined = payload.run_id;
  if (!runId) return;

  // Check if this run was triggered by ci-autofix via pipeline_runs.trigger_type
  const pipelineRun = await queryOne<PipelineRunRow>(
    'SELECT id, status, trigger_type FROM pipeline_runs WHERE id = $1',
    [runId],
  );
  if (!pipelineRun || pipelineRun.trigger_type !== 'ci-autofix') return;

  // 1. Look up ci_autofix_runs row
  const autofixRow = await queryOne<CiAutofixRunRow>(
    'SELECT id, workspace_id, head_sha, branch_name, check_run_name, run_id, agent_type FROM ci_autofix_runs WHERE run_id = $1',
    [runId],
  );
  if (!autofixRow) {
    logger.warn(`[CI Autofix] No ci_autofix_runs row found for run_id=${runId}, skipping feedback`);
    return;
  }

  // 2. Determine outcome from story_results
  const storyResults = await query<StoryResultRow>(
    'SELECT story_id, status, reason FROM story_results WHERE run_id = $1',
    [runId],
  );

  const passed = storyResults.filter((s) => s.status === 'pass');
  const failed = storyResults.filter((s) => s.status === 'fail' || s.status === 'timeout');
  const success = failed.length === 0 && passed.length > 0;

  // Build error summary for failed stories (first 500 chars)
  let errorSummary: string | null = null;
  if (!success && failed.length > 0) {
    const messages = failed.map((s) => {
      const reason = s.reason ? `: ${s.reason}` : '';
      return `${s.story_id} (${s.status}${reason})`;
    });
    errorSummary = messages.join('; ').substring(0, 500);
  }

  const finalStatus = success ? 'completed' : 'failed';

  // Automatic provider status mutation is deliberately disabled. CI autofix
  // records durable local/WAL outcome only; terminal GitHub projection remains
  // owned by the exact run release/Check Run reconciler.

  // 4. Update ci_autofix_runs row
  await execute(
    'UPDATE ci_autofix_runs SET status = $1, finished_at = NOW(), error_summary = $2 WHERE id = $3',
    [finalStatus, errorSummary, autofixRow.id],
  );

  // 5. Emit WAL event
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ('ci_autofix_completed', $1, 'ci-autofix', $2)
     RETURNING *`,
    [
      autofixRow.workspace_id,
      JSON.stringify({
        runId,
        headSha: autofixRow.head_sha,
        branchName: autofixRow.branch_name,
        checkRunName: autofixRow.check_run_name,
        success,
        storiesPassed: passed.length,
        storiesFailed: failed.length,
        agentType: autofixRow.agent_type,
      }),
    ],
  );

  if (walEvent) {
    broadcastAll(walEvent);
  }

  logger.info(
    `[CI Autofix] Feedback loop complete for run #${runId}: ${finalStatus} (${passed.length} passed, ${failed.length} failed)`,
  );
}

// ─── Startup ────────────────────────────────────────────────────────────────

/**
 * Subscribe to WAL events for `ci_check_failed` and `run_finished`.
 * Called once in server.ts startup.
 */
export function startCiAutofixOrchestrator(): void {
  subscribe((event: WalEvent) => {
    handleCiCheckFailed(event).catch((err) => {
      logger.error(
        { err },
        '[CI Autofix] Failed to handle ci_check_failed event',
      );
    });
    handleRunFinished(event).catch((err) => {
      logger.error(
        { err },
        '[CI Autofix] Failed to handle run_finished event',
      );
    });
  });
  logger.info('[CI Autofix] Orchestrator subscribed to WAL events');
}

// ─── Exports for testing ────────────────────────────────────────────────────

export {
  buildFixDescription,
  buildAcceptanceCriteria,
  resolveAgent,
  resolveModel,
  handleCiCheckFailed,
  handleRunFinished,
};
