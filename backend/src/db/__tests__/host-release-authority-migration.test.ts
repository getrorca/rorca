/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationPath = path.join(
  process.cwd(), 'src/db/pg-migrations/20260718160000_host_release_authority.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('release migration is next, unique, DB-only, and does not touch pgboss', () => {
  const files = fs.readdirSync(path.dirname(migrationPath)).filter(file => file.endsWith('.sql'));
  const prefixes = files.map(file => file.match(/^(\d+)_/)?.[1]).filter(Boolean);
  expect(new Set(prefixes).size).toBe(prefixes.length);
  expect(path.basename(migrationPath)).toBe('20260718160000_host_release_authority.sql');
  expect(sql).not.toMatch(/pgboss\./i);
});

test('migration freezes execution/repository/SHA identity and separates cleanup state', () => {
  expect(sql).toContain('execution_workspace_path');
  expect(sql).toContain('execution_worktree_path');
  expect(sql).toContain('pipeline_run_release_intents');
  expect(sql).toContain('predecessor_pass_story_ids');
  expect(sql).toContain('predecessor_authority_hash');
  expect(sql).toContain('authorized_sha CHAR(40)');
  expect(sql).toContain('deployment_allowed BOOLEAN NOT NULL DEFAULT FALSE CHECK (deployment_allowed = FALSE)');
  expect(sql).toContain('pipeline run release intent authority identity is immutable');
  expect(sql).toContain("worktree_cleanup_status IN ('not_started', 'pending', 'completed', 'failed')");
});

test('40-hex constraints tighten new writes without unsafe historical validation', () => {
  expect(sql).toContain("commit_sha ~ '^[0-9a-f]{40}$'");
  expect(sql).toContain("CHECK (head_sha ~ '^[0-9a-f]{40}$') NOT VALID");
  expect(sql).toContain("provider_head_sha ~ '^[0-9a-f]{40}$') NOT VALID");
  expect(sql).not.toContain("[0-9a-f]{64})$");
});
