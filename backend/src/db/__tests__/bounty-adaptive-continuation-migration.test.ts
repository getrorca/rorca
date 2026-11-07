/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(path.join(__dirname, '../pg-migrations/20260803140000_bounty_adaptive_continuation.sql'), 'utf8');

describe('bounty adaptive continuation migration contract', () => {
  test('persists fresh process/session identity, policy decisions, checkpoints and compaction order', () => {
    for (const field of ['process_identity', 'session_identity', 'context_nonce', 'branch_identity', 'approach', 'termination_reason']) expect(sql).toContain(field);
    expect(sql).toContain('bounty_attempt_fresh_process UNIQUE');
    expect(sql).toContain('bounty_attempt_fresh_session UNIQUE');
    expect(sql).toContain('CREATE TABLE bounty_continuation_decisions');
    expect(sql).toContain('CREATE TABLE bounty_continuation_checkpoints');
    expect(sql).toContain('CREATE TABLE bounty_context_compaction_receipts');
    expect(sql).toContain('FOREIGN KEY (workspace_id, checkpoint_id) REFERENCES bounty_continuation_checkpoints');
    expect(sql).toContain('context_ratio >= 0.6000');
    expect(sql).toContain('exact_nested_configuration');
  });

  test('makes persisted adapter classification the sole durable retry authority', () => {
    expect(sql).toContain('CREATE TABLE bounty_adapter_idempotency_classifications');
    expect(sql).toContain("classification IN ('repeatable','non-repeatable','unknown')");
    expect(sql).toContain('adapter_version_hash');
    expect(sql).toContain('bounty_adapter_classification_immutable');
  });

  test('keeps continuation facts immutable and does not manage transport or pg-boss schema', () => {
    for (const trigger of ['bounty_continuation_checkpoint_immutable', 'bounty_compaction_receipt_immutable', 'bounty_continuation_decision_immutable']) expect(sql).toContain(trigger);
    expect(sql).not.toMatch(/pgboss\.|createQueue|boss\.send|https?:\/\//i);
  });
});
