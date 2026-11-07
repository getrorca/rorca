/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationDirectory = path.join(import.meta.dirname, '..', 'pg-migrations');
const filename = '20260821140000_supabase_authority_qualification.sql';
const sql = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');

test('qualification persistence is sealed to a synthetic Rorca-owned fixture', () => {
  const files = fs.readdirSync(migrationDirectory).filter((entry) => entry.endsWith('.sql'));
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
  assert.match(sql, /CREATE TABLE rorca\.database_authority_qualification_receipts/);
  assert.match(sql, /report_record #>> '\{fixture,owner\}' = 'rorca'/);
  assert.match(sql, /report_record #>> '\{fixture,syntheticDataOnly\}' = 'true'/);
  assert.match(sql, /report_record #>> '\{fixture,customerDataPresent\}' = 'false'/);
  assert.match(sql, /report_record #>> '\{fixture,ownershipEvidenceHash\}' ~ '\^sha256:/);
  assert.match(sql, /report_record #>> '\{readOnlyInspection,transactionMode\}' = 'read-only'/);
  assert.match(sql, /report_record #>> '\{scratchRestore,backupVerified\}' = 'true'/);
  assert.match(sql, /report_record #>> '\{scratchRestore,expectedSchemaHash\}'.*= report_record #>> '\{scratchRestore,restoredSchemaHash\}'/s);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(report_record\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(receipt_record\)/);
});

test('rollout storage enforces inspect, restore, staging, then production and credentials', () => {
  const orderedTransition = /OLD\.stage = 'inspect-only' AND NEW\.stage = 'backup-restore'.*OLD\.stage = 'backup-restore' AND NEW\.stage = 'staging-mutation'.*OLD\.stage = 'staging-mutation' AND NEW\.stage = 'production-and-credentials'/s;
  assert.match(sql, orderedTransition);
  assert.match(sql, /stage = 'inspect-only' AND enabled_capabilities = ARRAY\[\s*'database\.schema\.inspect'/);
  assert.match(sql, /stage = 'staging-mutation'.*'database\.migration\.apply\.staging'/s);
  assert.match(sql, /stage = 'production-and-credentials'.*'database\.migration\.apply\.production'.*'credential\.supabase\.jwt-signing\.rotate'/s);
  assert.match(sql, /Database authority rollout phase transition is invalid/);
});

test('rollback revokes all leases and cannot discard qualified receipts', () => {
  assert.match(sql, /NOT OLD\.preserved_receipt_hashes <@ NEW\.preserved_receipt_hashes/);
  assert.match(sql, /Database authority rollback must revoke every capability lease first/);
  assert.match(sql, /stage = 'rolled-back' AND enabled_capabilities = ARRAY\[\s*'database\.schema\.inspect'/);
  assert.match(sql, /Rolled-back database authority control retains an active lease/);
  assert.match(sql, /OLD\.state <> 'active' OR NEW\.state <> 'revoked'/);
});

test('every enabled mutation capability requires one active tracked generation lease', () => {
  assert.match(sql, /CREATE UNIQUE INDEX database_authority_one_active_capability_lease_idx/);
  assert.match(sql, /lease\.qualification_receipt_id = control_record\.qualification_receipt_id/);
  assert.match(sql, /lease\.capability = enabled_capability/);
  assert.match(sql, /lease\.state = 'active'/);
  assert.match(sql, /binding_generation BIGINT NOT NULL CHECK \(binding_generation > 0\)/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
});

test('qualification receipts, controls, and leases remain behind split principals and RLS', () => {
  for (const table of [
    'database_authority_qualification_receipts',
    'database_authority_rollout_controls',
    'database_authority_capability_leases',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE rorca\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE rorca\\.${table} FROM PUBLIC`));
  }
  assert.match(sql, /principal_class = 'internal_runtime'/);
  assert.match(sql, /principal_class = 'canonical_writer'/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE).*TO %I', runtime_user/);
});
