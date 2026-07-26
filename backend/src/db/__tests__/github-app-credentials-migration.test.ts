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
const provenancePath = path.join(__dirname, '..', 'pg-migrations', '20260718120000_webhook_replay_provenance.sql');
const provenanceSql = fs.readFileSync(provenancePath, 'utf8');

test('GitHub App migration is repository-scoped, auditable, and avoids pg-boss', () => {
  expect(sql).toContain('integration_vault_secrets');
  expect(sql).toContain('github_app_registrations');
  expect(sql).toContain('github_app_installations');
  expect(sql).toContain('github_app_workspace_bindings');
  expect(sql).toContain('github_app_setup_states');
  expect(sql).toMatch(/workspace_id TEXT NOT NULL REFERENCES workspaces\(id\) ON DELETE RESTRICT/);
  expect(sql).toContain('CONSTRAINT ga_binding_workspace_key UNIQUE (workspace_id)');
  expect(sql).toContain('CONSTRAINT ga_binding_registration_repository_key UNIQUE (registration_id, repository_id)');
  expect(sql).toContain('CONSTRAINT ga_binding_installation_registration_fk');
  expect(sql).toContain("repository_selection TEXT NOT NULL CHECK (repository_selection = 'selected')");
  expect(sql).toContain('GitHub App workspace/repository/installation binding identity is immutable');
  expect(sql).not.toMatch(/CREATE\s+(TABLE|SCHEMA).*pgboss|ALTER\s+TABLE\s+pgboss/i);
  expect(sql).not.toMatch(/installation_token|app_jwt/i);
});

test('remediation makes App identity typed, immutable, and audit-supersedable', () => {
  expect(remediationSql).toContain('github_app_registration_private_key_typed_fk');
  expect(remediationSql).toContain('github_app_registration_webhook_secret_typed_fk');
  expect(remediationSql).toContain('FOREIGN KEY (installation_record_id, registration_id, installation_id)');
  expect(remediationSql.indexOf('DROP CONSTRAINT IF EXISTS ga_binding_installation_registration_fk'))
    .toBeLessThan(remediationSql.indexOf('DROP CONSTRAINT IF EXISTS ga_install_id_registration_key'));
  expect(remediationSql).toContain('uq_github_app_one_current_workspace_binding');
  expect(remediationSql).toContain('WHERE superseded_at IS NULL');
  expect(remediationSql).toContain('GitHub App binding supersession evidence is immutable');
  expect(remediationSql).toContain('CREATE OR REPLACE VIEW github_workspace_repository_authority');
  expect(remediationSql).toContain('NOT EXISTS (');
  expect(remediationSql).toContain('github_repository_configs');
  expect(remediationSql).toContain("provider_profile_verified_at >= NOW() - INTERVAL '24 hours'");
  expect(remediationSql).toContain(`b.permissions = '{"metadata":"read","actions":"write","checks":"write","contents":"write","issues":"read","pull_requests":"write","statuses":"write"}'::jsonb`);
  expect(remediationSql).toContain('jsonb_array_length(b.events) = 4');
  expect(remediationSql).toContain(`b.events @> '["check_run","issues","pull_request","push"]'::jsonb`);
  expect(remediationSql).toContain('provider_hook_configured');
  expect(remediationSql).toContain('signed_delivery_observed');
  expect(remediationSql).toContain("status IN ('processing', 'failed')");
  expect(remediationSql).not.toMatch(/CREATE\s+(TABLE|SCHEMA).*pgboss|ALTER\s+TABLE\s+pgboss/i);
});

test('DLQ provenance migration makes only exact verified provider deliveries replayable', () => {
  expect(provenanceSql).toContain('payload_sha256');
  expect(provenanceSql).toContain('verification_method');
  expect(provenanceSql).toContain('signature_verified_at');
  expect(provenanceSql).toContain("payload_sha256 ~ '^[0-9a-f]{64}$'");
  expect(provenanceSql).toContain("WHEN 'github' THEN 'github-hmac-sha256'");
  expect(provenanceSql).toContain("WHEN 'slack' THEN 'slack-signature'");
  expect(provenanceSql).toContain('webhook_event_verified_provenance_check');
  expect(provenanceSql).toContain('webhook_dlq_verified_provenance_check');
  expect(provenanceSql).toContain('idx_webhook_dlq_workspace_resolution');
  expect(provenanceSql).not.toMatch(/UPDATE\s+webhook_(?:events|dlq)\s+SET\s+(?:payload_sha256|signature_verified_at)/i);
});

test('all explicit migration identifiers fit PostgreSQL and remediation drops match first-migration names', () => {
  const identifiers = [sql, remediationSql, provenanceSql].flatMap(source => [
    ...source.matchAll(/\bCONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)/g),
    ...source.matchAll(/\b(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g),
    ...source.matchAll(/\bTRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/g),
  ].map(match => match[1]));
  expect(identifiers.length).toBeGreaterThan(20);
  for (const identifier of identifiers) expect(Buffer.byteLength(identifier, 'utf8')).toBeLessThanOrEqual(63);

  const initialConstraints = new Set([...sql.matchAll(/\bCONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]));
  const replacementDrops = [...remediationSql.matchAll(/DROP CONSTRAINT IF EXISTS (ga_(?:binding|install)_[A-Za-z0-9_]+)/g)]
    .map(match => match[1])
    .filter(name => ['ga_binding_installation_registration_fk', 'ga_install_id_registration_key',
      'ga_binding_workspace_key', 'ga_binding_registration_repository_key', 'ga_binding_registration_install_repo_key'].includes(name));
  expect(new Set(replacementDrops)).toEqual(new Set([
    'ga_binding_installation_registration_fk', 'ga_install_id_registration_key', 'ga_binding_workspace_key',
    'ga_binding_registration_repository_key', 'ga_binding_registration_install_repo_key',
  ]));
  for (const dropped of replacementDrops) expect(initialConstraints.has(dropped)).toBe(true);

  const dropBindingFk = remediationSql.indexOf('DROP CONSTRAINT IF EXISTS ga_binding_installation_registration_fk');
  const dropInstallKey = remediationSql.indexOf('DROP CONSTRAINT IF EXISTS ga_install_id_registration_key');
  const addInstallKey = remediationSql.indexOf('ADD CONSTRAINT ga_install_identity_key');
  const addBindingFk = remediationSql.indexOf('ADD CONSTRAINT ga_binding_installation_identity_fk');
  expect(dropBindingFk).toBeLessThan(dropInstallKey);
  expect(dropInstallKey).toBeLessThan(addInstallKey);
  expect(addInstallKey).toBeLessThan(addBindingFk);
});
