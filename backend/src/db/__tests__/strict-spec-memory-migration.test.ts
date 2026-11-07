/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'pg-migrations', '20260729149000_strict_spec_memory_synthesis.sql'),
  'utf8',
);

describe('strict spec memory synthesis migration', () => {
  test('uses an immutable exact-generation receipt without storing memory payload text', () => {
    expect(sql).toContain('PRIMARY KEY(workspace_id,spec_id,save_generation,policy_hash)');
    expect(sql).toContain('application_job_id UUID NOT NULL UNIQUE');
    expect(sql).toContain('memory_id INTEGER NOT NULL UNIQUE');
    expect(sql).toContain('input_hash TEXT NOT NULL');
    expect(sql).toContain('output_hash TEXT NOT NULL');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('w2_reject_immutable_mutation');
    const tableBody = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf(');', sql.indexOf('CREATE TABLE')));
    expect(tableBody).not.toMatch(/brief|stories|content\s+TEXT|request_payload|result_payload/i);
  });

  test('advances canonical Wave 2 readiness from its exact prior governed version without authority changes', () => {
    expect(sql).toContain('migration_version=20260729149000');
    expect(sql).toContain('migration_version=20260729147000');
    expect(sql).not.toMatch(/provider_human|authority_receipt|approval|dispatch/i);
  });
});
