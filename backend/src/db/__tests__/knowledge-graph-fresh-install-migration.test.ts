import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(__dirname, '../pg-migrations/050_knowledge_graph.sql');

describe('PostgreSQL 16 AGE fresh-install migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('transactionally bridges the application schema and AGE graph namespace collision', () => {
    expect(sql).toContain('ALTER SCHEMA rorca RENAME TO rorca_pre_age_050');
    expect(sql).toContain("PERFORM create_graph('rorca')");
    expect(sql).toContain('ALTER TABLE %I.%I SET SCHEMA rorca');
    expect(sql).toContain('DROP SCHEMA rorca_pre_age_050');
  });

  test('relocates extension-owned objects before removing the bridge schema', () => {
    expect(sql).toContain('ALTER EXTENSION pgcrypto SET SCHEMA public');
    expect(sql).toContain('ALTER EXTENSION vector SET SCHEMA public');
    expect(sql).toContain('ALTER FUNCTION %I.%I(%s) SET SCHEMA rorca');
  });

  test('remains idempotent for databases with the canonical graph already registered', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM ag_catalog\.ag_graph WHERE name = 'rorca'/);
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'rorca')");
  });
});
