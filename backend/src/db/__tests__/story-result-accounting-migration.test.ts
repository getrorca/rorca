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
    expect(names.indexOf(FILENAME)).toBeLessThan(
      names.indexOf('20260718140000_story_result_authority_and_github_projection.sql'),
    );
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
    expect(SQL).toContain("tu.cost_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')");
    expect(SQL).toContain('tu.cost_usd < 1000000000000');
    expect(SQL).toContain("NULLIF(BTRIM(tu.model), '') IS NOT NULL");
    expect(SQL).toContain('tu.input_tokens >= 0');
    expect(SQL).toContain('tu.output_tokens >= 0');
    expect(SQL).toContain('tu.reasoning_tokens >= 0');
    expect(SQL).toContain('COUNT(DISTINCT tu.id) = 1');
    expect(SQL.indexOf('UPDATE token_usage tu')).toBeLessThan(SQL.indexOf('CREATE UNIQUE INDEX'));
    expect(SQL).toContain('FOREIGN KEY (story_result_id) REFERENCES story_results(id)');
    expect(SQL).toContain('ON token_usage (story_result_id)');
    expect(SQL).toContain('story_results_integrated_commit_ck');
    expect(SQL).toContain('reject_token_usage_result_rebind');
  });

  test('modeled old-schema-valid malformed rows remain unbound while valid rows backfill', () => {
    type Legacy = { model: string; input: number; output: number; reasoning: number; cost: number };
    const eligible = (row: Legacy) => row.model.trim().length > 0
      && row.input >= 0 && row.output >= 0 && row.reasoning >= 0
      && Number.isFinite(row.cost) && row.cost >= 0 && row.cost < 1_000_000_000_000;
    const fixtures: Array<[string, Legacy, boolean]> = [
      ['valid zero', { model: 'unknown', input: 0, output: 0, reasoning: 0, cost: 0 }, true],
      ['valid upper range', { model: 'm', input: 2_147_483_647, output: 2_147_483_647, reasoning: 2_147_483_647, cost: 999_999_999_999.5 }, true],
      ['negative input', { model: 'm', input: -1, output: 0, reasoning: 0, cost: 0 }, false],
      ['negative output', { model: 'm', input: 0, output: -1, reasoning: 0, cost: 0 }, false],
      ['negative reasoning', { model: 'm', input: 0, output: 0, reasoning: -1, cost: 0 }, false],
      ['negative cost', { model: 'm', input: 0, output: 0, reasoning: 0, cost: -1 }, false],
      ['NaN cost', { model: 'm', input: 0, output: 0, reasoning: 0, cost: Number.NaN }, false],
      ['positive infinity', { model: 'm', input: 0, output: 0, reasoning: 0, cost: Number.POSITIVE_INFINITY }, false],
      ['negative infinity', { model: 'm', input: 0, output: 0, reasoning: 0, cost: Number.NEGATIVE_INFINITY }, false],
      ['numeric overflow', { model: 'm', input: 0, output: 0, reasoning: 0, cost: 1_000_000_000_000 }, false],
      ['empty model', { model: '', input: 0, output: 0, reasoning: 0, cost: 0 }, false],
      ['blank model', { model: '   ', input: 0, output: 0, reasoning: 0, cost: 0 }, false],
    ];
    for (const [name, row, expected] of fixtures) {
      expect({ name, eligible: eligible(row) }).toEqual({ name, eligible: expected });
    }
  });
});
