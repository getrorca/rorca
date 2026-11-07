/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(__dirname, '../pg-migrations/050_knowledge_graph.sql');
const runnerPath = path.resolve(__dirname, '../pg-index.ts');

describe('PostgreSQL 16 AGE graph migration contract', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');

  test('keeps migration 050 capability-only and never creates the obsolete application-schema graph', () => {
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS age');
    expect(sql).toContain('`rorca_v2` graph');
    expect(sql).not.toMatch(/create_graph\s*\(\s*'rorca'/i);
    expect(sql).not.toContain('ALTER SCHEMA rorca');
    expect(sql).not.toContain('rorca_pre_age_050');
  });

  test('runs the canonical bootstrap after the migration loop even when version 050 was already recorded', () => {
    expect(runner).toContain("import { bootstrapRorcaV2GraphForLifecycle } from '../lib/graph-contract'");
    expect(runner).toMatch(/for \(const file of files\)[\s\S]+bootstrapRorcaV2GraphForLifecycle\(pool\)/);
    expect(runner).toContain('[graph bootstrap: rorca_v2]');
    expect(runner).not.toMatch(/create_graph\s*\(\s*['"]rorca['"]/i);
  });

  test('retains Graph Lite as the explicit compatibility behavior when AGE cannot be used', () => {
    expect(runner).toContain('[skipped: extension unavailable]');
    expect(runner).toContain('Graph Lite active: rorca_v2 bootstrap');
  });
});
