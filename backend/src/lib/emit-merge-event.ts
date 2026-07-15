/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';

export type MergeEventType =
  | 'worktree_merge_started'
  | 'worktree_merged'
  | 'worktree_merge_failed';

export interface MergeStartedPayload {
  runId: number | string;
  branch: string;
  targetBranch: 'main';
}

export interface MergedPayload {
  runId: number | string;
  branch: string;
  targetBranch: 'main';
  mergeCommitSha: string;
}

export interface MergeFailedPayload {
  runId: number | string;
  branch: string;
  targetBranch: 'main';
  conflictSummary: string;
}

export type MergeEventPayload = MergeStartedPayload | MergedPayload | MergeFailedPayload;

const MAX_CONFLICT_SUMMARY_LENGTH = 2000;

/**
 * Truncate conflictSummary to max 2000 characters.
 * Exposed for testing.
 */
export function truncateConflictSummary(summary: string | null | undefined): string {
  if (summary == null) return '';
  return summary.slice(0, MAX_CONFLICT_SUMMARY_LENGTH);
}

/**
 * Write a merge WAL event directly to the DB and broadcast via SSE hub.
 * Uses direct DB insert (no HTTP round-trip) since this runs in worker context.
 */
export async function emitMergeEvent(
  runId: number | string,
  eventType: MergeEventType,
  payload: MergeEventPayload,
): Promise<void> {
  try {
    const normalizedPayload: Record<string, unknown> = { ...payload };

    // Enforce conflictSummary truncation for merge_failed events
    if (
      eventType === 'worktree_merge_failed' &&
      'conflictSummary' in normalizedPayload &&
      typeof normalizedPayload['conflictSummary'] === 'string'
    ) {
      normalizedPayload['conflictSummary'] = truncateConflictSummary(
        normalizedPayload['conflictSummary'] as string,
      );
    }

    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [eventType, null, null, null, JSON.stringify(normalizedPayload)],
    );

    if (walEvent) {
      broadcastAll(walEvent);
    }
  } catch (err) {
    logger.error({ err, runId, eventType }, '[emitMergeEvent] failed to write WAL event');
  }
}
