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
  '20260822100000_authority_staging_deployments.sql',
), 'utf8');

const operationTable = migration.slice(
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_deployment_operations'),
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_execution_receipts'),
);
const receiptTable = migration.slice(
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_execution_receipts'),
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_operation'),
);

test('deployment operations persist exact provider-neutral immutable inputs and no credentials', () => {
  assert.match(operationTable, /binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings/);
  assert.match(operationTable, /binding_generation BIGINT NOT NULL/);
  assert.match(operationTable, /source_revision TEXT/);
  assert.match(operationTable, /image_digest TEXT/);
  assert.match(operationTable, /configuration_binding_generation BIGINT NOT NULL/);
  assert.match(operationTable, /health_signals JSONB NOT NULL/);
  assert.match(operationTable, /provider_deployment_id TEXT/);
  assert.doesNotMatch(operationTable, /control_token|encrypted_key|credential_value|coolify_/i);
  assert.match(migration, /deployment operation request and accepted lineage are immutable/);
});

test('database guard prohibits cross-environment operation authority', () => {
  assert.match(migration, /binding_row\.environment_kind = 'staging' AND NEW\.capability <> 'deploy\.staging'/);
  assert.match(migration, /binding_row\.environment_kind = 'production' AND NEW\.capability <> 'deploy\.production'/);
  assert.match(migration, /deployment operation crosses the bound environment/);
  assert.match(migration, /binding_row\.binding_generation <> NEW\.binding_generation/);
});

test('one immutable receipt is bound to each deployment operation', () => {
  assert.match(receiptTable, /operation_id UUID NOT NULL UNIQUE REFERENCES rorca\.authority_deployment_operations/);
  assert.match(receiptTable, /receipt_payload JSONB NOT NULL/);
  assert.match(migration, /authority execution receipts are immutable/);
  assert.match(migration, /idx_authority_deployment_provider_lineage/);
  assert.doesNotMatch(receiptTable, /secret|token|credential/i);
});
