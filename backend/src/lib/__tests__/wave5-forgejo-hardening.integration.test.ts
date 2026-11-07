/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A3 hardening verification against the REAL migrated schema:
 *   * RLS cross-workspace denial: workspace B (runtime/writer principals)
 *     cannot read/update workspace A rows on the three Forgejo tables;
 *   * PUBLIC/authenticated/anon revocation;
 *   * immutability trigger rejection on the federation ledger and the
 *     terminal status-projection identity.
 */
import { Pool } from 'pg';

const ownerUrl = process.env.RORCA_MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!ownerUrl || !runtimeUrl || !writerUrl) throw new Error('wave5 hardening requires isolated owner, runtime, and writer URLs');

const WORKSPACE_A = 'workspace:hardening-a';
const WORKSPACE_B = 'workspace:hardening-b';
const BINDING_ID = '20000000-0000-4000-8000-000000000001';
const PROPOSAL_ID = 'proposal:hardening';

const ownerPool = new Pool({ connectionString: ownerUrl,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${WORKSPACE_A}` });
const runtimeA = new Pool({ connectionString: runtimeUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${WORKSPACE_A}` });
const runtimeB = new Pool({ connectionString: runtimeUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${WORKSPACE_B}` });
const writerA = new Pool({ connectionString: writerUrl,
  options: `--search_path=rorca_canonical_api,rorca,public -c rorca.workspace_id=${WORKSPACE_A}` });

let statusRunWalId = 0;

beforeAll(async () => {
  await ownerPool.query(`INSERT INTO workspaces (id, label, path) VALUES ($1,'A','/tmp/a'),($2,'B','/tmp/b')
    ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`, [WORKSPACE_A, WORKSPACE_B]);
  await ownerPool.query(`INSERT INTO forgejo_workspace_credentials (
      id, workspace_id, instance_url, repo_owner, repo_name, token_digest, scope_profile,
      status, credential_version, key_version, created_by
    ) VALUES ($1,$2,'https://forgejo.example.test','acme','widgets','sha256:'||repeat('0',64),
      '{"schemaVersion":"rorca.forgejo-capability-profile.v1"}'::jsonb,'active',1,1,'test')
    ON CONFLICT (id) DO NOTHING`, [BINDING_ID, WORKSPACE_A]);
  await ownerPool.query(`INSERT INTO forgejo_federation_projections (
      proposal_id, workspace_id, proposal_hash, head_sha, status, idempotency_key
    ) VALUES ($1,$2,'sha256:'||repeat('a',64),repeat('a',40),'projected','key:hardening')
    ON CONFLICT (proposal_id) DO NOTHING`, [PROPOSAL_ID, WORKSPACE_A]);
  await ownerPool.query(`INSERT INTO pipeline_runs (id, spec_path, workspace_id, status)
    VALUES (9000001, 'forge/specs/pending/h.json', $1, 'done')
    ON CONFLICT (id) DO NOTHING`, [WORKSPACE_A]);
  const wal = await ownerPool.query<{ id: number }>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, payload)
     VALUES ('run_started', $1, 'spec:h', '{}'::jsonb) RETURNING id`, [WORKSPACE_A]);
  statusRunWalId = wal.rows[0].id;
});

afterAll(async () => {
  await Promise.all([ownerPool.end(), runtimeA.end(), runtimeB.end(), writerA.end()]);
});

describe('Wave 5 Forgejo RLS hardening (A3)', () => {
  test('runtime principal in workspace B cannot read workspace A rows', async () => {
    const rows = await runtimeB.query(
      `SELECT id FROM forgejo_workspace_credentials WHERE workspace_id = $1`, [WORKSPACE_A]);
    expect(rows.rows).toHaveLength(0);
    const projections = await runtimeB.query(
      `SELECT proposal_id FROM forgejo_federation_projections WHERE workspace_id = $1`, [WORKSPACE_A]);
    expect(projections.rows).toHaveLength(0);
  });

  test('runtime principal in workspace A can read its own rows', async () => {
    const rows = await runtimeA.query(
      `SELECT id FROM forgejo_workspace_credentials WHERE workspace_id = $1`, [WORKSPACE_A]);
    expect(rows.rows.map((row) => row.id)).toEqual([BINDING_ID]);
  });

  test('workspace B cannot UPDATE workspace A rows and DELETE is revoked from the runtime principal', async () => {
    const updated = await runtimeB.query(
      `UPDATE forgejo_workspace_credentials SET last_validated_at = NOW() WHERE workspace_id = $1`,
      [WORKSPACE_A]);
    expect(updated.rowCount).toBe(0);
    await expect(runtimeB.query(
      `DELETE FROM forgejo_workspace_credentials WHERE workspace_id = $1`, [WORKSPACE_A]))
      .rejects.toMatchObject({ code: '42501' });
  });

  test('canonical writer principal is workspace-scoped too', async () => {
    const rows = await writerA.query(
      `SELECT id FROM forgejo_workspace_credentials WHERE workspace_id = $1`, [WORKSPACE_A]);
    expect(rows.rows).toHaveLength(1);
    const cross = await writerA.query(
      `SELECT id FROM forgejo_workspace_credentials WHERE workspace_id = $1`, [WORKSPACE_B]);
    expect(cross.rows).toHaveLength(0);
  });

  test('PUBLIC/authenticated/anon hold no privileges on the three tables', async () => {
    const grants = await ownerPool.query(
      `SELECT table_name, grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'rorca'
          AND table_name IN ('forgejo_workspace_credentials','forgejo_status_projections','forgejo_federation_projections')
          AND grantee IN ('PUBLIC','authenticated','anon')`);
    expect(grants.rows).toHaveLength(0);
  });

  test('federation projection identity is immutable; DELETE and TRUNCATE are rejected', async () => {
    await expect(ownerPool.query(
      `UPDATE forgejo_federation_projections SET head_sha = repeat('f',40) WHERE proposal_id = $1`,
      [PROPOSAL_ID])).rejects.toMatchObject({ code: '23514' });
    await expect(ownerPool.query(
      `DELETE FROM forgejo_federation_projections WHERE proposal_id = $1`, [PROPOSAL_ID]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(ownerPool.query(`TRUNCATE forgejo_federation_projections`))
      .rejects.toMatchObject({ code: '55000' });
  });

  test('terminal status-projection identity is immutable once provider-terminal', async () => {
    await ownerPool.query(`INSERT INTO forgejo_status_projections (
        run_id, workspace_id, spec_id, desired_event_id, desired_event_identity_hash,
        desired_state, head_sha, conclusion, desired_payload, desired_payload_hash,
        external_id, projection_status, repository_owner, repository_name
      ) VALUES (9000001,$1,'spec:h',$2,repeat('1',64),'in_progress',repeat('a',40),NULL,
        '{"runId":9000001,"state":"pending","description":"d"}'::jsonb,repeat('2',64),
        'rorca:pipeline-run:9000001:v1','projected','acme','widgets')
      ON CONFLICT (run_id) DO NOTHING`,
      [WORKSPACE_A, statusRunWalId]);
    await expect(ownerPool.query(
      `UPDATE forgejo_status_projections SET head_sha = repeat('f',40) WHERE run_id = 9000001`))
      .rejects.toMatchObject({ code: '23514' });
  });
});
