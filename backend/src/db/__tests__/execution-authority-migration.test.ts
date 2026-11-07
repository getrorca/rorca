/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const fixtureSql = readFileSync(
  join(__dirname, 'fixtures', 'execution-authority-populated-upgrade.sql'),
  'utf8',
);

const migrationSql = readFileSync(
  join(__dirname, '..', 'pg-migrations', '20260821120100_execution_authority_core.sql'),
  'utf8',
);

const authorityTables = [
  'operation_intents',
  'authority_requests',
  'authority_decisions',
  'authority_grants',
  'credential_leases',
  'execution_attempts',
  'execution_receipts',
  'execution_authority_bindings',
] as const;

const dropAuthoritySql = `DROP TABLE IF EXISTS
  rorca.execution_receipts,
  rorca.execution_attempts,
  rorca.credential_leases,
  rorca.authority_grants,
  rorca.authority_decisions,
  rorca.authority_requests,
  rorca.operation_intents,
  rorca.execution_authority_bindings
CASCADE`;

async function setMigrationRuntimePrincipal(owner: Pick<Pool, 'query'>): Promise<void> {
  const runtime = await owner.query<{ database_user: string }>(
    `SELECT database_user
       FROM rorca.wave2_database_principals
      WHERE principal_class = 'internal_runtime'
      ORDER BY database_user
      LIMIT 1`,
  );
  if (!runtime.rows[0]) throw new Error('Registered internal runtime principal is required');
  await owner.query(`SELECT set_config('rorca.runtime_database_user', $1, true)`, [
    runtime.rows[0].database_user,
  ]);
}

async function authorityTableCount(owner: Pick<Pool, 'query'>): Promise<number> {
  const result = await owner.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM unnest($1::text[]) AS authority_table(name)
      WHERE to_regclass('rorca.' || authority_table.name) IS NOT NULL`,
    [authorityTables],
  );
  return result.rows[0]?.count ?? 0;
}

async function pgbossRelations(owner: Pick<Pool, 'query'>): Promise<unknown[]> {
  const result = await owner.query(
    `SELECT relation.relname, relation.relkind, relation.oid
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'pgboss'
      ORDER BY relation.relname, relation.relkind, relation.oid`,
  );
  return result.rows;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function future(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}
const rolloutEvidenceKinds = [
  'migration', 'api', 'ui', 'crash_recovery', 'redaction', 'disposable_fixture_smoke',
] as const;

async function enableExecutionAuthorityProfile(
  owner: Pick<Pool, 'query'>,
  workspaceId: string,
  suffix: string,
): Promise<void> {
  const observedAt = new Date().toISOString();
  for (const evidenceKind of rolloutEvidenceKinds) {
    await owner.query(
      `INSERT INTO rorca.execution_authority_rollout_evidence
        (workspace_id, evidence_kind, result, artifact_reference, evidence_digest,
         observed_at, operator_principal, idempotency_key, provenance_json)
       VALUES ($1, $2, 'passed', $3, $4, $5, 'operator:rea-001-fixture', $6, $7::jsonb)`,
      [workspaceId, evidenceKind, `test://rea-001/${suffix}/${evidenceKind}`,
        digest(`rollout:${suffix}:${evidenceKind}`), observedAt,
        `rollout:${suffix}:${evidenceKind}`, JSON.stringify({ source: 'rea-001-fixture' })],
    );
  }
  await owner.query(
    `UPDATE rorca.execution_authority_profiles
        SET state = 'enabled', generation = generation + 1,
            transition_principal = 'operator:rea-001-fixture'
      WHERE workspace_id = $1 AND state = 'disabled'`,
    [workspaceId],
  );
}


describe('REA-001 PostgreSQL authority invariants', () => {
  let owner: Pool;

  beforeAll(async () => {
    const migrationUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
    owner = new Pool({
      connectionString: migrationUrl,
      max: 1,
      options: '--search_path=rorca,public -c rorca.migration_mode=on',
    });
  });

  afterAll(async () => {
    await owner.end();
  });

  test('applies over populated canonical tables without touching pgboss', async () => {
    const workspaceId = `rea-001-upgrade:${randomUUID()}`;
    await owner.query('BEGIN');
    try {
      const pgbossBefore = await pgbossRelations(owner);
      await owner.query(dropAuthoritySql);
      await owner.query(
        `SELECT set_config('rorca.execution_authority_fixture_workspace', $1, true)`,
        [workspaceId],
      );
      await owner.query(fixtureSql);
      await setMigrationRuntimePrincipal(owner);
      await owner.query(migrationSql);

      expect(await authorityTableCount(owner)).toBe(authorityTables.length);
      expect(await pgbossRelations(owner)).toEqual(pgbossBefore);
      const fixture = await owner.query(
        `SELECT 1 FROM rorca.pipeline_runs WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(fixture.rows).toHaveLength(1);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  test('failed populated upgrade rolls back every authority object and preserves its fixture', async () => {
    const workspaceId = `rea-001-failed-upgrade:${randomUUID()}`;
    const client = await owner.connect();
    await client.query('BEGIN');
    try {
      const pgbossBefore = await pgbossRelations(client);
      await client.query(dropAuthoritySql);
      await client.query(
        `SELECT set_config('rorca.execution_authority_fixture_workspace', $1, true)`,
        [workspaceId],
      );
      await client.query(fixtureSql);
      await setMigrationRuntimePrincipal(client);
      await client.query('SAVEPOINT authority_install');

      await expect(client.query(`${migrationSql}\nSELECT 1 / 0;`)).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT authority_install');

      expect(await authorityTableCount(client)).toBe(0);
      expect(await pgbossRelations(client)).toEqual(pgbossBefore);
      const fixture = await client.query(
        `SELECT 1 FROM rorca.pipeline_runs WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(fixture.rows).toHaveLength(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('persists a populated fixture and rejects replay, over-use, stale fences, secret bytes, and receipt mutation', async () => {
    const suffix = randomUUID();
    const workspaceId = `rea-001:${suffix}`;
    const bindingReference = `binding:${suffix}`;
    const capabilityId = 'provider.fixture.mutate';
    const providerResourceId = `fixture-resource:${suffix}`;
    const secretReference = `vault://workspaces/${workspaceId}/providers/fixture/key`;
    const secretFingerprint = digest(`fingerprint:${suffix}`);
    const provenance = { source: 'rea-001-postgresql-fixture', fixture: suffix };
    const constraints = { branch: `rorca/rea-001-${suffix}`, protected: false };

    await owner.query(
      `SELECT set_config('rorca.execution_authority_fixture_workspace', $1, false)`,
      [workspaceId],
    );
    await owner.query(fixtureSql);
    const runResult = await owner.query<{ id: string }>(
      `SELECT id::text FROM rorca.pipeline_runs
        WHERE workspace_id = $1
          AND spec_path = 'forge/specs/approved/execution-authority-populated-upgrade.json'
        ORDER BY id DESC LIMIT 1`,
      [workspaceId],
    );
    expect(runResult.rows).toHaveLength(1);
    const runId = runResult.rows[0].id;

    await expect(owner.query(
      `INSERT INTO rorca.execution_authority_bindings
        (workspace_id, binding_reference, generation, capability_id, provider, environment,
         provider_resource_id, secret_reference, secret_fingerprint, configuration_json, provenance_json)
       VALUES ($1, $2, 1, $3, 'fixture', 'test', $4, $5, $6, '{}'::jsonb, $7)`,
      [workspaceId, `${bindingReference}:raw`, capabilityId, providerResourceId,
        'provider-credential-bytes', secretFingerprint, provenance],
    )).rejects.toThrow();
    await expect(owner.query(
      `INSERT INTO rorca.execution_authority_bindings
        (workspace_id, binding_reference, generation, capability_id, provider, environment,
         provider_resource_id, secret_reference, secret_fingerprint, configuration_json, provenance_json)
       VALUES ($1, $2, 1, $3, 'fixture', 'test', $4, $5, $6, $7, $8)`,
      [workspaceId, `${bindingReference}:json`, capabilityId, providerResourceId,
        secretReference, secretFingerprint, { access_token: 'provider-credential-bytes' }, provenance],
    )).rejects.toThrow();

    const binding = await owner.query<{ id: string }>(
      `INSERT INTO rorca.execution_authority_bindings
        (workspace_id, binding_reference, generation, capability_id, provider, environment,
         provider_resource_id, secret_reference, secret_fingerprint, configuration_json, provenance_json)
       VALUES ($1, $2, 1, $3, 'fixture', 'test', $4, $5, $6, '{}'::jsonb, $7)
       RETURNING id::text`,
      [workspaceId, bindingReference, capabilityId, providerResourceId,
        secretReference, secretFingerprint, provenance],
    );
    expect(binding.rows).toHaveLength(1);
    await expect(owner.query(
      `INSERT INTO rorca.execution_authority_bindings
        (workspace_id, binding_reference, generation, capability_id, provider, environment,
         provider_resource_id, secret_reference, secret_fingerprint, configuration_json, provenance_json)
       VALUES ($1, $2, 3, $3, 'fixture', 'test', $4, $5, $6, '{}'::jsonb, $7)`,
      [workspaceId, bindingReference, capabilityId, providerResourceId,
        secretReference, secretFingerprint, provenance],
    )).rejects.toThrow(/Stale provider binding generation/);

    const otherWorkspaceId = `rea-001-other:${suffix}`;
    await owner.query(
      `SELECT set_config('rorca.execution_authority_fixture_workspace', $1, false)`,
      [otherWorkspaceId],
    );
    await owner.query(fixtureSql);
    const otherRun = await owner.query<{ id: string }>(
      `SELECT id::text FROM rorca.pipeline_runs
        WHERE workspace_id = $1
        ORDER BY id DESC LIMIT 1`,
      [otherWorkspaceId],
    );
    await expect(owner.query(
      `INSERT INTO rorca.operation_intents
        (workspace_id, run_id, story_id, requesting_principal, capability_id, binding_reference,
         binding_generation, environment, provider_resource_id, operation, constraints_json,
         evidence_digest, canonical_digest, idempotency_key, provenance_json)
       VALUES ($1, $2, 'REA-001', $3, $4, $5, 1, 'test', $6, 'fixture.write', $7, $8, $9, $10, $11)`,
      [workspaceId, otherRun.rows[0].id, `execution:${runId}:REA-001`, capabilityId,
        bindingReference, providerResourceId, constraints, digest(`cross-run-evidence:${suffix}`),
        digest(`cross-run-intent:${suffix}`), `cross-run-intent:${suffix}`, provenance],
    )).rejects.toThrow(/Operation intent does not match/);

    const intentDigest = digest(`intent:${suffix}`);
    const intentKey = `intent:${suffix}`;
    const intent = await owner.query<{ id: string }>(
      `INSERT INTO rorca.operation_intents
        (workspace_id, run_id, story_id, requesting_principal, capability_id, binding_reference,
         binding_generation, environment, provider_resource_id, operation, constraints_json,
         evidence_digest, canonical_digest, idempotency_key, provenance_json)
       VALUES ($1, $2, 'REA-001', $3, $4, $5, 1, 'test', $6, 'fixture.write', $7, $8, $9, $10, $11)
       RETURNING id::text`,
      [workspaceId, runId, `execution:${runId}:REA-001`, capabilityId, bindingReference,
        providerResourceId, constraints, digest(`evidence:${suffix}`), intentDigest, intentKey, provenance],
    );
    const intentId = intent.rows[0].id;
    await expect(owner.query(
      `INSERT INTO rorca.operation_intents
        (workspace_id, run_id, story_id, requesting_principal, capability_id, binding_reference,
         binding_generation, environment, provider_resource_id, operation, constraints_json,
         evidence_digest, canonical_digest, idempotency_key, provenance_json)
       VALUES ($1, $2, 'REA-001', $3, $4, $5, 1, 'test', $6, 'fixture.write', $7, $8, $9, $10, $11)`,
      [workspaceId, runId, `execution:${runId}:REA-001`, capabilityId, bindingReference,
        providerResourceId, constraints, digest(`evidence:${suffix}`), digest(`duplicate:${suffix}`),
        intentKey, provenance],
    )).rejects.toThrow();

    const evidenceDigest = digest(`evidence:${suffix}`);
    const requestDigest = digest(`request:${suffix}`);
    const request = await owner.query<{ id: string }>(
      `INSERT INTO rorca.authority_requests
        (workspace_id, intent_id, run_id, story_id, requesting_principal, capability_id,
         binding_reference, binding_generation, environment, provider_resource_id, operation,
         constraints_json, evidence_digest, request_digest, idempotency_key, maximum_uses,
         expires_at, provenance_json)
       VALUES ($1, $2, $3, 'REA-001', $4, $5, $6, 1, 'test', $7, 'fixture.write',
         $8, $9, $10, $11, 1, $12, $13)
       RETURNING id::text`,
      [workspaceId, intentId, runId, `execution:${runId}:REA-001`, capabilityId,
        bindingReference, providerResourceId, constraints, evidenceDigest, requestDigest,
        `request:${suffix}`, future(60), provenance],
    );
    const requestId = request.rows[0].id;

    await expect(owner.query(
      `INSERT INTO rorca.authority_decisions
        (workspace_id, request_id, request_digest, requesting_principal, operator_principal,
         decision, decision_digest, idempotency_key, reason_code, provenance_json)
       VALUES ($1, $2, $3, $4, 'operator:local', 'approved', $5, $6, 'approved', $7)`,
      [workspaceId, requestId, digest(`forged:${suffix}`), `execution:${runId}:REA-001`,
        digest(`bad-decision:${suffix}`), `bad-decision:${suffix}`, provenance],
    )).rejects.toThrow(/exact current unexpired request digest/);

    const decision = await owner.query<{ id: string }>(
      `INSERT INTO rorca.authority_decisions
        (workspace_id, request_id, request_digest, requesting_principal, operator_principal,
         decision, decision_digest, idempotency_key, reason_code, provenance_json)
       VALUES ($1, $2, $3, $4, 'operator:local', 'approved', $5, $6, 'approved', $7)
       RETURNING id::text`,
      [workspaceId, requestId, requestDigest, `execution:${runId}:REA-001`,
        digest(`decision:${suffix}`), `decision:${suffix}`, provenance],
    );
    const decisionId = decision.rows[0].id;
    await expect(owner.query(
      `UPDATE rorca.authority_requests SET status = 'denied' WHERE id = $1`,
      [requestId],
    )).rejects.toThrow(/Illegal authority request transition/);

    const grantValues = [workspaceId, requestId, decisionId, requestDigest, runId, capabilityId,
      bindingReference, providerResourceId, constraints, evidenceDigest, secretReference,
      secretFingerprint, `grant:${suffix}`, provenance];
    const grantInsert = `INSERT INTO rorca.authority_grants
      (workspace_id, request_id, decision_id, request_digest, run_id, story_id, capability_id,
       binding_reference, binding_generation, environment, provider_resource_id, operation,
       constraints_json, evidence_digest, secret_reference, secret_fingerprint, maximum_uses,
       fencing_generation, idempotency_key, provenance_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'REA-001', $6, $7, 1, 'test', $8, 'fixture.write',
       $9, $10, $11, $12, 1, 1, $13, $14, $15)`;
    await expect(owner.query(grantInsert, [...grantValues, future(-1)])).rejects.toThrow();
    await expect(owner.query(grantInsert, [...grantValues, future(90)]))
      .rejects.toThrow(/exact approved request/);
    const grant = await owner.query<{ id: string }>(
      `${grantInsert} RETURNING id::text`,
      [...grantValues, future(30)],
    );
    const grantId = grant.rows[0].id;
    await expect(owner.query(
      `UPDATE rorca.authority_grants SET uses_consumed = 2 WHERE id = $1`,
      [grantId],
    )).rejects.toThrow(/Illegal authority grant transition or use count/);

    const consumed = await owner.query<{ status: string; uses_consumed: number }>(
      `SELECT status, uses_consumed FROM rorca.consume_authority_grant_v1(
        $1, $2, $3, $4, 'REA-001', 'test', $5, 'fixture.write', 1
      )`,
      [grantId, requestDigest, workspaceId, runId, providerResourceId],
    );
    expect(consumed.rows).toEqual([{ status: 'exhausted', uses_consumed: 1 }]);
    await expect(owner.query(
      `SELECT * FROM rorca.consume_authority_grant_v1(
        $1, $2, $3, $4, 'REA-001', 'test', $5, 'fixture.write', 1
      )`,
      [grantId, requestDigest, workspaceId, runId, providerResourceId],
    )).rejects.toThrow(/Exact active unexpired authority grant required/);

    await enableExecutionAuthorityProfile(owner, workspaceId, suffix);

    const lease = await owner.query<{ id: string }>(
      `INSERT INTO rorca.credential_leases
        (workspace_id, grant_id, binding_reference, binding_generation, run_id, story_id,
         environment, provider_resource_id, operation, lease_purpose, idempotency_key,
         secret_reference, secret_fingerprint, fencing_generation, maximum_uses,
         provenance_json, expires_at)
       VALUES ($1, $2, $3, 1, $4, 'REA-001', 'test', $5, 'fixture.write',
         'execute exact fixture effect', $6, $7, $8, 1, 1, $9, $10)
       RETURNING id::text`,
      [workspaceId, grantId, bindingReference, runId, providerResourceId, `lease:${suffix}`,
        secretReference, secretFingerprint, provenance, future(20)],
    );
    const leaseId = lease.rows[0].id;
    await owner.query(`UPDATE rorca.credential_leases SET status = 'active' WHERE id = $1`, [leaseId]);
    await expect(owner.query(
      `UPDATE rorca.credential_leases SET uses_consumed = 1 WHERE id = $1`,
      [leaseId],
    )).rejects.toThrow();

    const attemptKey = `attempt:${suffix}`;
    const attempt = await owner.query<{ id: string }>(
      `INSERT INTO rorca.execution_attempts
        (workspace_id, intent_id, grant_id, lease_id, run_id, story_id, environment,
         provider_resource_id, operation, request_digest, idempotency_key, fencing_generation, provenance_json)
       VALUES ($1, $2, $3, $4, $5, 'REA-001', 'test', $6, 'fixture.write', $7, $8, 1, $9)
       RETURNING id::text`,
      [workspaceId, intentId, grantId, leaseId, runId, providerResourceId,
        requestDigest, attemptKey, provenance],
    );
    const attemptId = attempt.rows[0].id;
    await expect(owner.query(
      `UPDATE rorca.execution_attempts SET status = 'settled' WHERE id = $1`,
      [attemptId],
    )).rejects.toThrow(/Illegal execution attempt transition/);
    await owner.query(`UPDATE rorca.execution_attempts SET status = 'running' WHERE id = $1`, [attemptId]);
    await owner.query(`UPDATE rorca.execution_attempts SET status = 'uncertain' WHERE id = $1`, [attemptId]);
    await expect(owner.query(
      `INSERT INTO rorca.execution_attempts
        (workspace_id, intent_id, grant_id, lease_id, run_id, story_id, environment,
         provider_resource_id, operation, request_digest, idempotency_key, fencing_generation, provenance_json)
       VALUES ($1, $2, $3, $4, $5, 'REA-001', 'test', $6, 'fixture.write', $7, $8, 1, $9)`,
      [workspaceId, intentId, grantId, leaseId, runId, providerResourceId,
        requestDigest, attemptKey, provenance],
    )).rejects.toThrow(/Stale or duplicate execution fencing generation/);

    const newerAttempt = await owner.query<{ id: string }>(
      `INSERT INTO rorca.execution_attempts
        (workspace_id, intent_id, grant_id, lease_id, run_id, story_id, environment,
         provider_resource_id, operation, request_digest, idempotency_key, fencing_generation, provenance_json)
       VALUES ($1, $2, $3, $4, $5, 'REA-001', 'test', $6, 'fixture.write', $7, $8, 2, $9)
       RETURNING id::text`,
      [workspaceId, intentId, grantId, leaseId, runId, providerResourceId,
        requestDigest, attemptKey, provenance],
    );
    const newerAttemptId = newerAttempt.rows[0].id;
    await expect(owner.query(
      `UPDATE rorca.execution_attempts SET status = 'settled' WHERE id = $1`,
      [attemptId],
    )).rejects.toThrow(/Stale execution fencing generation/);
    await owner.query(`UPDATE rorca.execution_attempts SET status = 'running' WHERE id = $1`, [newerAttemptId]);

    const receiptInsert = `INSERT INTO rorca.execution_receipts
      (workspace_id, attempt_id, intent_id, grant_id, run_id, story_id, environment,
       provider_resource_id, operation, request_digest, receipt_digest, idempotency_key,
       fencing_generation, outcome, provider_receipt_reference, secret_reference,
       secret_fingerprint, redacted_payload, provenance_json, retention_class, retained_until)
     VALUES ($1, $2, $3, $4, $5, 'REA-001', 'test', $6, 'fixture.write', $7, $8, $9,
       2, 'reconciled_succeeded', $10, $11, $12, $13, $14, 'standard', $15)`;
    const receiptValues = [workspaceId, newerAttemptId, intentId, grantId, runId,
      providerResourceId, requestDigest, digest(`receipt:${suffix}`), attemptKey,
      `provider-receipt:${suffix}`, secretReference, secretFingerprint];
    await expect(owner.query(
      receiptInsert,
      [...receiptValues, { credential_bytes: 'provider-credential-bytes' }, provenance, future(1_440)],
    )).rejects.toThrow();
    const receipt = await owner.query<{ id: string }>(
      `${receiptInsert} RETURNING id::text`,
      [...receiptValues, { providerStatus: 'accepted', externalId: providerResourceId }, provenance, future(1_440)],
    );
    const receiptId = receipt.rows[0].id;

    await expect(owner.query(
      `UPDATE rorca.execution_receipts SET retained_until = $1 WHERE id = $2`,
      [future(2_880), receiptId],
    )).rejects.toThrow(/append-only/);
    await expect(owner.query(
      `DELETE FROM rorca.execution_receipts WHERE id = $1`,
      [receiptId],
    )).rejects.toThrow(/append-only/);

    const retained = await owner.query<{
      secret_reference: string; secret_fingerprint: string; provider_resource_id: string;
      retention_class: string; retained_until: Date; status: string;
    }>(
      `SELECT secret_reference, secret_fingerprint, provider_resource_id,
              retention_class, retained_until, status
         FROM rorca.execution_receipts WHERE id = $1`,
      [receiptId],
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]).toMatchObject({
      secret_reference: secretReference,
      secret_fingerprint: secretFingerprint,
      provider_resource_id: providerResourceId,
      retention_class: 'standard',
      status: 'settled',
    });
  });
});
