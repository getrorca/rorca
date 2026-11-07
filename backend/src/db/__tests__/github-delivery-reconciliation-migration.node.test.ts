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

const migration = fs.readFileSync(path.resolve(
  import.meta.dirname,
  '..',
  'pg-migrations',
  '20260824120000_github_delivery_reconciliation.sql',
), 'utf8');

test('operation attempts bind every provider effect to request, grant, lease, and workspace', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS provider_operation_attempts/);
  for (const column of [
    'workspace_id TEXT NOT NULL',
    'authority_request_id UUID NOT NULL',
    'authority_grant_id UUID NOT NULL',
    'authority_lease_id UUID NOT NULL',
    'repository_external_id TEXT NOT NULL',
    'installation_external_id TEXT NOT NULL',
    'branch_name TEXT NOT NULL',
    'commit_sha TEXT NOT NULL',
    'pull_request_external_id TEXT',
    'check_run_external_ids JSONB NOT NULL',
  ]) assert.ok(migration.includes(column), column);
  assert.match(migration, /provider_operation_attempt_lease_fk/);
  assert.match(migration, /'started',[\s\S]*'externally_accepted',[\s\S]*'reconciliation_required',[\s\S]*'settled',[\s\S]*'failed'/);
  assert.match(migration, /OLD\.state = 'started' AND NEW\.state IN \('externally_accepted','reconciliation_required','failed'\)/);
  assert.match(migration, /OLD\.state = 'externally_accepted' AND NEW\.state = 'settled'/);
  assert.match(migration, /operation = 'scm\.review\.request'[\s\S]*state IN \('started','reconciliation_required','failed'\) OR pull_request_external_id IS NOT NULL/);
});

test('receipts are one-use, immutable, redacted, and workspace scoped', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS provider_operation_receipts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS provider_operation_receipt_attempts/);
  assert.match(migration, /attempt_id UUID NOT NULL UNIQUE/);
  assert.match(migration, /receipt_json ->> 'workspaceId' = workspace_id/);
  assert.match(migration, /receipt_json #>> '\{authority,requestId\}' = authority_request_id::text/);
  assert.match(migration, /receipt_json #>> '\{authority,grantId\}' = authority_grant_id::text/);
  assert.match(migration, /receipt_json #>> '\{authority,leaseId\}' = authority_lease_id::text/);
  assert.match(migration, /reject_provider_receipt_mutation/);
  assert.match(migration, /BEFORE UPDATE OR DELETE OR TRUNCATE ON provider_operation_receipts/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE provider_operation_receipts FROM PUBLIC/);
  assert.match(migration, /Bearer\[\[:space:\]\]\+/);
  assert.doesNotMatch(migration, /pgboss\./);
});

test('failed revocation has one legal read-side transition after verified expiry', () => {
  assert.match(migration, /OLD\.state = 'reconciliation_required'/);
  assert.match(migration, /NEW\.state = 'settled'/);
  assert.match(migration, /OLD\.settlement_kind = 'revocation_failed'/);
  assert.match(migration, /NEW\.settlement_kind = 'verified_expiry'/);
  assert.match(migration, /NEW\.revocation_verified_at >= OLD\.expires_at/);
});
