/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(__dirname, '..', 'pg-migrations', '20260715222000_pty_rolling_checkpoints.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('PTY rolling checkpoint migration contract', () => {
  it('fills the story_id prerequisite and isolates checkpoint blobs from chunks', () => {
    expect(sql).toContain('ALTER TABLE run_output_chunks');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS story_id TEXT');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pty_checkpoints');
    expect(sql).toContain('compressed_blob BYTEA NOT NULL');
    expect(sql).toContain('generation_id UUID NOT NULL REFERENCES pty_generations(id)');
  });

  it('records reconstruction, compaction, dimensions, integrity, and true loss separately', () => {
    for (const column of [
      'checkpoint_seq', 'first_retained_seq', 'compacted_byte_count',
      'checksum', 'version', 'terminal_cols', 'terminal_rows',
    ]) expect(sql).toContain(column);
    expect(sql).toContain('retained_output_bytes');
    // Existing dropped_output_bytes remains capture-loss authority; compaction
    // metadata must not rewrite it or conflate safe eviction with loss.
    expect(sql).not.toMatch(/SET\s+dropped_output_bytes/i);
  });

  it('bounds checkpoint blobs and never touches pg-boss', () => {
    expect(sql).toContain('OCTET_LENGTH(compressed_blob) <= 16777216');
    expect(sql).not.toMatch(/pgboss\./i);
  });
});
