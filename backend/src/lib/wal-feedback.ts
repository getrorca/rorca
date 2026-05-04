/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * wal-feedback.ts — WAL Event → Memory Entry Generator (PR-020)
 *
 * Reads all WAL events for a completed pipeline run and generates
 * candidate memory entries based on failure analysis, success patterns,
 * and retry detection. Entries go through deduplication before being written.
 */

import { query, queryOne } from '../db/index';
import {
  readMemory,
  type MemoryEntry,
  type MemoryCategory,
} from './memory-ledger';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WalEventRow {
  id: number;
  event_type: string;
  story_id: string | null;
  payload: string | null;
  ts: string;
}

interface StoryResultRow {
  story_id: string;
  status: string;
  retries: number;
  started_at: string | null;
  finished_at: string | null;
}

interface PipelineRunRow {
  id: number;
  workspace_id: string;
  spec_path: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

export interface CandidateMemoryEntry {
  category: MemoryCategory;
  title: string;
  rule: string;
  context: string;
  source: string;
}

// ─── Core Analysis ──────────────────────────────────────────────────────────

/**
 * Analyze all WAL events for a completed run and generate candidate
 * memory entries. Does NOT write to MEMORY.md — returns candidates
 * for deduplication and persistence.
 */
export async function analyzeRunEvents(runId: number): Promise<CandidateMemoryEntry[]> {
  const run = await queryOne<PipelineRunRow>(
    'SELECT id, workspace_id, spec_path, status, started_at, finished_at FROM pipeline_runs WHERE id = $1',
    [runId]
  );

  if (!run) {
    logger.warn(`[wal-feedback] Run ${runId} not found`);
    return [];
  }

  const storyResults = await query<StoryResultRow>(
    'SELECT story_id, status, retries, started_at, finished_at FROM story_results WHERE run_id = $1',
    [runId]
  );

  if (storyResults.length === 0) return [];

  // Collect WAL events for this run's timeframe
  const walEvents = await collectWalEventsForRun(run);

  const candidates: CandidateMemoryEntry[] = [];

  // Analysis 1: Failure patterns
  candidates.push(...analyzeFailures(runId, storyResults, walEvents));

  // Analysis 2: Success patterns (all stories pass on first try)
  candidates.push(...analyzeSuccessPatterns(runId, storyResults));

  // Analysis 3: Retry/flaky patterns
  candidates.push(...analyzeRetryPatterns(runId, storyResults, walEvents));

  // Analysis 4: Escalation patterns
  candidates.push(...analyzeEscalations(runId, walEvents));

  // Deduplicate against existing memory entries
  const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]);
  if (ws) {
    const existing = readMemory(ws.path);
    return deduplicateCandidates(candidates, existing);
  }

  return candidates;
}

// ─── Failure Analysis ───────────────────────────────────────────────────────

function analyzeFailures(
  runId: number,
  storyResults: StoryResultRow[],
  walEvents: WalEventRow[],
): CandidateMemoryEntry[] {
  const candidates: CandidateMemoryEntry[] = [];
  const failedStories = storyResults.filter(s => s.status === 'fail');

  if (failedStories.length === 0) return candidates;

  // Extract failure reasons from WAL events
  for (const story of failedStories) {
    const failEvent = walEvents.find(
      e => e.event_type === 'story_failed' && e.story_id === story.story_id
    );

    if (!failEvent?.payload) continue;

    let payload: { reason?: string; error?: string };
    try {
      payload = JSON.parse(failEvent.payload);
    } catch {
      continue;
    }

    const reason = payload.reason || 'unknown';
    const errorSnippet = payload.error ? String(payload.error).slice(0, 200) : '';

    if (reason === 'timeout') {
      candidates.push({
        category: 'Gotcha',
        title: `Story ${story.story_id} timed out`,
        rule: `Story ${story.story_id} exceeded the execution timeout. Consider breaking it into smaller stories or increasing the timeout threshold.`,
        context: `Failed during run #${runId} with timeout.`,
        source: `auto-generated from run #${runId}`,
      });
    } else if (reason === 'max_retries') {
      candidates.push({
        category: 'Bug Fix',
        title: `Story ${story.story_id} failed after max retries`,
        rule: `Story ${story.story_id} failed ${story.retries} times and was skipped. Root cause: ${errorSnippet || 'unknown'}.`,
        context: `Persistent failure pattern in run #${runId}. Investigate root cause before re-running.`,
        source: `auto-generated from run #${runId}`,
      });
    } else {
      candidates.push({
        category: 'Gotcha',
        title: `Story ${story.story_id} failed: ${reason}`,
        rule: `Story ${story.story_id} failed with reason "${reason}". ${errorSnippet ? `Error: ${errorSnippet}` : ''}`,
        context: `Failure in run #${runId}. Review before retrying.`,
        source: `auto-generated from run #${runId}`,
      });
    }
  }

  // Aggregate pattern: multiple failures in one run
  if (failedStories.length >= 3) {
    candidates.push({
      category: 'Pattern',
      title: `High failure rate in run #${runId}`,
      rule: `${failedStories.length} of ${storyResults.length} stories failed. This may indicate systemic issues (missing dependencies, env misconfiguration, or overly complex stories).`,
      context: `Failed stories: ${failedStories.map(s => s.story_id).join(', ')}`,
      source: `auto-generated from run #${runId}`,
    });
  }

  return candidates;
}

// ─── Success Pattern Analysis ───────────────────────────────────────────────

function analyzeSuccessPatterns(
  runId: number,
  storyResults: StoryResultRow[],
): CandidateMemoryEntry[] {
  const candidates: CandidateMemoryEntry[] = [];
  const passed = storyResults.filter(s => s.status === 'pass');
  const allFirstTry = passed.length === storyResults.length &&
    storyResults.every(s => s.retries === 0);

  if (allFirstTry && storyResults.length >= 3) {
    candidates.push({
      category: 'Pattern',
      title: `Clean run #${runId}: all ${storyResults.length} stories passed first try`,
      rule: `All ${storyResults.length} stories passed on first attempt with zero retries. The spec was well-structured and context was sufficient.`,
      context: `This indicates good spec quality and adequate direction stack context.`,
      source: `auto-generated from run #${runId}`,
    });
  }

  return candidates;
}

// ─── Retry/Flaky Pattern Analysis ───────────────────────────────────────────

function analyzeRetryPatterns(
  runId: number,
  storyResults: StoryResultRow[],
  walEvents: WalEventRow[],
): CandidateMemoryEntry[] {
  const candidates: CandidateMemoryEntry[] = [];

  // Stories that failed then eventually passed (retries > 0 and status = pass)
  const retriedAndPassed = storyResults.filter(s => s.status === 'pass' && s.retries > 0);

  for (const story of retriedAndPassed) {
    // Find the failure event(s) for context
    const failEvents = walEvents.filter(
      e => e.event_type === 'story_failed' && e.story_id === story.story_id
    );

    let failureContext = '';
    for (const fe of failEvents) {
      if (!fe.payload) continue;
      try {
        const p = JSON.parse(fe.payload);
        if (p.reason) failureContext += `reason=${p.reason} `;
        if (p.error) failureContext += `error="${String(p.error).slice(0, 100)}" `;
      } catch { /* ignore */ }
    }

    candidates.push({
      category: 'Gotcha',
      title: `Flaky: ${story.story_id} required ${story.retries} retries`,
      rule: `Story ${story.story_id} eventually passed after ${story.retries} retry attempts. ${failureContext.trim() || 'No specific failure reason captured.'}`,
      context: `Flaky pattern detected in run #${runId}. Consider simplifying the story or adding more context to prevent initial failures.`,
      source: `auto-generated from run #${runId}`,
    });
  }

  // Aggregate: many retried stories
  if (retriedAndPassed.length >= 3) {
    candidates.push({
      category: 'Pattern',
      title: `High retry rate in run #${runId}`,
      rule: `${retriedAndPassed.length} stories required retries before passing. This suggests insufficient context or overly complex acceptance criteria.`,
      context: `Retried stories: ${retriedAndPassed.map(s => s.story_id).join(', ')}`,
      source: `auto-generated from run #${runId}`,
    });
  }

  return candidates;
}

// ─── Escalation Analysis ────────────────────────────────────────────────────

function analyzeEscalations(
  runId: number,
  walEvents: WalEventRow[],
): CandidateMemoryEntry[] {
  const candidates: CandidateMemoryEntry[] = [];

  const escalationEvents = walEvents.filter(e => e.event_type === 'story_escalated');

  for (const event of escalationEvents) {
    if (!event.payload) continue;
    let payload: { fromModel?: string; toModel?: string; storyId?: string; reason?: string };
    try {
      payload = JSON.parse(event.payload);
    } catch {
      continue;
    }

    if (payload.fromModel && payload.toModel) {
      candidates.push({
        category: 'Decision',
        title: `Model escalation for ${payload.storyId || 'unknown'}: ${payload.fromModel} -> ${payload.toModel}`,
        rule: `Story ${payload.storyId || 'unknown'} required escalation from ${payload.fromModel} to ${payload.toModel}. ${payload.reason ? `Reason: ${payload.reason}` : ''}`,
        context: `Model cascading escalation in run #${runId}. Consider pre-assigning this story type to a higher-tier model.`,
        source: `auto-generated from run #${runId}`,
      });
    }
  }

  return candidates;
}

// ─── WAL Event Collection ───────────────────────────────────────────────────

async function collectWalEventsForRun(run: PipelineRunRow): Promise<WalEventRow[]> {
  // Get events that reference this run_id in payload
  const events = await query<WalEventRow>(
    `SELECT id, event_type, story_id, payload, ts FROM wal_events
     WHERE workspace_id = $1 AND payload LIKE $2
     ORDER BY id ASC LIMIT 200`,
    [run.workspace_id, `%"run_id":${run.id}%`]
  );

  // Also get story-level events in the run timeframe
  const storyEvents = await query<WalEventRow>(
    `SELECT id, event_type, story_id, payload, ts FROM wal_events
     WHERE workspace_id = $1 AND event_type IN ('story_started', 'story_passed', 'story_failed', 'story_skipped', 'story_escalated')
     AND id >= (SELECT COALESCE(MIN(id), 0) FROM wal_events WHERE workspace_id = $2 AND event_type = 'run_started' AND payload LIKE $3)
     AND id <= (SELECT COALESCE(MAX(id), 999999999) FROM wal_events WHERE workspace_id = $4 AND event_type = 'run_finished' AND payload LIKE $5)
     ORDER BY id ASC LIMIT 200`,
    [
      run.workspace_id,
      run.workspace_id, `%"run_id":${run.id}%`,
      run.workspace_id, `%"run_id":${run.id}%`,
    ]
  );

  // Deduplicate
  const seen = new Set<number>();
  const all: WalEventRow[] = [];
  for (const e of [...events, ...storyEvents]) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      all.push(e);
    }
  }

  return all.sort((a, b) => a.id - b.id);
}

// ─── Deduplication ──────────────────────────────────────────────────────────

function deduplicateCandidates(
  candidates: CandidateMemoryEntry[],
  existing: MemoryEntry[],
): CandidateMemoryEntry[] {
  const existingTitles = new Set(existing.map(e => e.title.toLowerCase()));

  // Also deduplicate within candidates themselves
  const seen = new Set<string>();

  return candidates.filter(c => {
    const key = c.title.toLowerCase();
    if (existingTitles.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Workspace Setting Check ────────────────────────────────────────────────

/**
 * Check if AUTO_MEMORY_SYNTHESIS is enabled for a workspace.
 * Reads from workspace_env_vars table.
 */
export async function isAutoSynthesisEnabled(workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM workspace_env_vars WHERE workspace_id = $1 AND key = 'AUTO_MEMORY_SYNTHESIS'`,
    [workspaceId]
  );

  return row?.value === 'true';
}
