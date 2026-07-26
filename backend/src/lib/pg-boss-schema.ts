// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

/** One validated authority for pg-boss configuration and internal evidence reads. */
export function getPgBossSchemaName(): string {
  const configuredSchema = process.env.RORCA_PGBOSS_SCHEMA?.trim() || 'pgboss';
  if (!/^pgboss(?:_[a-z0-9_]{1,48})?$/.test(configuredSchema)) {
    throw new Error('[pg-boss] RORCA_PGBOSS_SCHEMA must be pgboss or a bounded pgboss_* identifier');
  }
  return configuredSchema;
}

/** SQL identifier safe only because getPgBossSchemaName applies a closed grammar. */
export function getPgBossSchemaSql(): string {
  return `"${getPgBossSchemaName()}"`;
}

const PG_BOSS_INTERNAL_TABLES = ['job', 'archive', 'schedule', 'version'] as const;
export type PgBossInternalTable = typeof PG_BOSS_INTERNAL_TABLES[number];

/** Closed-table SQL reference for unavoidable read-only pg-boss evidence queries. */
export function getPgBossTableSql(table: PgBossInternalTable): string {
  if (!PG_BOSS_INTERNAL_TABLES.includes(table)) {
    throw new Error('[pg-boss] unsupported internal table reference');
  }
  return `${getPgBossSchemaSql()}.${table}`;
}
