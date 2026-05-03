/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * draft-pr-subscriber.ts — WAL event subscriber for draft PR progress updates.
 *
 * Subscribes to sse-hub and reacts to story completion events by triggering
 * debounced PR body updates. Registered once in server.ts (same pattern as
 * agent-hook-runner.ts and notification-dispatcher.ts).
 */

import { subscribe, type WalEvent } from './sse-hub';
import { updateDraftPrProgress } from './github-draft-pr';
import { logger } from './logger';

const TRACKED_EVENTS = new Set([
  'story_passed',
  'story_failed',
  'story_skipped',
]);

/**
 * Register the draft PR subscriber on the SSE hub.
 * Call once at server startup.
 */
export function registerDraftPrSubscriber(): void {
  subscribe((event: WalEvent) => {
    if (!TRACKED_EVENTS.has(event.event_type)) return;
    if (!event.payload) return;

    try {
      const payload = JSON.parse(event.payload);
      const runId = payload.run_id;
      const workspaceId = event.workspace_id;

      if (runId == null || workspaceId == null) return;

      // Fire debounced update (non-blocking, fire-and-forget)
      updateDraftPrProgress(Number(runId), workspaceId);
    } catch {
      // Malformed payload — skip
    }
  });

  logger.info('[draft-pr-subscriber] Registered on SSE hub');
}
