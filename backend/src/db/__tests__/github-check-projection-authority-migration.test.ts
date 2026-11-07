/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrations = path.resolve(__dirname, '..', 'pg-migrations');
const filename = '20260720090000_github_check_projection_authority.sql';
const sql = fs.readFileSync(path.join(migrations, filename), 'utf8');

test('Check projections freeze exact repository and App authority without rebinding legacy rows', () => {
  const names = fs.readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  expect(names.indexOf(filename)).toBeGreaterThan(names.indexOf('20260719090000_pty_recovery_operations.sql'));
  for (const field of [
    'repository_owner', 'repository_name', 'repository_authority_source',
    'repository_binding_id', 'repository_installation_id', 'repository_id',
  ]) expect(sql).toContain(field);
  expect(sql).toContain('pipeline_run_release_intents');
  expect(sql).toContain('GITHUB_CHECK_RUN_LEGACY_AUTHORITY_UNFROZEN');
  expect(sql).not.toContain('github_workspace_repository_authority');
  expect(sql).toContain('Check Run projection repository authority is immutable');
  // Shipped migration history is immutable. PR evidence strengthening belongs
  // to the later 130000 forward migration and is upgrade-tested separately.
  expect(sql).not.toContain('ALTER TABLE github_pr_delivery_evidence');
  const upgrade = fs.readFileSync(path.join(migrations, '20260720130000_github_pr_evidence_authority_upgrade.sql'), 'utf8');
  expect(upgrade).toContain('github_pr_evidence_repository_authority_ck');
  expect(upgrade).toContain('GitHub PR evidence repository authority is immutable');
  expect(sql).not.toMatch(/pgboss\./i);
  expect(upgrade).not.toMatch(/pgboss\./i);
});
