/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Per-test isolation and pool cleanup.
 *
 * The destructive connection is pinned once from the dedicated test credential;
 * it never follows mutable DATABASE_URL. Server truth is verified immediately
 * before every TRUNCATE, and guard failures are never swallowed.
 */

import { Client } from 'pg';
import {
  assertConnectedTestDatabase,
  resolveTestDatabaseUrl,
} from './src/lib/test-db-safety';

const TEST_DB_URL = resolveTestDatabaseUrl();
const CLEAN_TABLES = [
  'users',
  'refresh_tokens',
  'subscriptions',
  'workspaces',
  'pipeline_runs',
  'story_results',
  'wal_events',
  'token_usage',
  'spec_versions',
  'spec_tags',
  'story_commits',
  'story_comments',
  'direction_layers',
  'teams',
  'team_members',
  'templates',
  'template_ratings',
  'notifications',
  'notification_preferences',
  'budget_config',
  'workspace_env_vars',
  'agent_hooks',
  'agent_profiles',
  'pipeline_hooks',
  'pipeline_schedules',
  'onboarding_state',
  'user_settings',
  'workspace_context',
  'api_key_vault',
  'provider_defaults',
  'run_output_chunks',
  'run_pty_sessions',
  'run_pty_output_chunks',
  'run_pty_input_requests',
  'run_pty_resize_requests',
  'worker_heartbeat',
  'memories',
];

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

beforeEach(async () => {
  const client = new Client({ connectionString: TEST_DB_URL });
  try {
    await client.connect();
    await assertConnectedTestDatabase(client, TEST_DB_URL);

    const existing = await client.query<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename
         FROM pg_tables
        WHERE schemaname IN ('public', 'rorca')
          AND tablename = ANY($1::text[])
        ORDER BY schemaname, tablename`,
      [CLEAN_TABLES],
    );
    if (existing.rows.length > 0) {
      const tables = existing.rows
        .map(({ schemaname, tablename }) => `${quoteIdentifier(schemaname)}.${quoteIdentifier(tablename)}`)
        .join(', ');
      await client.query(`TRUNCATE ${tables} CASCADE`);
    }
  } finally {
    await client.end().catch(() => {});
  }
});

afterEach(async () => {
  try {
    const dbMod = require('./src/db/index');
    if (typeof dbMod.closePool === 'function') {
      await dbMod.closePool();
    }
  } catch {
    // The pool may be absent or already closed; this path is non-destructive.
  }
});
