/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260812124000_lifecycle_source_publication_authority.sql';
const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const sql = fs.readFileSync(path.join(migrationDirectory, migrationFile), 'utf8');

describe('LFC-SOURCE-002 publication authority migration', () => {
  test('uses a unique sequential migration slot', () => {
    const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
  });

  test('binds persisted authority to every receipt identity used by projection', () => {
    for (const column of [
      'workspace_id',
      'spec_slug',
      'release_subject_hash',
      'package_id',
      'package_path',
      'receipt_id',
      'receipt_hash',
      'event_hash',
      'manifest_hash',
      'package_hash',
      'preview_hash',
      'snapshot_hash',
    ]) {
      expect(sql).toContain(`${column} TEXT NOT NULL`);
    }
    expect(sql).toContain("CHECK (receipt_id = 'package-event:' || event_hash)");
    expect(sql).toContain('PRIMARY KEY (workspace_id, receipt_id)');
  });

  test('keeps issuance on the canonical writer and runtime verification read-only', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON rorca.lifecycle_source_publication_receipts');
    expect(sql).toContain('BEFORE TRUNCATE ON rorca.lifecycle_source_publication_receipts');
    expect(sql).toContain("current_setting('rorca.runtime_database_user', TRUE)");
    expect(sql).toContain("current_setting('rorca.canonical_writer_database_user', TRUE)");
    expect(sql).toContain('REVOKE ALL ON rorca.lifecycle_source_publication_receipts FROM %I');
    expect(sql).toContain('GRANT SELECT ON rorca.lifecycle_source_publication_receipts TO %I');
    expect(sql).toContain('GRANT SELECT,INSERT ON rorca.lifecycle_source_publication_receipts TO %I');
    expect(sql).toContain('GRANT SELECT,INSERT,UPDATE ON rorca.spec_sources TO %I');
    expect(sql).not.toMatch(/GRANT\s+(?:UPDATE|DELETE|TRUNCATE)\s+ON rorca\.lifecycle_source_publication_receipts/i);
  });

  test('grants the split principals only their required runtime capabilities', async () => {
    const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
    const runtimeUrl = process.env.DATABASE_URL;
    if (!writerUrl || !runtimeUrl) throw new Error('Split-principal test database URLs are required');
    const writer = new Pool({ connectionString: writerUrl, max: 1 });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      const writerPrivileges = await writer.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
      }>(`SELECT
        has_table_privilege(current_user, 'rorca.lifecycle_source_publication_receipts', 'SELECT') AS can_select,
        has_table_privilege(current_user, 'rorca.lifecycle_source_publication_receipts', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'rorca.lifecycle_source_publication_receipts', 'UPDATE') AS can_update`);
      const runtimePrivileges = await runtime.query<{
        can_select: boolean;
        can_insert: boolean;
      }>(`SELECT
        has_table_privilege(current_user, 'rorca.lifecycle_source_publication_receipts', 'SELECT') AS can_select,
        has_table_privilege(current_user, 'rorca.lifecycle_source_publication_receipts', 'INSERT') AS can_insert`);
      expect(writerPrivileges.rows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: false,
      });
      expect(runtimePrivileges.rows[0]).toEqual({
        can_select: true,
        can_insert: false,
      });
    } finally {
      await Promise.all([writer.end(), runtime.end()]);
    }
  });
});
