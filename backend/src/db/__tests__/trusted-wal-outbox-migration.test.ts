/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationPath = path.resolve(
  __dirname,
  '..',
  'pg-migrations',
  '20260717100000_trusted_wal_outbox.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('trusted WAL migration precedes webhook and accounting while identifiers stay bounded', () => {
  expect(path.basename(migrationPath)).toMatch(/^20260717100000_/);
  const names = fs.readdirSync(path.dirname(migrationPath)).filter(name => name.endsWith('.sql')).sort();
  expect(names.indexOf('20260717100000_trusted_wal_outbox.sql')).toBeLessThan(
    names.indexOf('20260718120000_webhook_replay_provenance.sql'),
  );
  expect(names.indexOf('20260718120000_webhook_replay_provenance.sql')).toBeLessThan(
    names.indexOf('20260718130000_story_result_accounting_identity.sql'),
  );
  expect(names.at(-1)).toBe('20260718130000_story_result_accounting_identity.sql');
  const identifiers = [...sql.matchAll(/(?:CONSTRAINT|INDEX IF NOT EXISTS)\s+([a-zA-Z0-9_]+)/g)]
    .map(match => match[1]);
  expect(identifiers.length).toBeGreaterThan(0);
  expect(Math.max(...identifiers.map(identifier => Buffer.byteLength(identifier)))).toBeLessThanOrEqual(63);
});

test('trusted host shape and relay-only insert trigger fail closed', () => {
  expect(sql).toContain("trust_provenance IN ('untrusted', 'host')");
  expect(sql).toContain("trusted_source IN ('execution-engine', 'worker', 'story-result')");
  expect(sql).toContain("event_identity_hash ~ '^[0-9a-f]{64}$'");
  expect(sql).toContain("IF NEW.trust_provenance = 'untrusted'");
  expect(sql).toContain("OLD.trust_provenance = 'untrusted' AND NEW.trust_provenance <> 'untrusted'");
  expect(sql).toContain("RAISE EXCEPTION 'host WAL identity is immutable'");
  expect(sql).toContain("RAISE EXCEPTION 'host WAL readiness is monotonic'");
  expect(sql).toContain("RAISE EXCEPTION 'host WAL relay acknowledgement is monotonic'");
  expect(sql).toContain('FOREIGN KEY (story_result_id) REFERENCES story_results(id)');
  expect(sql).toContain('ON wal_events (story_result_id)');
  expect(sql).toContain('AND outbox_ready_at IS NOT NULL');
  expect(sql).toContain('AND outbox_relayed_at IS NULL');
  expect(sql).toContain('ADD COLUMN IF NOT EXISTS expected_story_ids TEXT[]');
});
