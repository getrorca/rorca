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
const filename = '20260821100000_database_backup_restore_evidence.sql';
const sql = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');

test('backup storage records encrypted, retained, reference-only artifact evidence', () => {
  const files = fs.readdirSync(migrationDirectory).filter((entry) => entry.endsWith('.sql'));
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
  assert.match(sql, /CREATE TABLE rorca\.database_backup_artifacts/);
  for (const field of [
    'source_identity', 'source_identity_hash', 'source_database_identity_hash',
    'provider_artifact_reference', 'storage_provider_id', 'storage_location_reference',
    'content_hash', 'schema_hash', 'database_version', 'encryption_provenance',
    'retention', 'verification', 'record_hash',
  ]) {
    assert.match(sql, new RegExp(`${field} (?:TEXT|JSONB)`));
  }
  assert.match(sql, /encryption_provenance ->> 'encrypted' = 'true'/);
  assert.match(sql, /verification ->> 'verified' = 'true'/);
  assert.match(sql, /verification ->> 'verifiedContentHash' = content_hash/);
  assert.match(sql, /retention ->> 'retainUntil'/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(artifact_record\)/);
  assert.doesNotMatch(sql, /(?:connection_string|password|credential_bytes|secret_bytes|api_key|service_role_key)\s+(?:TEXT|BYTEA|JSONB)/i);
});

test('exact one-use grants separate backup authority from high-risk restore authority', () => {
  assert.match(sql, /CREATE TABLE rorca\.database_authority_operation_grants/);
  assert.match(sql, /capability = 'database\.backup\.create' AND risk_class = 'elevated'/);
  assert.match(sql, /capability = 'database\.backup\.restore' AND risk_class = 'high'/);
  assert.match(sql, /subject_hash TEXT NOT NULL/);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /issued_by_authority_hash TEXT NOT NULL/);
  assert.match(sql, /consumed_by_operation_id UUID UNIQUE/);
  assert.match(sql, /authority_grant_id UUID NOT NULL UNIQUE/);
  assert.match(sql, /grant_record\.subject_hash = NEW\.request_hash/);
  assert.match(sql, /grant_record\.consumed_by_operation_id = NEW\.id/);
  assert.match(sql, /Database authority grant subject is immutable and single-use/);
});

test('backup and restore operations have distinct capabilities and one terminal outcome', () => {
  assert.match(sql, /CREATE TABLE rorca\.database_backup_restore_operations/);
  assert.match(sql, /capability IN \('database\.backup\.create', 'database\.backup\.restore'\)/);
  assert.match(sql, /UNIQUE \(workspace_id, capability, idempotency_key\)/);
  assert.match(sql, /receipt_id UUID UNIQUE REFERENCES rorca\.authority_operation_receipts/);
  assert.match(sql, /state IN \('started', 'succeeded', 'cleanup_required'\)/);
  assert.match(sql, /OLD\.state <> 'started' OR NEW\.state NOT IN \('succeeded', 'cleanup_required'\)/);
  assert.match(sql, /permits one terminal transition/);
  assert.match(sql, /Database backup operation receipt does not match exact authority subject/);
  assert.match(sql, /cannot settle without its verified artifact/);
  assert.match(sql, /cleanup_evidence ->> 'operationId' = id::TEXT/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(cleanup_evidence\)/);
});

test('artifact and operation mutation stay behind the internal runtime principal', () => {
  assert.match(sql, /Database backup artifact records are immutable/);
  assert.match(sql, /Database backup operations are immutable/);
  assert.match(sql, /principal_class = 'internal_runtime'/);
  assert.match(sql, /principal_class = 'canonical_writer'/);
  assert.match(sql, /GRANT SELECT ON rorca\.database_authority_operation_grants TO %I', runtime_user/);
  assert.match(sql, /GRANT UPDATE \(consumed_by_operation_id, consumed_at\).*runtime_user/s);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT ON rorca\.database_authority_operation_grants TO %I', runtime_user/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_authority_operation_grants TO %I', writer_user/);
  assert.match(sql, /GRANT UPDATE \(revoked_at\).*writer_user/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_backup_artifacts TO %I/);
  assert.match(sql, /GRANT UPDATE \(state, receipt_id, result_record, cleanup_evidence, settled_at\)/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE|TRUNCATE) ON rorca\.database_backup_artifacts/);
  assert.match(sql, /REVOKE ALL ON TABLE rorca\.database_backup_artifacts FROM PUBLIC/);
  assert.match(sql, /pg_roles WHERE rolname IN \('authenticated', 'anon'\)/);
});
