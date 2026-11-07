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
const filename = '20260821120000_database_production_migration_authority.sql';
const sql = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');

test('production authority seals every grant-bound migration input', () => {
  const files = fs.readdirSync(migrationDirectory).filter((entry) => entry.endsWith('.sql'));
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
  assert.match(sql, /CREATE TABLE rorca\.database_production_migration_operations/);
  for (const field of [
    'request_hash', 'manifest_digest', 'target_digest', 'backup_record_hash',
    'window_digest', 'evidence_digest', 'recovery_plan_digest',
    'recovery_owner_digest', 'external_gate_digest',
  ]) {
    assert.match(sql, new RegExp(`${field} TEXT NOT NULL`));
  }
  assert.match(sql, /result_record #>> '\{target,targetDigest\}' = target_digest/);
  assert.match(sql, /result_record #>> '\{backup,recordHash\}' = backup_record_hash/);
  assert.match(sql, /result_record ->> 'evidenceDigest' = evidence_digest/);
  assert.match(sql, /result_record ->> 'recoveryOwnerDigest' = recovery_owner_digest/);
  assert.match(sql, /UNIQUE \(workspace_id, target_identity_hash, manifest_digest\)/);
});

test('production capability is a separate one-use critical authority', () => {
  assert.match(sql, /'database\.migration\.apply\.production' AND risk_class = 'critical'/);
  assert.match(sql, /grant_record\.capability = 'database\.migration\.apply\.production'/);
  assert.match(sql, /grant_record\.subject_hash = NEW\.request_hash/);
  assert.match(sql, /grant_record\.consumed_by_operation_id = NEW\.id/);
  assert.match(sql, /Database production migration operation lacks its exact consumed critical grant/);
  assert.doesNotMatch(sql, /(?:deploy|deployment)\.(?:apply|execute)/);
});

test('external-gate waiting is durable and only approval promotion consumes authority', () => {
  assert.match(sql, /state IN \('waiting', 'started', 'succeeded', 'aborted'\)/);
  assert.match(sql, /OLD\.state = 'waiting' AND NEW\.state = 'started'/);
  assert.match(sql, /WHERE state IN \('waiting', 'started'\)/);
  assert.match(sql, /UPDATE \(state, receipt_id, before_schema_hash, after_schema_hash, result_record, abort_proof, final_consistency, started_at, settled_at\)/);
  assert.doesNotMatch(sql, /UPDATE \([^)]*(?:request_hash|manifest_digest|target_digest|backup_record_hash)/);
});

test('crash reconciliation has one append-only intent and verified history boundary', () => {
  assert.match(sql, /CREATE TABLE rorca\.database_production_migration_attempts/);
  assert.match(sql, /CREATE TABLE rorca\.database_production_migration_history/);
  assert.match(sql, /PRIMARY KEY \(operation_id, migration_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, target_identity_hash, target_ordinal\)/);
  assert.match(sql, /attempt before-schema hash conflicts with verified history/);
  assert.match(sql, /history lacks its exact durable attempt boundary/);
  assert.match(sql, /history ordinal must be gapless and increasing/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(/);
  assert.match(sql, /permits one durable abort-proof boundary/);
  assert.match(sql, /OLD\.abort_proof IS NULL OR NEW\.abort_proof IS DISTINCT FROM OLD\.abort_proof/);
});

test('abort and success receipts prove one final credential-free consistency state', () => {
  assert.match(sql, /state = 'aborted'.*abort_proof IS NOT NULL/s);
  assert.match(sql, /abort_proof ->> 'strategy' IN \('rollback', 'forward-fix', 'restore'\)/);
  assert.match(sql, /final_consistency ->> 'verified' = 'true'/);
  assert.match(sql, /final_consistency ->> 'schemaHash' = after_schema_hash/);
  assert.match(sql, /final_consistency ->> 'migrationHistoryDigest'/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(result_record\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(abort_proof\)/);
  assert.doesNotMatch(sql, /(?:connection_string|password|credential_bytes|secret_bytes|api_key|service_role_key)\s+(?:TEXT|BYTEA|JSONB)/i);
});

test('production evidence remains behind distinct runtime and canonical-writer principals', () => {
  assert.match(sql, /principal_class = 'internal_runtime'/);
  assert.match(sql, /principal_class = 'canonical_writer'/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_production_migration_operations TO %I', runtime_user/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_production_migration_attempts TO %I', runtime_user/);
  assert.match(sql, /GRANT SELECT, INSERT ON rorca\.database_production_migration_history TO %I', runtime_user/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE|TRUNCATE).*database_production_migration_history/);
  assert.match(sql, /REVOKE ALL ON TABLE rorca\.database_production_migration_operations FROM PUBLIC/);
  assert.match(sql, /pg_roles WHERE rolname IN \('authenticated', 'anon'\)/);
});
