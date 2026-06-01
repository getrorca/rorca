/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * memory-synthesis.ts — Post-Run Memory Synthesis (CIE-005 + CIE-014)
 *
 * Subscribes to WAL events. When a run finishes (done or failed),
 * reviews story results, git diffs, WAL events, and error messages,
 * then proposes new memory ledger entries.
 * Proposals are persisted in memory_proposals table and broadcast via SSE.
 */

import { execSync } from 'child_process';
import { query, queryOne, execute } from '../db/index';
import { subscribe, broadcastAll, type WalEvent } from './sse-hub';
import {
  readMemory,
  buildSynthesisPrompt,
  parseSynthesisResponse,
  type ProposedMemoryEntry,
} from './memory-ledger';
import { chatComplete } from './llm-client';
import { logger } from './logger';
import { isAutoSynthesisEnabled } from './wal-feedback';

interface StoryResultRow {
  story_id: string;
  status: string;
  log_path: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface WalEventRow {
  event_type: string;
  story_id: string | null;
  payload: string | null;
  ts: string;
}

/**
 * Start the memory synthesis subscriber.
 * Listens for run_finished events and triggers synthesis for completed/failed runs.
 */
export function startMemorySynthesis(): void {
  subscribe((event: WalEvent) => {
    if (event.event_type !== 'run_finished') return;

    let payload: { run_id?: number; status?: string };
    try {
      payload = JSON.parse(event.payload || '{}');
    } catch {
      return;
    }

    // Trigger on both 'done' and 'failed' runs
    if (!payload.run_id) return;
    if (payload.status !== 'done' && payload.status !== 'failed') return;

    const workspaceId = event.workspace_id;
    if (!workspaceId) return;

    // PR-020: Auto-synthesis is opt-in via workspace setting AUTO_MEMORY_SYNTHESIS=true
    isAutoSynthesisEnabled(workspaceId).then(enabled => {
      if (!enabled) return;

      synthesizeMemory(workspaceId, payload.run_id!, payload.status!).catch(err => {
        logger.error(`[memory-synthesis] Error for run ${payload.run_id}:`, err);
      });
    }).catch(err => {
      logger.error(`[memory-synthesis] Error checking auto-synthesis for workspace ${workspaceId}:`, err);
    });
  });
}

/**
 * Collect git diffs for commits made during a pipeline run.
 * Returns a truncated diff string.
 */
async function collectRunDiffs(workspacePath: string, runId: number): Promise<string> {
  // Get commit SHAs from story_commits for this run's stories
  const storyRows = await query<{ story_id: string }>(
    'SELECT DISTINCT story_id FROM story_results WHERE run_id = $1',
    [runId]
  );
  const storyIds = storyRows.map(r => r.story_id);

  if (storyIds.length === 0) return '';

  const placeholders = storyIds.map((_, i) => `$${i + 1}`).join(',');
  const commits = await query<{ commit_sha: string }>(
    `SELECT DISTINCT commit_sha FROM story_commits WHERE story_id IN (${placeholders}) ORDER BY id DESC LIMIT 20`,
    storyIds
  );

  if (commits.length === 0) {
    // Fallback: get recent commits from git log with the run timeframe
    const run = await queryOne<{ started_at: string; finished_at: string | null }>(
      'SELECT started_at, finished_at FROM pipeline_runs WHERE id = $1',
      [runId]
    );

    if (!run) return '';

    try {
      const since = run.started_at.replace(' ', 'T') + 'Z';
      const diffOutput = execSync(
        `git log --since="${since}" --format="%H" --no-merges | head -20 | xargs -r git diff --stat`,
        { cwd: workspacePath, timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return diffOutput.slice(0, 5000);
    } catch {
      return '';
    }
  }

  // Get diff --stat for the collected commits
  const shas = commits.map(c => c.commit_sha);
  try {
    const diffParts: string[] = [];
    for (const sha of shas.slice(0, 10)) {
      const diff = execSync(
        `git show --stat --format="commit %H%nSubject: %s" ${sha}`,
        { cwd: workspacePath, timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      diffParts.push(diff);
    }
    return diffParts.join('\n---\n').slice(0, 5000);
  } catch {
    return '';
  }
}

/**
 * Collect WAL events from a specific run for synthesis context.
 */
async function collectRunWalEvents(workspaceId: string, runId: number): Promise<string> {
  const events = await query<WalEventRow>(
    `SELECT event_type, story_id, payload, ts FROM wal_events
     WHERE workspace_id = $1 AND payload LIKE $2
     ORDER BY id ASC LIMIT 100`,
    [workspaceId, `%"run_id":${runId}%`]
  );

  // Also get story-level events
  const storyEvents = await query<WalEventRow>(
    `SELECT event_type, story_id, payload, ts FROM wal_events
     WHERE workspace_id = $1 AND event_type IN ('story_started', 'story_passed', 'story_failed', 'story_skipped', 'story_escalated')
     AND id >= (SELECT COALESCE(MIN(id), 0) FROM wal_events WHERE workspace_id = $2 AND event_type = 'run_started' AND payload LIKE $3)
     AND id <= (SELECT COALESCE(MAX(id), 999999999) FROM wal_events WHERE workspace_id = $4 AND event_type = 'run_finished' AND payload LIKE $5)
     ORDER BY id ASC LIMIT 100`,
    [
      workspaceId,
      workspaceId, `%"run_id":${runId}%`,
      workspaceId, `%"run_id":${runId}%`,
    ]
  );

  const allEvents = [...events, ...storyEvents];
  // Deduplicate by ts+event_type
  const seen = new Set<string>();
  const unique = allEvents.filter(e => {
    const key = `${e.ts}-${e.event_type}-${e.story_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return '';

  const lines = unique.map(e => {
    let detail = '';
    if (e.payload) {
      try {
        const p = JSON.parse(e.payload);
        if (p.reason) detail = ` reason=${p.reason}`;
        if (p.error) detail += ` error="${String(p.error).slice(0, 200)}"`;
        if (p.exit_code !== undefined) detail += ` exit_code=${p.exit_code}`;
      } catch { /* ignore */ }
    }
    return `[${e.event_type}] story=${e.story_id ?? 'N/A'}${detail}`;
  });

  return lines.join('\n').slice(0, 3000);
}

/**
 * Extract error messages from failed stories.
 */
async function collectErrorMessages(runId: number): Promise<string> {
  const failedStories = await query<StoryResultRow>(
    `SELECT story_id, status, log_path FROM story_results WHERE run_id = $1 AND status IN ('fail', 'timeout')`,
    [runId]
  );

  if (failedStories.length === 0) return '';

  // Get error details from WAL events for failed stories
  const errors: string[] = [];
  for (const story of failedStories) {
    const walEvent = await queryOne<{ payload: string | null }>(
      `SELECT payload FROM wal_events WHERE event_type = 'story_failed' AND story_id = $1 ORDER BY id DESC LIMIT 1`,
      [story.story_id]
    );

    let errorDetail = `${story.story_id}: status=${story.status}`;
    if (walEvent?.payload) {
      try {
        const p = JSON.parse(walEvent.payload);
        if (p.reason) errorDetail += ` reason="${p.reason}"`;
        if (p.error) errorDetail += ` error="${String(p.error).slice(0, 300)}"`;
      } catch { /* ignore */ }
    }
    errors.push(errorDetail);
  }

  return errors.join('\n').slice(0, 2000);
}

/**
 * Synthesize memory entries from a completed/failed run.
 * Fetches story results, git diffs, WAL events, and error messages.
 * Builds an enriched synthesis prompt, calls LLM,
 * persists proposals in memory_proposals table, and broadcasts via SSE.
 */
async function synthesizeMemory(workspaceId: string, runId: number, runStatus: string): Promise<void> {
  const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
  if (!ws) return;

  // Get story results for this run
  const storyResults = await query<StoryResultRow>(
    'SELECT story_id, status, log_path, started_at, finished_at FROM story_results WHERE run_id = $1',
    [runId]
  );

  // Skip synthesis for runs with 0 completed stories (pass or fail)
  const completedStories = storyResults.filter(s => s.status === 'pass' || s.status === 'fail');
  if (completedStories.length === 0) return;

  // Collect rich context for synthesis
  const diffs = await collectRunDiffs(ws.path, runId);
  const walEventsContext = await collectRunWalEvents(workspaceId, runId);
  const errorMessages = await collectErrorMessages(runId);

  // Get existing memory entries
  const existingEntries = readMemory(ws.path);

  // Build enriched synthesis prompt
  const storyData = storyResults.map(sr => ({
    id: sr.story_id,
    title: sr.story_id,
    status: sr.status,
    diff: undefined as string | undefined,
  }));

  const prompt = buildSynthesisPrompt(storyData, existingEntries, {
    runStatus,
    diffs,
    walEvents: walEventsContext,
    errorMessages,
  });

  // Call LLM for synthesis
  let result;
  try {
    result = await chatComplete([{ role: 'user', content: prompt }]);
  } catch (err) {
    logger.error({ err }, '[memory-synthesis] LLM call failed');
    return;
  }

  // Parse proposed entries
  const proposed = parseSynthesisResponse(result.text);
  if (proposed.length === 0) return;

  // Build proposals with IDs and persist to DB
  const today = new Date().toISOString().slice(0, 10);
  const proposals: ProposedMemoryEntry[] = proposed.map((entry, i) => ({
    ...entry,
    date: today,
    proposalId: `run-${runId}-${i}`,
    status: 'pending' as const,
  }));

  // Persist each proposal in the memory_proposals table
  for (const p of proposals) {
    await execute(
      `INSERT INTO memory_proposals (proposal_id, run_id, workspace_id, category, title, rule, context, source_story, status, proposed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
       ON CONFLICT DO NOTHING`,
      [p.proposalId, runId, workspaceId, p.category, p.title, p.rule, p.context, p.source]
    );
  }

  // Broadcast as WAL event for SSE (Hub picks this up in real time)
  const walPayload = JSON.stringify({
    run_id: runId,
    workspace_id: workspaceId,
    proposals,
  });

  const walRow = await queryOne<{ id: number }>(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('memory_proposals', $1, $2) RETURNING id`,
    [workspaceId, walPayload]
  );

  // Broadcast to SSE subscribers
  broadcastAll({
    id: walRow?.id ?? 0,
    ts: new Date().toISOString(),
    event_type: 'memory_proposals',
    workspace_id: workspaceId,
    spec_id: null,
    story_id: null,
    actor: 'system',
    payload: walPayload,
  });

  logger.info(`[memory-synthesis] Proposed ${proposals.length} memory entries for run ${runId} (status: ${runStatus})`);
}
