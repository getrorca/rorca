/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260820190000_sequential_integration_closeout_reconciliation.sql'),
  'utf8',
);

describe('sequential integration closeout reconciliation migration', () => {
  test('reconstructs only accepted integrations backed by canonical host closeout evidence', () => {
    expect(migration).toContain('INSERT INTO rorca.story_integration_ledger');
    expect(migration).toContain("wal.event_type = 'run_closeout'");
    expect(migration).toContain("wal.trust_provenance = 'host'");
    expect(migration).toContain("wal.trusted_source = 'worker'");
    expect(migration).toContain('wal.outbox_ready_at IS NOT NULL');
    expect(migration).toContain("decision.status = 'accepted'");
    expect(migration).toContain('position.resulting_head = lower(commit_row.commit_sha)');
  });

  test('is append-only, deterministic, and ordered by attested ancestry', () => {
    expect(migration).toContain("'finalized'");
    expect(migration).toContain('element.ordinality - 1 AS integration_order');
    expect(migration).toContain('previous.integration_order = position.integration_order - 1');
    expect(migration).toContain('sequential-closeout-ledger:');
    expect(migration).toContain('ON CONFLICT (run_id, story_id, attempt) DO NOTHING');
    expect(migration).toContain('NOT EXISTS (');
    expect(migration).not.toMatch(/UPDATE\s+rorca\.story_integration_ledger/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+rorca\.story_integration_ledger/i);
  });
});
