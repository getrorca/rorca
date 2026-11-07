/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type PgBoss from 'pg-boss';
import { execute } from '../db/index';
import { subscribe, type WalEvent } from './sse-hub';
import { getBoss, initBoss } from './pg-boss';
import {
  enqueueLifecycleAssuranceForRun,
  recoverRecentLifecycleAssurancePublications,
  registerLifecycleAssuranceWorker,
} from './ssdlc-lifecycle-orchestrator';
import { logger } from './logger';


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
    await enqueueLifecycleAssuranceForRun({
      workspaceId: event.workspace_id,
      runId,
    });
  } catch (error) {
    await auditSubscriberError(event, error);
  }
}

let activeStop: (() => void) | null = null;
let workerRegistration: Promise<PgBoss> | null = null;
let recoverySweep: Promise<void> | null = null;

function recoverDueLifecycleAssurance(boss: PgBoss): Promise<void> {
  if (recoverySweep) return recoverySweep;
  recoverySweep = recoverRecentLifecycleAssurancePublications(100, boss)
    .catch((error) => {
      logger.warn({ err: error }, '[ssdlc-evidence] lifecycle assurance recovery sweep failed');
    })
    .finally(() => {
      recoverySweep = null;
    });
  return recoverySweep;
}

function ensureWorkerRegistered(): Promise<PgBoss> {
  workerRegistration ??= initBoss().then(async () => {
    const boss = getBoss();
    await registerLifecycleAssuranceWorker(boss);
    return boss;
  }).catch((error) => {
    workerRegistration = null;
    throw error;
  });
  return workerRegistration;
}

/** Side-write only: failures are audited and never affect canonical run/story status. */
export function startSsdlcEvidenceNormalizer(): () => void {
  if (activeStop) return activeStop;

  const unsubscribe = subscribe((event) => normalizeCompletedRun(event));
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (activeStop !== stop) return;
    unsubscribe();
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
    activeStop = null;
  };
  activeStop = stop;

  void ensureWorkerRegistered()
    .then((boss) => {
      if (activeStop !== stop) return;
      void recoverDueLifecycleAssurance(boss);
      recoveryTimer = setInterval(() => {
        void recoverDueLifecycleAssurance(boss);
      }, 60_000);
      recoveryTimer.unref();
    })
    .catch((error) => {
      logger.warn({ err: error }, '[ssdlc-evidence] lifecycle assurance startup recovery failed');
    });

  return stop;
}
