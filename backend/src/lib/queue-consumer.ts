import { db } from '../db/index';
import { subscribe, broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';

interface RunQueueEntry {
  id: number;
  workspace_id: number;
  spec_id: string;
  spec_path: string;
  parallelism: number;
  auto_worktree: number;
  position: number;
  status: string;
}

const RETRY_DELAY_MS = 5_000;

/**
 * Subscribes to WAL run_finished events and auto-triggers
 * the next pending queue entry for the same workspace.
 */
export function startQueueConsumer(): void {
  subscribe(handleWalEvent);
}

function handleWalEvent(event: WalEvent): void {
  if (event.event_type !== 'run_finished') return;
  if (!event.workspace_id) return;

  const workspaceId = event.workspace_id;

  // Find next pending entry for this workspace
  const entry = db.prepare(
    `SELECT * FROM run_queue WHERE workspace_id = ? AND status = 'pending' ORDER BY position ASC LIMIT 1`
  ).get(Number(workspaceId)) as RunQueueEntry | undefined;

  if (!entry) return; // Queue empty — no-op

  triggerQueueEntry(entry);
}

function triggerQueueEntry(entry: RunQueueEntry): void {
  // Mark as triggering
  db.prepare(
    `UPDATE run_queue SET status = 'triggering' WHERE id = ?`
  ).run(entry.id);

  // Make internal HTTP call to pipeline trigger (same code path as POST /api/pipeline/trigger)
  const port = process.env.PORT || 3030;
  const payload = JSON.stringify({
    specPath: entry.spec_path,
    workspaceId: String(entry.workspace_id),
    parallelism: entry.parallelism,
    autoWorktree: entry.auto_worktree === 1,
    triggerType: 'queued',
  });

  // Use dynamic import to avoid pulling in http at module level during tests
  const http = require('http') as typeof import('http');
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/pipeline/trigger',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && result.ok) {
            // Success — mark triggered
            db.prepare(
              `UPDATE run_queue SET status = 'triggered', triggered_at = datetime('now') WHERE id = ?`
            ).run(entry.id);

            // Emit WAL event
            emitQueueTriggerEvent(entry);

            logger.info(`[QueueConsumer] Triggered run for spec ${entry.spec_id} (queue entry ${entry.id})`);
          } else if (result.conflict) {
            // Active run conflict — revert to pending, retry after delay
            db.prepare(
              `UPDATE run_queue SET status = 'pending' WHERE id = ?`
            ).run(entry.id);

            logger.info(`[QueueConsumer] Conflict for workspace ${entry.workspace_id}, retrying in ${RETRY_DELAY_MS}ms`);
            setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
          } else {
            // Other error
            const errorMsg = result.error || `HTTP ${res.statusCode}`;
            markEntryFailed(entry, errorMsg);
            setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
          }
        } catch (parseErr) {
          markEntryFailed(entry, `Response parse error: ${body.slice(0, 200)}`);
          setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
        }
      });
    },
  );

  req.on('error', (err: Error) => {
    markEntryFailed(entry, `Connection error: ${err.message}`);
    setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
  });

  req.write(payload);
  req.end();
}

function markEntryFailed(entry: RunQueueEntry, errorMessage: string): void {
  db.prepare(
    `UPDATE run_queue SET status = 'failed', error_message = ? WHERE id = ?`
  ).run(errorMessage, entry.id);
  logger.error(`[QueueConsumer] Failed to trigger spec ${entry.spec_id}: ${errorMessage}`);
}

function retryNextEntry(workspaceId: number): void {
  const next = db.prepare(
    `SELECT * FROM run_queue WHERE workspace_id = ? AND status = 'pending' ORDER BY position ASC LIMIT 1`
  ).get(workspaceId) as RunQueueEntry | undefined;

  if (next) {
    triggerQueueEntry(next);
  }
}

function emitQueueTriggerEvent(entry: RunQueueEntry): void {
  const walResult = db.prepare(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, payload) VALUES ('run_queued_trigger', ?, ?, ?)`
  ).run(
    String(entry.workspace_id),
    entry.spec_id,
    JSON.stringify({ queuePosition: entry.position, queueEntryId: entry.id }),
  );

  const walEvent = db.prepare(
    'SELECT * FROM wal_events WHERE id = ?'
  ).get(walResult.lastInsertRowid) as WalEvent;

  broadcastAll(walEvent);
}
