/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/index';
import { logger } from './logger';

const SLOW_QUERY_THRESHOLD_MS = 100;

/**
 * V2-099: Database query timing middleware.
 * Logs requests where the total handler time exceeds 100ms.
 * This captures slow DB queries indirectly via total request duration.
 */
export function queryTimerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  const originalEnd = res.end;
  const originalJson = res.json;

  // Intercept res.json to measure time before response is sent
  res.json = function (body?: any) {
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn(
        `[QueryTimer] SLOW ${req.method} ${req.originalUrl} — ${elapsed.toFixed(1)}ms (threshold: ${SLOW_QUERY_THRESHOLD_MS}ms)`
      );
    }
    return originalJson.call(this, body);
  };

  // Also intercept res.end for SSE and non-JSON responses
  const wrappedEnd: typeof res.end = function (this: Response, ...args: any[]) {
    const elapsed = performance.now() - start;
    // Only log for non-SSE endpoints (SSE connections are long-lived)
    if (elapsed > SLOW_QUERY_THRESHOLD_MS && !res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
      logger.warn(
        `[QueryTimer] SLOW ${req.method} ${req.originalUrl} — ${elapsed.toFixed(1)}ms (threshold: ${SLOW_QUERY_THRESHOLD_MS}ms)`
      );
    }
    return originalEnd.apply(this, args as any);
  } as typeof res.end;
  res.end = wrappedEnd;

  next();
}

/**
 * V2-099: EXPLAIN audit for common queries.
 * Run at startup to verify no sequential scans exist for hot paths.
 * Returns audit results — logs warnings for Seq Scan operations.
 *
 * Uses the pg Pool from db/index (no parameter needed).
 */
export async function runQueryPlanAudit(): Promise<{
  query: string;
  plan: string;
  hasScan: boolean;
}[]> {
  const queries = [
    // Pipeline runs: conflict check (workspace_id + status)
    {
      label: 'pipeline_runs: conflict check',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM pipeline_runs WHERE workspace_id = 'ws1' AND status IN ('running', 'paused') LIMIT 1`,
    },
    // Pipeline runs: list by workspace
    {
      label: 'pipeline_runs: list by workspace',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM pipeline_runs WHERE workspace_id = 'ws1' ORDER BY id DESC LIMIT 50`,
    },
    // Story results: by run_id
    {
      label: 'story_results: by run_id',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM story_results WHERE run_id = 1 ORDER BY id ASC`,
    },
    // Story results: by run_id + story_id
    {
      label: 'story_results: by run_id + story_id',
      sql: `EXPLAIN (FORMAT TEXT) SELECT id FROM story_results WHERE run_id = 1 AND story_id = 'V2-001' ORDER BY id DESC LIMIT 1`,
    },
    // WAL events: SSE polling (id > last_seen, common event types)
    {
      label: 'wal_events: SSE poll (id > N)',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM wal_events WHERE id > 0 AND event_type IN ('story_started','story_passed','story_failed','run_started','run_finished') ORDER BY id ASC LIMIT 50`,
    },
    // WAL events: by workspace_id
    {
      label: 'wal_events: filter by workspace_id',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM wal_events WHERE workspace_id = 'ws1' ORDER BY id DESC LIMIT 50`,
    },
    // WAL events: rejected specs
    {
      label: 'wal_events: rejected spec lookup',
      sql: `EXPLAIN (FORMAT TEXT) SELECT spec_id, ts, payload FROM wal_events WHERE event_type = 'spec_rejected' AND payload::text LIKE '%ws1%' ORDER BY ts DESC`,
    },
    // Token usage: by run_id
    {
      label: 'token_usage: by run_id',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM token_usage WHERE run_id = 1`,
    },
    // Token usage: by workspace_id
    {
      label: 'token_usage: by workspace_id',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM token_usage WHERE workspace_id = 'ws1'`,
    },
    // Spec versions: by slug
    {
      label: 'spec_versions: by slug',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM spec_versions WHERE spec_slug = 'my-spec'`,
    },
    // Notifications: by user_id unread
    {
      label: 'notifications: unread by user',
      sql: `EXPLAIN (FORMAT TEXT) SELECT * FROM notifications WHERE user_id = 'u1' AND read_at IS NULL ORDER BY created_at DESC`,
    },
  ];

  const results: { query: string; plan: string; hasScan: boolean }[] = [];

  for (const { label, sql } of queries) {
    try {
      const rows = await query<{ 'QUERY PLAN': string }>(sql);
      const plan = rows.map(r => r['QUERY PLAN']).join('\n');
      // Seq Scan = sequential scan (PostgreSQL equivalent of SQLite's SCAN TABLE)
      const hasScan = plan.includes('Seq Scan');

      if (hasScan) {
        logger.warn(`[QueryAudit] FULL TABLE SCAN detected: ${label}\n  Plan: ${plan}`);
      }

      results.push({ query: label, plan, hasScan });
    } catch {
      // Table may not exist yet during early migrations — skip silently
    }
  }

  const scanCount = results.filter(r => r.hasScan).length;
  const totalCount = results.length;
  logger.info(`[QueryAudit] Audit complete: ${totalCount - scanCount}/${totalCount} queries use indexes`);

  return results;
}
