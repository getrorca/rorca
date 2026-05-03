/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';

export const WORKER_HEARTBEAT_STALE_MS = 90_000;

export interface WorkerHeartbeatRow {
  pid: number;
  started_at?: string;
  last_seen: string;
  active_jobs?: number;
}

export async function getLatestWorkerHeartbeat(): Promise<WorkerHeartbeatRow | undefined> {
  return queryOne<WorkerHeartbeatRow>(
    'SELECT pid, started_at, last_seen, active_jobs FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 1',
  );
}

export function isWorkerHeartbeatStale(lastSeen: string, now = Date.now()): boolean {
  return now - new Date(lastSeen).getTime() > WORKER_HEARTBEAT_STALE_MS;
}
