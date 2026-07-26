/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { query, transaction } from '../index';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260714161000_ssdlc_lifecycle.sql';
const migrationPath = path.join(__dirname, '..', 'pg-migrations', migrationFile);

describe('LFC-002 SSDLC lifecycle migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('has a collision-free timestamp prefix and exactly three durable concepts', () => {
    const migrationDir = path.join(__dirname, '..', 'pg-migrations');
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(migrationFile).toMatch(/^20260714161000_/);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(3);
    expect(sql).not.toMatch(/phase_status/i);
    expect(sql).not.toMatch(/\bCREATE\s+(?:TABLE|INDEX|SCHEMA).*pgboss/is);
  });

  test('declares idempotent DDL without replaying a historical migration over the shared upgrade state', async () => {
    const objectsBefore = await query<{ object_name: string }>(`
      SELECT c.relkind::text || ':' || c.relname AS object_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pgboss'
      ORDER BY object_name
    `);

    // Global setup already proves the complete ordered migration chain applies.
    // Re-executing this historical file in isolation would overwrite newer
    // CREATE OR REPLACE FUNCTION bodies while their durable markers remain,
    // corrupting every later dirty-upgrade test in the shared append-only DB.
    expect(sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(10);
    expect(sql).toContain('DROP TRIGGER IF EXISTS');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA)[^;]*\bpgboss\b/is);

    const objectsAfter = await query<{ object_name: string }>(`
      SELECT c.relkind::text || ':' || c.relname AS object_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pgboss'
      ORDER BY object_name
    `);
    expect(objectsAfter).toEqual(objectsBefore);
  });

  test('enforces plan identity/current uniqueness and immutable failed outcomes', () => {
    expect(sql).toContain('ssdlc_compiled_plans_identity_unique UNIQUE');
    for (const field of [
      'workspace_id',
      'spec_slug',
      'spec_version',
      'compiler_version',
      'normalized_input_hash',
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain('idx_ssdlc_compiled_plans_one_current');
    expect(sql).toContain("CHECK (NOT is_current OR validation_status = 'validated')");
    expect(sql).toContain('ssdlc_compiled_plans_immutable');
  });

  test('enforces evidence subjects, source uniqueness, audit-preserving run links, and append-only rows', () => {
    for (const subject of ['spec_hash', 'commit_sha', 'artifact_digest', 'deployment_id']) {
      expect(sql).toContain(`'${subject}'`);
    }
    expect(sql).toContain('UNIQUE (workspace_id, source_system, source_idempotency_key)');
    expect(sql).toContain('run_id INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL');
    expect(sql).toContain('ssdlc_lifecycle_evidence_append_only');
    for (const lookup of ['phase_detail', 'gate', 'story', 'run', 'revision']) {
      expect(sql).toContain(`idx_ssdlc_evidence_${lookup}`);
    }
  });

  test('database constraints enforce identity uniqueness, current selection, replay dedupe, and one-way revocation', async () => {
    await transaction(async (client) => {
      const workspaceId = `lfc-002-${Date.now()}`;
      await client.query(
        'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
        [workspaceId, 'LFC-002 migration test', `/tmp/${workspaceId}`],
      );

      const expectRejected = async (sqlText: string, params: unknown[]): Promise<void> => {
        await client.query('SAVEPOINT expected_lifecycle_rejection');
        try {
          await expect(client.query(sqlText, params)).rejects.toBeDefined();
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT expected_lifecycle_rejection');
          await client.query('RELEASE SAVEPOINT expected_lifecycle_rejection');
        }
      };

      const planValues = [workspaceId, 'safe-delivery', '2', 'compiler-1', 'input-hash'];
      await client.query(`
        INSERT INTO ssdlc_compiled_plans (
          workspace_id, spec_slug, spec_version, compiler_version, normalized_input_hash,
          schema_version, plan_json, validation_status, validated_at, is_current
        ) VALUES ($1, $2, $3, $4, $5, 'plan.v1', '{}', 'validated', NOW(), TRUE)
      `, planValues);
      await expectRejected(`
        INSERT INTO ssdlc_compiled_plans (
          workspace_id, spec_slug, spec_version, compiler_version, normalized_input_hash,
          schema_version, plan_json, validation_status, validated_at
        ) VALUES ($1, $2, $3, $4, $5, 'plan.v1', '{}', 'validated', NOW())
      `, planValues);
      await expectRejected(`
        INSERT INTO ssdlc_compiled_plans (
          workspace_id, spec_slug, spec_version, compiler_version, normalized_input_hash,
          schema_version, plan_json, validation_status, validated_at, is_current
        ) VALUES ($1, $2, '3', $3, 'new-hash', 'plan.v1', '{}', 'validated', NOW(), TRUE)
      `, [workspaceId, 'safe-delivery', 'compiler-1']);

      const evidenceValues = [workspaceId, 'safe-delivery', 'github', 'check-run-42'];
      await client.query(`
        INSERT INTO ssdlc_lifecycle_evidence (
          workspace_id, spec_slug, evidence_type, subject_type, subject_value,
          source_system, source_idempotency_key, payload_hash, observed_at
        ) VALUES ($1, $2, 'test_report', 'commit_sha', 'abc123', $3, $4, 'payload-a', NOW())
      `, evidenceValues);
      await expectRejected(`
        INSERT INTO ssdlc_lifecycle_evidence (
          workspace_id, spec_slug, evidence_type, subject_type, subject_value,
          source_system, source_idempotency_key, payload_hash, observed_at
        ) VALUES ($1, $2, 'test_report', 'commit_sha', 'def456', $3, $4, 'payload-b', NOW())
      `, evidenceValues);

      const { rows: decisions } = await client.query<{ id: string }>(`
        INSERT INTO ssdlc_lifecycle_decisions (
          workspace_id, spec_slug, phase_id, gate_id, decision_type, actor, rationale
        ) VALUES ($1, 'safe-delivery', 'verify', 'qa', 'qa_approval', 'reviewer', 'Evidence complete')
        RETURNING id::text
      `, [workspaceId]);
      const decisionId = decisions[0].id;
      await client.query(`
        UPDATE ssdlc_lifecycle_decisions
        SET revoked_at = NOW(), revoked_by = 'lead', revocation_rationale = 'Evidence invalidated'
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, decisionId]);
      await expectRejected(`
        UPDATE ssdlc_lifecycle_decisions
        SET revocation_rationale = 'Rewritten audit history'
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, decisionId]);
      await expectRejected(
        'DELETE FROM ssdlc_lifecycle_decisions WHERE workspace_id = $1 AND id = $2',
        [workspaceId, decisionId],
      );
    });
  });

  test('supports all governed decisions and permits only complete one-way revocation', () => {
    for (const decision of [
      'defer',
      'not_applicable_confirmation',
      'gate_override',
      'qa_approval',
      'merge_approval',
      'production_approval',
    ]) {
      expect(sql).toContain(`'${decision}'`);
    }
    expect(sql).toContain('revoked_at TIMESTAMPTZ');
    expect(sql).toContain('revoked_by TEXT');
    expect(sql).toContain('revocation_rationale TEXT');
    expect(sql).toContain('only one-way revocation is allowed');
    expect(sql).toContain('idx_ssdlc_decisions_active');
    expect(sql).toContain('WHERE revoked_at IS NULL');
  });
});
