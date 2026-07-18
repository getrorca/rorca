/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrations = path.resolve(__dirname, '..', 'pg-migrations');
const filename = '20260718140000_story_result_authority_and_github_projection.sql';
const sql = fs.readFileSync(path.join(migrations, filename), 'utf8');

test('host result provenance and terminal Check Run projection are schema-enforced', () => {
  const names = fs.readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  expect(names.at(-1)).toBe(filename);
  expect(sql).toContain("result_provenance IN ('host', 'compatibility', 'recovery_proposal', 'legacy')");
  expect(sql).toContain("result_provenance = 'host' AND result_source = 'execution-engine'");
  expect(sql).toContain("result_provenance = 'legacy' AND result_source = 'legacy'");
  expect(sql).toContain('story result authority identity is immutable');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS github_check_run_projections');
  expect(sql).toContain("projection_status IN ('pending', 'processing', 'retry', 'uncertain', 'projected', 'completed', 'blocked')");
  expect(sql).toContain("OLD.desired_state = 'completed'");
  const identifiers = [
    ...sql.matchAll(/\bCONSTRAINT\s+([a-z0-9_]+)/gi),
    ...sql.matchAll(/\bINDEX IF NOT EXISTS\s+([a-z0-9_]+)/gi),
    ...sql.matchAll(/\bFUNCTION\s+([a-z0-9_]+)/gi),
    ...sql.matchAll(/\bTRIGGER\s+([a-z0-9_]+)/gi),
  ].map(match => match[1]).filter(name => !['if', 'language'].includes(name.toLowerCase()));
  expect(Math.max(...identifiers.map(name => Buffer.byteLength(name)))).toBeLessThanOrEqual(63);
});
