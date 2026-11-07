/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const migrationPath = path.join(
  __dirname,
  '..',
  'pg-migrations',
  '20260821110000_provider_credential_rotation_cutovers.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('provider credential cutover migration', () => {
  it('persists provider-neutral fingerprints and exact grace expiry without credential values', () => {
    assert.match(sql, /CREATE TABLE rorca\.provider_credential_rotation_cutovers/);
    assert.match(sql, /prior_fingerprint TEXT NOT NULL/);
    assert.match(sql, /replacement_fingerprint TEXT NOT NULL/);
    assert.match(sql, /grace_expires_at TIMESTAMPTZ/);
    assert.match(sql, /provider_credential_cutover_distinct_fingerprints/);
    assert.match(sql, /reject_provider_credential_cutover_value/);
    assert.doesNotMatch(sql, /(?:encrypted_)?(?:key|secret)_value\s+(?:TEXT|BYTEA)/i);
    assert.doesNotMatch(sql, /CREATE TABLE\s+(?:rorca\.)?stripe/i);
  });

  it('allows one active target generation and settles only after verified rejection', () => {
    assert.match(sql, /WHERE status = 'active'/);
    assert.match(sql, /WAITING_FOR_REVOCATION' AND NEW\.state = 'COMPLETED'/);
    assert.match(sql, /oldKeyRejection'->>'result' = 'authentication_rejected'/);
    assert.match(sql, /state IN \(\s*'READY_FOR_STAGING', 'GRACE_PERIOD', 'WAITING_FOR_REVOCATION', 'COMPLETED'/);
  });

  it('retains receipts and grants no runtime mutation authority', () => {
    assert.match(sql, /cutover receipts are audit-retained/);
    assert.match(sql, /GRANT SELECT ON TABLE rorca\.provider_credential_rotation_cutovers TO %I', runtime_user/);
    assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;\n]*runtime_user/i);
  });
});
