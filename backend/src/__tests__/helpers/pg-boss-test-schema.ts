// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import { getPgBossSchemaName } from '../../lib/pg-boss-schema';

export const PG_BOSS_INTEGRATION_SUITE_NAMES = [
  'cancel',
  'concurrency',
  'dlq',
  'integration',
  'load',
  'restart',
  'scheduler',
  'zero_downtime',
] as const;

export type PgBossIntegrationSuiteName = typeof PG_BOSS_INTEGRATION_SUITE_NAMES[number];

/**
 * Give every real-runtime suite its own migration-owner-preinstalled schema.
 * The closed suite-name set prevents a new runtime suite from silently asking
 * the non-migrating principal to create an unprovisioned database schema.
 */
export function pgBossTestSchema(suite: string): string {
  if (!(PG_BOSS_INTEGRATION_SUITE_NAMES as readonly string[]).includes(suite)) {
    throw new Error(`Unprovisioned pg-boss integration suite schema suffix: ${suite}`);
  }
  const schema = `${getPgBossSchemaName()}_${suite}`;
  if (Buffer.byteLength(schema, 'utf8') > 63) {
    throw new Error(`pg-boss test schema exceeds PostgreSQL identifier limit: ${schema}`);
  }
  return schema;
}
