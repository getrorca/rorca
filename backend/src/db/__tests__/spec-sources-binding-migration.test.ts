/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260810130000_spec_sources_genesis_binding.sql';
const migrations = path.join(process.cwd(), 'src/db/pg-migrations');
const sql = fs.readFileSync(path.join(migrations, migrationFile), 'utf8');

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const migrationPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});

afterAll(async () => {
  await migrationPool.end();
});

describe('spec_sources genesis binding migration contract', () => {
  test('has a unique timestamp prefix and ships the immutable binding DDL', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(migrationFile).toMatch(/^20260810130000_/);
    for (const column of [
      'source_kind', 'source_id', 'package_hash', 'content_hash', 'citation_summary',
      'evidence_chunk_ids', 'citations', 'review_status', 'sensitivity', 'bound_at', 'bound_by',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('CREATE OR REPLACE FUNCTION spec_sources_binding_immutable');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON spec_sources');
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA).*pgboss/is);
  });

  test('applies cleanly over the historical spec_sources schema, re-applies idempotently, and freezes genesis-bound rows', async () => {
    const client = await migrationPool.connect();
    const schema = `spec_sources_${randomUUID().replaceAll('-', '')}`;
    const hash = `sha256:${'a'.repeat(64)}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE spec_sources (
          spec_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          source TEXT NOT NULL DEFAULT 'local',
          source_repo TEXT,
          source_ref TEXT,
          source_sha TEXT,
          discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (spec_id, workspace_id)
        );
        CREATE INDEX idx_spec_sources_workspace ON spec_sources(workspace_id);
        CREATE INDEX idx_spec_sources_source ON spec_sources(source);
      `);
      await client.query(`INSERT INTO workspaces(id) VALUES ('ws-upgrade')`);
      await client.query(`INSERT INTO spec_sources(spec_id, workspace_id, source) VALUES ('webhook-spec', 'ws-upgrade', 'github')`);

      await client.query(sql);
      await client.query(sql);

      const columns = await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'spec_sources'
        AND column_name IN ('source_kind','source_id','package_hash','content_hash','citation_summary',
          'evidence_chunk_ids','citations','review_status','sensitivity','bound_at','bound_by')
        ORDER BY column_name`, [schema]);
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'bound_at', 'bound_by', 'citation_summary', 'citations', 'content_hash',
        'evidence_chunk_ids', 'package_hash', 'review_status', 'sensitivity',
        'source_id', 'source_kind',
      ]);

      await client.query(`
        INSERT INTO spec_sources (spec_id, workspace_id, source, source_kind, source_id, package_hash,
          content_hash, citation_summary, evidence_chunk_ids, citations, review_status, sensitivity, bound_at, bound_by)
        VALUES ('genesis-spec', 'ws-upgrade', 'genesis', 'genesis_package', 'GEN-PKG-1', $1, $1,
          'Approved citations', '["chunk-1"]'::jsonb, '[{"chunkId":"chunk-1","citation":"c1"}]'::jsonb,
          'approved', 'internal', NOW(), 'principal-reviewer')
      `, [hash]);

      await expect(client.query(
        `UPDATE spec_sources SET citation_summary = 'tampered' WHERE spec_id = 'genesis-spec'`,
      )).rejects.toMatchObject({ code: '55000' });
      await expect(client.query(
        `DELETE FROM spec_sources WHERE spec_id = 'genesis-spec'`,
      )).rejects.toMatchObject({ code: '55000' });

      await expect(client.query(
        `INSERT INTO spec_sources (spec_id, workspace_id, source_kind) VALUES ('partial-spec', 'ws-upgrade', 'genesis_package')`,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(
        `INSERT INTO spec_sources (spec_id, workspace_id, source, source_kind, source_id, package_hash,
          content_hash, citation_summary, evidence_chunk_ids, citations, review_status, sensitivity, bound_at, bound_by)
         VALUES ('badhash-spec', 'ws-upgrade', 'genesis', 'genesis_package', 'GEN-PKG-2', 'not-a-hash', 'not-a-hash',
          'x', '[]'::jsonb, '[]'::jsonb, 'approved', 'internal', NOW(), 'p')`,
      )).rejects.toMatchObject({ code: '23514' });

      await client.query(`UPDATE spec_sources SET source_ref = 'refs/heads/main' WHERE spec_id = 'webhook-spec'`);
      const refreshed = await client.query(`SELECT source_ref FROM spec_sources WHERE spec_id = 'webhook-spec'`);
      expect(refreshed.rows[0].source_ref).toBe('refs/heads/main');
    } finally {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
