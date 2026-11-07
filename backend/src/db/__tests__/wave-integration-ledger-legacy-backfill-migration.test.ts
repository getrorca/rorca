/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260817130000_wave_integration_ledger_legacy_closeout_backfill.sql'),
  'utf8',
);

describe('wave integration ledger legacy closeout backfill migration', () => {
  test('reconstructs finalized ledger rows from canonical host run_closeout WAL evidence', () => {
    expect(migration).toContain('INSERT INTO rorca.story_integration_ledger');
    expect(migration).toContain("'finalized'");
    expect(migration).toContain("wal.event_type = 'run_closeout'");
    expect(migration).toContain("wal.trust_provenance = 'host'");
    expect(migration).toContain("wal.trusted_source = 'worker'");
    expect(migration).toContain('wal.outbox_ready_at IS NOT NULL');
    expect(migration).toContain("decision.status = 'accepted'");
    expect(migration).toContain('integration_ancestry');
    expect(migration).toContain('story_commits');
  });

  test('writes immutable deterministic identities and never touches existing rows', () => {
    expect(migration).toContain('frozen_manifest_hash');
    expect(migration).toContain('validation_identity');
    expect(migration).toContain('finalization_identity');
    expect(migration).toContain('legacy-ledger-backfill:');
    expect(migration).toContain('ON CONFLICT (run_id, story_id, attempt) DO NOTHING');
    expect(migration).toContain('NOT EXISTS (');
    expect(migration).not.toMatch(/UPDATE\s+rorca\.story_integration_ledger/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+rorca\.story_integration_ledger/i);
  });

  test('orders integrations by the WAL ancestry and maps story commits exactly', () => {
    expect(migration).toContain('element.ordinality - 1 AS integration_order');
    expect(migration).toContain('position.resulting_head = lower(commit_row.commit_sha)');
    expect(migration).toContain('previous.integration_order = position.integration_order - 1');
  });

  test('is governed and does not hand-manage pgboss or roles', () => {
    expect(migration).not.toMatch(/pgboss/i);
    expect(migration).not.toMatch(/CREATE\s+(?:ROLE|SCHEMA|EXTENSION|DATABASE)/i);
    expect(migration).not.toMatch(/ALTER\s+ROLE/i);
  });
});
