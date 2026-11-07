/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { checkDuplicatePrefixes, createPoolForConnectionString, runPgMigrations } from '../pg-index';

const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const ledgerSql = fs.readFileSync(path.join(migrationDirectory, '079_schema_migrations_version_bigint.sql'), 'utf8');
const vaultMigrationFile = '20260818110000_provider_vault_split_principal_remediation.sql';
const vaultSql = fs.readFileSync(path.join(migrationDirectory, vaultMigrationFile), 'utf8');

describe('canonical ledger and provider-vault remediation migrations', () => {
  test('widens only the canonical public migration ledger before timestamp versions are recorded', () => {
    expect(ledgerSql).toMatch(/ALTER\s+TABLE\s+public\.schema_migrations\s+ALTER\s+COLUMN\s+version\s+TYPE\s+BIGINT\s*;/i);
    expect(ledgerSql).not.toMatch(/ALTER\s+TABLE\s+(?!public\.)schema_migrations/i);
  });

  test('uses a unique remedial slot and supports both fresh and populated vault schemas', () => {
    const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(vaultSql).toContain('ALTER TABLE rorca.api_key_vault');
    expect(vaultSql).toContain('ADD COLUMN IF NOT EXISTS workspace_id TEXT');
    expect(vaultSql).toContain("conrelid = 'rorca.api_key_vault'::regclass");
    expect(vaultSql).toContain('FOREIGN KEY (workspace_id) REFERENCES rorca.workspaces(id) ON DELETE CASCADE');
    expect(vaultSql).toContain('ON rorca.api_key_vault (user_id, workspace_id, created_at DESC)');
    expect(vaultSql).not.toMatch(/(?:ALTER\s+TABLE|REFERENCES|ON\s+TABLE)\s+(?:api_key_vault|provider_defaults|workspaces)\b/i);
  });

  test('declares read-only runtime grants and column-bounded canonical-writer mutations', () => {
    expect(vaultSql).toContain('GRANT SELECT ON TABLE rorca.api_key_vault, rorca.provider_defaults TO %I');
    expect(vaultSql).toContain("principal_class = 'internal_runtime'");
    expect(vaultSql).toContain("principal_class = 'canonical_writer'");
    expect(vaultSql).toContain('GRANT SELECT, DELETE ON TABLE rorca.api_key_vault TO %I');
    expect(vaultSql).toContain('GRANT INSERT (id, user_id, workspace_id, provider, encrypted_key, label, base_url) ON TABLE rorca.api_key_vault TO %I');
    expect(vaultSql).toContain('GRANT UPDATE (last_used_at) ON TABLE rorca.api_key_vault TO %I');
    expect(vaultSql).toContain('GRANT INSERT (id, user_id, workspace_id, provider) ON TABLE rorca.provider_defaults TO %I');
    expect(vaultSql).toContain('GRANT UPDATE (provider, updated_at) ON TABLE rorca.provider_defaults TO %I');
    expect(vaultSql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE).*runtime_user/i);
  });


  test('replays idempotently over a populated legacy vault without rebinding its rows', async () => {
    const migrationUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
    const owner = createPoolForConnectionString(migrationUrl);
    const suffix = randomUUID();
    const userId = `provider-vault-user:${suffix}`;
    const keyId = `provider-vault-key:${suffix}`;
    try {
      await owner.query(
        `INSERT INTO rorca.users (id, email, display_name, auth_id)
         VALUES ($1, $2, 'Provider vault migration fixture', $3)`,
        [userId, `provider-vault-${suffix}@example.com`, randomUUID()],
      );
      await owner.query(
        `INSERT INTO rorca.api_key_vault (id, user_id, provider, encrypted_key, label)
         VALUES ($1, $2, 'openrouter', 'legacy-encrypted-key', 'Legacy populated row')`,
        [keyId, userId],
      );
      const before = await owner.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.schema_migrations',
      );

      await owner.query('DELETE FROM public.schema_migrations WHERE version = $1', [20260818110000]);
      await runPgMigrations(owner);

      const after = await owner.query<{ count: string; workspace_id: string | null; encrypted_key: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM public.schema_migrations) AS count,
           workspace_id,
           encrypted_key
         FROM rorca.api_key_vault
         WHERE id = $1`,
        [keyId],
      );
      expect(after.rows).toEqual([{
        count: before.rows[0].count,
        workspace_id: null,
        encrypted_key: 'legacy-encrypted-key',
      }]);
    } finally {
      await owner.query('DELETE FROM rorca.api_key_vault WHERE id = $1', [keyId]);
      await owner.query('DELETE FROM rorca.users WHERE id = $1', [userId]);
      await owner.end();
    }
  });

  test('installs exact schema objects and split-principal grants', async () => {
    const migrationUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
    const runtimeUrl = process.env.DATABASE_URL;
    const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
    if (!migrationUrl || !runtimeUrl || !writerUrl) {
      throw new Error('Split migration, runtime, and canonical-writer database URLs are required');
    }

    const owner = new Pool({ connectionString: migrationUrl, max: 1, options: '--search_path=rorca,public -c rorca.migration_mode=on' });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1, options: '--search_path=rorca,public' });
    const writer = new Pool({ connectionString: writerUrl, max: 1, options: '--search_path=rorca_canonical_api,rorca,public' });
    try {
      const objects = await owner.query<{
        workspace_column: string;
        foreign_table: string;
        index_definition: string;
      }>(`SELECT
          format('%I.%I:%s:%s', table_schema, table_name, column_name, is_nullable) AS workspace_column,
          (SELECT format('%I.%I', target_ns.nspname, target.relname)
             FROM pg_constraint constraint_row
             JOIN pg_class target ON target.oid = constraint_row.confrelid
             JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
            WHERE constraint_row.conrelid = 'rorca.api_key_vault'::regclass
              AND constraint_row.conname = 'api_key_vault_workspace_id_fkey') AS foreign_table,
          (SELECT pg_get_indexdef(indexrelid)
             FROM pg_index
            WHERE indexrelid = 'rorca.idx_api_key_vault_user_workspace_created'::regclass) AS index_definition
        FROM information_schema.columns
       WHERE table_schema = 'rorca'
         AND table_name = 'api_key_vault'
         AND column_name = 'workspace_id'`);
      expect(objects.rows).toEqual([{
        workspace_column: 'rorca.api_key_vault:workspace_id:YES',
        foreign_table: 'rorca.workspaces',
        index_definition: 'CREATE INDEX idx_api_key_vault_user_workspace_created ON rorca.api_key_vault USING btree (user_id, workspace_id, created_at DESC)',
      }]);

      const runtimeGrants = await runtime.query(`SELECT
        has_table_privilege(current_user, 'rorca.api_key_vault', 'SELECT') AS vault_select,
        has_table_privilege(current_user, 'rorca.api_key_vault', 'INSERT') AS vault_insert,
        has_table_privilege(current_user, 'rorca.api_key_vault', 'UPDATE') AS vault_update,
        has_table_privilege(current_user, 'rorca.api_key_vault', 'DELETE') AS vault_delete,
        has_table_privilege(current_user, 'rorca.provider_defaults', 'SELECT') AS defaults_select,
        has_table_privilege(current_user, 'rorca.provider_defaults', 'INSERT') AS defaults_insert,
        has_table_privilege(current_user, 'rorca.provider_defaults', 'UPDATE') AS defaults_update,
        has_table_privilege(current_user, 'rorca.provider_defaults', 'DELETE') AS defaults_delete`);
      expect(runtimeGrants.rows[0]).toEqual({
        vault_select: true,
        vault_insert: false,
        vault_update: false,
        vault_delete: false,
        defaults_select: true,
        defaults_insert: false,
        defaults_update: false,
        defaults_delete: false,
      });

      const writerGrants = await writer.query(`SELECT
        has_table_privilege(current_user, 'rorca.api_key_vault', 'SELECT') AS vault_select,
        has_table_privilege(current_user, 'rorca.api_key_vault', 'DELETE') AS vault_delete,
        has_column_privilege(current_user, 'rorca.api_key_vault', 'encrypted_key', 'INSERT') AS vault_secret_insert,
        has_column_privilege(current_user, 'rorca.api_key_vault', 'spend_total_usd', 'INSERT') AS vault_spend_insert,
        has_column_privilege(current_user, 'rorca.api_key_vault', 'last_used_at', 'UPDATE') AS vault_usage_update,
        has_column_privilege(current_user, 'rorca.api_key_vault', 'encrypted_key', 'UPDATE') AS vault_secret_update,
        has_column_privilege(current_user, 'rorca.provider_defaults', 'provider', 'INSERT') AS defaults_provider_insert,
        has_column_privilege(current_user, 'rorca.provider_defaults', 'provider', 'UPDATE') AS defaults_provider_update,
        has_table_privilege(current_user, 'rorca.provider_defaults', 'DELETE') AS defaults_delete`);
      expect(writerGrants.rows[0]).toEqual({
        vault_select: true,
        vault_delete: true,
        vault_secret_insert: true,
        vault_spend_insert: false,
        vault_usage_update: true,
        vault_secret_update: false,
        defaults_provider_insert: true,
        defaults_provider_update: true,
        defaults_delete: false,
      });
    } finally {
      await Promise.all([owner.end(), runtime.end(), writer.end()]);
    }
  });
});
