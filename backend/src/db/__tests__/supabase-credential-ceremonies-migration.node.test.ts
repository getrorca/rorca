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
const filename = '20260821130000_supabase_credential_ceremonies.sql';
const sql = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');

test('credential migration defines three exact grant, operation, and receipt contracts', () => {
  const files = fs.readdirSync(migrationDirectory).filter((entry) => entry.endsWith('.sql'));
  assert.doesNotThrow(() => checkDuplicatePrefixes(files));
  for (const type of ['api-key-rotation', 'legacy-key-migration', 'jwt-signing-rotation']) {
    assert.match(sql, new RegExp(type));
  }
  for (const capability of [
    'credential.supabase.api-key.rotate',
    'credential.supabase.legacy-key.migrate',
    'credential.supabase.jwt-signing.rotate',
  ]) {
    assert.match(sql, new RegExp(capability.replaceAll('.', '\\.')));
  }
  assert.match(sql, /credential_ceremony_grant_consuming_ceremony_fk/);
  assert.match(sql, /ceremony\.request_digest = NEW\.subject_hash/);
  assert.match(sql, /ceremony\.ceremony_type = NEW\.ceremony_type/);
  assert.match(sql, /ceremony\.capability = NEW\.capability/);
});

test('only the core SecretStore table contains encrypted credential payloads', () => {
  assert.match(sql, /CREATE TABLE rorca\.authority_secret_store_entries/);
  assert.match(sql, /encrypted_value BYTEA NOT NULL/);
  const authorityMetadata = sql.slice(0, sql.indexOf('CREATE TABLE rorca.authority_secret_store_entries'));
  assert.doesNotMatch(authorityMetadata, /(?:credential_bytes|secret_bytes|signing_key|api_key|service_role_key|encrypted_value)\s+(?:TEXT|BYTEA|JSONB)/i);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(request_record\)/);
  assert.match(sql, /authority_metadata_is_reference_only_v1\(receipt_record\)/);
  assert.match(sql, /Never join encrypted_value into API responses, model context, logs, authority rows, or receipts/);
});

test('consumer inventory and JWT key transitions are one-way and complete', () => {
  assert.match(sql, /CREATE TABLE rorca\.credential_consumer_bindings/);
  assert.match(sql, /state TEXT NOT NULL CHECK \(state IN \('current', 'standby', 'current-replacement', 'revoked-old'\)\)/);
  assert.match(sql, /OLD\.state = 'current' AND NEW\.state = 'standby'/);
  assert.match(sql, /OLD\.state = 'standby' AND NEW\.state = 'current-replacement'/);
  assert.match(sql, /OLD\.state = 'current-replacement' AND NEW\.state = 'revoked-old'/);
  assert.match(sql, /old_reference_id IS DISTINCT FROM NEW\.old_reference_id/);
  assert.match(sql, /Credential consumer inventory identity is immutable/);
});

test('revocation settlement requires canary, cutover, rollback readiness, and typed receipt', () => {
  assert.match(sql, /state = 'revoked'.*canary_evidence IS NOT NULL.*cutover_evidence IS NOT NULL.*revocation_evidence IS NOT NULL.*receipt_record IS NOT NULL/s);
  assert.match(sql, /revocation_evidence ->> 'rollbackReadinessPassed' = 'true'/);
  assert.match(sql, /rorca\.supabase-api-key-rotation-receipt\.v1/);
  assert.match(sql, /rorca\.supabase-legacy-key-migration-receipt\.v1/);
  assert.match(sql, /rorca\.supabase-jwt-signing-rotation-receipt\.v1/);
  assert.match(sql, /Credential ceremony receipts are immutable/);
});

test('credential material and evidence remain behind split principals and RLS', () => {
  for (const table of [
    'credential_ceremony_grants',
    'credential_ceremonies',
    'authority_secret_store_entries',
    'credential_consumer_bindings',
    'credential_ceremony_receipts',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE rorca\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE rorca\\.${table} FROM PUBLIC`));
  }
  assert.match(sql, /principal_class = 'internal_runtime'/);
  assert.match(sql, /principal_class = 'canonical_writer'/);
  assert.match(sql, /revoked_at IS NULL/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE).*authority_secret_store_entries TO %I', runtime_user/);
});
