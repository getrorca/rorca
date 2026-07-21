/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrations = path.join(process.cwd(), 'src/db/pg-migrations');
const init = fs.readFileSync(path.join(migrations, '001_init.sql'), 'utf8');
const releaseSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/release-authority.ts'), 'utf8');
const sql = fs.readFileSync(path.join(migrations, '20260718170000_gate6_release_contract.sql'), 'utf8');

test('ordered upgrade migrations truthfully preserve and extend the historical run status contract', () => {
  const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
  const prefixes = files.map((file) => file.match(/^(\d+)_/)?.[1]).filter(Boolean);
  expect(new Set(prefixes).size).toBe(prefixes.length);
  const gate6Index = files.indexOf('20260718170000_gate6_release_contract.sql');
  expect(gate6Index).toBeGreaterThan(files.indexOf('20260718140000_story_result_authority_and_github_projection.sql'));
  for (const later of [
    '20260719090000_pty_recovery_operations.sql',
    '20260720090000_github_check_projection_authority.sql',
    '20260720110000_pty_archive_health_authority.sql',
  ]) expect(files.indexOf(later)).toBeGreaterThan(gate6Index);
  expect(init).not.toContain("'release_pending'");
  expect(releaseSource).toContain("status = CASE WHEN status = 'done' THEN status ELSE 'release_pending' END");
  expect(sql).toContain('DROP CONSTRAINT IF EXISTS pipeline_runs_status_check');
  expect(sql).toMatch(/ADD CONSTRAINT pipeline_runs_status_check CHECK[\s\S]*'release_pending'/);
  expect(sql).toMatch(/pipeline_runs_status_check[\s\S]*'pi_native'/);
  expect(sql).not.toMatch(/pgboss\./i);
  expect(sql).toContain('"actions":"read"');
  expect(sql).not.toContain('"actions":"write"');

  const effectiveDefinitions = files.flatMap((file) => {
    const source = fs.readFileSync(path.join(migrations, file), 'utf8');
    return source.includes('ADD CONSTRAINT pipeline_runs_status_check') ? [{ file, source }] : [];
  });
  expect(effectiveDefinitions.length).toBeGreaterThanOrEqual(1);
  const latestDefinition = effectiveDefinitions.at(-1);
  expect(latestDefinition?.file).toBe('20260720151000_wave_dispatch_starting_status.sql');
  expect(latestDefinition?.source).toContain("'release_pending'");
  expect(latestDefinition?.source).toContain("'pi_native'");
  expect(latestDefinition?.source).toContain("'starting'");
});

test('migration freezes exact direct base, integration checkout, and unique provider release ref', () => {
  for (const field of ['base_branch', 'base_sha', 'provider_release_ref', 'integration_checkout_path']) {
    expect(sql).toContain(field);
  }
  expect(sql).toContain('pipeline_run_release_intents_base_identity_ck');
  expect(sql).toContain("base_sha ~ '^[0-9a-f]{40}$'");
  expect(sql).toContain('idx_pipeline_release_provider_ref_unique');
  expect(sql).toContain('NEW.base_sha IS DISTINCT FROM OLD.base_sha');
});

test('new commit decisions enforce 40 hex while historical rows remain upgrade-safe and fail closed in runtime', () => {
  expect(sql).toMatch(/ssdlc_decisions_commit_subject_sha_ck[\s\S]*subject_value ~ '\^\[0-9a-f\]\{40\}\$'[\s\S]*NOT VALID/);
  expect(sql).not.toContain("subject_value ~ '^[0-9a-f]{64}$'");
});
