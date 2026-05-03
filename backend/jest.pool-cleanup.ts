/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * jest.pool-cleanup.ts — Global beforeEach/afterEach for test isolation
 *
 * 1. beforeEach: Truncate key tables via a DIRECT pg connection (not the app's pool).
 *    Tests use a shared PostgreSQL test database (rorca_test) and the same
 *    test user (testauth@example.com). Without cleanup, data from test N
 *    contaminates test N+1 (e.g., billing plan stays 'pro' after license tests).
 *
 * 2. afterEach: Close the app's pg Pool to prevent connection exhaustion.
 *    Each jest.resetModules() + require('../../server') creates a fresh Pool.
 *    Without closing it, N tests = N open connections.
 *
 * IMPORTANT: The truncation uses a standalone pg Client (not the app's pool)
 * because the app's pool may be closed between tests. The afterEach closes
 * the pool, and the next test's beforeEach must truncate BEFORE
 * jest.resetModules() recreates the pool.
 */

import { Client } from 'pg';

const TRUNCATE_SQL = `
  TRUNCATE
    users,
    refresh_tokens,
    subscriptions,
    workspaces,
    pipeline_runs,
    story_results,
    wal_events,
    token_usage,
    spec_versions,
    spec_tags,
    story_commits,
    story_comments,
    direction_layers,
    teams,
    team_members,
    templates,
    template_ratings,
    notifications,
    notification_preferences,
    budget_config,
    workspace_env_vars,
    agent_hooks,
    agent_profiles,
    pipeline_hooks,
    pipeline_schedules,
    onboarding_state,
    user_settings,
    workspace_context,
    api_key_vault,
    provider_defaults,
    run_output_chunks,
    worker_heartbeat,
    memories
  CASCADE
`;

beforeEach(async () => {
  // Use a direct pg Client (not the app's pool) to ensure truncation works
  // even when the pool was closed by the previous test's afterEach.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(TRUNCATE_SQL);
  } catch {
    // DB may not be initialized yet (first test) or table may not exist — ignore.
  } finally {
    await client.end().catch(() => {});
  }
});

afterEach(async () => {
  try {
    // require() returns the currently cached db/index module, which holds
    // the pool created by the most recent jest.resetModules() + require('../../server').
    // Calling closePool() ends all its connections before the next test creates a new one.
    const dbMod = require('./src/db/index');
    if (typeof dbMod.closePool === 'function') {
      await dbMod.closePool();
    }
  } catch {
    // Pool may already be closed, not initialized, or module may not be cached — ignore.
  }
});
