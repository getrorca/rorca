/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.join(__dirname, '..', 'pg-migrations', '20260715230000_github_app_credentials.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const remediationPath = path.join(__dirname, '..', 'pg-migrations', '20260717090000_github_repository_authority_remediation.sql');
const remediationSql = fs.readFileSync(remediationPath, 'utf8');

test('GitHub App migration is repository-scoped, auditable, and avoids pg-boss', () => {
  expect(sql).toContain('integration_vault_secrets');
  expect(sql).toContain('github_app_registrations');
  expect(sql).toContain('github_app_installations');
  expect(sql).toContain('github_app_workspace_bindings');
  expect(sql).toContain('github_app_setup_states');
  expect(sql).toMatch(/workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces\(id\) ON DELETE RESTRICT/);
  expect(sql).toContain('UNIQUE (registration_id, repository_id)');
  expect(sql).toContain('FOREIGN KEY (installation_record_id, registration_id)');
  expect(sql).toContain("repository_selection TEXT NOT NULL CHECK (repository_selection = 'selected')");
  expect(sql).toContain('GitHub App workspace/repository/installation binding identity is immutable');
  expect(sql).not.toMatch(/CREATE\s+(TABLE|SCHEMA).*pgboss|ALTER\s+TABLE\s+pgboss/i);
  expect(sql).not.toMatch(/installation_token|app_jwt/i);
});

test('remediation makes App identity typed, immutable, and audit-supersedable', () => {
  expect(remediationSql).toContain('github_app_registration_private_key_typed_fk');
  expect(remediationSql).toContain('github_app_registration_webhook_secret_typed_fk');
  expect(remediationSql).toContain('FOREIGN KEY (installation_record_id, registration_id, installation_id)');
  expect(remediationSql.indexOf('DROP CONSTRAINT IF EXISTS github_app_workspace_bindings_installation_record_id_registration_id_fkey'))
    .toBeLessThan(remediationSql.indexOf('DROP CONSTRAINT IF EXISTS github_app_installations_id_registration_id_key'));
  expect(remediationSql).toContain('uq_github_app_one_current_workspace_binding');
  expect(remediationSql).toContain('WHERE superseded_at IS NULL');
  expect(remediationSql).toContain('GitHub App binding supersession evidence is immutable');
  expect(remediationSql).toContain('CREATE OR REPLACE VIEW github_workspace_repository_authority');
  expect(remediationSql).toContain('NOT EXISTS (');
  expect(remediationSql).toContain('github_repository_configs');
  expect(remediationSql).not.toMatch(/CREATE\s+(TABLE|SCHEMA).*pgboss|ALTER\s+TABLE\s+pgboss/i);
});
