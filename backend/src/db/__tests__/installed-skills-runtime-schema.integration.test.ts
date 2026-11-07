/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool, type PoolClient } from 'pg';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import type { SkillRegistry as SkillRegistryClass } from '../../lib/skill-registry';

let mockRuntimeClient: PoolClient | undefined;

jest.mock('../index', () => ({
  query: async (sql: string, params?: unknown[]) => {
    if (!mockRuntimeClient) throw new Error('runtime test client is not connected');
    return (await mockRuntimeClient.query(sql, params)).rows;
  },
  execute: async (sql: string, params?: unknown[]) => {
    if (!mockRuntimeClient) throw new Error('runtime test client is not connected');
    const result = await mockRuntimeClient.query(sql, params);
    return { rowCount: result.rowCount ?? 0 };
  },
}));

const { SkillRegistry } = require('../../lib/skill-registry') as {
  SkillRegistry: typeof SkillRegistryClass;
};

const baseSql = fs.readFileSync(path.join(
  __dirname,
  '..',
  'pg-migrations',
  '20260806120400_installed_skills_workspace_scope.sql',
), 'utf8');
const remediationSql = fs.readFileSync(path.join(
  __dirname,
  '..',
  'pg-migrations',
  '20260806120500_installed_skills_runtime_schema_remediation.sql',
), 'utf8');
const canonicalRuntimeSql = fs.readFileSync(path.join(
  __dirname,
  '..',
  'pg-migrations',
  '20260812125000_installed_skills_canonical_runtime_relation.sql',
), 'utf8');

const LEGACY_WORKSPACE_ID = 'rorca:system:legacy-installed-skills';
const WORKSPACE_A = 'installed-skills-runtime-a';
const WORKSPACE_B = 'installed-skills-runtime-b';

function skillMarkdown(name: string, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} integration skill`,
    '---',
    body,
  ].join('\n');
}

async function createLegacyInstalledSkills(client: PoolClient, qualifiedName: string): Promise<void> {
  await client.query(`
    CREATE TABLE ${qualifiedName} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX idx_installed_skills_name ON ${qualifiedName}(name)`);
}

describe('installed skills runtime-schema remediation', () => {
  const pool = new Pool({
    connectionString: process.env.WAVE2_TEST_MIGRATION_DATABASE_URL ?? resolveTestDatabaseUrl(),
    max: 1,
    options: '--search_path=rorca,public -c rorca.migration_mode=on',
  });
  let workspaceRoot: string;

  beforeAll(async () => {
    mockRuntimeClient = await pool.connect();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-installed-skills-runtime-'));
  });

  afterEach(async () => {
    if (mockRuntimeClient) await mockRuntimeClient.query('ROLLBACK');
  });

  afterAll(async () => {
    mockRuntimeClient?.release();
    mockRuntimeClient = undefined;
    await pool.end();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('repairs the rorca runtime table after the base migration upgraded public and preserves A/B isolation and cascade', async () => {
    const client = mockRuntimeClient!;
    await client.query('BEGIN');

    await client.query('DROP TABLE IF EXISTS public.installed_skills CASCADE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.workspaces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        path TEXT NOT NULL
      )
    `);
    await createLegacyInstalledSkills(client, 'public.installed_skills');

    await client.query('TRUNCATE TABLE rorca.installed_skills');
    await client.query('ALTER TABLE rorca.installed_skills DROP COLUMN IF EXISTS workspace_id CASCADE');
    await client.query('DROP INDEX IF EXISTS rorca.idx_installed_skills_name');
    await client.query(`
      DO $downgrade$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_constraint
          WHERE conrelid = 'rorca.installed_skills'::regclass
            AND conname = 'installed_skills_name_key'
        ) THEN
          ALTER TABLE rorca.installed_skills
            ADD CONSTRAINT installed_skills_name_key UNIQUE (name);
        END IF;
      END
      $downgrade$
    `);
    await client.query('CREATE INDEX idx_installed_skills_name ON rorca.installed_skills(name)');

    await client.query(`
      INSERT INTO rorca.installed_skills (name, description, source, content)
      VALUES ('legacy-runtime', 'legacy runtime row', 'legacy', $1)
    `, [skillMarkdown('legacy-runtime', 'Legacy runtime guidance.')]);
    await client.query(`
      INSERT INTO public.installed_skills (name, description, source, content)
      VALUES ('legacy-public', 'legacy public row', 'legacy', $1)
    `, [skillMarkdown('legacy-public', 'Legacy public guidance.')]);

    await client.query('SET LOCAL search_path TO public');
    await client.query(baseSql);
    await client.query('SET LOCAL search_path TO rorca, public');
    await client.query(remediationSql);
    await client.query(remediationSql);

    const runtimeColumns = await client.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'rorca'
        AND table_name = 'installed_skills'
        AND column_name = 'workspace_id'
    `);
    expect(runtimeColumns.rows).toEqual([{ column_name: 'workspace_id', is_nullable: 'NO' }]);

    const legacyOwner = await client.query<{ workspace_id: string }>(`
      SELECT workspace_id
      FROM rorca.installed_skills
      WHERE name = 'legacy-runtime'
    `);
    expect(legacyOwner.rows).toEqual([{ workspace_id: LEGACY_WORKSPACE_ID }]);

    await client.query(`
      INSERT INTO rorca.workspaces (id, label, path)
      VALUES ($1, 'Workspace A', $3), ($2, 'Workspace B', $3)
    `, [WORKSPACE_A, WORKSPACE_B, workspaceRoot]);
    await client.query(`
      INSERT INTO public.workspaces (id, label, path)
      VALUES ($1, 'Public decoy', $2)
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, path = EXCLUDED.path
    `, [WORKSPACE_A, workspaceRoot]);
    await client.query(`
      INSERT INTO public.installed_skills
        (workspace_id, name, description, source, content)
      VALUES ($1, 'public-decoy', 'must not resolve at runtime', 'test', $2)
    `, [WORKSPACE_A, skillMarkdown('public-decoy', 'Wrong schema.')]);

    // Relation identity, not the caller's search_path, owns persistence.
    await client.query('SET LOCAL search_path TO public');

    const registryA = new SkillRegistry();
    const registryB = new SkillRegistry();
    await registryA.install(WORKSPACE_A, 'shared-skill', skillMarkdown('shared-skill', 'Workspace A guidance.'));
    await registryB.install(WORKSPACE_B, 'shared-skill', skillMarkdown('shared-skill', 'Workspace B guidance.'));

    const discoveredA = await new SkillRegistry().discover(workspaceRoot, WORKSPACE_A);
    const discoveredB = await new SkillRegistry().discover(workspaceRoot, WORKSPACE_B);
    expect(discoveredA.getSkill('shared-skill')?.promptText).toBe('Workspace A guidance.');
    expect(discoveredB.getSkill('shared-skill')?.promptText).toBe('Workspace B guidance.');
    expect(discoveredA.getSkill('public-decoy')).toBeUndefined();
    expect(discoveredB.getSkill('public-decoy')).toBeUndefined();

    await client.query('DELETE FROM rorca.workspaces WHERE id = $1', [WORKSPACE_A]);
    const remaining = await client.query<{ workspace_id: string; name: string }>(`
      SELECT workspace_id, name
      FROM rorca.installed_skills
      WHERE workspace_id IN ($1, $2)
      ORDER BY workspace_id, name
    `, [WORKSPACE_A, WORKSPACE_B]);
    expect(remaining.rows).toEqual([{ workspace_id: WORKSPACE_B, name: 'shared-skill' }]);

    const afterCascadeA = await new SkillRegistry().discover(workspaceRoot, WORKSPACE_A);
    const afterCascadeB = await new SkillRegistry().discover(workspaceRoot, WORKSPACE_B);
    expect(afterCascadeA.getSkill('shared-skill')).toBeUndefined();
    expect(afterCascadeB.getSkill('shared-skill')?.promptText).toBe('Workspace B guidance.');
  });

  test('fails closed when the reserved runtime workspace id is occupied', async () => {
    const client = mockRuntimeClient!;
    await client.query('BEGIN');
    await client.query('DELETE FROM rorca.workspaces WHERE id = $1', [LEGACY_WORKSPACE_ID]);
    await client.query(`
      INSERT INTO rorca.workspaces (id, label, path)
      VALUES ($1, 'Conflicting workspace', '/conflict')
    `, [LEGACY_WORKSPACE_ID]);

    await expect(client.query(remediationSql)).rejects.toThrow(
      'reserved legacy installed-skills workspace id is already in use',
    );
  });

  test('leaves an already-correct public table unchanged when no rorca table exists', async () => {
    const client = mockRuntimeClient!;
    await client.query('BEGIN');
    await client.query('DROP TABLE IF EXISTS public.installed_skills CASCADE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.workspaces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        path TEXT NOT NULL
      )
    `);
    await createLegacyInstalledSkills(client, 'public.installed_skills');
    await client.query(`
      INSERT INTO public.installed_skills (name, description, source, content)
      VALUES ('public-only', 'already correct public row', 'test', $1)
    `, [skillMarkdown('public-only', 'Public-only guidance.')]);
    await client.query('SET LOCAL search_path TO public');
    await client.query(baseSql);
    await client.query('SET LOCAL search_path TO rorca, public');
    await client.query('ALTER TABLE rorca.installed_skills RENAME TO installed_skills_runtime_hidden');

    const before = await client.query<{ oid: string; columns: string[] }>(`
      SELECT table_class.oid::text AS oid,
        array_agg(attribute.attname ORDER BY attribute.attnum) AS columns
      FROM pg_catalog.pg_class AS table_class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE namespace.nspname = 'public'
        AND table_class.relname = 'installed_skills'
      GROUP BY table_class.oid
    `);

    await client.query(remediationSql);

    const after = await client.query<{ oid: string; columns: string[] }>(`
      SELECT table_class.oid::text AS oid,
        array_agg(attribute.attname ORDER BY attribute.attnum) AS columns
      FROM pg_catalog.pg_class AS table_class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE namespace.nspname = 'public'
        AND table_class.relname = 'installed_skills'
      GROUP BY table_class.oid
    `);
    expect(after.rows).toEqual(before.rows);
  });

  test('creates the canonical table for a public-only legacy install, imports retained rows, and restores runtime grants', async () => {
    const client = mockRuntimeClient!;
    const runtimeUser = process.env.RORCA_RUNTIME_DATABASE_USER;
    if (!runtimeUser) throw new Error('RORCA_RUNTIME_DATABASE_USER is required');
    await client.query('BEGIN');
    await client.query('DROP TABLE IF EXISTS public.installed_skills CASCADE');
    await createLegacyInstalledSkills(client, 'public.installed_skills');
    await client.query(`
      INSERT INTO public.installed_skills (name, description, source, content)
      VALUES ('public-only', 'retained public-only row', 'legacy', $1)
    `, [skillMarkdown('public-only', 'Retained legacy guidance.')]);
    await client.query('DROP TABLE rorca.installed_skills CASCADE');
    await client.query(
      "SELECT set_config('rorca.runtime_database_user', $1, TRUE)",
      [runtimeUser],
    );

    await client.query(canonicalRuntimeSql);
    await client.query(canonicalRuntimeSql);

    const imported = await client.query<{ workspace_id: string; name: string }>(`
      SELECT workspace_id, name
      FROM rorca.installed_skills
      WHERE name = 'public-only'
    `);
    expect(imported.rows).toEqual([{
      workspace_id: LEGACY_WORKSPACE_ID,
      name: 'public-only',
    }]);

    const privileges = await client.query<{ table_access: boolean; sequence_access: boolean }>(`
      SELECT
        has_table_privilege(
          $1,
          'rorca.installed_skills',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS table_access,
        has_sequence_privilege(
          $1,
          'rorca.installed_skills_id_seq',
          'USAGE,SELECT'
        ) AS sequence_access
    `, [runtimeUser]);
    expect(privileges.rows).toEqual([{ table_access: true, sequence_access: true }]);
  });
});
