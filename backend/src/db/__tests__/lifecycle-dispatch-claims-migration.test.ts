/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260812121000_lifecycle_dispatch_claims.sql';
const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const sql = fs.readFileSync(path.join(migrationDirectory, migrationFile), 'utf8');

describe('LFC-TOCTOU-001 lifecycle dispatch claim migration', () => {
  test('uses the reserved sequential migration slot', () => {
    const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(migrationFile).toBe('20260812121000_lifecycle_dispatch_claims.sql');
  });

  test('binds request identity to the exact immutable plan and spec identity', () => {
    expect(sql).toContain('workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT');
    expect(sql).toContain('compiled_plan_id BIGINT NOT NULL REFERENCES ssdlc_compiled_plans(id) ON DELETE RESTRICT');
    expect(sql).toContain('spec_hash TEXT NOT NULL');
    expect(sql).toContain('request_identity TEXT NOT NULL');
    expect(sql).toContain('request_hash TEXT NOT NULL');
    expect(sql).toContain('UNIQUE (workspace_id, request_identity)');
    expect(sql).toContain("plan.provenance_json->>'specHash' = NEW.spec_hash");
    expect(sql).toContain("plan.validation_status = 'validated'");
    expect(sql).toContain('plan.is_current = TRUE');
    expect(sql).toContain('FOR SHARE');
  });

  test('prevents every mutation of a persisted dispatch claim', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON ssdlc_lifecycle_dispatch_claims');
    expect(sql).toContain('BEFORE TRUNCATE ON ssdlc_lifecycle_dispatch_claims');
    expect(sql).toContain("RAISE EXCEPTION 'lifecycle dispatch claims are immutable'");
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });
});
