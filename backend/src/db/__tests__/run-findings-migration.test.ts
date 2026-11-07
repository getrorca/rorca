/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const filename = '20260810140000_run_findings.sql';
const migrationPath = path.resolve(__dirname, '..', 'pg-migrations', filename);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('creates the run_findings capture-candidate table without touching pg-boss tables', () => {
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS run_findings');
  expect(sql).toContain('run_id BIGINT NOT NULL REFERENCES pipeline_runs(id)');
  expect(sql).toContain('workspace_id TEXT NOT NULL REFERENCES workspaces(id)');
  expect(sql).toContain('UNIQUE (run_id, finding_key)');
  expect(sql).toContain("kind IN ('decision', 'deviation', 'risk', 'convention')");
  expect(sql).toContain("status IN ('capture_candidate', 'captured', 'dismissed')");
  expect(sql).toContain("status TEXT NOT NULL DEFAULT 'capture_candidate'");
  expect(sql).toContain('captured_at TIMESTAMPTZ');
  expect(sql).toContain('jsonb_typeof(evidence) = \'array\'');
  expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+pgboss\./i);
});

test('migration stays ordered after the genesis binding migration', () => {
  const names = fs.readdirSync(path.dirname(migrationPath)).filter((name) => name.endsWith('.sql')).sort();
  expect(names.indexOf(filename)).toBeGreaterThan(names.indexOf('20260810130000_spec_sources_genesis_binding.sql'));
});
