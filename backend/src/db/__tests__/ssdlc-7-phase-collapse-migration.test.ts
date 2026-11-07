/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import crypto, { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  LEGACY_EVIDENCE_REQUIREMENT_TO_CANONICAL,
  LEGACY_GATE_TO_CANONICAL_GATE,
  LEGACY_PHASE_TO_CANONICAL_PHASE,
} from '../../lib/ssdlc-contracts';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260817150000_ssdlc_7_phase_collapse.sql'),
  'utf8',
);
const classificationMigration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260818230000_ssdlc_evidence_testing_classification.sql'),
  'utf8',
);

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const pool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});

const H = (value: string): string => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

async function createLedgerFixture(client: PoolClient, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`
    CREATE TABLE ${schema}.ssdlc_compiled_plans (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, spec_slug text NOT NULL,
      spec_version text NOT NULL, compiler_version text NOT NULL,
      normalized_input_hash text NOT NULL, schema_version text NOT NULL,
      plan_json jsonb NOT NULL, profile_hash text, validation_status text NOT NULL,
      is_current boolean NOT NULL, created_at timestamptz NOT NULL,
      validated_at timestamptz, updated_at timestamptz NOT NULL
    );
    CREATE TABLE ${schema}.ssdlc_lifecycle_evidence (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, spec_slug text NOT NULL,
      spec_version text, revision text, run_id integer, story_id text, phase_id text,
      gate_id text, evidence_type text NOT NULL, subject_type text NOT NULL,
      subject_value text NOT NULL, source_system text NOT NULL,
      source_idempotency_key text NOT NULL, payload_hash text NOT NULL,
      metadata jsonb NOT NULL, provenance jsonb NOT NULL, source_ref text,
      observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
      github_pr_delivery_evidence_id text, compiled_plan_id bigint,
      delivery_projection_kind text CHECK (delivery_projection_kind IN ('validation', 'merge')),
      CHECK (
        (github_pr_delivery_evidence_id IS NULL AND compiled_plan_id IS NULL AND delivery_projection_kind IS NULL)
        OR
        (github_pr_delivery_evidence_id IS NOT NULL AND compiled_plan_id IS NOT NULL AND delivery_projection_kind IS NOT NULL)
      )
    );
    CREATE TABLE ${schema}.ssdlc_lifecycle_decisions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, spec_slug text NOT NULL,
      spec_version text, revision text, run_id integer, story_id text, phase_id text,
      gate_id text, decision_type text NOT NULL, actor text NOT NULL, rationale text NOT NULL,
      scope jsonb NOT NULL, provenance jsonb NOT NULL, created_at timestamptz NOT NULL,
      expires_at timestamptz, revoked_at timestamptz, revoked_by text,
      revocation_rationale text
    );
    CREATE TABLE ${schema}.ssdlc_decisions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, spec_slug text NOT NULL,
      phase_id text NOT NULL, gate_id text, request_hash text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE FUNCTION ${schema}.reject_immutable_ledger_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='fixture ledger is immutable';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER compiled_plan_fixture_immutable
      BEFORE UPDATE OR DELETE ON ${schema}.ssdlc_compiled_plans
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_immutable_ledger_mutation();
    CREATE TRIGGER evidence_fixture_immutable
      BEFORE UPDATE OR DELETE ON ${schema}.ssdlc_lifecycle_evidence
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_immutable_ledger_mutation();
    CREATE TRIGGER lifecycle_decision_fixture_immutable
      BEFORE UPDATE OR DELETE ON ${schema}.ssdlc_lifecycle_decisions
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_immutable_ledger_mutation();
    CREATE TRIGGER decision_fixture_immutable
      BEFORE UPDATE OR DELETE ON ${schema}.ssdlc_decisions
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_immutable_ledger_mutation();
  `);
}

function schemaMigration(schema: string): string {
  return migration.replace(/\brorca\./g, `${schema}.`);
}

async function rolledBackFixture(action: (client: PoolClient, schema: string) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  const schema = `ssdlc_collapse_${randomUUID().replaceAll('-', '')}`;
  await client.query('BEGIN');
  try {
    await createLedgerFixture(client, schema);
    await action(client, schema);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function snapshots(client: PoolClient, schema: string): Promise<Record<string, string>> {
  const relations = [
    'ssdlc_compiled_plans',
    'ssdlc_lifecycle_evidence',
    'ssdlc_lifecycle_decisions',
    'ssdlc_decisions',
  ];
  return Object.fromEntries(await Promise.all(relations.map(async (relation) => {
    const result = await client.query<{ body: string }>(
      `SELECT row_to_json(row_value)::text AS body FROM ${schema}.${relation} AS row_value ORDER BY id`,
    );
    return [relation, JSON.stringify(result.rows.map((row) => row.body))];
  })));
}

afterAll(async () => pool.end());

describe('ssdlc seven-phase brownfield compatibility migration', () => {

  test('fresh installation creates the exact compatibility contract and is replay-idempotent', async () => {
    await rolledBackFixture(async (client, schema) => {
      const sql = schemaMigration(schema);
      await client.query(sql);
      await client.query(sql);
      const counts = await client.query<{ phases: number; gates: number; requirements: number }>(`
        SELECT
          (SELECT count(*)::int FROM ${schema}.ssdlc_legacy_phase_compatibility) AS phases,
          (SELECT count(*)::int FROM ${schema}.ssdlc_legacy_gate_compatibility) AS gates,
          (SELECT count(*)::int FROM ${schema}.ssdlc_legacy_evidence_requirement_compatibility) AS requirements
      `);
      expect(counts.rows[0]).toEqual({ phases: 11, gates: 22, requirements: 22 });
      const phaseMappings = await client.query<{ legacy_phase_id: string; canonical_phase_id: string }>(`
        SELECT legacy_phase_id,canonical_phase_id
        FROM ${schema}.ssdlc_legacy_phase_compatibility ORDER BY legacy_phase_id
      `);
      expect(Object.fromEntries(phaseMappings.rows.map((row) => [
        row.legacy_phase_id, row.canonical_phase_id,
      ]))).toEqual(LEGACY_PHASE_TO_CANONICAL_PHASE);
      const gateMappings = await client.query<{ legacy_gate_id: string; canonical_gate_id: string }>(`
        SELECT legacy_gate_id,canonical_gate_id
        FROM ${schema}.ssdlc_legacy_gate_compatibility ORDER BY legacy_gate_id
      `);
      expect(Object.fromEntries(gateMappings.rows.map((row) => [
        row.legacy_gate_id, row.canonical_gate_id,
      ]))).toEqual(LEGACY_GATE_TO_CANONICAL_GATE);
      const requirementMappings = await client.query<{
        legacy_evidence_requirement_id: string; canonical_evidence_requirement_id: string;
      }>(`SELECT legacy_evidence_requirement_id,canonical_evidence_requirement_id
           FROM ${schema}.ssdlc_legacy_evidence_requirement_compatibility
           ORDER BY legacy_evidence_requirement_id`);
      expect(Object.fromEntries(requirementMappings.rows.map((row) => [
        row.legacy_evidence_requirement_id, row.canonical_evidence_requirement_id,
      ]))).toEqual(LEGACY_EVIDENCE_REQUIREMENT_TO_CANONICAL);
      const canonical = await client.query<{ canonical_phase_id: string }>(`
        SELECT DISTINCT canonical_phase_id FROM ${schema}.ssdlc_legacy_phase_compatibility ORDER BY canonical_phase_id
      `);
      expect(canonical.rows.map((row) => row.canonical_phase_id).sort()).toEqual([
        'deployment', 'design', 'development', 'maintenance', 'planning', 'requirements', 'testing',
      ]);
      await client.query(`INSERT INTO ${schema}.ssdlc_lifecycle_evidence VALUES
        (99,'workspace-current','spec-current','revision-1','spec-revision-1',NULL,NULL,'testing','gate-current','test_result','spec_hash',$1,'current-host','current-evidence-99',$2,'{}','{}',NULL,'2026-08-17T00:00:00Z','2026-08-17T00:00:00Z','provider-current',2,'testing')`,
      [H('current-subject'), H('current-evidence')]);
      const currentProjection = await client.query<{ canonical_delivery_projection_kind: string }>(`
        SELECT canonical_delivery_projection_kind
        FROM ${schema}.ssdlc_lifecycle_evidence_compatibility WHERE id=99
      `);
      expect(currentProjection.rows[0].canonical_delivery_projection_kind).toBe('testing');
    });
  });

  test('populated upgrade preserves immutable plan, evidence, and decision bytes and hashes', async () => {
    await rolledBackFixture(async (client, schema) => {
      const plan = {
        schemaVersion: 1,
        planId: 'plan-legacy-17',
        planVersion: 4,
        inputHash: H('compiled-input'),
        phaseOrder: ['intake', 'requirements', 'architecture', 'implementation', 'validation', 'security', 'staging', 'qa', 'merge', 'production', 'learn'],
        phases: [{ phaseId: 'merge', disposition: { disposition: 'required', rationale: 'Historical merge payload.' }, gateIds: ['gate-ctrl-merge-evidence-complete'] }],
        profile: { profileId: 'general-sdlc-7', profileVersion: 1, profileHash: H('legacy-profile'), stages: [{ id: 'deployment', label: 'Deployment', phaseIds: ['staging', 'merge', 'production'] }], blockingStages: ['deployment'] },
        gates: [{ gateId: 'gate-ctrl-merge-evidence-complete', phaseId: 'merge', evidenceRequirementIds: ['evidence-ctrl-merge-evidence-complete-1', 'evidence-ctrl-merge-evidence-complete-2'] }],
        evidenceRequirements: [
          { evidenceRequirementId: 'evidence-ctrl-merge-evidence-complete-1', gateId: 'gate-ctrl-merge-evidence-complete', payload: { retained: true } },
          { evidenceRequirementId: 'evidence-ctrl-merge-evidence-complete-2', gateId: 'gate-ctrl-merge-evidence-complete', payload: { retained: true, ordinal: 2 } },
        ],
      };
      await client.query(`INSERT INTO ${schema}.ssdlc_compiled_plans VALUES
        (1,'workspace-legacy','spec-legacy','revision-7','compiler-legacy',$1,'1',$2,$3,'validated',true,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`,
      [H('normalized-input'), JSON.stringify(plan), H('legacy-profile')]);
      await client.query(`INSERT INTO ${schema}.ssdlc_lifecycle_evidence VALUES
        (2,'workspace-legacy','spec-legacy','revision-7','spec-revision-7',91,'STORY-7','merge','gate-ctrl-merge-evidence-complete','approval','commit_sha',$1,'legacy-host','legacy-evidence-2',$2,'{"evidenceRequirementIds":["evidence-ctrl-merge-evidence-complete-1","evidence-ctrl-merge-evidence-complete-2"]}','{"issuer":"host"}','wal:2','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','provider-legacy',1,'merge')`,
      ['a'.repeat(40), H('evidence-payload')]);
      await client.query(`INSERT INTO ${schema}.ssdlc_lifecycle_decisions VALUES
        (3,'workspace-legacy','spec-legacy','revision-7','spec-revision-7',91,'STORY-7','merge','gate-ctrl-merge-evidence-complete','merge_approval','operator','Historical exact-subject approval.','{}','{"issuer":"operator"}','2026-08-01T00:00:00Z',NULL,NULL,NULL,NULL)`);
      await client.query(`INSERT INTO ${schema}.ssdlc_decisions VALUES
        (4,'workspace-legacy','spec-legacy','merge','gate-ctrl-merge-evidence-complete',$1,'2026-08-01T00:00:00Z')`,
      [H('decision-request')]);

      const before = await snapshots(client, schema);
      const countSql = `
        SELECT
          (SELECT count(*)::int FROM ${schema}.ssdlc_compiled_plans) AS plans,
          (SELECT count(*)::int FROM ${schema}.ssdlc_lifecycle_evidence) AS evidence,
          (SELECT count(*)::int FROM ${schema}.ssdlc_lifecycle_decisions) AS lifecycle_decisions,
          (SELECT count(*)::int FROM ${schema}.ssdlc_decisions) AS decisions
      `;
      const beforeCounts = await client.query<{
        plans: number; evidence: number; lifecycle_decisions: number; decisions: number;
      }>(countSql);
      await client.query(schemaMigration(schema));
      expect(await snapshots(client, schema)).toEqual(before);
      const afterCounts = await client.query(countSql);
      expect(afterCounts.rows[0]).toEqual(beforeCounts.rows[0]);

      const evidenceProjection = await client.query<{
        phase_id: string; gate_id: string; canonical_phase_id: string;
        canonical_gate_id: string; canonical_delivery_projection_kind: string;
        subject_value: string; payload_hash: string;
      }>(`SELECT phase_id,gate_id,canonical_phase_id,canonical_gate_id,
                 canonical_delivery_projection_kind,subject_value,payload_hash
          FROM ${schema}.ssdlc_lifecycle_evidence_compatibility WHERE id=2`);
      expect(evidenceProjection.rows[0]).toEqual({
        phase_id: 'merge',
        gate_id: 'gate-ctrl-merge-evidence-complete',
        canonical_phase_id: 'deployment',
        canonical_gate_id: 'gate-ctrl-deployment-evidence-complete',
        canonical_delivery_projection_kind: 'deployment',
        subject_value: 'a'.repeat(40),
        payload_hash: H('evidence-payload'),
      });
      const requirementProjection = await client.query<{
        canonical_evidence_requirement_id: string;
      }>(`SELECT canonical_evidence_requirement_id
           FROM ${schema}.ssdlc_legacy_evidence_requirement_compatibility
           WHERE legacy_evidence_requirement_id = 'evidence-ctrl-merge-evidence-complete-2'`);
      expect(requirementProjection.rows[0].canonical_evidence_requirement_id)
        .toBe('evidence-ctrl-deployment-evidence-complete-2');
      const storedPlan = await client.query<{ plan_json: unknown; profile_hash: string; normalized_input_hash: string; lifecycle_contract: string }>(`
        SELECT plan_json,profile_hash,normalized_input_hash,lifecycle_contract
        FROM ${schema}.ssdlc_compiled_plan_compatibility WHERE id=1
      `);
      expect(storedPlan.rows[0]).toEqual({
        plan_json: plan,
        profile_hash: H('legacy-profile'),
        normalized_input_hash: H('normalized-input'),
        lifecycle_contract: 'legacy-eleven-v1',
      });
      const enabled = await client.query<{ enabled: boolean }>(`
        SELECT bool_and(tgenabled='O') AS enabled FROM pg_trigger
        WHERE tgrelid IN (
          '${schema}.ssdlc_compiled_plans'::regclass,
          '${schema}.ssdlc_lifecycle_evidence'::regclass,
          '${schema}.ssdlc_lifecycle_decisions'::regclass,
          '${schema}.ssdlc_decisions'::regclass
        ) AND NOT tgisinternal
      `);
      expect(enabled.rows[0].enabled).toBe(true);
    });
  });

  test('interrupted application rolls back cleanly and a later retry remains idempotent', async () => {
    await rolledBackFixture(async (client, schema) => {
      await client.query('SAVEPOINT interrupted_upgrade');
      await client.query(schemaMigration(schema));
      await client.query('ROLLBACK TO SAVEPOINT interrupted_upgrade');
      const absent = await client.query<{ relation: string | null }>(
        `SELECT to_regclass('${schema}.ssdlc_legacy_phase_compatibility')::text AS relation`,
      );
      expect(absent.rows[0].relation).toBeNull();
      await client.query(schemaMigration(schema));
      await client.query(schemaMigration(schema));
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${schema}.ssdlc_legacy_phase_compatibility`,
      );
      expect(count.rows[0].count).toBe(11);
    });
  });

  test('evidence classification constraint admits the merged testing phase', () => {
    // The 7-phase collapse renamed validation/security/qa to 'testing' and the
    // evidence writers classify those rows 'testing'. The follow-up migration
    // must admit that value or every governed closeout fails persisting its
    // evidence with a CHECK violation (closeout_exception).
    expect(classificationMigration).toContain("'qa', 'testing',");
    expect(classificationMigration).toContain("'validation', 'revision', 'completion', 'risk_judgment', 'qa', 'testing',");
    expect(classificationMigration).toContain("'documentation', 'staging', 'deployment', 'memory_closeout', 'approval'");
    expect(classificationMigration).toContain('DROP CONSTRAINT IF EXISTS ssdlc_evidence_classification_check');
    expect(classificationMigration).toContain('ADD CONSTRAINT ssdlc_evidence_classification_check');
  });


});
