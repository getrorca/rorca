/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const root = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src')) ? path.resolve(process.cwd(), 'backend', 'src') : path.resolve(process.cwd(), 'src');
const route = fs.readFileSync(path.join(root, 'routes', 'pipeline.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker.ts'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'lib', 'pg-boss-schemas.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'db', 'pg-migrations', '20260719100000_governed_story_retry_attempts.sql'), 'utf8');
const retryLease = fs.readFileSync(path.join(root, 'lib', 'governed-retry-execution-lease.ts'), 'utf8');

function retryRoute(): string {
  const start = route.indexOf('export async function retryPipelineRunHandler');
  const end = route.indexOf("router.post('/runs/:runId/retry-merge'", start);
  return route.slice(start, end);
}

function retryWorker(): string {
  const start = worker.indexOf('async function handlePipelineRetry');
  const end = worker.indexOf('// ── Job handler: pipeline:cancel', start);
  return worker.slice(start, end);
}

test('route derives wave retry authority from all three durable evidence sources before preview', () => {
  const source = retryRoute();
  const completion = source.indexOf('FROM story_closeout_decisions');
  const ledger = source.indexOf('FROM story_integration_ledger');
  const closeout = source.indexOf('loadHostRunCloseoutEvidence');
  const derivation = source.indexOf('deriveAuthoritativeRetryScope');
  const preview = source.indexOf('createRetryPreview');
  assert.ok(completion > 0 && ledger > 0 && closeout > 0);
  assert.ok(derivation > completion && derivation > ledger && derivation > closeout);
  assert.ok(preview > derivation);
  assert.match(source, /carriedForward/);
});

test('route persists complete outbox and unique attempts before send and never supplies a pg-boss id', () => {
  const source = retryRoute();
  const outbox = source.indexOf('INSERT INTO governed_retry_dispatches');
  const attempts = source.indexOf('INSERT INTO governed_retry_story_attempts');
  const createQueue = source.lastIndexOf("boss.createQueue('pipeline:retry')");
  const send = source.lastIndexOf("boss.send('pipeline:retry'");
  assert.ok(outbox > 0 && attempts > outbox && createQueue > attempts && send > createQueue);
  assert.doesNotMatch(source.slice(send, send + 500), /\bid\s*:/);
  assert.match(source.slice(send, send + 500), /retryLimit: 5/);
  assert.match(source, /'outbox_ready'/);
  assert.match(source, /publishGovernedRetryDispatch/);
  assert.match(source, /Retry queue rejected durable outbox replay/);
  assert.doesNotMatch(source, /FROM pgboss\.|(?:INSERT|UPDATE|DELETE)[\s\S]{0,40}pgboss\./i);
});

test('strict queue payload carries the exact governed dispatch identity', () => {
  assert.match(schema, /dispatchIdentity: z\.record/);
  assert.match(retryRoute(), /createGovernedRetryDispatchIdentity/);
  assert.match(retryRoute(), /executionManifestHash/);
  assert.match(retryRoute(), /recoveryRefRevision/);
  assert.match(retryRoute(), /originalRunLineage/);
  assert.match(retryRoute(), /queuePayloadHash/);
});

test('worker validates identity, revisions, preview, manifest, and durable row before claiming execution', () => {
  const source = retryWorker();
  const identity = source.indexOf('verifyGovernedRetryDispatchIdentity');
  const publication = source.indexOf('publishGovernedRetryDispatch');
  const revisions = source.indexOf("execFileSync('git', ['rev-parse', dispatchIdentity.recoveryRef]");
  const manifest = source.indexOf("refuseBeforeClaim('retry_execution_manifest_changed')");
  const durableRead = source.indexOf('const persistedDispatch = await queryOne');
  const durableRefusal = source.indexOf("await refuseBeforeClaim('retry_durable_dispatch_identity_inconsistent')");
  const claim = source.indexOf('claimGovernedRetryExecutionLease');
  assert.ok(identity > 0 && publication > identity && revisions > publication && manifest > revisions);
  assert.ok(durableRead > manifest && durableRefusal > durableRead && claim > durableRefusal);
  assert.match(source.slice(durableRead, durableRefusal), /queue_payload_hash !== dispatchIdentity\.queuePayloadHash/);
  assert.doesNotMatch(source, /retry_preview_not_authorized/);
});

test('duplicate deliveries are fenced before agent start and leases renew while executing', () => {
  const source = retryWorker();
  const claim = source.indexOf('claimGovernedRetryExecutionLease');
  const duplicate = source.indexOf('duplicate retry delivery fenced before agent start');
  const executeFence = source.indexOf('markGovernedRetryLeaseExecuting');
  const spawn = source.indexOf('const child = spawn');
  assert.ok(claim > 0 && duplicate > claim && executeFence > duplicate && spawn > executeFence);
  assert.match(retryLease, /state\s*=\s*CASE WHEN state\s*=\s*'dispatched' THEN 'claimed' ELSE state END/);
  assert.match(retryLease, /fencing_token\s*=\s*CASE WHEN state\s*=\s*'dispatched' THEN fencing_token ELSE fencing_token\s*\+\s*1 END/);
  assert.match(retryLease, /lease_expires_at\s*=\s*NOW\(\)\s*\+\s*INTERVAL '5 minutes'/);
  assert.match(retryLease, /WHERE identity_hash=\$1 AND retry_run_id=\$3/);
  assert.match(source, /governed retry lease renewal lost its fence; terminating agent/);
  assert.match(source, /prior fenced engine process is still alive; duplicate start refused/);
  assert.match(source, /partial post-agent evidence requires manual review; duplicate agent start refused/);
  assert.match(source, /retry_reconciled_without_duplicate_agent/);
});

test('worker finalization is optimistic and prior evidence is never updated or deleted', () => {
  const source = retryWorker();
  assert.match(source, /failure finalization lost its fence/);
  assert.match(source, /dispatch finalization lost optimistic concurrency/);
  assert.match(source, /JOIN story_integration_ledger/);
  assert.match(source, /persistHostRunCloseout/);
  assert.doesNotMatch(source, /UPDATE\s+(?:wal_events|story_closeout_decisions|story_integration_ledger|story_commits)\b/i);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON governed_retry_carry_forward/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON governed_retry_attempt_events/);
});

test('worker replays queued wave finalization through its host-only canonical persistence seam before deriving terminal status', () => {
  const source = worker;
  assert.match(source, /replayWorkerFallbackResults/);
  assert.match(source, /persistCanonicalStoryResult/);
  assert.match(source, /WORKER_RESULT_AUTHORITY/);
  assert.match(source, /fallbackReplay\.atomicFinalizations > 0/);
  assert.match(source, /expectedRetryStoryIds\.every\(storyId => latest\.get\(storyId\) === 'pass'\)/);
  assert.doesNotMatch(source, /\/api\/pipeline\/story-result/);
  assert.doesNotMatch(source, /INSERT INTO story_results[\s\S]{0,400}integrationFinalization/);
});

test('migration owns no pg-boss tables and constrains one append-only identity per attempt', () => {
  assert.match(migration, /UNIQUE \(original_root_run_id, story_id, attempt\)/);
  assert.match(migration, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /lease_identity TEXT NOT NULL UNIQUE/);
  assert.match(migration, /finalization_identity TEXT UNIQUE/);
  assert.match(migration, /state_version BIGINT NOT NULL DEFAULT 1/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
});
