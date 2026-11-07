/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const migrationName = '20260821120000_provider_credential_rotation_failures.sql';
const sql = readFileSync(path.join(migrationDirectory, migrationName), 'utf8');

describe('provider credential failure migration', () => {
  it('uses a unique provider-neutral migration version with no credential value columns', () => {
    assert.deepEqual(
      readdirSync(migrationDirectory).filter((file) => file.startsWith('20260821120000_')),
      [migrationName],
    );
    assert.match(sql, /CREATE TABLE rorca\.provider_credential_rotation_rollbacks/);
    assert.match(sql, /CREATE TABLE rorca\.provider_credential_emergency_requests/);
    assert.match(sql, /CREATE TABLE rorca\.provider_credential_status_reconciliations/);
    assert.doesNotMatch(sql, /CREATE TABLE\s+(?:rorca\.)?stripe/i);
    assert.doesNotMatch(sql, /(?:encrypted_)?(?:key|secret)_value\s+(?:TEXT|BYTEA)/i);
  });

  it('makes rollback receipts immutable and requires quarantined replacement evidence', () => {
    assert.match(sql, /provider credential failure receipts are audit-retained and immutable/);
    assert.match(sql, /receipt_payload->>'replacementSecretStatus' = 'quarantined'/);
    assert.match(sql, /disposition IN \('ROLLED_BACK', 'MANUAL_RECONCILIATION'\)/);
    assert.match(sql, /rotation_intent_id UUID NOT NULL UNIQUE/);
  });

  it('makes emergency authority inert and Dashboard-authentication bound', () => {
    assert.match(sql, /state TEXT NOT NULL CHECK \(state = 'AWAITING_DASHBOARD_AUTHENTICATION'\)/);
    for (const field of [
      'canGrant',
      'canBroadenPermissions',
      'canCrossWorkspace',
      'canCrossMode',
      'canInjectSecret',
    ]) {
      assert.match(sql, new RegExp(`'${field}', false`));
    }
    assert.match(sql, /'requiresDashboardAuthentication', true/);
    assert.match(sql, /guard_provider_credential_emergency_request/);
    assert.match(sql, /binding\.permission_manifest @> NEW\.request_payload->'permissionManifest'/);
    assert.match(sql, /NEW\.request_payload->'permissionManifest' @> binding\.permission_manifest/);
    assert.match(sql, /binding\.mode = NEW\.mode/);
    assert.match(sql, /emergency request cannot change binding scope, mode, permissions, or authority/);
  });

  it('blocks unresolved status retries and grants runtime no mutation authority', () => {
    assert.match(sql, /retry_allowed = \(disposition = 'PROVIDER_READBACK_RESOLVED'\)/);
    assert.match(sql, /credential-shaped values are forbidden in provider credential failure evidence/);
    assert.match(sql, /GRANT SELECT ON TABLE rorca\.%I TO %I/);
    assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;\n]*runtime_user/i);
  });
});
