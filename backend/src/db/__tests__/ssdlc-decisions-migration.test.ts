/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260715143000_ssdlc_decisions.sql';
const migrationDir = path.join(__dirname, '..', 'pg-migrations');
const sql = fs.readFileSync(path.join(migrationDir, migrationFile), 'utf8');

describe('LFC-007 governed SSDLC decision migration', () => {
  test('uses one collision-free timestamp migration and never touches pgboss', () => {
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(migrationFile).toMatch(/^\d{14}_ssdlc_decisions\.sql$/);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS ssdlc_decisions/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA).*pgboss/is);
  });

  test('records complete scope, authority, provenance, expiry, and revocation state', () => {
    for (const column of [
      'workspace_id',
      'spec_slug',
      'phase_id',
      'gate_id',
      'decision_type',
      'rationale',
      'principal_type',
      'principal_id',
      'principal_display_label',
      'source_request_id',
      'source_channel',
      'delegated_principal_id',
      'created_at',
      'expires_at',
      'revoked_at',
      'revocation_rationale',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('REFERENCES workspaces(id) ON DELETE RESTRICT');
    expect(sql).toContain('REFERENCES pipeline_runs(id) ON DELETE SET NULL');
    expect(sql).toContain('UNIQUE (workspace_id, source_request_id)');
  });

  test('enforces bounded deferrals, overrides, immutable approvals, and one-way audit history', () => {
    expect(sql).toContain("decision_type NOT IN ('defer', 'gate_override') OR expires_at IS NOT NULL");
    expect(sql).toContain("decision_type <> 'gate_override'");
    expect(sql).toContain('evidence_gap IS NOT NULL');
    expect(sql).toContain("decision_type IN ('qa_approval', 'merge_approval', 'production_approval')");
    expect(sql).toContain("subject_type IN ('commit_sha', 'artifact_digest')");
    expect(sql).toContain('ssdlc_decisions_immutable');
    expect(sql).toContain('only one-way revocation is allowed');
    expect(sql).not.toMatch(/UPDATE\s+ssdlc_lifecycle_evidence/i);
  });

  test('supports active derive-on-read filtering without deleting expired or revoked history', () => {
    expect(sql).toContain('idx_ssdlc_decisions_scope_active');
    expect(sql).toContain('WHERE revoked_at IS NULL');
    expect(sql).toContain('idx_ssdlc_decisions_history');
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });
});
