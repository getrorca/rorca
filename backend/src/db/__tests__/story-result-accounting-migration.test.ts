/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.resolve(__dirname, '..', 'pg-migrations');
const FILENAME = '20260718130000_story_result_accounting_identity.sql';
const SQL = fs.readFileSync(path.join(MIGRATIONS, FILENAME), 'utf8');

describe('story-result accounting identity migration', () => {
  test('sorts after the prior latest migration and uses bounded explicit identifiers', () => {
    const names = fs.readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort();
    expect(names.at(-1)).toBe(FILENAME);
    const identifiers = [
      ...SQL.matchAll(/\bCONSTRAINT\s+([a-z0-9_]+)/gi),
      ...SQL.matchAll(/\bINDEX IF NOT EXISTS\s+([a-z0-9_]+)/gi),
      ...SQL.matchAll(/\bFUNCTION\s+([a-z0-9_]+)/gi),
      ...SQL.matchAll(/\bTRIGGER\s+([a-z0-9_]+)/gi),
    ].map(match => match[1]).filter(name => !['if', 'language'].includes(name.toLowerCase()));
    expect(Math.max(...identifiers.map(name => Buffer.byteLength(name)))).toBeLessThanOrEqual(63);
  });

  test('backfills only unambiguous legacy pairs before adding keyed one-to-one safeguards', () => {
    expect(SQL).toContain('COUNT(DISTINCT sr.id) = 1');
    expect(SQL).toContain('COUNT(DISTINCT tu.id) = 1');
    expect(SQL.indexOf('UPDATE token_usage tu')).toBeLessThan(SQL.indexOf('CREATE UNIQUE INDEX'));
    expect(SQL).toContain('FOREIGN KEY (story_result_id) REFERENCES story_results(id)');
    expect(SQL).toContain('ON token_usage (story_result_id)');
    expect(SQL).toContain('story_results_integrated_commit_ck');
    expect(SQL).toContain('reject_token_usage_result_rebind');
  });
});
