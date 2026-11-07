/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationDirectory = path.join(import.meta.dirname, '..', 'pg-migrations');
const filename = '20260821090000_database_authority_provider_bindings.sql';
const sql = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');

test('database authority storage uses a unique migration generation and generic reference-only tables', () => {
  const files = fs.readdirSync(migrationDirectory).filter((entry) => entry.endsWith('.sql'));
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
  for (const relation of [
    'rorca.authority_provider_bindings',
    'rorca.authority_secret_references',
    'rorca.authority_operation_receipts',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${relation.replace('.', '\\.')}`));
  }
  assert.match(sql, /provider_subject_ref TEXT NOT NULL/);
  assert.match(sql, /resource_identity JSONB NOT NULL/);
  assert.match(sql, /binding_generation BIGINT NOT NULL/);
  assert.match(sql, /role_profile JSONB NOT NULL/);
  assert.match(sql, /reference_id TEXT NOT NULL/);
  assert.match(sql, /reference_fingerprint TEXT NOT NULL/);
  assert.doesNotMatch(sql, /(?:connection_string|password|credential_bytes|secret_bytes|api_key|service_role_key)\s+(?:TEXT|BYTEA|JSONB)/i);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(resource_identity\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(role_profile\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(redacted_evidence\)/);
  assert.match(sql, /reference_id !~\* '\^postgres\(\?:ql\)\?:\/\//);
});

test('binding identity, environment, target, verified profile, and secret references are immutable', () => {
  for (const field of [
    'workspace_id', 'provider_id', 'provider_subject_ref', 'environment', 'resource_identity',
    'resource_identity_hash', 'binding_generation', 'role_profile', 'binding_hash',
  ]) {
    assert.match(sql, new RegExp(`OLD\\.${field} IS DISTINCT FROM NEW\\.${field}`));
  }
  assert.match(sql, /permits only active-to-disabled transition/);
  assert.match(sql, /Authority secret references are immutable; create a new binding generation/);
  assert.match(sql, /Database authority bindings are append-only/);
  assert.match(sql, /Authority operation receipts are immutable/);
  assert.match(sql, /UNIQUE \(workspace_id, provider_id, provider_subject_ref, environment, binding_generation\)/);
  assert.match(sql, /WHERE binding_status = 'active'/);
});

test('runtime can read bindings and settle safe receipts but cannot mutate binding authority', () => {
  assert.match(sql, /principal_class = 'internal_runtime'/);
  assert.match(sql, /principal_class = 'canonical_writer'/);
  assert.match(sql, /GRANT SELECT ON rorca\.authority_provider_bindings, rorca\.authority_secret_references TO %I/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.authority_operation_receipts TO %I/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE).*authority_provider_bindings TO %I', runtime_user/);
  assert.match(sql, /GRANT UPDATE \(binding_status, disabled_at\) ON rorca\.authority_provider_bindings TO %I/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON rorca\.authority_provider_bindings/);
  assert.match(sql, /REVOKE ALL ON TABLE rorca\.authority_provider_bindings FROM PUBLIC/);
  assert.match(sql, /pg_roles WHERE rolname IN \('authenticated', 'anon'\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION rorca\.authority_metadata_is_reference_only_v1\(JSONB\) TO %I/);
});

test('application credential classes remain explicit and cannot imply database-role authority', () => {
  assert.match(sql, /'database-role'/);
  assert.match(sql, /role_profile ->> 'authenticationClass' = 'database-role'/);
  for (const credentialClass of [
    'application-anon',
    'application-publishable',
    'application-secret',
    'application-service-role',
  ]) {
    assert.match(sql, new RegExp(`'${credentialClass}'`));
  }
  assert.match(sql, /PRIMARY KEY \(binding_id, purpose\)/);
  assert.match(sql, /purpose <> 'database-connection' OR credential_class = 'database-role'/);
  assert.match(sql, /FOREIGN KEY \(binding_id, workspace_id\)/);
});
