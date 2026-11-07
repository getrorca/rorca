/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  bootstrapRorcaV2GraphForLifecycle,
  buildRorcaCypherSql,
  RORCA_EDGE_LABELS,
  RORCA_GRAPH_NAME,
  RORCA_KEYED_NODE_LABELS,
  RORCA_UNKEYED_NODE_LABELS,
} from '../graph-contract';

const backendSource = path.resolve(import.meta.dirname, '../..');

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(target);
      } else if (entry.isFile() && entry.name.endsWith('.ts')
        && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
        files.push(target);
      }
    }
  };
  visit(root);
  return files.sort();
}

function fakeAgePool(options: { failCode?: string } = {}): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
  released: boolean[];
} {
  let graphExists = false;
  const labels = new Set<string>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const released: boolean[] = [];

  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (options.failCode && sql === 'SELECT ag_catalog.age_pi()') {
        const error = new Error('AGE capability unavailable') as Error & { code: string };
        error.code = options.failCode;
        throw error;
      }
      if (sql.includes("FROM pg_extension WHERE extname = 'age'")) return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM ag_catalog.ag_label')) {
        const label = String(params[1] ?? '');
        return { rowCount: labels.has(label) ? 1 : 0, rows: labels.has(label) ? [{}] : [] };
      }
      if (sql.includes('FROM ag_catalog.ag_graph')) return { rowCount: graphExists ? 1 : 0, rows: graphExists ? [{}] : [] };
      if (sql.includes('create_graph')) {
        assert.deepEqual(params, [RORCA_GRAPH_NAME]);
        graphExists = true;
      }
      if (sql.includes('create_vlabel')) {
        assert.equal(params[0], RORCA_GRAPH_NAME);
        labels.add(String(params[1]));
      }
      if (sql.includes('create_elabel')) {
        assert.equal(params[0], RORCA_GRAPH_NAME);
        labels.add(String(params[1]));
      }
      return { rowCount: 0, rows: [] };
    },
    release(destroy?: boolean) {
      released.push(Boolean(destroy));
    },
  } as unknown as PoolClient;

  return {
    pool: { connect: async () => client } as unknown as Pool,
    calls,
    released,
  };
}

test('every production Cypher and graph-name response is bound to the reviewed rorca_v2 identity', () => {
  const violations: string[] = [];
  for (const file of productionTypeScriptFiles(backendSource)) {
    const source = fs.readFileSync(file, 'utf8');
    if (/cypher\s*\(\s*['"]rorca['"]/i.test(source)) violations.push(path.relative(backendSource, file));
    if (/graphName\s*:\s*['"]rorca['"]/i.test(source)) violations.push(path.relative(backendSource, file));
  }
  assert.deepEqual(violations, []);

  const helperModules = [
    'lib/knowledge-graph.ts',
    'lib/graph-context.ts',
    'lib/memory-graph.ts',
    'lib/memory-ontology.ts',
    'lib/graph-drift-detector.ts',
  ];
  for (const relative of helperModules) {
    assert.match(fs.readFileSync(path.join(backendSource, relative), 'utf8'), /buildRorcaCypherSql/);
  }

  assert.equal(
    buildRorcaCypherSql('MATCH (n) RETURN n', 'n agtype'),
    "SELECT * FROM cypher('rorca_v2', $$ MATCH (n) RETURN n $$) AS (n agtype)",
  );
});

test('migration 050 and its caller never create the obsolete rorca graph', () => {
  const migration = fs.readFileSync(path.join(backendSource, 'db/pg-migrations/050_knowledge_graph.sql'), 'utf8');
  const runner = fs.readFileSync(path.join(backendSource, 'db/pg-index.ts'), 'utf8');
  assert.doesNotMatch(migration, /create_graph\s*\(\s*['"]rorca['"]/i);
  assert.doesNotMatch(runner, /create_graph\s*\(\s*['"]rorca['"]/i);
  assert.match(runner, /bootstrapRorcaV2GraphForLifecycle\(pool\)/);
});

test('migration lifecycle bootstraps already-recorded installations idempotently', async () => {
  const fixture = fakeAgePool();
  const first = await bootstrapRorcaV2GraphForLifecycle(fixture.pool);
  const second = await bootstrapRorcaV2GraphForLifecycle(fixture.pool);

  assert.equal(first.available, true);
  assert.deepEqual(second, first);
  if (!first.available) assert.fail('expected AGE graph bootstrap');
  assert.equal(first.graphName, RORCA_GRAPH_NAME);
  assert.deepEqual(first.labels, [...RORCA_KEYED_NODE_LABELS]);
  assert.equal(fixture.calls.filter(({ sql }) => sql.includes('create_graph')).length, 1);
  assert.equal(
    fixture.calls.filter(({ sql }) => sql.includes('create_vlabel')).length,
    RORCA_KEYED_NODE_LABELS.length + RORCA_UNKEYED_NODE_LABELS.length,
  );
  assert.equal(fixture.calls.filter(({ sql }) => sql.includes('create_elabel')).length, RORCA_EDGE_LABELS.length);
  assert.equal(fixture.calls.filter(({ sql }) => sql.includes('CREATE INDEX IF NOT EXISTS')).length, RORCA_KEYED_NODE_LABELS.length * 2);
  assert.equal(fixture.calls.some(({ params }) => params.includes('rorca')), false);
  assert.deepEqual(fixture.released, [false, false]);
  assert.equal(fixture.calls.some(({ sql }) => sql === "LOAD 'age'"), false);
  assert.equal(fixture.calls.some(({ sql }) => sql === 'SELECT ag_catalog.age_pi()'), true);
});

test('migration lifecycle grants bounded graph data access to the configured runtime principal', async () => {
  const previous = process.env.RORCA_RUNTIME_DATABASE_USER;
  process.env.RORCA_RUNTIME_DATABASE_USER = 'rorca_runtime';
  try {
    const fixture = fakeAgePool();
    const result = await bootstrapRorcaV2GraphForLifecycle(fixture.pool);
    assert.equal(result.available, true);
    const statements = fixture.calls.map(({ sql }) => sql);
    assert.ok(statements.includes('GRANT USAGE ON SCHEMA "rorca_v2" TO "rorca_runtime"'));
    assert.ok(statements.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "rorca_v2" TO "rorca_runtime"'));
    assert.ok(statements.includes('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "rorca_v2" TO "rorca_runtime"'));
  } finally {
    if (previous === undefined) delete process.env.RORCA_RUNTIME_DATABASE_USER;
    else process.env.RORCA_RUNTIME_DATABASE_USER = previous;
  }
});

test('migration lifecycle remains Graph Lite on an explicitly unavailable AGE capability', async () => {
  const fixture = fakeAgePool({ failCode: '42501' });
  const result = await bootstrapRorcaV2GraphForLifecycle(fixture.pool);
  assert.deepEqual(result, {
    available: false,
    reason: 'capability-unavailable',
    errorCode: '42501',
  });
  assert.deepEqual(fixture.released, [true]);
});
