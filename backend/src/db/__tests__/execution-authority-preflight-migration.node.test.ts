/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(
  join(__dirname, '..', 'pg-migrations', '20260822120000_execution_authority_preflight.sql'),
  'utf8',
);
const executableMigration = migration.replace(/--[^\n]*/g, '');
const route = readFileSync(join(__dirname, '..', '..', 'routes', 'pipeline.ts'), 'utf8');
const lifecycle = readFileSync(join(__dirname, '..', '..', 'lib', 'run-lifecycle.ts'), 'utf8');
const capabilityContract = readFileSync(join(__dirname, '..', '..', 'lib', 'required-capability.ts'), 'utf8');

test('preflight migration is application-owned and adds exact typed waiting persistence', () => {
  assert.doesNotMatch(executableMigration, /\bpgboss\b/i);
  assert.match(migration, /CREATE TABLE rorca\.authority_run_preflights/);
  assert.match(migration, /CREATE TABLE rorca\.authority_preflight_requirements/);
  assert.match(migration, /UNIQUE \(workspace_id, run_id, preflight_digest\)/);
  assert.match(migration, /spec_revision TEXT NOT NULL CHECK \(spec_revision ~ '\^sha256:/);
  assert.match(migration, /policy_revision TEXT NOT NULL CHECK \(policy_revision ~ '\^sha256:/);
  assert.match(migration, /pending_story_position INTEGER NOT NULL/);
  assert.match(migration, /wait_expires_at TIMESTAMPTZ/);
  for (const state of [
    'WAITING_FOR_AUTHORIZATION',
    'WAITING_FOR_AUTHENTICATION',
    'WAITING_FOR_CHANGE_WINDOW',
  ]) {
    assert.match(migration, new RegExp(state));
    assert.match(lifecycle, new RegExp(state.toLowerCase()));
  }
});

test('binding or context invalidation revokes grants and cancels unresolved authority without deleting audit rows', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION rorca\.invalidate_authority_run_preflight_v1/);
  assert.match(migration, /UPDATE rorca\.authority_grants[\s\S]*SET status = 'revoked'/);
  assert.match(migration, /UPDATE rorca\.operation_intents[\s\S]*SET status = 'cancelled'/);
  assert.match(migration, /UPDATE rorca\.authority_requests[\s\S]*SET status = 'cancelled'/);
  assert.match(migration, /provider_binding_generation_changed/);
  assert.match(migration, /BEFORE DELETE ON rorca\.authority_run_preflights/);
  assert.match(migration, /BEFORE DELETE ON rorca\.authority_preflight_requirements/);
  assert.doesNotMatch(migration, /DELETE FROM rorca\.(authority_run_preflights|authority_preflight_requirements|authority_grants|authority_requests)/);
});

test('required capability contract carries every exact versioned preflight field', () => {
  assert.match(capabilityContract, /rorca\.required-capability\.v1/);
  for (const field of [
    'capabilityId',
    'bindingReference',
    'bindingGeneration',
    'environment',
    'resource',
    'requestedMode',
    'evidenceRequirements',
  ]) assert.match(capabilityContract, new RegExp(field));
});

test('canonical trigger settles authority before timeout construction and every story publication', () => {
  const handler = route.slice(route.indexOf('async function handlePipelineTrigger('), route.indexOf('const CampaignPauseControlSchema'));
  const prepare = handler.indexOf('const preparedAuthorityPreflight = await prepareWorkspaceExecutionAuthorityPreflight');
  const jobPayload = handler.indexOf('const jobPayload = {');
  const lastSettlementBeforePayload = handler.lastIndexOf('settleExecutionAuthorityPreflight({', jobPayload);
  const timeout = handler.indexOf('executionTimeoutSeconds: computePipelineExecutionTimeoutSeconds', jobPayload);
  const publish = handler.indexOf('await publishPreparedDispatch({', jobPayload);
  assert.ok(prepare > 0);
  assert.ok(lastSettlementBeforePayload > prepare);
  assert.ok(jobPayload > lastSettlementBeforePayload);
  assert.ok(timeout > jobPayload);
  assert.ok(publish > timeout);
  assert.match(handler.slice(lastSettlementBeforePayload, jobPayload), /if \(!authorityPreflight\.dispatchAllowed\)[\s\S]*return;/);
  assert.match(handler, /storyTimeoutStarted: false/);
});
