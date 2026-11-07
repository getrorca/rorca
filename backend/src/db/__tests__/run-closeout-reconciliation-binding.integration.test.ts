/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { runPgMigrations } from '../pg-index';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const migrationPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});
const runtimePool = new Pool({
  connectionString: resolveTestDatabaseUrl(),
  max: 1,
  options: '--search_path=rorca,public',
});
const RUN_ID = 20260316000550;
const PROTECTED_RUN_ID = 20260316000549;
const WORKSPACE_ID = `wave1-binding-${randomUUID()}`;
const PREVIEW_HASH = `sha256:${'a'.repeat(64)}`;
const BUILD_RECEIPT_HASH = `sha256:${'b'.repeat(64)}`;
const REQUEST_HASH = `sha256:${'c'.repeat(64)}`;
const AUTHORITY_HASH = `sha256:${'d'.repeat(64)}`;
const JOB_HASH = `sha256:${'e'.repeat(64)}`;

async function receipt(client: PoolClient, requester: string | null, targetHash = PREVIEW_HASH): Promise<string> {
  const id = randomUUID();
  await client.query(`
    INSERT INTO provider_human_authority_receipts (
      id,workspace_id,purpose,target_hash,issuer_id,key_id,key_fingerprint,
      provider,provider_tenant_id,actor_id,conversation_id,thread_id,message_id,
      occurred_at,normalized_command_hash,ingress_idempotency_key,attestation_hash,
      requester_actor_id,workspace_owner_verified
    ) VALUES ($1,$2,'run_closeout_reconciliation',$3,'issuer','key',$4,
      'slack','tenant','external-owner','conversation','thread',$5,statement_timestamp(),
      $3,$6,$7,$8,TRUE)
  `, [id, WORKSPACE_ID, targetHash, `sha256:${'f'.repeat(64)}`,
    randomUUID(), `binding:${randomUUID()}`, `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`, requester]);
  return id;
}

function insertSql(runId = RUN_ID): string {
  return `
    INSERT INTO pipeline_run_closeout_reconciliations (
      id,run_id,workspace_id,idempotency_key,request_hash,preview_hash,
      immutable_authority_hash,owner_receipt_id,requester_actor_id,rationale,
      required_fix_sha,build_sha,build_receipt_hash,preview_expires_at,state,
      boss_job_id,job_payload_hash,before_projection
    ) VALUES ($1,${runId},$2,$3,$4,$5,$6,$7,$8,
      'Independent owner approved exact closeout correction',
      'e0fbcff3dd227ef918da71e3b0fe8761ee79b6d1',$9,$10,
      statement_timestamp() + INTERVAL '1 hour','prepared',$11,$12,'{}'::jsonb)
  `;
}

beforeAll(async () => {
  await migrationPool.query('INSERT INTO workspaces(id,label,path) VALUES ($1,$1,$2)', [WORKSPACE_ID, process.cwd()]);
  await migrationPool.query(`
    INSERT INTO pipeline_runs(id,spec_path,workspace_id,status,lifecycle_status,summary,finished_at)
    VALUES ($1,'forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json',$2,
      'failed','failed','worker_closeout_failed',statement_timestamp())
  `, [RUN_ID, WORKSPACE_ID]);
});

afterAll(async () => {
  try {
    await migrationPool.query(
      'DELETE FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
      [RUN_ID, WORKSPACE_ID],
    );
    await migrationPool.query('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
  } finally {
    await Promise.all([migrationPool.end(), runtimePool.end()]);
  }
});

test('ordinary runtime cannot create a closeout migration fixture schema', async () => {
  const client = await runtimePool.connect();
  const schema = `runtime_closeout_probe_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await expect(client.query(`CREATE SCHEMA ${schema}`)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('exact migration 243 upgrades a genuine populated 242-shaped legacy fixture', async () => {
  const schema = `wave1_m242_${randomUUID().replaceAll('-', '')}`;
  const client = await migrationPool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE pipeline_runs (
      id BIGINT PRIMARY KEY,
      dispatch_fence TEXT
    )`);
    await client.query(`CREATE TABLE host_story_attempt_envelopes (
      envelope_id UUID PRIMARY KEY DEFAULT gen_random_uuid()
    )`);
    await client.query(`CREATE TABLE pipeline_run_release_intents (
      run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id)
    )`);
    await client.query(`CREATE TABLE schema_migrations (
      version BIGINT PRIMARY KEY,
      filename TEXT NOT NULL
    )`);
    const legacyVersions = await client.query<{ version: string; filename: string }>(`
      SELECT version::text, filename FROM public.schema_migrations
       WHERE version < 20260727125000 ORDER BY version LIMIT 242
    `);
    expect(legacyVersions.rows).toHaveLength(242);
    for (const row of legacyVersions.rows) {
      await client.query(`INSERT INTO schema_migrations(version,filename) VALUES($1,$2)`, [row.version, row.filename]);
    }
    const legacyFence = `sha256:${'7'.repeat(64)}`;
    await client.query('INSERT INTO pipeline_runs(id,dispatch_fence) VALUES(1,$1)', [legacyFence]);
    await client.query('INSERT INTO pipeline_run_release_intents(run_id) VALUES(1)');

    const migrationPath = path.resolve(__dirname, '../pg-migrations/20260727125000_wave1_authority_remediation3.sql');
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    await client.query(`INSERT INTO schema_migrations(version,filename)
      VALUES(20260727125000,'20260727125000_wave1_authority_remediation3.sql')`);

    const upgraded = await client.query<{
      migration_count: string;
      release_dispatch_fence: string;
      canonical_spec_column: boolean;
      run_spec_column: boolean;
    }>(`SELECT
      (SELECT COUNT(*)::text FROM schema_migrations) AS migration_count,
      (SELECT dispatch_fence FROM pipeline_run_release_intents WHERE run_id=1) AS release_dispatch_fence,
      EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='pipeline_runs' AND column_name='canonical_spec_revision') AS canonical_spec_column,
      EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='pipeline_runs' AND column_name='run_spec_revision') AS run_spec_column`,
    [schema]);
    expect(upgraded.rows[0]).toEqual({
      migration_count: '243',
      release_dispatch_fence: legacyFence,
      canonical_spec_column: true,
      run_spec_column: true,
    });
  } finally {
    await client.query('SET search_path TO rorca, public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
});

test('exact migration 245 keeps populated legacy-null success inert and installs immutable ledgers', async () => {
  const schema = `wave1_m244_${randomUUID().replaceAll('-', '')}`;
  const client = await migrationPool.connect();
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  const legacyEnvelopeId = randomUUID();
  const conflictId = randomUUID();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE pipeline_runs (id BIGINT PRIMARY KEY, dispatch_fence TEXT)`);
    await client.query(`CREATE TABLE pipeline_run_cancellation_requests (run_id BIGINT)`);
    await client.query(`CREATE TABLE governed_retry_dispatches (retry_run_id BIGINT, cancellation_requested_at TIMESTAMPTZ)`);
    await client.query(`CREATE TABLE host_story_attempt_envelopes (
      envelope_id UUID PRIMARY KEY, schema_version TEXT, workspace_id TEXT, run_id BIGINT,
      story_id TEXT, attempt INTEGER, launch_generation UUID, cancellation_fence TEXT,
      manifest_hash TEXT, spec_id TEXT, spec_revision TEXT, story_revision TEXT,
      canonical_spec_path TEXT, canonical_spec_revision TEXT, canonical_spec_bytes_hash TEXT,
      run_spec_path TEXT, run_spec_revision TEXT, run_spec_bytes_hash TEXT,
      repository_realpath TEXT, repository_identity TEXT, repository_remote TEXT,
      base_git_sha TEXT, expected_git_sha TEXT, observed_git_sha TEXT, expected_git_branch TEXT,
      worktree_realpath TEXT, worktree_identity TEXT, worktree_branch TEXT,
      runtime_identity JSONB, identity_hash TEXT, authority_state TEXT,
      outcome TEXT, outcome_provenance TEXT, exit_code INTEGER, exit_signal TEXT,
      launched_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, payload_hash TEXT, created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE host_story_attempt_conflicts (
      conflict_id UUID PRIMARY KEY, workspace_id TEXT, run_id BIGINT, story_id TEXT,
      attempt INTEGER, launch_generation UUID, existing_identity_hash TEXT,
      conflicting_identity_hash TEXT, reason_code TEXT, observed_payload JSONB,
      observed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE story_closeout_decisions (
      decision_id TEXT, workspace_id TEXT, run_id BIGINT, story_id TEXT,
      attempt INTEGER, manifest_hash TEXT, status TEXT
    )`);
    await client.query(`CREATE FUNCTION enforce_host_story_attempt_envelope_update()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`);
    await client.query(`CREATE TRIGGER trg_host_story_attempt_envelope_update
      BEFORE UPDATE OR DELETE ON host_story_attempt_envelopes
      FOR EACH ROW EXECUTE FUNCTION enforce_host_story_attempt_envelope_update()`);
    await client.query(`CREATE FUNCTION enforce_successful_host_attempt_for_story_closeout()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await client.query(`CREATE TRIGGER trg_story_closeout_requires_host_attempt
      BEFORE INSERT ON story_closeout_decisions
      FOR EACH ROW EXECUTE FUNCTION enforce_successful_host_attempt_for_story_closeout()`);
    const generation = randomUUID();
    await client.query(`INSERT INTO pipeline_runs(id,dispatch_fence) VALUES(1,$1)`, [hash('1')]);
    await client.query(`INSERT INTO host_story_attempt_envelopes (
      envelope_id,schema_version,workspace_id,run_id,story_id,attempt,launch_generation,
      cancellation_fence,manifest_hash,spec_id,spec_revision,story_revision,
      canonical_spec_path,run_spec_path,repository_realpath,repository_identity,
      base_git_sha,observed_git_sha,worktree_realpath,worktree_identity,worktree_branch,
      runtime_identity,identity_hash,authority_state,outcome,outcome_provenance,exit_code,
      launched_at,finished_at,payload_hash,created_at
    ) VALUES ($1,'rorca.host-story-attempt-envelope.v1','legacy-ws',1,'W1-LEGACY',1,$2,
      $3,$4,'legacy-spec',$5,$6,'forge/specs/approved/legacy.json','/run/legacy.json',
      '/repo',$7,$8,$8,'/repo',$9,'main','{}'::jsonb,$10,'valid','success',
      'host_process',0,statement_timestamp(),statement_timestamp(),$11,statement_timestamp())`, [
      legacyEnvelopeId, generation, hash('1'), hash('2'), hash('3'), hash('4'), hash('5'),
      'a'.repeat(40), hash('6'), hash('7'), hash('8'),
    ]);
    const migrationPath = path.resolve(__dirname, '../pg-migrations/20260727127000_wave1_authority_remediation5.sql');
    await client.query(fs.readFileSync(migrationPath, 'utf8'));

    const state = await client.query<{ validated: boolean; legacy_rows: string }>(`
      SELECT convalidated AS validated,
             (SELECT COUNT(*)::text FROM host_story_attempt_envelopes WHERE outcome='success') AS legacy_rows
        FROM pg_constraint WHERE conrelid='host_story_attempt_envelopes'::regclass
         AND conname='host_story_attempt_envelopes_complete_success_authority_check'
    `);
    expect(state.rows[0]).toEqual({ validated: false, legacy_rows: '1' });
    await expect(client.query(
      `UPDATE host_story_attempt_envelopes SET canonical_spec_revision=$2 WHERE envelope_id=$1`,
      [legacyEnvelopeId, hash('a')],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(`INSERT INTO story_closeout_decisions
      (decision_id,workspace_id,run_id,story_id,attempt,manifest_hash,status)
      VALUES('legacy-closeout','legacy-ws',1,'W1-LEGACY',1,$1,'accepted')`, [hash('2')]))
      .rejects.toMatchObject({ code: '23514' });
    // The accepted closeout refusal above is null-authority-only. Conflict
    // evidence is inserted afterward to independently exercise its append-only gate.
    await client.query(`INSERT INTO host_story_attempt_conflicts (
      conflict_id,workspace_id,run_id,story_id,attempt,launch_generation,
      conflicting_identity_hash,reason_code,observed_payload,observed_at
    ) VALUES($1,'legacy-ws',1,'W1-LEGACY',1,$2,$3,'payload_changed','{}'::jsonb,statement_timestamp())`,
    [conflictId, generation, hash('9')]);
    await expect(client.query(
      `UPDATE host_story_attempt_conflicts SET reason_code='stale_generation' WHERE conflict_id=$1`,
      [conflictId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query('DELETE FROM host_story_attempt_conflicts WHERE conflict_id=$1', [conflictId]))
      .rejects.toMatchObject({ code: '23514' });
    const preserved = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM host_story_attempt_conflicts WHERE conflict_id=$1', [conflictId],
    );
    expect(preserved.rows[0].count).toBe('1');
  } finally {
    await client.query('SET search_path TO rorca, public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
});

test('migration 243 remains idempotent when replayed over an already-shaped populated schema', async () => {
  const before = await migrationPool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM public.schema_migrations',
  );
  await migrationPool.query('DELETE FROM public.schema_migrations WHERE version = $1', [20260727125000]);
  await expect(runPgMigrations(migrationPool)).resolves.toBeUndefined();
  const after = await migrationPool.query<{ count: string; workspace: string }>(`
    SELECT (SELECT COUNT(*)::text FROM public.schema_migrations) AS count,
           (SELECT id FROM workspaces WHERE id = $1) AS workspace
  `, [WORKSPACE_ID]);
  expect(after.rows[0]).toEqual({ count: before.rows[0].count, workspace: WORKSPACE_ID });
  const functionBody = await migrationPool.query<{ definition: string }>(`
    SELECT pg_get_functiondef('enforce_successful_host_attempt_for_story_closeout()'::regprocedure) AS definition
  `);
  expect(functionBody.rows[0].definition).toContain('host_story_attempt_conflicts');
  const remediation3 = await migrationPool.query<{
    canonical_spec_revision: boolean;
    run_spec_revision: boolean;
    release_dispatch_fence: boolean;
  }>(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='pipeline_runs' AND column_name='canonical_spec_revision') AS canonical_spec_revision,
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='pipeline_runs' AND column_name='run_spec_revision') AS run_spec_revision,
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='pipeline_run_release_intents' AND column_name='dispatch_fence') AS release_dispatch_fence
  `);
  expect(remediation3.rows[0]).toEqual({
    canonical_spec_revision: true,
    run_spec_revision: true,
    release_dispatch_fence: true,
  });
});

test('canonical trigger denies Genesis first and accepts only exact null-safe owner binding', async () => {
  const client = await migrationPool.connect();
  await client.query('BEGIN');
  try {
    await client.query('SAVEPOINT protected_case');
    const protectedParams = [randomUUID(), WORKSPACE_ID, `binding-${randomUUID()}`, REQUEST_HASH,
      PREVIEW_HASH, AUTHORITY_HASH, randomUUID(), 'local-admin', 'a'.repeat(40),
      BUILD_RECEIPT_HASH, randomUUID(), JOB_HASH];
    await expect(client.query(insertSql(PROTECTED_RUN_ID), protectedParams)).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT protected_case');

    const mismatchTarget = `sha256:${'9'.repeat(64)}`;
    const mismatchedReceipt = await receipt(client, 'different-local-admin', mismatchTarget);
    await client.query('SAVEPOINT mismatch_case');
    await expect(client.query(insertSql(), [randomUUID(), WORKSPACE_ID, `binding-${randomUUID()}`,
      REQUEST_HASH, mismatchTarget, AUTHORITY_HASH, mismatchedReceipt, 'local-admin',
      'a'.repeat(40), BUILD_RECEIPT_HASH, randomUUID(), JOB_HASH])).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT mismatch_case');

    const matchingReceipt = await receipt(client, 'local-admin');
    const validParams = [randomUUID(), WORKSPACE_ID, `binding-${randomUUID()}`, REQUEST_HASH,
      PREVIEW_HASH, AUTHORITY_HASH, matchingReceipt, 'local-admin', 'a'.repeat(40),
      BUILD_RECEIPT_HASH, randomUUID(), JOB_HASH];
    await expect(client.query(insertSql(), validParams)).resolves.toMatchObject({ rowCount: 1 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
