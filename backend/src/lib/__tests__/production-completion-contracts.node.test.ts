/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { dispatchOutcome, replayDispositionForRunStatus } from '../hermes-dispatch-outcome';

const sourceRoot = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
  ? path.resolve(process.cwd(), 'backend', 'src')
  : path.resolve(process.cwd(), 'src');
const readSource = (...segments: string[]): string => fs.readFileSync(path.join(sourceRoot, ...segments), 'utf8');

test('Hermes dispatch outcomes distinguish new queueing, replay, terminal state, and refusal', () => {
  assert.deepEqual(dispatchOutcome({ disposition: 'queued', runId: 42, runStatus: 'queued', reasonCode: 'queued' }), {
    schemaVersion: 'rorca-dispatch-outcome.v1', disposition: 'queued', accepted: true,
    newlyQueued: true, replayed: false, runId: 42, runStatus: 'queued', retryable: false, reasonCode: 'queued',
  });
  assert.equal(dispatchOutcome({ disposition: 'conflict', reasonCode: 'scope_conflict' }).accepted, false);
  assert.equal(dispatchOutcome({ disposition: 'pending_publication', reasonCode: 'outbox_pending' }).retryable, true);
  assert.equal(replayDispositionForRunStatus('running'), 'running');
  assert.equal(replayDispositionForRunStatus('done'), 'terminal_success');
  assert.equal(replayDispositionForRunStatus('failed'), 'terminal_failure');
});

test('provider-human authority verifies exact target, freshness, tenant binding, signature, replay, and four-eyes before authority use', () => {
  const source = readSource('lib', 'provider-human-authority.ts');
  const target = source.indexOf('event.normalizedCommandHash !== input.targetHash');
  const distinct = source.indexOf('input.requireDistinctActor');
  const freshness = source.indexOf("Math.abs(now.getTime() - occurredAt) > 10 * 60_000");
  const binding = source.indexOf('candidate.providerTenantId === event.providerTenantId');
  const signature = source.indexOf('crypto.verify(null, message, publicKey, signature)');
  const lookup = source.indexOf('FROM provider_human_authority_receipts');
  const insert = source.indexOf('INSERT INTO provider_human_authority_receipts');
  assert.ok(target > 0 && distinct > target && binding > distinct && signature > binding && lookup > signature && freshness > lookup && insert > freshness);
  assert.match(source, /message_id = \$2/);
  assert.match(source, /already used for a different authority target/);
});

test('authoring persistence and approval are durable idempotent operations with separate canonical targets', () => {
  const mutations = readSource('lib', 'authoring-mutations.ts');
  const specs = readSource('routes', 'specs.ts');
  const specWriter = readSource('lib', 'spec-writer.ts');
  const migration = readSource('db', 'pg-migrations', '20260720145000_authoring_human_operation_authority.sql');
  assert.match(mutations, /authoring_mutation_operations/);
  assert.match(mutations, /request_hash/);
  assert.match(mutations, /receiptId/);
  assert.match(specs, /mutationReceipt/);
  assert.match(specs, /\/authoring\/preflight\/confirm/);
  assert.match(specs, /\/:specId\/approval-target/);
  assert.match(specs, /purpose: 'authoring_plan_confirmation'/);
  assert.match(specs, /purpose: 'spec_set_approval'/);
  assert.match(specs, /requireDistinctActor: \['high', 'critical'\]\.includes/);
  assert.match(specs, /authoringSpecMaterialHash/);
  assert.match(specs, /ensureAuthoringVersionSnapshot/);
  assert.match(specs, /authoring\/mutation-state/);
  assert.match(specWriter, /persist_after_spec_file_before_diagram/);
  assert.match(specs, /approve_after_rename/);
  assert.match(mutations, /readAuthoringMutationState/);
  assert.match(migration, /provider_human_authority_receipts/);
  assert.match(migration, /authoring_mutation_operations/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
});

test('strict post-save memory stage reports degradation instead of converting failure to success', () => {
  const memory = readSource('lib', 'auto-memory.ts');
  const handler = readSource('lib', 'spec-job-handlers.ts');
  assert.match(memory, /Promise<SpecMemorySynthesisResult>/);
  assert.match(memory, /success: false, saved: 0, reason: 'timeout'/);
  assert.match(memory, /success: false, saved: 0, reason: 'provider_or_storage_failure'/);
  assert.match(handler, /if \(!synthesis\.success\)/);
  assert.match(handler, /throw new Error\(`Required spec memory synthesis did not complete/);
});

test('TaskManifest source and provider-human authority bind tenant, manifest hash, immutable lineage, and canonical outcomes', () => {
  const manifest = readSource('lib', 'task-manifest.ts');
  const pipeline = readSource('routes', 'pipeline.ts');
  const version = readSource('routes', 'version.ts');
  const providerHuman = readSource('lib', 'provider-human-authority.ts');
  const providerMigration = readSource('db', 'pg-migrations', '20260722201500_task_manifest_provider_human_authority.sql');
  assert.match(manifest, /teamId: identifierString\('Slack team id'\)/);
  assert.match(pipeline, /assertProviderTenantWorkspaceBinding/);
  assert.match(pipeline, /dispatchOutcome\(/);
  assert.match(pipeline, /purpose: 'task_manifest_dispatch'/);
  assert.match(pipeline, /Internal services must relay the exact signed provider-human TaskManifest approval command/);
  assert.match(providerHuman, /'task_manifest_dispatch'/);
  assert.match(providerMigration, /provider_human_receipt_id/);
  assert.match(providerMigration, /receipt\.target_hash <> NEW\.manifest_hash/);
  assert.doesNotMatch(providerMigration, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
  assert.match(version, /resultContract: 'rorca-dispatch-outcome\.v1'/);
  assert.match(version, /sourceTenantBinding: 'slack-team-v1'/);
  assert.match(version, /humanAuthorityVersion: 'provider-human-event\.v1'/);
  assert.match(version, /serviceRelayRequiresProviderHuman: true/);
});
