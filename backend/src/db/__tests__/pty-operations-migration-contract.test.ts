/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const sql = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260719090000_pty_recovery_operations.sql'), 'utf8');

describe('PTY operations migration contract', () => {
  it('is additive, restart-safe, and declares actionable compatibility state', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pty_recovery_schema_state');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).toContain('ON CONFLICT (singleton) DO NOTHING');
    expect(sql).toContain("mutation_state IN ('ready', 'blocked')");
  });

  it('gives every retained artifact the mandatory safety guard', () => {
    for (const table of ['run_pty_output_chunks', 'pty_checkpoints', 'pty_transcript_events', 'pty_raw_archive_segments']) {
      expect(sql).toContain(`ALTER TABLE ${table}`);
    }
    expect((sql.match(/WHERE completed_at IS NOT NULL AND NOT referenced_by_manifest/g) ?? [])).toHaveLength(4);
  });

  it('constrains byte telemetry and never manages pg-boss', () => {
    for (const byteClass of ['observed', 'archived', 'transcripted', 'compacted', 'dropped', 'unrecoverable']) {
      expect(sql).toContain(`'${byteClass}'`);
    }
    expect(sql).not.toMatch(/pgboss\./i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
