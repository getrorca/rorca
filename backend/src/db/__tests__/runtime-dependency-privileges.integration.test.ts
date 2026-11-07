/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool, type PoolClient } from 'pg';
import { closePool, pool } from '../index';

const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!writerUrl) throw new Error('RORCA_CANONICAL_WRITER_DATABASE_URL is required');
const writerPool = new Pool({
  connectionString: writerUrl,
  options: '--search_path=rorca_canonical_api,rorca,public -c rorca.workspace_id=workspace:wave-two',
});

async function withRequestRole<T>(
  role: 'authenticated' | 'anon',
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    return await action(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

afterAll(async () => {
  await Promise.all([closePool(), writerPool.end()]);
});

test('ordinary runtime receives only the repository-authority read and byte-digest dependencies', async () => {
  const grants = await pool.query<{
    authority_select: boolean;
    digest_execute: boolean;
    principal_select: boolean;
    canonical_insert: boolean;
    canonical_issuer: boolean;
    hydration_select: boolean;
    hydration_insert: boolean;
    hydration_update: boolean;
    hydration_delete: boolean;
    hydration_truncate: boolean;
    hydration_sequence_usage: boolean;
  }>(`SELECT
    has_table_privilege(current_user,'rorca.github_workspace_repository_authority','SELECT') authority_select,
    has_function_privilege(current_user,'rorca.digest(bytea,text)','EXECUTE') digest_execute,
    has_table_privilege(current_user,'rorca.wave2_database_principals','SELECT') principal_select,
    has_table_privilege(current_user,'rorca.governed_missions','INSERT') canonical_insert,
    has_function_privilege(current_user,'rorca.authorize_wave2_canonical_writer_mutation_v3(text,text,text,text,jsonb)','EXECUTE') canonical_issuer,
    has_table_privilege(current_user,'rorca.workspace_hydration','SELECT') hydration_select,
    has_table_privilege(current_user,'rorca.workspace_hydration','INSERT') hydration_insert,
    has_table_privilege(current_user,'rorca.workspace_hydration','UPDATE') hydration_update,
    has_table_privilege(current_user,'rorca.workspace_hydration','DELETE') hydration_delete,
    has_table_privilege(current_user,'rorca.workspace_hydration','TRUNCATE') hydration_truncate,
    has_sequence_privilege(current_user,'rorca.workspace_hydration_id_seq','USAGE') hydration_sequence_usage`);
  expect(grants.rows[0]).toEqual({
    authority_select: true,
    digest_execute: true,
    principal_select: true,
    canonical_insert: false,
    canonical_issuer: false,
    hydration_select: true,
    hydration_insert: true,
    hydration_update: true,
    hydration_delete: true,
    hydration_truncate: false,
    hydration_sequence_usage: true,
  });

  const observed = await pool.query<{ authority_read: boolean; digest: string; principal_class: string }>(`SELECT
    (SELECT COUNT(*)>=0 FROM rorca.github_workspace_repository_authority) authority_read,
    encode(rorca.digest(convert_to('runtime-integrity','UTF8'),'sha256'),'hex') digest,
    (SELECT principal_class FROM rorca.wave2_database_principals WHERE database_user=current_user) principal_class`);
  expect(observed.rows[0]).toEqual({
    authority_read: true,
    digest: '9819a4b9bcecd01110e37d23f52e376a629e3fce0edec0c6e92d962b557d5c5c',
    principal_class: 'internal_runtime',
  });
});

test('PUBLIC and inherited request roles receive neither dependency nor principal-ledger access', async () => {
  const publicAcl = await pool.query<{
    authority_denied: boolean;
    digest_denied: boolean;
    principals_denied: boolean;
    hydration_denied: boolean;
    hydration_sequence_denied: boolean;
  }>(`SELECT
    NOT EXISTS(
      SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
      WHERE relation.oid='rorca.github_workspace_repository_authority'::regclass
        AND privilege.grantee=0 AND privilege.privilege_type='SELECT'
    ) authority_denied,
    NOT EXISTS(
      SELECT 1 FROM pg_proc routine
      CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid='rorca.digest(bytea,text)'::regprocedure
        AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
    ) digest_denied,
    NOT EXISTS(
      SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
      WHERE relation.oid='rorca.wave2_database_principals'::regclass
        AND privilege.grantee=0 AND privilege.privilege_type='SELECT'
    ) principals_denied,
    NOT EXISTS(
      SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
      WHERE relation.oid='rorca.workspace_hydration'::regclass
        AND privilege.grantee=0
    ) hydration_denied,
    NOT EXISTS(
      SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('S',relation.relowner))) privilege
      WHERE relation.oid='rorca.workspace_hydration_id_seq'::regclass
        AND privilege.grantee=0
    ) hydration_sequence_denied`);
  expect(publicAcl.rows[0]).toEqual({
    authority_denied: true,
    digest_denied: true,
    principals_denied: true,
    hydration_denied: true,
    hydration_sequence_denied: true,
  });

  for (const role of ['authenticated', 'anon'] as const) {
    const grants = await withRequestRole(role, (client) => client.query<{
      authority_select: boolean;
      digest_execute: boolean;
      principal_select: boolean;
      hydration_select: boolean;
      hydration_insert: boolean;
    }>(`SELECT
      has_table_privilege(current_user,'rorca.github_workspace_repository_authority','SELECT') authority_select,
      has_function_privilege(current_user,'rorca.digest(bytea,text)','EXECUTE') digest_execute,
      has_table_privilege(current_user,'rorca.wave2_database_principals','SELECT') principal_select,
      has_table_privilege(current_user,'rorca.workspace_hydration','SELECT') hydration_select,
      has_table_privilege(current_user,'rorca.workspace_hydration','INSERT') hydration_insert`));
    expect(grants.rows[0]).toEqual({
      authority_select: false,
      digest_execute: false,
      principal_select: false,
      hydration_select: false,
      hydration_insert: false,
    });

    await expect(withRequestRole(role, (client) => client.query(
      'SELECT principal_class FROM rorca.wave2_database_principals',
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(withRequestRole(role, (client) => client.query(
      'SELECT id FROM rorca.workspace_hydration',
    ))).rejects.toMatchObject({ code: '42501' });
    const sequenceAcl = await pool.query<{ denied: boolean }>(`SELECT NOT EXISTS(
      SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('S',relation.relowner))) privilege
      WHERE relation.oid='rorca.workspace_hydration_id_seq'::regclass
        AND privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)
    ) denied`, [role]);
    expect(sequenceAcl.rows[0].denied).toBe(true);
  }
});

test('authenticated legacy RLS evaluates without reading the protected principal ledger', async () => {
  const result = await withRequestRole('authenticated', async (client) => {
    await client.query(`SELECT
      set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000099',TRUE),
      set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated"}',TRUE)`);
    return client.query<{ count: string }>('SELECT COUNT(*)::text count FROM rorca.workspaces');
  });
  expect(result.rows[0]).toEqual({ count: '0' });
});

test('canonical writer retains self-only authority and bounded crypto dependencies without base DML', async () => {
  const grants = await writerPool.query<{
    authority_select: boolean;
    digest_execute: boolean;
    canonical_insert: boolean;
    canonical_issuer: boolean;
    hydration_select: boolean;
    hydration_insert: boolean;
    hydration_sequence_usage: boolean;
  }>(`SELECT
    has_table_privilege(current_user,'rorca.github_workspace_repository_authority','SELECT') authority_select,
    has_function_privilege(current_user,'rorca.digest(bytea,text)','EXECUTE') digest_execute,
    has_table_privilege(current_user,'rorca.governed_missions','INSERT') canonical_insert,
    has_function_privilege(current_user,'rorca.authorize_wave2_canonical_writer_mutation_v3(text,text,text,text,jsonb)','EXECUTE') canonical_issuer,
    has_table_privilege(current_user,'rorca.workspace_hydration','SELECT') hydration_select,
    has_table_privilege(current_user,'rorca.workspace_hydration','INSERT') hydration_insert,
    has_sequence_privilege(current_user,'rorca.workspace_hydration_id_seq','USAGE') hydration_sequence_usage`);
  expect(grants.rows[0]).toEqual({
    authority_select: false,
    digest_execute: true,
    canonical_insert: false,
    canonical_issuer: true,
    hydration_select: false,
    hydration_insert: false,
    hydration_sequence_usage: false,
  });

  await expect(writerPool.query('SELECT id FROM rorca.workspace_hydration'))
    .rejects.toMatchObject({ code: '42501' });

  const identities = await writerPool.query<{ database_user: string; principal_class: string; current_user: string }>(
    `SELECT database_user,principal_class,current_user
       FROM rorca.wave2_database_principals
      ORDER BY database_user,principal_class`,
  );
  expect(identities.rows).toHaveLength(1);
  expect(identities.rows[0]).toMatchObject({
    database_user: identities.rows[0].current_user,
    principal_class: 'canonical_writer',
  });
});
