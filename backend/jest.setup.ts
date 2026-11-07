/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Jest global setup: provision one fresh nonce-owned PostgreSQL 16 target. */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createPoolForConnectionString, runPgMigrations } from './src/db/pg-index';
import { provisionIsolatedTestDatabase } from './src/lib/test-db-harness';
import { assertConnectedTestDatabase } from './src/lib/test-db-safety';
import {
  PG_BOSS_INTEGRATION_SUITE_NAMES,
  pgBossTestSchema,
} from './src/__tests__/helpers/pg-boss-test-schema';

interface AuthorityReadinessRow {
  authenticated_role: boolean;
  auth_schema: boolean;
  auth_uid: boolean;
  auth_jwt: boolean;
  pgcrypto_extension: boolean;
  vector_extension: boolean;
  migrations_table: boolean;
  graph_decision_recorded: boolean;
  workspace_members_table: boolean;
  test_identity_function: boolean;
}

function missingAuthorityObjects(row: AuthorityReadinessRow | undefined): string[] {
  if (!row) return ['authority readiness row'];
  return Object.entries(row).filter(([, ready]) => ready !== true).map(([name]) => name);
}

export default async function globalSetup(): Promise<void> {
  const state = await provisionIsolatedTestDatabase();
  if (!state.databaseUrl || !state.migrationDatabaseUrl
    || !state.canonicalWriterDatabaseUrl || !state.user) {
    throw new Error('[jest-setup] Invocation split-principal topology was not provisioned');
  }
  const canonicalWriterUser = decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl).username);
  Object.assign(process.env, {
    RORCA_TEST_DB_CAPABILITY: 'invocation-lease',
    RORCA_TEST_DATABASE_URL: state.databaseUrl,
    DATABASE_URL_TEST: state.databaseUrl,
    DATABASE_URL: state.databaseUrl,
    RORCA_MIGRATION_DATABASE_URL: state.migrationDatabaseUrl,
    WAVE2_TEST_MIGRATION_DATABASE_URL: state.migrationDatabaseUrl,
    RORCA_RUNTIME_DATABASE_USER: state.user,
    RORCA_CANONICAL_WRITER_DATABASE_URL: state.canonicalWriterDatabaseUrl,
    RORCA_CANONICAL_WRITER_DATABASE_USER: canonicalWriterUser,
    RORCA_TEST_DATABASE_WORKSPACE_SCOPE: 'workspace:wave-two',
    RORCA_PGBOSS_SCHEMA: 'pgboss',
    RORCA_PGBOSS_PREAPPLIED: 'true',
  });
  const pool = createPoolForConnectionString(state.migrationDatabaseUrl);
  try {
    const connected = await assertConnectedTestDatabase(pool, state.migrationDatabaseUrl);
    await runPgMigrations(pool);
    await pool.query(`
      CREATE FUNCTION rorca.test_invocation_server_identity()
      RETURNS TABLE(system_identifier TEXT, data_directory TEXT)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT control.system_identifier::text, current_setting('data_directory')
          FROM pg_control_system() control
      $$;
      REVOKE ALL ON FUNCTION rorca.test_invocation_server_identity() FROM PUBLIC;
      DO $$ BEGIN
        EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.test_invocation_server_identity() TO %I',
          current_setting('rorca.canonical_writer_database_user'));
      END $$;
    `);
    // pg-boss 10.4.2 may retain an internal handle after stop(). Install the
    // canonical runtime schema and the exact closed set of real integration
    // suite schemas through isolated migration-owner children. Runtime PgBoss
    // instances receive object rights, never CREATE authority on the database.
    const pgBossSchemas = [
      process.env.RORCA_PGBOSS_SCHEMA as string,
      ...PG_BOSS_INTEGRATION_SUITE_NAMES.map(pgBossTestSchema),
    ];
    for (const schema of pgBossSchemas) {
      const installer = spawnSync(process.execPath, [
        '--import',
        'tsx',
        path.resolve(process.cwd(), 'src/db/pg-boss-install.ts'),
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: state.migrationDatabaseUrl,
          RORCA_PGBOSS_SCHEMA: schema,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (installer.error || installer.status !== 0) {
        throw new Error(`[jest-setup] Split-principal pg-boss installer failed for ${schema}: ${
          installer.error?.message ?? `${String(installer.stderr).slice(-2000)} ${String(installer.stdout).slice(-1000)}`
        }`);
      }
    }
    // Hosted Supabase authority supplies role grants and legacy auth projection
    // outside repository migrations. Reproduce only that bounded contract
    // without re-granting sensitive rorca functions revoked by Wave migrations.
    await pool.query('ALTER TABLE rorca.users ADD COLUMN IF NOT EXISTS password_hash TEXT');
    await pool.query(`INSERT INTO rorca.workspaces(id,label,path) VALUES
      ('workspace:wave-two','Wave 2 service integration','/tmp/wave2-service-integration'),
      ('workspace:other','Wave 2 cross-tenant fixture','/tmp/wave2-other')
      ON CONFLICT(id) DO NOTHING`);
    await pool.query('GRANT USAGE ON SCHEMA rorca, auth TO authenticated, anon');
    await pool.query(`GRANT USAGE, SELECT ON SEQUENCE
      rorca.direction_layers_id_seq,
      rorca.wal_events_id_seq
      TO authenticated`);
    await pool.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated, anon');
    const readiness = await pool.query<AuthorityReadinessRow>(`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS authenticated_role,
             to_regnamespace('auth') IS NOT NULL AS auth_schema,
             to_regprocedure('auth.uid()') IS NOT NULL AS auth_uid,
             to_regprocedure('auth.jwt()') IS NOT NULL AS auth_jwt,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS pgcrypto_extension,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_extension,
             to_regclass('public.schema_migrations') IS NOT NULL AS migrations_table,
             -- Migration 050 is valid either as the legacy certified lite-mode
             -- skip or as the current rorca_v2 graph-bootstrap receipt.
             EXISTS (
               SELECT 1 FROM public.schema_migrations
                WHERE version = 50
                  AND (
                    skipped_in_lite_mode = TRUE
                    OR filename LIKE '%[graph bootstrap: rorca_v2]%'
                  )
             ) AS age_skip_receipt,
             EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'rorca'
                  AND table_name = 'users'
                  AND column_name = 'password_hash'
             ) AS password_hash_column,
             to_regclass('rorca.workspace_members') IS NOT NULL AS workspace_members_table,
             EXISTS (
               SELECT 1 FROM public.schema_migrations
                WHERE version = 50
                  AND (filename LIKE '050_knowledge_graph.sql%' OR skipped_in_lite_mode = TRUE)
             ) AS graph_decision_recorded,
             to_regprocedure('rorca.test_invocation_server_identity()') IS NOT NULL AS test_identity_function
    `);
    const missing = missingAuthorityObjects(readiness.rows[0]);
    if (missing.length > 0) throw new Error(`[jest-setup] Fresh invocation database is incomplete: ${missing.join(', ')}`);
    console.log(`[jest-setup] ready ${connected.user}@${connected.database}; invocation=${state.invocationId}; mode=${state.mode}; extensions=${state.extensions?.join(',')}`);
  } finally {
    await pool.end();
  }
}
