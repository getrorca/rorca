/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execute } from '../index';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260713170000_gitreins_evidence.sql';
const migrationPath = path.join(__dirname, '..', 'pg-migrations', migrationFile);

describe('GitReins append-only evidence migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('has a unique timestamp prefix and idempotent DDL', () => {
    const migrationDir = path.join(__dirname, '..', 'pg-migrations');
    const files = fs.readdirSync(migrationDir).filter(file => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gitreins_evidence');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_gitreins_evidence_mutation');
    expect(sql).toContain('CREATE OR REPLACE TRIGGER gitreins_evidence_append_only');
    expect(sql).toContain('CREATE OR REPLACE TRIGGER gitreins_evidence_no_truncate');
  });

  test('enforces append-only storage and constrained contract vocabulary', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON gitreins_evidence/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON gitreins_evidence/);
    expect(sql).toContain("RAISE EXCEPTION 'gitreins_evidence is append-only");
    expect(sql).toContain("mode IN ('observe', 'enforce')");
    expect(sql).toContain("status IN ('pass', 'fail', 'error')");
    expect(sql).toContain("CHECK (command = 'judge')");
    expect(sql).toContain("CHECK (scope = 'working-tree')");
    expect(sql).not.toMatch(/pgboss\./);
  });

  test('can be applied a second time without replacing evidence rows', async () => {
    await expect(execute(sql)).resolves.toBeDefined();
  });

  test('database rejects update and delete after an append', async () => {
    const inserted = await execute(
      `INSERT INTO gitreins_evidence
       (workspace_id, run_id, story_id, attempt, mode, status, reason_code)
       VALUES ($1, $2, $3, 1, 'observe', 'error', 'missing_binary')`,
      ['gitreins-migration-test', 999999, 'US-TEST'],
    );
    expect(inserted.rowCount).toBe(1);
    await expect(execute(
      `UPDATE gitreins_evidence SET status = 'pass'
       WHERE workspace_id = $1 AND run_id = $2`,
      ['gitreins-migration-test', 999999],
    )).rejects.toThrow(/append-only/);
    await expect(execute(
      'DELETE FROM gitreins_evidence WHERE workspace_id = $1 AND run_id = $2',
      ['gitreins-migration-test', 999999],
    )).rejects.toThrow(/append-only/);
    await expect(execute('TRUNCATE gitreins_evidence')).rejects.toThrow(/append-only/);
  });
});
