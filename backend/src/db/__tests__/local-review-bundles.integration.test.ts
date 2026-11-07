/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { canonicalDeliveryJson, deliverySha256 } from '../../lib/delivery-adapter';
import type { LocalReviewBundleAdapter as LocalReviewBundleAdapterType } from '../../lib/local-review-bundle-adapter';
import { retryHash } from '../../lib/retry-governance';
import { deriveStoryContractRevision } from '../../lib/story-execution-packet';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import { resetDisposableWave1Database } from './wave1-test-cleanup';

const databaseUrl = resolveTestDatabaseUrl();
const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const workspaceId = `local-review-db-${randomUUID()}`;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = workspaceId;
const { LocalReviewBundleAdapter } = require('../../lib/local-review-bundle-adapter') as {
  LocalReviewBundleAdapter: typeof LocalReviewBundleAdapterType;
};
const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}`,
});
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 4,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}`,
});
const runId = 9_280_000 + Math.floor(Math.random() * 10_000);
const envelopeId = randomUUID();
const generation = randomUUID();
const fence = `sha256:${'1'.repeat(64)}`;
const executionManifestHash = `sha256:${'2'.repeat(64)}`;
let specRevision: string;
let storyRevision: string;
let bytesHash: string;
const repositoryIdentity = `sha256:${'6'.repeat(64)}`;
let worktreeIdentity: string;
let baseSha: string;
let headSha: string;
let fixtureRoot: string;
let repositoryPath: string;
let artifactRoot: string;
let createdBundleId: string;
const createdAt = new Date().toISOString();
const receiptId = randomUUID();
const attemptResultId = `ATR-sha256:${'a'.repeat(64)}`;
const closeoutDecisionId = `CLO-sha256:${'b'.repeat(64)}`;

function makeManifest(idempotencyKey = 'review:db:exact:one') {
  const draft = {
    schemaVersion: 'rorca.local-review-bundle.v1' as const,
    adapter: {
      contractVersion: 'rorca.delivery-adapter.v1' as const, adapterId: 'local-review-bundle', adapterVersion: '1.1.0',
      label: 'Local review bundle', kind: 'local' as const, default: true, optional: false,
      requiresNetwork: false, requiresCredentials: false, supportsReviewBundle: true,
      supportsExternalChangeRequest: false, implementationStatus: 'canonical_adapter' as const,
      mergeAuthority: 'none' as const, deploymentAuthority: 'none' as const,
    },
    idempotencyKey,
    identity: {
      workspaceId, specId: 'spec-one', storyId: 'US-001', runId, attempt: 1,
      generation, hostAttemptEnvelopeId: envelopeId,
    },
    specification: {
      canonicalPath: 'forge/specs/approved/spec-one.json', revision: specRevision,
      bytesHash, storyRevision, executionManifestHash,
    },
    repository: {
      repositoryIdentity, repositoryPathDigest: `sha256:${'d'.repeat(64)}`,
      worktreeIdentity, worktreePathDigest: `sha256:${'e'.repeat(64)}`,
      runBaseSha: baseSha, baseSha, headSha, branch: 'main',
    },
    changedFiles: [],
    artifacts: [{ name: 'changes.patch' as const, mediaType: 'text/x-diff' as const, bytes: 0, sha256: `sha256:${'f'.repeat(64)}` }],
    validation: {
      status: 'passed' as 'blocked' | 'passed', authoredBy: 'host_closeout' as 'none' | 'host_closeout',
      receipts: [{
        receiptId, gate: 'execution-engine', checkpointSha: headSha,
        evidenceDigest: `sha256:${'c'.repeat(64)}`, passedAt: createdAt,
        expiresAt: '2099-01-01T00:00:00.000Z', revoked: false, trustClass: 'host_observed',
      }],
      agentProseAccepted: false, ptyAccepted: false, processExitAcceptedAsPass: false, memoryAccepted: false,
    },
    evidenceReferences: [],
    createdAt,
    delivery: {
      reviewStatus: 'awaiting_local_review' as const, mergeStatus: 'not_authorized' as const,
      deploymentStatus: 'not_authorized' as const, mergeAuthority: 'none' as const, deploymentAuthority: 'none' as const,
    },
  };
  const contentBasis = canonicalDeliveryJson(draft);
  const contentHash = deliverySha256(contentBasis);
  return { ...draft, bundleId: `lrb-${contentHash.slice(7)}`, contentHash };
}

function bundleInsert(
  manifest: ReturnType<typeof makeManifest>,
  actor = 'local-admin',
  requestOverride?: unknown,
) {
  const requestBytes = canonicalDeliveryJson(requestOverride ?? {
    contractVersion: 'rorca.delivery-adapter.v1', adapterId: 'local-review-bundle', adapterVersion: '1.1.0',
    workspaceId, runId, storyId: manifest.identity.storyId, attempt: 1, generation,
    hostAttemptEnvelopeId: envelopeId, requestedBy: actor,
  });
  const { bundleId: _bundleId, contentHash: _contentHash, ...draft } = manifest;
  const contentBasis = canonicalDeliveryJson(draft);
  const manifestBytes = canonicalDeliveryJson(manifest);
  const digest = manifest.contentHash.slice(7);
  return {
    sql: `
      INSERT INTO local_review_bundles (
        bundle_id,contract_version,schema_version,adapter_id,adapter_version,
        workspace_id,spec_id,story_id,run_id,attempt,launch_generation,
        host_attempt_envelope_id,idempotency_key,request_hash,request_bytes,content_hash,
        manifest_hash,content_basis_bytes,manifest_bytes,projection_key,manifest_json,validation_status,
        merge_status,deployment_status,created_by,created_at,finalized_at
      ) VALUES(
        $1,'rorca.delivery-adapter.v1','rorca.local-review-bundle.v1','local-review-bundle','1.1.0',
        $2,'spec-one','US-001',$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        $14::jsonb,$15,'not_authorized','not_authorized',$16,$17,$17
      )`,
    params: [
      manifest.bundleId, workspaceId, runId, generation, envelopeId, manifest.idempotencyKey,
      deliverySha256(requestBytes), Buffer.from(requestBytes), manifest.contentHash,
      deliverySha256(manifestBytes), Buffer.from(contentBasis), Buffer.from(manifestBytes),
      `sha256/${digest.slice(0, 2)}/${digest}`, JSON.stringify(manifest), manifest.validation.status,
      actor, manifest.createdAt,
    ],
  };
}

beforeAll(async () => {
  fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-local-proof-db-')));
  repositoryPath = path.join(fixtureRoot, 'repository');
  artifactRoot = path.join(fixtureRoot, 'artifacts');
  fs.mkdirSync(repositoryPath);
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repositoryPath, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  git(['init', '-b', 'main']);
  const story = { id: 'US-001', title: 'Synthetic local delivery proof', description: 'No provider authority' };
  const spec = { id: 'spec-one', userStories: [story], approvalReady: false, executionAuthority: 'none' };
  const specBytes = Buffer.from(`${JSON.stringify(spec)}\n`);
  fs.mkdirSync(path.join(repositoryPath, 'forge/specs/approved'), { recursive: true });
  fs.mkdirSync(path.join(repositoryPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repositoryPath, 'forge/specs/approved/spec-one.json'), specBytes);
  fs.writeFileSync(path.join(repositoryPath, 'src/value.txt'), 'before\n');
  git(['add', '.']);
  git(['-c', 'user.name=Test Host', '-c', 'user.email=host@rorca.test', 'commit', '-m', 'synthetic base']);
  baseSha = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repositoryPath, 'src/value.txt'), 'after\n');
  git(['add', 'src/value.txt']);
  git(['-c', 'user.name=Test Host', '-c', 'user.email=host@rorca.test', 'commit', '-m', 'synthetic story change']);
  headSha = git(['rev-parse', 'HEAD']);
  specRevision = deriveStoryContractRevision(spec);
  storyRevision = deriveStoryContractRevision(story);
  bytesHash = deliverySha256(specBytes);
  const stat = fs.statSync(repositoryPath);
  worktreeIdentity = retryHash({ realpath: repositoryPath, device: String(stat.dev), inode: String(stat.ino) });

  await ownerPool.query('INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2)', [workspaceId, repositoryPath]);
  await ownerPool.query(`
    INSERT INTO pipeline_runs (
      id,spec_path,workspace_id,status,branch_name,worktree_path,
      execution_workspace_path,execution_worktree_path,dispatch_fence,
      canonical_spec_revision,canonical_spec_bytes_hash,run_spec_path,run_spec_revision,run_spec_bytes_hash
    ) VALUES($1,'forge/specs/approved/spec-one.json',$2,'starting','main',$3,$3,$3,$4,$5,$6,$7,$5,$6)
  `, [runId, workspaceId, repositoryPath, fence, specRevision, bytesHash,
    path.join(repositoryPath, 'forge/specs/approved/spec-one.json')]);
  await ownerPool.query(`
    INSERT INTO story_execution_manifests (
      manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,
      spec_revision,story_revision,payload
    ) VALUES($1,'rorca.story-execution-manifest.v2',$2,'spec-one',$3,'US-001',1,$4,$5,'{}'::jsonb)
  `, [executionManifestHash, workspaceId, runId, specRevision, storyRevision]);
  await ownerPool.query(`
    INSERT INTO host_story_attempt_envelopes (
      envelope_id,schema_version,workspace_id,run_id,story_id,attempt,launch_generation,
      cancellation_fence,manifest_hash,spec_id,spec_revision,story_revision,
      canonical_spec_path,canonical_spec_revision,canonical_spec_bytes_hash,
      run_spec_path,run_spec_revision,run_spec_bytes_hash,
      repository_realpath,repository_identity,base_git_sha,expected_git_sha,observed_git_sha,
      expected_git_branch,worktree_realpath,worktree_identity,worktree_branch,runtime_identity,
      identity_hash,payload_hash,outcome,outcome_provenance,exit_code,finished_at
    ) VALUES(
      $1,'rorca.host-story-attempt-envelope.v1',$2,$3,'US-001',1,$4,$5,$6,'spec-one',$7,$8,
      'forge/specs/approved/spec-one.json',$7,$9,$10,$7,$9,$11,$12,$13::char(40),$14::text,$14::char(40),
      'main',$11,$15,'main',$16::jsonb,$17,$18,'success','host_process',0,$19::timestamptz
    )
  `, [
    envelopeId, workspaceId, runId, generation, fence, executionManifestHash, specRevision,
    storyRevision, bytesHash, path.join(repositoryPath, 'forge/specs/approved/spec-one.json'), repositoryPath,
    repositoryIdentity, baseSha, baseSha, worktreeIdentity,
    JSON.stringify({ processRole: 'worker-engine', processPid: 1 }),
    `sha256:${'0'.repeat(64)}`, `sha256:${'1'.repeat(64)}`, createdAt,
  ]);
  await ownerPool.query(`
    INSERT INTO story_attempt_results(
      attempt_result_id,manifest_hash,workspace_id,spec_id,run_id,story_id,attempt,payload,created_at
    ) VALUES($1,$2,$3,'spec-one',$4,'US-001',1,'{}'::jsonb,$5)
  `, [attemptResultId, executionManifestHash, workspaceId, runId, createdAt]);
  await ownerPool.query(`
    INSERT INTO story_closeout_decisions(
      decision_id,manifest_hash,attempt_result_id,workspace_id,spec_id,run_id,story_id,attempt,status,payload,created_at
    ) VALUES($1,$2,$3,$4,'spec-one',$5,'US-001',1,'accepted','{}'::jsonb,$6)
  `, [closeoutDecisionId, executionManifestHash, attemptResultId, workspaceId, runId, createdAt]);
  const result = await ownerPool.query<{ id: number }>(`
    INSERT INTO story_results(
      run_id,story_id,status,finished_at,worktree_path,spec_id,spec_revision,story_revision,
      manifest_hash,closeout_decision_id,integrated,commit_sha,commit_message,commit_author,
      commit_branch,commit_observed_source,accounting_required,finished_at_source,
      result_provenance,result_source
    ) VALUES($1,'US-001','pass',$2,$3,'spec-one',$4,$5,$6,$7,TRUE,$8,
      'exact local proof','rorca-execution-engine','main','worktree_branch',FALSE,'database','host','execution-engine')
    RETURNING id
  `, [runId, createdAt, repositoryPath, specRevision, storyRevision,
    executionManifestHash, closeoutDecisionId, headSha]);
  await ownerPool.query(`
    INSERT INTO story_commits(story_id,spec_id,workspace_id,commit_sha,commit_message,author,run_id,branch_name,observed_source)
    VALUES('US-001','spec-one',$1,$2,'exact local proof','rorca-execution-engine',$3,'main','worktree_branch')
  `, [workspaceId, headSha, runId]);
  await ownerPool.query(`
    INSERT INTO checkpoint_validation_attestations(
      id,workspace_id,run_id,story_id,branch_name,checkpoint_sha,validation_gate,evidence_digest,passed_at,expires_at
    ) VALUES($1,$2,$3,'US-001','main',$4,'execution-engine',$5,$6,'2099-01-01T00:00:00.000Z')
  `, [receiptId, workspaceId, runId, headSha, 'c'.repeat(64), createdAt]);
  const closeout = await ownerPool.query<{ id: number }>(`
    INSERT INTO wal_events(
      event_type,workspace_id,spec_id,actor,payload,ingest_key,trust_provenance,trusted_source,
      canonical_run_id,event_identity_hash,outbox_ready_at
    ) VALUES('run_closeout',$1,'spec-one','worker','{}'::jsonb,$2,'host','worker',$3,$4,statement_timestamp())
    RETURNING id
  `, [workspaceId, `local-proof-closeout-${runId}`, runId, 'd'.repeat(64)]);
  await ownerPool.query('UPDATE pipeline_runs SET host_closeout_event_id=$2 WHERE id=$1', [runId, closeout.rows[0].id]);
  expect(result.rows[0].id).toBeGreaterThan(0);
});

afterAll(async () => {
  await resetDisposableWave1Database(ownerPool);
  await Promise.all([pool.end(), ownerPool.end()]);
  if (fixtureRoot) {
    const makeWritable = (candidate: string): void => {
      if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) return;
      fs.chmodSync(candidate, fs.lstatSync(candidate).isDirectory() ? 0o700 : 0o600);
      if (fs.lstatSync(candidate).isDirectory()) {
        for (const child of fs.readdirSync(candidate)) makeWritable(path.join(candidate, child));
      }
    };
    makeWritable(fixtureRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('runtime is the exact scoped non-owner and cannot acquire maintenance authority', async () => {
  const authority = await pool.query<{
    current_user: string;
    table_owner: string;
    principal_class: string;
    can_truncate: boolean;
  }>(`SELECT current_user,
      (SELECT tableowner FROM pg_tables WHERE schemaname='rorca' AND tablename='local_review_bundles') table_owner,
      (SELECT principal_class FROM wave2_database_principals WHERE database_user=current_user) principal_class,
      has_table_privilege(current_user,'rorca.local_review_bundles','TRUNCATE') can_truncate`);
  expect(authority.rows[0]).toMatchObject({ principal_class: 'internal_runtime', can_truncate: false });
  expect(authority.rows[0].current_user).not.toBe(authority.rows[0].table_owner);
  await expect(pool.query('TRUNCATE local_review_bundles CASCADE')).rejects.toMatchObject({ code: '42501' });
  await expect(pool.query(
    'ALTER TABLE local_review_bundles DISABLE TRIGGER trg_local_review_bundles_no_truncate',
  )).rejects.toMatchObject({ code: '42501' });
});

test('disposable synthetic adapter proof finalizes exact bytes concurrently without provider, merge, deploy, or approval authority', async () => {
  const request = {
    workspaceId, runId, storyId: 'US-001', attempt: 1, generation,
    hostAttemptEnvelopeId: envelopeId, idempotencyKey: 'review:db:exact:one', requestedBy: 'local-admin',
  };
  const [first, second] = await Promise.all([
    new LocalReviewBundleAdapter({ artifactRoot }).create(request),
    new LocalReviewBundleAdapter({ artifactRoot }).create(request),
  ]);
  expect(new Set([first.manifest.bundleId, second.manifest.bundleId])).toHaveProperty('size', 1);
  expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  expect(first.manifest.changedFiles).toEqual([
    expect.objectContaining({ path: 'src/value.txt', change: 'modified' }),
  ]);
  expect(first.manifest.validation).toMatchObject({ status: 'passed', authoredBy: 'host_closeout' });
  expect(first.manifest.delivery).toEqual({
    reviewStatus: 'awaiting_local_review', mergeStatus: 'not_authorized', deploymentStatus: 'not_authorized',
    mergeAuthority: 'none', deploymentAuthority: 'none',
  });
  createdBundleId = first.manifest.bundleId;
  const restarted = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}`,
  });
  try {
    const row = await restarted.query('SELECT bundle_id,merge_status,deployment_status,local_review_bundle_is_current(bundle_id) AS current FROM local_review_bundles');
    expect(row.rows[0]).toMatchObject({ merge_status: 'not_authorized', deployment_status: 'not_authorized', current: true });
  } finally {
    await restarted.end();
  }
  await expect(ownerPool.query("UPDATE local_review_bundles SET validation_status='passed'"))
    .rejects.toMatchObject({ code: '23514' });
  await expect(ownerPool.query('DELETE FROM local_review_bundles')).rejects.toMatchObject({ code: '23514' });
  await expect(ownerPool.query('TRUNCATE local_review_bundles CASCADE')).rejects.toMatchObject({ code: '23514' });

  const badProjection = makeManifest('review:db:bad:projection');
  const badInsert = bundleInsert(badProjection);
  badInsert.params[12] = `sha256/00/${badProjection.contentHash.slice(7)}`;
  await expect(ownerPool.query(badInsert.sql, badInsert.params)).rejects.toMatchObject({ code: '23514' });
});

test('malformed, partial, wrong-type, and wrong-identity request/manifest JSON fail closed', async () => {
  const validRequest = {
    contractVersion: 'rorca.delivery-adapter.v1', adapterId: 'local-review-bundle', adapterVersion: '1.1.0',
    workspaceId, runId, storyId: 'US-001', attempt: 1, generation,
    hostAttemptEnvelopeId: envelopeId, requestedBy: 'local-admin',
  };
  const invalidRequests: Array<[string, unknown]> = [
    ['empty', {}],
    ['partial', { ...validRequest, requestedBy: undefined }],
    ['wrong-run-type', { ...validRequest, runId: String(runId) }],
    ['wrong-actor', { ...validRequest, requestedBy: 'different-admin' }],
    ['wrong-attempt', { ...validRequest, attempt: 2 }],
    ['wrong-generation', { ...validRequest, generation: randomUUID() }],
    ['wrong-envelope', { ...validRequest, hostAttemptEnvelopeId: randomUUID() }],
    ['wrong-adapter', { ...validRequest, adapterId: 'other-adapter' }],
    ['wrong-version', { ...validRequest, adapterVersion: '9.9.9' }],
    ['wrong-contract', { ...validRequest, contractVersion: 'rorca.delivery-adapter.v0' }],
    ['unknown-key', { ...validRequest, unexpected: true }],
  ];
  for (const [label, invalidRequest] of invalidRequests) {
    const candidate = makeManifest(`review:db:request:${label}`);
    const insert = bundleInsert(candidate, 'local-admin', invalidRequest);
    await expect(ownerPool.query(insert.sql, insert.params)).rejects.toMatchObject({ code: '23514' });
  }

  const malformed = makeManifest('review:db:malformed');
  const malformedInsert = bundleInsert(malformed);
  malformedInsert.params[13] = JSON.stringify({});
  malformedInsert.params[11] = Buffer.from('{}\n');
  malformedInsert.params[9] = deliverySha256('{}\n');
  await expect(ownerPool.query(malformedInsert.sql, malformedInsert.params)).rejects.toMatchObject({ code: '23514' });

  const nestedMutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['top-unknown', (value) => { value.unexpected = true; }],
    ['adapter-unknown', (value) => { value.adapter.unexpected = true; }],
    ['adapter-status', (value) => { value.adapter.implementationStatus = 'legacy_optional_surfaces'; }],
    ['changed-change', (value) => { value.changedFiles = [{ path: 'src/value.txt', change: 7, before: null, after: { bytes: 1, sha256: `sha256:${'a'.repeat(64)}` } }]; }],
    ['changed-snapshot', (value) => { value.changedFiles = [{ path: 'src/value.txt', change: 'modified', before: { bytes: '1', sha256: 'bad' }, after: null }]; }],
    ['artifact-extra', (value) => { value.artifacts[0].unexpected = true; }],
    ['artifact-size', (value) => { value.artifacts[0].bytes = 8388609; }],
    ['receipt-extra', (value) => { value.validation.receipts[0].unexpected = true; }],
    ['receipt-type', (value) => { value.validation.receipts[0].revoked = 'false'; }],
    ['evidence-extra', (value) => { value.evidenceReferences = [{ kind: 'host_attempt', reference: envelopeId, digest: null, trustClass: 'host_observed', unexpected: true }]; }],
    ['unsafe-path', (value) => { value.changedFiles = [{ path: '.env', change: 'added', before: null, after: { bytes: 1, sha256: `sha256:${'a'.repeat(64)}` } }]; }],
  ];
  for (const [label, mutate] of nestedMutations) {
    const candidate = makeManifest(`review:db:nested:${label}`) as unknown as Record<string, any>;
    mutate(candidate);
    const { bundleId: _oldBundle, contentHash: _oldHash, ...draft } = candidate;
    const contentHash = deliverySha256(canonicalDeliveryJson(draft));
    candidate.contentHash = contentHash;
    candidate.bundleId = `lrb-${contentHash.slice(7)}`;
    const insert = bundleInsert(candidate as ReturnType<typeof makeManifest>);
    await expect(ownerPool.query(insert.sql, insert.params)).rejects.toMatchObject({ code: '23514' });
  }

  await ownerPool.query(`
    INSERT INTO local_review_bundle_conflicts(
      workspace_id,adapter_id,idempotency_key,existing_request_hash,conflicting_request_hash,reason_code,observed_by
    ) SELECT workspace_id,adapter_id,idempotency_key,request_hash,$2,'changed_replay','test-admin'
        FROM local_review_bundles WHERE workspace_id=$1
  `, [workspaceId, `sha256:${'d'.repeat(64)}`]);
  await expect(ownerPool.query('DELETE FROM local_review_bundle_conflicts WHERE workspace_id=$1', [workspaceId]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(ownerPool.query('TRUNCATE local_review_bundle_conflicts')).rejects.toMatchObject({ code: '23514' });

  const beforeForgery = await pool.query<{ exact: boolean }>(
    'SELECT local_review_bundle_exact_pass_authority($1,$2,$3) AS exact', [envelopeId, createdAt, headSha],
  );
  expect(beforeForgery.rows[0].exact).toBe(true);
  await ownerPool.query(`
    INSERT INTO story_results(
      run_id,story_id,status,finished_at,worktree_path,spec_id,spec_revision,story_revision,
      manifest_hash,closeout_decision_id,finished_at_source,result_provenance,result_source
    ) VALUES($1,'US-001','fail',$2,$3,'spec-one',$4,$5,$6,$7,'database','host','worker')
  `, [runId, createdAt, repositoryPath, specRevision, storyRevision,
    executionManifestHash, closeoutDecisionId]);
  const afterForgery = await pool.query<{ exact: boolean; current: boolean }>(`
    SELECT local_review_bundle_exact_pass_authority($1,$2,$3) AS exact,
           local_review_bundle_is_current($4) AS current
  `, [envelopeId, createdAt, headSha, createdBundleId]);
  expect(afterForgery.rows[0]).toEqual({ exact: false, current: false });
});

test('populated partial canonical/run-spec authority cannot project or insert passed', async () => {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE pipeline_runs
         SET canonical_spec_revision=NULL, canonical_spec_bytes_hash=NULL, run_spec_bytes_hash=NULL
       WHERE id=$1
    `, [runId]);
    const exact = await client.query<{ exact: boolean }>(
      'SELECT local_review_bundle_exact_pass_authority($1,$2,$3) AS exact', [envelopeId, createdAt, headSha],
    );
    expect(exact.rows[0].exact).toBe(false);
    const candidate = makeManifest('review:db:partial-upgrade');
    const insert = bundleInsert(candidate);
    await expect(client.query(insert.sql, insert.params)).rejects.toMatchObject({ code: '23514' });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test.each([
  ['host conflict', 'host_conflict'],
  ['dispatch fence change', 'dispatch_fence_changed'],
  ['retry cancellation', 'retry_cancellation_requested'],
  ['receipt revocation', 'validation_receipt_revoked'],
] as const)('post-finalization %s durably disqualifies exact pass authority', async (scenario, reasonCode) => {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    if (scenario === 'host conflict') {
      await client.query(`
        INSERT INTO host_story_attempt_conflicts(
          workspace_id,run_id,story_id,attempt,launch_generation,
          existing_identity_hash,conflicting_identity_hash,reason_code,observed_payload
        ) VALUES($1,$2,'US-001',1,$3,$4,$5,'payload_changed','{}'::jsonb)
      `, [workspaceId, runId, generation, `sha256:${'0'.repeat(64)}`, `sha256:${'9'.repeat(64)}`]);
    } else if (scenario === 'dispatch fence change') {
      await client.query('UPDATE pipeline_runs SET dispatch_fence=$2 WHERE id=$1', [runId, `sha256:${'8'.repeat(64)}`]);
    } else if (scenario === 'receipt revocation') {
      await client.query('UPDATE checkpoint_validation_attestations SET revoked_at=statement_timestamp() WHERE id=$1', [receiptId]);
    } else {
      const previewHash = `sha256:${'4'.repeat(64)}`;
      const identityHash = `sha256:${'5'.repeat(64)}`;
      await client.query(`
        INSERT INTO pipeline_retry_previews(
          preview_hash,original_run_id,retry_run_id,workspace_id,scope_hash,status,packet
        ) VALUES($1,$2,$2,$3,$4,'previewed','{}'::jsonb)
      `, [previewHash, runId, workspaceId, `sha256:${'6'.repeat(64)}`]);
      await client.query(`
        INSERT INTO governed_retry_dispatches(
          identity_hash,workspace_id,spec_id,spec_revision,original_run_id,retry_run_id,
          original_run_lineage,base_revision,integrated_revision,prior_integration_ancestry,
          recovery_ref,recovery_ref_revision,preview_hash,scope_hash,evidence_hash,
          execution_manifest_hash,queue_payload_hash,job_payload,queue_name,idempotency_key,
          lease_identity,state
        ) VALUES($1,$2,'spec-one',$3,$4,$4,'[]'::jsonb,$5,$5,'[]'::jsonb,
          'refs/rorca/retry/test',$5,$6,$7,$8,$9,$10,'{}'::jsonb,'pipeline:retry',$11,$12,'prepared')
      `, [identityHash, workspaceId, specRevision, runId, baseSha, previewHash,
        `sha256:${'6'.repeat(64)}`, `sha256:${'7'.repeat(64)}`, executionManifestHash,
        `sha256:${'8'.repeat(64)}`, `retry-local-review-${runId}`, `sha256:${'9'.repeat(64)}`]);
      await client.query(`
        UPDATE governed_retry_dispatches
           SET cancellation_requested_at=statement_timestamp(), cancellation_request='{}'::jsonb
         WHERE identity_hash=$1
      `, [identityHash]);
    }
    const result = await client.query(`
      SELECT local_review_bundle_is_current(bundle_id) AS current,
             (SELECT COUNT(*)::int FROM local_review_bundle_disqualifications d
               WHERE d.bundle_id=b.bundle_id AND d.reason_code=$2) AS disqualifications
        FROM local_review_bundles b WHERE workspace_id=$1
    `, [workspaceId, reasonCode]);
    expect(result.rows[0]).toEqual({ current: false, disqualifications: 1 });
    const exact = await client.query<{ exact: boolean }>(
      'SELECT local_review_bundle_exact_pass_authority($1,$2,$3) AS exact', [envelopeId, createdAt, headSha],
    );
    expect(exact.rows[0].exact).toBe(false);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('non-destructive maintenance ledger accepts bounded staging identity and remains immutable', async () => {
  const digest = '7'.repeat(64);
  const projectionKey = `staging/sha256/${digest}`;
  await ownerPool.query(`
    INSERT INTO local_review_projection_gc_actions(
      projection_key,content_hash,action_type,reason_code,observed_by,detail_code
    ) VALUES($1,$2,'retained','staging_restart_recovery','db-maintenance-test','operator_maintenance_required')
  `, [projectionKey, `sha256:${digest}`]);
  const row = await pool.query(`
    SELECT projection_key,action_type,reason_code,detail_code
      FROM local_review_projection_gc_actions WHERE projection_key=$1
  `, [projectionKey]);
  expect(row.rows[0]).toEqual({
    projection_key: projectionKey,
    action_type: 'retained',
    reason_code: 'staging_restart_recovery',
    detail_code: 'operator_maintenance_required',
  });
  await expect(ownerPool.query(`
    INSERT INTO local_review_projection_gc_actions(
      projection_key,content_hash,action_type,reason_code,observed_by
    ) VALUES('/tmp/attacker-path',$1,'retained','staging_restart_recovery','db-maintenance-test')
  `, [`sha256:${digest}`])).rejects.toMatchObject({ code: '23514' });
  await expect(ownerPool.query(`
    UPDATE local_review_projection_gc_actions SET detail_code='changed' WHERE projection_key=$1
  `, [projectionKey])).rejects.toMatchObject({ code: '23514' });
  await expect(ownerPool.query('TRUNCATE local_review_projection_gc_actions')).rejects.toMatchObject({ code: '23514' });
});

test('post-finalization cancellation appends relational disqualification and makes reads non-current', async () => {
  await ownerPool.query(`
    INSERT INTO pipeline_run_cancellation_requests(run_id,workspace_id,requested_by,reason)
    VALUES($1,$2,'test-admin','adversarial cancellation')
  `, [runId, workspaceId]);
  const result = await pool.query(`
    SELECT local_review_bundle_is_current(bundle_id) AS current,
           (SELECT COUNT(*)::int FROM local_review_bundle_disqualifications d
             WHERE d.bundle_id=b.bundle_id AND d.reason_code='cancellation_requested') AS disqualifications
      FROM local_review_bundles b WHERE workspace_id=$1
  `, [workspaceId]);
  expect(result.rows[0]).toEqual({ current: false, disqualifications: 1 });
});
