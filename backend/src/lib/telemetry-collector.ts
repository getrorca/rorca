/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── Telemetry Collector ──────────────────────────────────────────────────────
// PR-005: Collect anonymous usage metrics (event type, agent type, story count, duration)
// NEVER collects: spec content, file paths, workspace names, API keys

import { queryOne } from '../db/index';
import { isTelemetryEnabled } from './telemetry-config';
import { agentType } from './config';
import { logger } from './logger';

export interface TelemetryMetrics {
  eventType: string;
  agentType: string;
  storyCount: number;
  durationMs: number;
  timestamp: string;
}

/**
 * Collect anonymous usage metrics from a completed pipeline run.
 * Returns null if telemetry is disabled.
 */
export async function collectRunMetrics(runId: number): Promise<TelemetryMetrics | null> {
  if (!isTelemetryEnabled()) {
    return null;
  }

  try {
    const run = await queryOne<{ id: number; started_at: string; finished_at: string; agent_type: string }>(
      `SELECT id, started_at, finished_at, agent_type FROM pipeline_runs WHERE id = $1`,
      [runId]
    );

    if (!run) {
      return null;
    }

    const storyResults = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM story_results WHERE run_id = $1`,
      [runId]
    );

    const startedAt = new Date(run.started_at).getTime();
    const finishedAt = new Date(run.finished_at).getTime();
    const durationMs = finishedAt - startedAt;

    return {
      eventType: 'run_completed',
      agentType: run.agent_type || agentType,
      storyCount: storyResults?.cnt || 0,
      durationMs,
      timestamp: run.finished_at,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to collect run metrics');
    return null;
  }
}

/**
 * Collect spec generation metrics.
 */
export function collectSpecMetrics(specId: string, storyCount: number, durationMs: number): TelemetryMetrics | null {
  if (!isTelemetryEnabled()) {
    return null;
  }

  return {
    eventType: 'spec_generated',
    agentType,
    storyCount,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}
