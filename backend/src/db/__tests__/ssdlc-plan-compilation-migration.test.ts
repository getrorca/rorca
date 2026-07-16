/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260715130500_ssdlc_plan_compilation_lifecycle.sql';
const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const sql = fs.readFileSync(path.join(migrationDirectory, migrationFile), 'utf8');

describe('LFC-004 lifecycle plan compilation migration', () => {
  test('uses a collision-free migration prefix and never touches pg-boss schema', () => {
    const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA).*pgboss/is);
  });

  test('adds provenance, retryable readiness, and current input-hash uniqueness', () => {
    expect(sql).toContain('provenance_json JSONB');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ssdlc_plan_readiness_reasons');
    expect(sql).toContain('retryable BOOLEAN NOT NULL DEFAULT TRUE');
    expect(sql).toContain('idx_ssdlc_compiled_plans_current_input');
    expect(sql).toContain('(workspace_id, spec_slug, normalized_input_hash)');
    expect(sql).toContain('WHERE is_current = TRUE');
  });

  test('permits only the atomic draft-to-validated current transition', () => {
    expect(sql).toContain("OLD.validation_status = 'draft'");
    expect(sql).toContain("NEW.validation_status = 'validated'");
    expect(sql).toContain('NEW.is_current = TRUE');
    expect(sql).toContain('compiled plan content and validation outcome are immutable');
  });
});
