/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260817120000_lifecycle_policy_approval_plan_binding_reconciliation.sql'),
  'utf8',
);

describe('lifecycle policy approval plan-binding reconciliation migration', () => {
  test('mints new-generation approvals bound to the current validated plan', () => {
    expect(migration).toContain('INSERT INTO rorca.ssdlc_decisions');
    expect(migration).toContain('compiled_plan_id, plan_id');
    expect(migration).toContain("plan.is_current = TRUE");
    expect(migration).toContain("plan.validation_status = 'validated'");
    expect(migration).toContain("stale.decision_type = 'policy_approval'");
    expect(migration).toContain('stale.compiled_plan_id IS NULL');
    expect(migration).toContain('stale.plan_id IS NULL');
    expect(migration).toContain("stale.subject_value = plan.provenance_json->>'specHash'");
  });

  test('uses a fresh reconciled idempotency key that cannot collide with the immutable historical row', () => {
    expect(migration).toContain("':plan:reconciled'");
    expect(migration).toContain('ON CONFLICT (workspace_id, source_request_id) DO NOTHING');
    expect(migration).not.toMatch(/UPDATE\s+rorca\.ssdlc_decisions/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+rorca\.ssdlc_decisions/i);
  });

  test('reproduces the exact policy verifier identity and request binding the app persists', () => {
    expect(migration).toContain("'lifecycle-policy-verifier'");
    expect(migration).toContain("'Rorca Lifecycle Policy Verifier'");
    expect(migration).toContain("plan.plan_json->>'policyVersion'");
    expect(migration).toContain("plan.plan_json->>'planId'");
    expect(migration).toContain("plan.plan_json->>'inputHash'");
    expect(migration).toContain('stale.request_hash');
  });

  test('is idempotent and does not hand-manage pgboss', () => {
    expect(migration).not.toMatch(/CREATE\s+(?:TABLE|INDEX)[\s\S]*pgboss\./i);
    expect(migration).not.toMatch(/pgboss/i);
    expect(migration).not.toMatch(/ALTER\s+ROLE/i);
    expect(migration).not.toMatch(/CREATE\s+(?:ROLE|SCHEMA|EXTENSION)/i);
  });
});
