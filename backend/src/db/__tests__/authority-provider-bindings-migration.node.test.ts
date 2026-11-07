/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'pg-migrations',
  '20260821100100_authority_provider_bindings.sql',
), 'utf8');
const bindingTable = migration.slice(
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.deployment_provider_bindings'),
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.deployment_capability_leases'),
);

test('provider binding schema uses immutable target UUIDs and a core encrypted-vault reference', () => {
  assert.match(bindingTable, /project_uuid UUID NOT NULL/);
  assert.match(bindingTable, /application_uuid UUID NOT NULL/);
  assert.match(bindingTable, /environment_uuid UUID NOT NULL/);
  assert.match(bindingTable, /secret_store_id TEXT NOT NULL REFERENCES rorca\.api_key_vault\(id\)/);
  assert.match(bindingTable, /UNIQUE \(workspace_id, provider_id, environment_kind\)/);
  assert.match(bindingTable, /UNIQUE \(provider_id, base_url, application_uuid\)/);
  assert.doesNotMatch(bindingTable, /control_token|token_cipher|token_plaintext|coolify_secret/i);
  assert.match(migration, /provider binding identity is immutable/);
});

test('verified profiles are fenced to binding identity, policy, validation state, and vault scope', () => {
  assert.ok(bindingTable.includes(
    "(verified_profile #>> '{target,project,uuid}') IS NOT DISTINCT FROM project_uuid::TEXT",
  ));
  assert.ok(bindingTable.includes(
    "(verified_profile #>> '{target,application,uuid}') IS NOT DISTINCT FROM application_uuid::TEXT",
  ));
  assert.ok(bindingTable.includes(
    "(verified_profile #>> '{target,environment,uuid}') IS NOT DISTINCT FROM environment_uuid::TEXT",
  ));
  assert.ok(bindingTable.includes(
    "(verified_profile->'allowedActions') IS NOT DISTINCT FROM (capability_policy->'allowedActions')",
  ));
  assert.match(bindingTable, /status = 'active' AND verified_profile IS NOT NULL AND validation_error_code IS NULL/);
  assert.match(bindingTable, /status = 'invalid' AND verified_profile IS NULL AND validation_error_code IS NOT NULL/);
  assert.match(migration, /secret_workspace_id IS DISTINCT FROM NEW\.workspace_id/);
  assert.match(migration, /secret_provider_id IS DISTINCT FROM NEW\.provider_id/);
  assert.match(migration, /BEFORE INSERT ON rorca.deployment_provider_bindings/);
});

test('lease fencing rejects inactive, stale-generation, expired, and disallowed bindings', () => {
  assert.match(migration, /binding_row\.status <> 'active'/);
  assert.match(migration, /binding_row\.binding_generation <> NEW\.binding_generation/);
  assert.match(migration, /binding_row\.profile_expires_at <= NOW\(\)/);
  assert.match(migration, /NEW\.expires_at > binding_row\.profile_expires_at/);
  assert.match(migration, /capability_policy->'allowedActions' \? NEW\.capability/);
});

test('disable transition revokes unused leases and marks provider attempts for recovery', () => {
  assert.match(migration, /WHEN 'leased' THEN 'revoked'/);
  assert.match(migration, /WHEN 'dispatched' THEN 'revocation_required'/);
  assert.match(migration, /WHEN 'outcome_unknown' THEN 'reconciliation_required'/);
});
