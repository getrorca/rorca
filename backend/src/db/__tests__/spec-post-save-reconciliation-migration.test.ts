/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const sql = fs.readFileSync(path.join(__dirname, '..', 'pg-migrations', '20260729148000_spec_post_save_exact_reconciliation.sql'), 'utf8');

describe('exact post-save reconciliation migration contract', () => {
  test('creates a bounded immutable audit ledger without managing pg-boss', () => {
    expect(sql).toContain('CREATE TABLE rorca.spec_post_save_reconciliation_audit');
    expect(sql).toContain("outcome IN ('accepted','rejected','no_op')");
    expect(sql).toContain("schema_version = 'rorca.spec-post-save-reconciliation-audit.v1'");
    expect(sql).toContain('spec_post_save_reconciliation_audit_immutable');
    expect(sql).toContain('spec_post_save_reconciliation_audit_no_truncate');
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:pgboss|pgboss_)\./i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+(?:pgboss|pgboss_)\./i);
  });

  test('forces workspace-scoped RLS and grants only audit read/insert authority', () => {
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("workspace_id=current_setting('rorca.workspace_id',TRUE)");
    expect(sql).toContain("principal_class='internal_runtime'");
    expect(sql).toContain('GRANT SELECT,INSERT ON rorca.spec_post_save_reconciliation_audit');
    expect(sql).not.toMatch(/GRANT\s+[^;]*(?:UPDATE|DELETE|TRUNCATE)[^;]*spec_post_save_reconciliation_audit/i);
  });
});
