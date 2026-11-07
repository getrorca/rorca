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
  '20260824100000_authority_production_deployments.sql',
), 'utf8');

const authorizationGuard = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.guard_authority_production_authorization'),
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.protect_authority_production_authorization'),
);

test('production authority persists typed waits without storing provider credentials', () => {
  assert.match(migration, /'waiting_for_authorization', 'waiting_for_change_window'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rorca\.authority_production_authorizations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rorca\.authority_external_gate_configurations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rorca\.authority_external_gate_evidence/);
  assert.doesNotMatch(migration, /control_token|encrypted_key|api_key_vault|secret_store/i);
});

test('reviewed external gate evidence binds exact intent, CI, cohort, approval, and production target', () => {
  assert.match(migration, /configuration_row\.status IS DISTINCT FROM 'reviewed'/);
  assert.match(migration, /intent_row\.intent_digest IS DISTINCT FROM NEW\.intent_digest/);
  assert.match(migration, /intent_row\.ci_evidence_digest IS DISTINCT FROM NEW\.ci_evidence_digest/);
  assert.match(migration, /intent_row\.intent_payload->'rolloutCohort' IS DISTINCT FROM NEW\.rollout_cohort/);
  assert.match(migration, /providerApprovalReference,approvalId/);
  assert.match(migration, /binding_row\.environment_kind IS DISTINCT FROM 'production'/);
  assert.match(migration, /productionApprovalMode.*independent_external/s);
});

test('database rejects closed windows, expired grants, denied gates, and replay', () => {
  assert.match(authorizationGuard, /grant_row\.expires_at <= NEW\.authorized_at/);
  assert.match(authorizationGuard, /changeWindow,startsAt/);
  assert.match(authorizationGuard, /changeWindow,endsAt/);
  assert.match(authorizationGuard, /evidence_row\.decision IS DISTINCT FROM 'approved'/);
  assert.match(authorizationGuard, /evidence_row\.expires_at <= NEW\.authorized_at/);
  assert.match(migration, /idx_authority_production_grant_consumption/);
  assert.match(migration, /idx_authority_production_gate_evidence_consumption/);
});

test('authorization and reviewed gate records preserve immutable consumption lineage', () => {
  assert.match(migration, /production authorization material and consumption are immutable/);
  assert.match(migration, /reviewed external gate records are immutable/);
  assert.match(migration, /OLD\.authorization_grant_id IS NOT NULL/);
  assert.match(migration, /OLD\.external_gate_evidence_id IS NOT NULL/);
  assert.match(migration, /OLD\.claimed_at IS NOT NULL/);
});
