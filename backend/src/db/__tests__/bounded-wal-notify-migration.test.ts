// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';

const migrationName = '20260802173000_bounded_wal_event_notifications.sql';
const migrationPath = path.resolve(__dirname, '..', 'pg-migrations', migrationName);
const sql = fs.readFileSync(migrationPath, 'utf8');

test('bounded WAL notification migration follows the prior migration without a prefix collision', () => {
  const migrations = fs.readdirSync(path.dirname(migrationPath))
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  const migrationIndex = migrations.indexOf(migrationName);

  expect(migrationIndex).toBeGreaterThan(0);
  expect(migrations[migrationIndex - 1]).toBe('20260801150000_bounty_effect_ledger.sql');
  expect(migrations.filter((name) => name.startsWith('20260802173000_'))).toEqual([migrationName]);
});

test('trigger sends only a compact durable row pointer and explicitly rebinds the trigger', () => {
  expect(sql).toContain('CREATE OR REPLACE FUNCTION rorca.notify_wal_event()');
  expect(sql).toContain("json_build_object('wal_event_id', NEW.id)::text");
  expect(sql).toContain('DROP TRIGGER IF EXISTS wal_events_notify ON rorca.wal_events');
  expect(sql).toContain('EXECUTE FUNCTION rorca.notify_wal_event()');
  expect(sql).toContain("IF NEW.trust_provenance = 'untrusted'");
  expect(sql).not.toMatch(/row_to_json\s*\(/i);
  expect(sql).not.toMatch(/NEW\.(?:payload|event_type|workspace_id|spec_id|story_id|actor)/i);
});
