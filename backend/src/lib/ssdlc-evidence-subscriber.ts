/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import path from 'node:path';
import { execute, queryOne } from '../db/index';
import { subscribe, type WalEvent } from './sse-hub';
import { normalizeExistingRunEvidence } from './ssdlc-evidence';
import { logger } from './logger';

interface RunRow {
  id: number;
  workspace_id: string;
  spec_path: string;
}

function payloadObject(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function auditSubscriberError(event: WalEvent, error: unknown): Promise<void> {
  try {
    await execute(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
      VALUES ('ssdlc_evidence_adapter_error', $1, $2, $3, 'ssdlc-evidence', $4::jsonb)
    `, [
      event.workspace_id,
      event.spec_id,
      event.story_id,
      JSON.stringify({
        adapter: 'run_finished_subscriber',
        retryable: true,
        sourceWalEventId: event.id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        observedAt: new Date().toISOString(),
      }),
    ]);
  } catch (auditError) {
    logger.warn({ err: auditError }, '[ssdlc-evidence] Failed to audit subscriber error');
  }
}

async function normalizeCompletedRun(event: WalEvent): Promise<void> {
  if (event.event_type !== 'run_finished' || !event.workspace_id) return;
  try {
    const payload = payloadObject(event.payload);
    const candidate = payload.run_id ?? payload.runId;
    const runId = typeof candidate === 'number' ? candidate : Number(candidate);
    if (!Number.isSafeInteger(runId) || runId <= 0) return;
    const run = await queryOne<RunRow>(
      'SELECT id, workspace_id, spec_path FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
      [runId, event.workspace_id],
    );
    if (!run) return;
    const specSlug = event.spec_id
      || path.basename(run.spec_path).replace(/\.json$/i, '');
    if (!specSlug) return;

    await normalizeExistingRunEvidence({
      scope: {
        workspaceId: run.workspace_id,
        specSlug,
        runId: run.id,
        storyId: null,
        phaseId: 'validation',
        gateId: 'run-completion',
      },
      phaseSubject: null,
    });
  } catch (error) {
    await auditSubscriberError(event, error);
  }
}

let unsubscribe: (() => void) | null = null;

/** Side-write only: failures are audited and never affect canonical run/story status. */
export function startSsdlcEvidenceNormalizer(): () => void {
  if (unsubscribe) return unsubscribe;
  unsubscribe = subscribe((event) => {
    void normalizeCompletedRun(event);
  });
  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
}
