/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationFilename = '20260812134000_openrouter_provider_prefs_workspace_scope.sql';
const sql = fs.readFileSync(path.join(__dirname, '..', 'pg-migrations', migrationFilename), 'utf8');

describe('OpenRouter provider preference workspace scope migration', () => {
  test('adds an idempotent workspace scope with retained global fallback', () => {
    expect(sql).toMatch(
      /ALTER TABLE rorca\.openrouter_provider_prefs\s+ADD COLUMN IF NOT EXISTS workspace_id TEXT/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(workspace_id\) REFERENCES rorca\.workspaces\(id\) ON DELETE CASCADE/i,
    );
    expect(sql).toMatch(
      /ON rorca\.openrouter_provider_prefs \(model_id\)\s+WHERE workspace_id IS NULL/i,
    );
    expect(sql).toMatch(
      /ON rorca\.openrouter_provider_prefs \(workspace_id, model_id\)\s+WHERE workspace_id IS NOT NULL/i,
    );
    expect(sql).not.toMatch(/UPDATE\s+rorca\.openrouter_provider_prefs\s+SET\s+workspace_id/i);
  });

  test('removes global-only uniqueness and restores runtime read access', () => {
    expect(sql).toMatch(/contype = 'u'/i);
    expect(sql).toMatch(/conkey = ARRAY\[model_id_attnum\]/i);
    expect(sql).toContain("current_setting('rorca.runtime_database_user', TRUE)");
    expect(sql).toMatch(/GRANT SELECT ON rorca\.openrouter_provider_prefs TO %I/i);
  });

  test('does not touch transport ownership', () => {
    expect(sql).not.toMatch(/pgboss\./i);
  });
});
