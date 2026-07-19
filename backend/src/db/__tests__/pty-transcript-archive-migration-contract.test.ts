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
  '20260715223000_pty_transcript_raw_archive.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('PTY transcript/raw archive migration contract', () => {
  it('keeps transcript identity ordered, append-only, correlated, and non-authoritative for presentation', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pty_transcript_events');
    expect(sql).toContain('UNIQUE (generation_id, seq)');
    expect(sql).toContain('pty_transcript_tool_correlation');
    expect(sql).toContain("event_type IN (\n    'model_message', 'tool_call', 'tool_result', 'host_notice', 'error', 'gap'");
    expect(sql).not.toContain("'completion'");
    expect(sql).toContain('pty_transcript_presentation_not_authority');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON pty_transcript_events');
  });

  it('records compressed segment integrity, exclusive raw ranges, retention, and explicit gaps', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pty_raw_archive_manifests');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pty_raw_archive_segments');
    expect(sql).toContain("compression TEXT NOT NULL DEFAULT 'gzip'");
    expect(sql).toContain('raw_size = raw_end - raw_start');
    expect(sql).toContain("sha256 ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('retention_expires_at TIMESTAMPTZ NOT NULL');
    expect(sql).toContain("gaps JSONB NOT NULL DEFAULT '[]'::jsonb");
    for (const state of ['writing', 'complete', 'failed', 'interrupted', 'corrupt', 'pruned']) {
      expect(sql).toContain(`'${state}'`);
    }
  });

  it('is restart-safe and does not touch pg-boss tables', () => {
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).toContain('DROP TRIGGER IF EXISTS');
    expect(sql).not.toMatch(/(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)[^;]*pgboss\./i);
  });
});
