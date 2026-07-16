/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260715200000_learn_closeout_status.sql'),
  'utf8',
);

describe('LFC-027 Learn closeout migration', () => {
  test('tracks bounded producer state on runs without creating a second memory system', () => {
    expect(migration).toContain('ALTER TABLE pipeline_runs');
    expect(migration).toContain('learn_closeout_status');
    expect(migration).toContain("'not_started', 'generated', 'blocked'");
    expect(migration).toContain('learn_candidate_count >= 0');
    expect(migration).toContain('learn_candidate_ids JSONB');
    expect(migration).toContain('jsonb_array_length(learn_candidate_ids) <= 24');
    expect(migration).not.toMatch(/CREATE TABLE/i);
    expect(migration).not.toMatch(/pgboss\./i);
  });

  test('indexes lifecycle provenance in the existing candidate queue', () => {
    expect(migration).toContain('idx_memory_candidates_lifecycle_closeout');
    expect(migration).toContain("provenance->>'kind' = 'lifecycle_closeout'");
  });
});
