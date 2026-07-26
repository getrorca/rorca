/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(path.resolve(
  __dirname, '..', 'pg-migrations', '20260718150000_github_run_authority_remediation.sql',
), 'utf8');

test('freezes disjoint host-owned expected/excluded scope and canonical checkout identity', () => {
  expect(sql).toContain("ADD COLUMN IF NOT EXISTS excluded_story_ids TEXT[] NOT NULL DEFAULT '{}'::text[]");
  expect(sql).toContain('pipeline_runs_frozen_scope_disjoint_ck');
  expect(sql).toContain('expected_story_ids && excluded_story_ids');
  for (const field of ['workspace_id', 'spec_path', 'expected_story_ids', 'excluded_story_ids', 'branch_name', 'worktree_path']) {
    expect(sql).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`);
  }
  expect(sql).not.toMatch(/pgboss\./i);
});
