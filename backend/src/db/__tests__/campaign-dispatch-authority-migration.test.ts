/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.join(__dirname, '..', 'pg-migrations', '20260727120000_campaign_dispatch_authority.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

test('campaign authority migration is application-owned and never mutates pg-boss', () => {
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS campaign_dispatch_controls/i);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS campaign_dispatch_control_events/i);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS campaign_dispatch_authorizations/i);
  expect(sql).toMatch(/campaign_dispatch_authorizations_immutable/i);
  expect(sql).toMatch(/campaign_dispatch_control_events_append_only/i);
  expect(sql).toMatch(/REFERENCES ssdlc_decisions\(id\)/i);
  expect(sql).toMatch(/REFERENCES github_app_workspace_bindings\(id\)/i);
  expect(sql).toMatch(/REFERENCES pipeline_dispatch_authorizations|REFERENCES campaign_dispatch_authorizations/i);
  expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:TABLE\s+)?(?:"?pgboss"?\.|pgboss_)/i);
});

test('migration supplies single-consumption, pause generation, and immutable run identity constraints', () => {
  expect(sql).toMatch(/authorization_hash TEXT PRIMARY KEY/i);
  expect(sql).toMatch(/UNIQUE \(workspace_id, idempotency_key\)/i);
  expect(sql).toMatch(/UNIQUE \(workspace_id, campaign_id, wave_id, attempt_fence\)/i);
  expect(sql).toMatch(/UNIQUE \(workspace_id, campaign_id, generation\)/i);
  expect(sql).toMatch(/campaign_dispatch_authorization_hash/i);
  expect(sql).toMatch(/consumed_at <= expires_at/i);
  expect(sql).toMatch(/DEFERRABLE INITIALLY IMMEDIATE/i);
});
