/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDirectory = path.join(__dirname, '..', 'pg-migrations');
const baseMigrationFilename = '20260806120400_installed_skills_workspace_scope.sql';
const remediationMigrationFilename = '20260806120500_installed_skills_runtime_schema_remediation.sql';
const canonicalRuntimeMigrationFilename = '20260812125000_installed_skills_canonical_runtime_relation.sql';
const sql = fs.readFileSync(path.join(migrationsDirectory, baseMigrationFilename), 'utf8');
const remediationSql = fs.readFileSync(path.join(migrationsDirectory, remediationMigrationFilename), 'utf8');
const canonicalRuntimeSql = fs.readFileSync(path.join(migrationsDirectory, canonicalRuntimeMigrationFilename), 'utf8');

describe('installed skills workspace scope migration', () => {
  test('retains ownerless legacy rows only in a reserved system workspace', () => {
    expect(sql).toContain("'rorca:system:legacy-installed-skills'");
    expect(sql).toContain("'system://legacy-installed-skills'");
    expect(sql).toContain('UPDATE installed_skills');
    expect(sql).toContain("SET workspace_id = 'rorca:system:legacy-installed-skills'");
    expect(sql).not.toMatch(/SELECT\s+id\s+FROM\s+workspaces\s+LIMIT\s+1/i);
  });

  test('enforces workspace ownership, scoped uniqueness, and cascade deletion', () => {
    expect(sql).toMatch(/workspace_id\s+TEXT/i);
    expect(sql).toMatch(/ALTER COLUMN workspace_id SET NOT NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(workspace_id\) REFERENCES workspaces\(id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/UNIQUE \(workspace_id, name\)/i);
    expect(sql).toMatch(/idx_installed_skills_workspace_name/i);
    expect(sql).toMatch(/DROP CONSTRAINT installed_skills_name_key/i);
  });

  test('applies an append-only, schema-qualified repair to the runtime-resolved table', () => {
    expect(remediationMigrationFilename).toMatch(/^20260806120500_/);
    expect(remediationSql).toContain("to_regclass('rorca.installed_skills')");
    expect(remediationSql).toContain("to_regclass('rorca.workspaces')");
    expect(remediationSql).toMatch(/ALTER TABLE rorca\.installed_skills/i);
    expect(remediationSql).toMatch(/UPDATE rorca\.installed_skills/i);
    expect(remediationSql).toMatch(/REFERENCES rorca\.workspaces\(id\)/i);
    expect(remediationSql).toMatch(/ON DELETE CASCADE/i);
    expect(remediationSql).toMatch(/UNIQUE \(workspace_id, name\)/i);
    expect(remediationSql).toContain('idx_installed_skills_workspace_name');
    expect(remediationSql).toMatch(/conrelid = installed_skills_oid/i);
    expect(remediationSql).not.toMatch(/(?:ALTER TABLE|UPDATE|REFERENCES)\s+public\.installed_skills/i);
    expect(remediationSql).not.toMatch(/SELECT\s+id\s+FROM\s+(?:rorca\.)?workspaces\s+LIMIT\s+1/i);
  });

  test('pins the canonical runtime relation and preserves split-principal access', () => {
    expect(canonicalRuntimeMigrationFilename).toMatch(/^20260812125000_/);
    expect(canonicalRuntimeSql).toContain("to_regclass('rorca.installed_skills')");
    expect(canonicalRuntimeSql).toMatch(/CREATE TABLE rorca\.installed_skills/i);
    expect(canonicalRuntimeSql).toMatch(/ALTER TABLE rorca\.installed_skills/i);
    expect(canonicalRuntimeSql).toMatch(/REFERENCES rorca\.workspaces\(id\) ON DELETE CASCADE/i);
    expect(canonicalRuntimeSql).toMatch(/UNIQUE \(workspace_id, name\)/i);
    expect(canonicalRuntimeSql).toContain("current_setting('rorca.runtime_database_user', TRUE)");
    expect(canonicalRuntimeSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON rorca\.installed_skills TO %I/i,
    );
    expect(canonicalRuntimeSql).toMatch(
      /GRANT USAGE, SELECT ON SEQUENCE rorca\.installed_skills_id_seq TO %I/i,
    );
  });

  test('keeps the complete migration prefix set unique', () => {
    const migrationFiles = fs.readdirSync(migrationsDirectory)
      .filter(filename => /^\d+_.*\.sql$/.test(filename));
    const prefixes = migrationFiles.map(filename => filename.match(/^(\d+)_/)![1]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test('does not touch the pg-boss schema', () => {
    expect(sql).not.toMatch(/pgboss\./i);
    expect(remediationSql).not.toMatch(/pgboss\./i);
    expect(canonicalRuntimeSql).not.toMatch(/pgboss\./i);
  });
});
