/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';

export const PIPELINE_RUN_TRANSPORT_QUEUES = [
  'pipeline:run',
  'pipeline:run:direct',
  'pipeline:retry',
] as const;

const LIVE_PIPELINE_RUN_TRANSPORT_SQL = PIPELINE_RUN_TRANSPORT_QUEUES
  .map((queueName) => `'${queueName}'`)
  .join(', ');

/** Consuming-side crash recovery inventory for every fresh/retry run lane. */
export async function findLivePipelineRunTransport(
  runId: number | string,
  pgBossJobTable: string,
): Promise<{ id: string } | undefined> {
  return queryOne<{ id: string }>(
    `SELECT id FROM ${pgBossJobTable}
      WHERE name IN (${LIVE_PIPELINE_RUN_TRANSPORT_SQL})
        AND data->>'runId' = $1
        AND state IN ('created', 'active', 'retry')
      LIMIT 1`,
    [String(runId)],
  );
}
