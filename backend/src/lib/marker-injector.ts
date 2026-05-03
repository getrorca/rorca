/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * marker-injector.ts — WAL subscriber that injects ANSI story-completion markers
 * into run_output_chunks so they are persisted and replayed for late-joiners.
 *
 * Subscribes globally to sse-hub. On story_passed / story_failed / story_skipped,
 * writes a colored marker line as a new chunk with the next sequence number.
 */

import { subscribe, type WalEvent } from './sse-hub';
import { queryOne, execute } from '../db/index';

const STORY_EVENTS = new Set(['story_passed', 'story_failed', 'story_skipped']);

/** Track injected WAL event IDs to prevent duplicate markers on rebroadcast. */
const injectedIds = new Set<number>();

/**
 * Format an ANSI-colored marker line matching the US-003 frontend format.
 */
function formatMarker(storyId: string, title: string, status: string, payload: Record<string, unknown>): string {
  let elapsedStr = '';
  if (payload.elapsed_ms && typeof payload.elapsed_ms === 'number') {
    const totalSec = Math.round(payload.elapsed_ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    elapsedStr = min > 0 ? `${min}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
  }

  if (status === 'story_passed') {
    return `\r\n\x1b[32m✓ ${storyId}: ${title} — passed${elapsedStr ? ` (${elapsedStr})` : ''}\x1b[0m\r\n`;
  }
  if (status === 'story_failed') {
    return `\r\n\x1b[31m✗ ${storyId}: ${title} — failed${elapsedStr ? ` (${elapsedStr})` : ''}\x1b[0m\r\n`;
  }
  // story_skipped
  let extra = '';
  if (payload.blocked_by) extra = ` (blocked by ${payload.blocked_by})`;
  else if (payload.reason) extra = ` (${payload.reason})`;
  return `\r\n\x1b[33m⊘ ${storyId}: ${title} — skipped${extra}\x1b[0m\r\n`;
}

async function handleWalEvent(event: WalEvent): Promise<void> {
  if (!STORY_EVENTS.has(event.event_type)) return;
  if (!event.story_id) return;

  // Idempotency: skip if we already injected a marker for this WAL event
  if (injectedIds.has(event.id)) return;
  injectedIds.add(event.id);

  // Parse payload
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(event.payload ?? '{}'); } catch { /* ignore */ }

  // Resolve run_id from payload or from story_results
  const runId = payload.run_id ?? payload.runId;
  if (!runId) return;
  const numericRunId = Number(runId);
  if (isNaN(numericRunId)) return;

  // Resolve story title — try payload first, fall back to story_results
  let title = (payload.story_title as string) || (payload.title as string) || '';
  if (!title) {
    const sr = await queryOne<{ story_title: string }>(
      'SELECT story_title FROM story_results WHERE run_id = $1 AND story_id = $2',
      [numericRunId, event.story_id],
    );
    title = sr?.story_title || event.story_id;
  }

  const marker = formatMarker(event.story_id, title, event.event_type, payload);
  const markerBuf = Buffer.from(marker, 'utf8');

  // Get next sequence number atomically
  const seqRow = await queryOne<{ max_seq: number | null }>(
    'SELECT MAX(sequence) AS max_seq FROM run_output_chunks WHERE run_id = $1',
    [numericRunId],
  );
  const nextSeq = (seqRow?.max_seq ?? 0) + 1;

  // Insert with ON CONFLICT DO NOTHING for idempotency (unique on run_id, sequence)
  await execute(
    `INSERT INTO run_output_chunks (run_id, chunk, sequence)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id, sequence) DO NOTHING`,
    [numericRunId, markerBuf, nextSeq],
  );
}

/**
 * Start the marker injector — call once from server.ts at startup.
 */
export function startMarkerInjector(): void {
  subscribe((event) => {
    handleWalEvent(event).catch(() => {
      // Non-fatal — marker injection failure must not affect the run
    });
  });
}
