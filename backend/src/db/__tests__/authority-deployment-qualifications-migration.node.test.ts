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
  '20260824120000_authority_deployment_qualifications.sql',
), 'utf8');
const runTable = migration.slice(
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_deployment_qualifications ('),
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_deployment_qualification_scenarios ('),
);
const targetGuard = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_qualification_target'),
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_qualification_scenario'),
);
const scenarioGuard = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_qualification_scenario'),
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.protect_authority_deployment_qualification_scenario'),
);
const settlementGuard = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.protect_authority_deployment_qualification()'),
  migration.indexOf('REVOKE ALL PRIVILEGES'),
);

test('qualification persistence is provider-neutral evidence with no credential value column', () => {
  assert.match(runTable, /staging_binding_id UUID NOT NULL REFERENCES rorca\.authority_provider_bindings/);
  assert.match(runTable, /production_binding_id UUID NOT NULL REFERENCES rorca\.authority_provider_bindings/);
  assert.match(runTable, /fixture_owner TEXT NOT NULL CHECK \(fixture_owner = 'rorca'\)/);
  assert.match(runTable, /fixture_namespace ~ '\^rorca-disposable-coolify\//);
  assert.doesNotMatch(runTable, /control_token|api_token|encrypted_key|secret_value/i);
});

test('database admits only distinct Rorca-owned staging and protected-production bindings', () => {
  assert.match(targetGuard, /environment_kind IS DISTINCT FROM 'staging'/);
  assert.match(targetGuard, /environment_kind IS DISTINCT FROM 'production'/);
  assert.match(targetGuard, /status IS DISTINCT FROM 'active'/);
  assert.match(targetGuard, /application_uuid IS NOT DISTINCT FROM production_row\.application_uuid/);
  assert.match(targetGuard, /environment_uuid IS NOT DISTINCT FROM production_row\.environment_uuid/);
  assert.match(targetGuard, /secret_store_id IS NOT DISTINCT FROM production_row\.secret_store_id/);
  assert.match(targetGuard, /rorca-disposable-qualification/);
  assert.match(targetGuard, /rorca-fixture-team/);
  assert.match(targetGuard, /productionApprovalMode.*independent_external/s);
});

test('attack and crash evidence is immutable, unique, and safe around provider mutation', () => {
  for (const scenario of [
    'intent_digest_changed',
    'migration_set_changed',
    'change_window_closed',
    'external_gate_denied',
    'external_gate_invalid',
    'grant_expired',
    'grant_replayed',
    'cross_environment_binding',
    'control_token_prompt_extraction',
    'health_abort',
    'crash_deploy',
    'crash_canary',
    'crash_rollback',
    'crash_revocation',
  ]) {
    assert.match(migration, new RegExp(`'${scenario}'`));
  }
  assert.match(scenarioGuard, /unique_operation_count IS DISTINCT FROM operation_count/);
  assert.match(scenarioGuard, /unique_idempotency_count IS DISTINCT FROM idempotency_count/);
  assert.match(scenarioGuard, /providerMutationCount.*provider_mutation_count/s);
  assert.match(scenarioGuard, /target,bindingGeneration.*production_binding_generation/s);
  assert.match(scenarioGuard, /terminalState,authorityBindingGeneration.*production_binding_generation/s);
  assert.match(scenarioGuard, /productionCredentialResolved' IS DISTINCT FROM 'false'/);
  assert.match(scenarioGuard, /lease_ids IS DISTINCT FROM revoked_lease_ids/);
  assert.match(migration, /qualification scenario evidence is immutable/);
});

test('stage and reviewed gate checkpoints precede production and terminal settlement stays disabled', () => {
  assert.match(settlementGuard, /production qualification cannot begin before staging evidence/);
  assert.match(settlementGuard, /production qualification cannot begin before external gate evidence/);
  assert.match(settlementGuard, /github-protected-environment-fixture/);
  assert.match(settlementGuard, /external_gate_evidence->>'reviewed' IS DISTINCT FROM 'true'/);
  assert.match(settlementGuard, /production_row\.status IS DISTINCT FROM 'disabled'/);
  assert.match(settlementGuard, /scenario_count IS DISTINCT FROM 14/);
  assert.match(settlementGuard, /receipt_scenario_match_count IS DISTINCT FROM 14/);
  assert.match(settlementGuard, /receipt_scenario_name_count IS DISTINCT FROM 14/);
  assert.match(settlementGuard, /qualification_receipt->'staging' IS DISTINCT FROM NEW.staging_evidence/);
  assert.match(settlementGuard, /productionRolloutEnabled' IS DISTINCT FROM 'false'/);
  assert.match(settlementGuard, /rollback_blocked/);
  assert.match(settlementGuard, /blocker_count = 0/);
});
