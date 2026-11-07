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
const filename = '20260821110000_database_staging_migration_evidence.sql';
const sql = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');

test('staging manifests and exact target identity have one durable operation', () => {
  const files = fs.readdirSync(migrationDirectory).filter((entry) => entry.endsWith('.sql'));
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
  assert.match(sql, /CREATE TABLE rorca\.database_staging_migration_operations/);
  for (const field of [
    'request_hash', 'manifest_id', 'manifest_digest', 'target_identity_hash',
    'before_schema_hash', 'after_schema_hash', 'result_record', 'recovery_proof',
  ]) {
    assert.match(sql, new RegExp(`${field} (?:TEXT|UUID|JSONB)`));
  }
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key\)/);
  assert.match(sql, /UNIQUE \(workspace_id, target_identity_hash, manifest_digest\)/);
  assert.match(sql, /authority_grant_id UUID NOT NULL UNIQUE/);
  assert.match(sql, /state IN \('started', 'succeeded', 'recovered'\)/);
});

test('one-use high-risk staging authority is bound to the exact operation subject', () => {
  assert.match(sql, /'database\.migration\.apply\.staging'/);
  assert.match(sql, /database\.migration\.apply\.staging'\) AND risk_class = 'high'/);
  assert.match(sql, /DROP CONSTRAINT database_authority_grant_consuming_operation_fk/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION rorca\.guard_database_authority_grant_transition_v1/);
  assert.match(sql, /operation\.authority_grant_id = NEW\.id/);
  assert.match(sql, /operation\.request_hash = NEW\.subject_hash/);
  assert.match(sql, /Database authority grant consuming operation does not match its exact subject/);
  assert.match(sql, /grant_record\.consumed_by_operation_id = NEW\.id/);
  assert.match(sql, /grant_record\.subject_hash = NEW\.request_hash/);
});

test('external apply reconciliation requires an exact append-only attempt boundary', () => {
  assert.match(sql, /CREATE TABLE rorca\.database_staging_migration_attempts/);
  for (const field of [
    'manifest_digest', 'migration_id', 'migration_content_hash', 'target_ordinal',
    'before_schema_hash', 'expected_schema_hash', 'attempted_at',
  ]) {
    assert.match(sql, new RegExp(`${field} (?:TEXT|BIGINT|TIMESTAMPTZ)`));
  }
  assert.match(sql, /PRIMARY KEY \(operation_id, migration_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, target_identity_hash, target_ordinal\)/);
  assert.match(sql, /Database staging migration attempts are append-only/);
  assert.match(sql, /attempt ordinal must be next after verified history/);
  assert.match(sql, /attempt before-schema hash conflicts with verified history/);
  assert.match(sql, /history lacks its exact durable attempt boundary/);
});

test('verified history is append-only, gapless, fenced, and schema-hash bound', () => {
  assert.match(sql, /CREATE TABLE rorca\.database_staging_migration_history/);
  for (const field of [
    'manifest_digest', 'migration_id', 'migration_content_hash', 'target_ordinal',
    'schema_hash_after', 'statement_outcomes', 'verification',
  ]) {
    assert.match(sql, new RegExp(`${field} (?:TEXT|BIGINT|JSONB)`));
  }
  assert.match(sql, /PRIMARY KEY \(workspace_id, target_identity_hash, migration_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, target_identity_hash, target_ordinal\)/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(/);
  assert.match(sql, /previous_ordinal \+ 1/);
  assert.match(sql, /verification ->> 'passed' = 'true'/);
  assert.match(sql, /verification ->> 'actualSchemaHash' = schema_hash_after/);
  assert.match(sql, /Database staging migration history is append-only/);
  assert.match(sql, /operation\.manifest_digest = NEW\.manifest_digest/);
});

test('terminal receipts prove exact hashes, outcomes, verification, and recovery without credentials', () => {
  assert.match(sql, /result_record ->> 'manifestDigest' = manifest_digest/);
  assert.match(sql, /result_record ->> 'beforeSchemaHash' = before_schema_hash/);
  assert.match(sql, /result_record ->> 'afterSchemaHash' = after_schema_hash/);
  assert.match(sql, /recovery_proof ->> 'resultingSchemaHash' = after_schema_hash/);
  assert.match(sql, /recovery_proof ->> 'strategy' IN \('rollback', 'forward-fix', 'scratch-restore'\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(result_record\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(recovery_proof\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(statement_outcomes\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(verification\)/);
  assert.doesNotMatch(sql, /(?:connection_string|password|credential_bytes|secret_bytes|api_key|service_role_key)\s+(?:TEXT|BYTEA|JSONB)/i);
});

test('staging mutation evidence stays behind split runtime and canonical-writer principals', () => {
  assert.match(sql, /principal_class = 'internal_runtime'/);
  assert.match(sql, /principal_class = 'canonical_writer'/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_staging_migration_operations TO %I', runtime_user/);
  assert.match(sql, /GRANT UPDATE \(state, receipt_id, before_schema_hash, after_schema_hash, result_record, recovery_proof, settled_at\)/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_staging_migration_history TO %I', runtime_user/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_staging_migration_attempts TO %I', runtime_user/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE|TRUNCATE).*database_staging_migration_history/);
  assert.match(sql, /REVOKE ALL ON TABLE rorca\.database_staging_migration_operations FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON TABLE rorca\.database_staging_migration_history FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON TABLE rorca\.database_staging_migration_attempts FROM PUBLIC/);
  assert.match(sql, /pg_roles WHERE rolname IN \('authenticated', 'anon'\)/);
});
