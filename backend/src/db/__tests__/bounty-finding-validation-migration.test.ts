/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(path.join(__dirname, '../pg-migrations/20260803150000_bounty_finding_validation.sql'), 'utf8');
const admission = fs.readFileSync(path.join(__dirname, '../../lib/bounty-finding-admission.ts'), 'utf8');
const operationLedger = fs.readFileSync(path.join(__dirname, '../../lib/bounty-operation-ledger.ts'), 'utf8');

describe('bounty finding validation persistence contract', () => {
  test('pins policy decisions and makes candidate and affected-target admission unique', () => {
    expect(sql).toContain("policy_version = 'bounty.validation.v1'");
    expect(sql).toContain('UNIQUE (workspace_id, mission_id, candidate_identity)');
    expect(sql).toContain('UNIQUE (workspace_id, mission_id, affected_target_id)');
    expect(sql).toContain('bounty_affected_target_stop_fence_immutable');
    expect(sql).toContain('bounty_finding_admission_immutable');
  });

  test('requires an exact, terminal, one-use provider-human receipt for human-required admission', () => {
    expect(sql).toContain("action TEXT NOT NULL CHECK (action = 'finding.admit')");
    expect(sql).toContain('target_hash');
    expect(sql).toContain('exact_target');
    expect(sql).toContain('provider_event');
    expect(sql).toContain('CHECK (consumed_at IS NULL OR revoked_at IS NULL)');
    expect(sql).toContain('bounty_guard_finding_approval_receipt_update');
    expect(sql).toContain("disposition = 'human-required' AND approval_receipt_id IS NOT NULL");
  });

  test('serializes candidate and target locks and writes finding, stop fence, and admission in one transaction', () => {
    expect(admission).toContain('return transaction(async (client) =>');
    expect(admission).toContain('pg_advisory_xact_lock');
    expect(admission).toContain('bounty:finding-candidate:');
    expect(admission).toContain('bounty:finding-target:');
    expect(admission).toContain('INSERT INTO bounty_findings');
    expect(admission).toContain('INSERT INTO bounty_affected_target_stop_fences');
    expect(admission).toContain('INSERT INTO bounty_finding_admissions');
    expect(admission).toContain('replay: true');
    expect(admission).toContain('persistFindingApprovalReceipt');
  });

  test('the committed stop fence denies later target effects', () => {
    expect(operationLedger).toContain('bounty_affected_target_stop_fences');
    expect(operationLedger).toContain('Affected target is stopped by an admitted finding');
  });

  test('does not hand-manage pg-boss or external transport', () => {
    expect(sql).not.toMatch(/pgboss\.|createQueue|boss\.send|https?:\/\//i);
  });
});
