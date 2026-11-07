/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '../..');
const controller = fs.readFileSync(path.join(root, 'lib/bounty-controller.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'db/pg-migrations/20260801130000_bounty_controller_metadata.sql'), 'utf8');

const walk = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() && entry.name !== '__tests__' ? walk(file) : entry.isFile() && /\.(?:ts|js)$/.test(entry.name) ? [file] : [];
});

describe('bounty Controller authority boundary', () => {
  test('persists provenance and all four atomic transaction artifacts', () => {
    for (const field of ['payload_hash', 'actor', 'purpose', 'expires_at']) expect(migration).toContain(field);
    for (const table of ['bounty_missions', 'bounty_operations', 'bounty_events', 'bounty_operation_receipts', 'bounty_application_outbox']) expect(controller).toContain(table);
    expect(controller).toContain('pg_advisory_xact_lock');
    expect(controller).toContain('FOR UPDATE');
  });

  test('only designated Controller authority services contain direct authority writes', () => {
    const forbidden = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+bounty_(?:programs|missions|contracts|generations|work_packages|attempts|budgets|leases|holds|operations|operation_receipts|evidence|findings|drafts|approvals|events|application_outbox)\b/i;
    const designatedAuthorityServices = [
      'lib/bounty-controller.ts',
      'lib/bounty-finding-admission.ts',
      'lib/bounty-job-outbox.ts',
      'lib/bounty-mission-control.ts',
      'lib/bounty-operation-ledger.ts',
      'lib/bounty-production-caido.ts',
      'lib/bounty-production-services.ts',
    ];
    const directWriters = walk(root)
      .filter((file) => !file.includes(`${path.sep}db${path.sep}`) && forbidden.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
      .sort();
    expect(directWriters).toEqual(designatedAuthorityServices.sort());
  });
});
