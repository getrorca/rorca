/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '..',
  'pg-migrations',
  '20260715221000_pty_generations.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('PTY generation migration contract', () => {
  it('is restart-safe and never rewrites or renumbers historical chunk rows', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pty_generations');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS generation_id UUID');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain("'__legacy__'");
    expect(sql).not.toMatch(/UPDATE\s+run_output_chunks/i);
    expect(sql).not.toMatch(/UPDATE\s+run_pty_output_chunks/i);
    // pipeline_runs has started_at/finished_at but never had created_at.
    expect(sql).not.toContain('pr.created_at');
  });

  it('enforces immutable identity, one active generation, and ordered replay indexes', () => {
    expect(sql).toContain('trg_pty_generation_identity_immutable');
    expect(sql).toContain('PTY generation identity is immutable');
    expect(sql).toContain('idx_pty_generations_one_active_run');
    expect(sql).toContain('idx_pty_generations_active_token');
    expect(sql).toContain('idx_run_pty_output_chunks_generation_replay');
    expect(sql).toContain('FOREIGN KEY (generation_id) REFERENCES pty_generations(id)');
  });

  it('does not touch the pg-boss managed schema', () => {
    expect(sql).not.toMatch(/pgboss\./i);
  });
});
