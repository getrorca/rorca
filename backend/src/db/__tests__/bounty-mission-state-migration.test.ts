/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(path.join(
  __dirname,
  '../pg-migrations/20260801120000_bounty_mission_state.sql',
), 'utf8');

describe('bounty mission state migration contract', () => {
  test('creates the complete durable state model with enforced lineage', () => {
    for (const table of [
      'programs', 'missions', 'contracts', 'generations', 'work_packages', 'attempts',
      'budgets', 'leases', 'holds', 'operations', 'operation_receipts', 'evidence',
      'findings', 'drafts', 'approvals', 'events', 'application_outbox',
    ]) {
      expect(sql).toContain(`CREATE TABLE bounty_${table}`);
    }
    expect(sql).toContain('FOREIGN KEY (workspace_id, program_id)');
    expect(sql).toContain('FOREIGN KEY (workspace_id, mission_id, generation_id)');
    expect(sql).toContain("CHECK (release_mode = 'sequential')");
  });

  test('serializes monotonic identities and makes durable facts append-only', () => {
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain("bounty_require_next_number('mission_id','revision')");
    expect(sql).toContain("bounty_require_next_number('mission_id','epoch')");
    expect(sql).toContain('bounty_receipts_append_only');
    expect(sql).toContain('bounty_events_append_only');
    expect(sql).toContain('bounty_evidence_append_only');
    expect(sql).toContain('UNIQUE (workspace_id, idempotency_key)');
  });

  test('is timestamped, transactional DDL without queue, network, or pg-boss ownership', () => {
    expect(path.basename('20260801120000_bounty_mission_state.sql')).toMatch(/^\d{14}_.+\.sql$/);
    expect(sql).not.toMatch(/pgboss\.|createQueue|boss\.send|https?:\/\//i);
    expect(sql).not.toMatch(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+pgboss/i);
  });
});
