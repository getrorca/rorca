import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { broadcastAll, attachSSE, type WalEvent } from '../lib/sse-hub';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineRunRow {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: string;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
}

interface StoryResultRow {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  retries: number;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
}

// ─── POST /api/pipeline/runs — Create a pipeline run ────────────────────────

router.post('/runs', (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;

    if (!specPath || !workspaceId) {
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
      return;
    }

    const result = db.prepare(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, 'running')`
    ).run(specPath, workspaceId);

    const runId = result.lastInsertRowid as number;

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow;

    // Insert WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_started', ?, ?)`
    ).run(workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath }));

    // Broadcast to SSE subscribers
    const walEvent = db.prepare(
      'SELECT * FROM wal_events WHERE id = ?'
    ).get(walResult.lastInsertRowid) as WalEvent;

    broadcastAll(walEvent);

    res.status(201).json({ run });
  } catch (error: any) {
    console.error('[Pipeline] Create run error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/pipeline/runs — List pipeline runs ─────────────────────────────

router.get('/runs', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const runs = db.prepare(
      'SELECT * FROM pipeline_runs WHERE workspace_id = ? ORDER BY id DESC'
    ).all(workspaceId) as PipelineRunRow[];

    res.json({ runs });
  } catch (error: any) {
    console.error('[Pipeline] List runs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/pipeline/runs/:runId — Get run detail + story results ──────────

router.get('/runs/:runId', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const stories = db.prepare(
      'SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC'
    ).all(runId) as StoryResultRow[];

    res.json({ run, stories });
  } catch (error: any) {
    console.error('[Pipeline] Get run error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/pipeline/stream — SSE event stream ─────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;

router.get('/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial keepalive
  res.write(': keepalive\n\n');

  // Wire up real-time broadcast via sse-hub
  const unsubscribe = attachSSE(res);

  // Heartbeat every 15s
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  // Also poll WAL for events (catch events from external processes like Ralph)
  const runId = req.query.runId as string;
  let lastSeenId = 0;
  const pollInterval = setInterval(() => {
    try {
      let events;
      if (runId) {
        events = db.prepare(
          `SELECT * FROM wal_events
           WHERE id > ?
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_skipped','run_started','run_finished','run_failed','spec_generated','spec_approved','spec_rejected')
             AND (payload LIKE ? OR spec_id IS NOT NULL)
           ORDER BY id ASC
           LIMIT 50`
        ).all(lastSeenId, `%"run_id":${runId}%`);
      } else {
        events = db.prepare(
          `SELECT * FROM wal_events
           WHERE id > ?
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_skipped','run_started','run_finished','run_failed','spec_generated','spec_approved','spec_rejected')
           ORDER BY id ASC
           LIMIT 50`
        ).all(lastSeenId);
      }

      for (const event of events as any[]) {
        res.write(`event: wal_event\ndata: ${JSON.stringify(event)}\n\n`);
        lastSeenId = event.id;
      }
    } catch {
      // DB may be locked briefly, skip this tick
    }
  }, 1000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeatInterval);
    clearInterval(pollInterval);
  });
});

export default router;
