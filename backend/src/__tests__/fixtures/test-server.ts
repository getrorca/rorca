#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * test-server.ts — Minimal Express server for pg-boss restart resilience tests (PG-014).
 *
 * Implements only the endpoints needed by the test:
 *   GET  /api/health                       — health probe (returns 200 with status=healthy)
 *   POST /api/pipeline/trigger             — insert pipeline_run + enqueue pg-boss job
 *   POST /api/wal                          — insert WAL event (called by slow-mock-engine)
 *   POST /api/pipeline/story-result        — insert story_results row (called by slow-mock-engine)
 *   GET  /api/pipeline/runs/:id/status     — status query helper
 *
 * Usage:
 *   DATABASE_URL=... PORT=3039 npx tsx test-server.ts
 */

import express from 'express';
import PgBoss from 'pg-boss';
import { Pool } from 'pg';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3039', 10);
const DB_URL = process.env.DATABASE_URL;
const BOSS_SCHEMA = process.env.PGBOSS_TEST_SCHEMA ?? 'pgboss';

if (!DB_URL) {
  process.stderr.write('[test-server] DATABASE_URL is not set — exiting\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL, max: 5 });

let boss: PgBoss | null = null;

async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({
    connectionString: DB_URL!,
    schema: BOSS_SCHEMA,
    maintenanceIntervalSeconds: 120,
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
  });
  boss.on('error', () => { /* suppress */ });
  await boss.start();
  // Ensure queue partition exists
  await boss.createQueue('pipeline:run');
  return boss;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// GET /api/health — health probe
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'postgresql', db_connected: true });
  } catch {
    res.status(503).json({ status: 'degraded', db_connected: false });
  }
});

// POST /api/pipeline/trigger — insert run + enqueue pg-boss job
app.post('/api/pipeline/trigger', async (req, res) => {
  try {
    const {
      workspaceId,
      specPath,
    } = req.body as { workspaceId?: string; specPath?: string };

    if (!workspaceId || !specPath) {
      res.status(400).json({ error: 'workspaceId and specPath are required' });
      return;
    }

    // Look up workspace path
    const wsRow = await pool.query<{ path: string }>(
      'SELECT path FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (wsRow.rows.length === 0) {
      res.status(404).json({ error: `workspace not found: ${workspaceId}` });
      return;
    }
    const workspacePath = wsRow.rows[0].path;

    // Insert pipeline_runs row
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
       VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
       RETURNING id`,
      [specPath, workspaceId],
    );
    const runId = rows[0].id;

    // Enqueue pg-boss job
    const b = await getBoss();
    await b.send('pipeline:run', {
      runId,
      specPath,
      workspacePath,
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    });

    res.json({ ok: true, runId, queued: true, queuePosition: 1, agentType: 'claude' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/wal — insert WAL event (called by slow-mock-engine)
app.post('/api/wal', async (req, res) => {
  try {
    const { event_type, workspace_id, spec_id, story_id, payload } = req.body as {
      event_type: string;
      workspace_id?: string;
      spec_id?: string;
      story_id?: string;
      payload?: Record<string, unknown>;
    };
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event_type,
        workspace_id ?? null,
        spec_id ?? null,
        story_id ?? null,
        payload ? JSON.stringify(payload) : null,
      ],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/pipeline/story-result — insert story result (called by slow-mock-engine)
app.post('/api/pipeline/story-result', async (req, res) => {
  try {
    const { runId, storyId, status } = req.body as {
      runId: number;
      storyId: string;
      status: string;
    };
    await pool.query(
      `INSERT INTO story_results (run_id, story_id, status, finished_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [runId, storyId, status],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/pipeline/runs/:id/status — status query (optional, for test convenience)
app.get('/api/pipeline/runs/:id/status', async (req, res) => {
  try {
    const { rows } = await pool.query<{ id: number; status: string }>(
      'SELECT id, status FROM pipeline_runs WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[test-server] listening on port ${PORT}\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  server.close();
  if (boss) {
    try { await boss.stop({ timeout: 3_000 }); } catch { /* ignore */ }
  }
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
